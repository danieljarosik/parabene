/*
 * ParaBene – decision engine.
 *
 * Every evaluator implements `async evaluate(text)` and returns:
 *   { hide: boolean, reason: string, source: "keyword" | "ai", category?: string }
 * `reason` is raw data (a matched phrase or the model's own text); `category`
 * is a language-neutral id. Turning them into UI text is up to the caller.
 *
 * content.js knows only this contract, so the evaluation strategy
 * (keywords, local AI model, fallback chain) can be swapped without
 * touching the DOM scanning logic.
 */
(function (root) {
  'use strict';

  function makeResult(hide, reason, source, category) {
    const result = { hide: Boolean(hide), reason: String(reason || ''), source };
    if (category) result.category = category;
    return result;
  }

  /** Error with a language-neutral `code` (and optional `detail`) for the UI to translate. */
  function codedError(code, message, detail) {
    const err = new Error(message);
    err.code = code;
    if (detail !== undefined) err.detail = detail;
    return err;
  }

  /** Base interface for content evaluation strategies. */
  class ContentEvaluator {
    /**
     * @param {string} text
     * @returns {Promise<{hide: boolean, reason: string, source: string, category?: string}>}
     */
    async evaluate(text) {
      throw new Error(`${this.constructor.name}.evaluate(text) must be implemented by a subclass.`);
    }
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function normalize(value) {
    return String(value == null ? '' : value)
      .normalize('NFC')
      .replace(/\s+/g, ' ')
      .trim()
      .toLocaleLowerCase('pl');
  }

  /**
   * Fast local keyword matching.
   * - case-insensitive, with full Unicode support for diacritics (`u` flag),
   * - a phrase must start at a word boundary (no letter/digit right before it),
   * - the end of a phrase is open, so a stem also matches inflected forms.
   */
  class KeywordEvaluator extends ContentEvaluator {
    /**
     * @param {string[]} keywords
     * @param {{categories?: Map<string,string>|Object<string,string>}} [options]
     *        phrase → category id; a match on such a phrase reports the category
     */
    constructor(keywords, options = {}) {
      super();
      const categories = options.categories instanceof Map
        ? options.categories
        : new Map(Object.entries(options.categories || {}));

      this.categories = new Map();
      const unique = new Set();
      for (const raw of keywords || []) {
        const keyword = normalize(raw);
        if (!keyword || unique.has(keyword)) continue;
        unique.add(keyword);
        if (categories.has(keyword)) this.categories.set(keyword, categories.get(keyword));
      }

      const alternatives = [...unique]
        .sort((a, b) => b.length - a.length)
        .map((keyword) => escapeRegExp(keyword).replace(/ /g, '\\s+'));

      this.regex = alternatives.length
        ? new RegExp(`(?<![\\p{L}\\p{N}_])(${alternatives.join('|')})`, 'iu')
        : null;
    }

    async evaluate(text) {
      return this.evaluateSync(text);
    }

    evaluateSync(text) {
      if (!this.regex || !text) return makeResult(false, '', 'keyword');
      const match = this.regex.exec(String(text).normalize('NFC'));
      if (!match) return makeResult(false, '', 'keyword');
      const matched = normalize(match[1]);
      return makeResult(true, matched, 'keyword', this.categories.get(matched));
    }
  }

  /** Limits the number of concurrent requests to the local model. */
  class ConcurrencyLimiter {
    constructor(max) {
      this.max = Math.max(1, max);
      this.active = 0;
      this.queue = [];
    }

    async run(task) {
      if (this.active >= this.max) {
        await new Promise((resolve) => this.queue.push(resolve));
      }
      this.active += 1;
      try {
        return await task();
      } finally {
        this.active -= 1;
        const next = this.queue.shift();
        if (next) next();
      }
    }
  }

  /**
   * HTTP transport: POSTs `body` (by default {"text": "..."}) as JSON and returns the parsed JSON reply.
   * Used by the service worker (bypasses page CORS and Private Network Access).
   */
  async function fetchTransport({ endpoint, text, timeoutMs, body }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body === undefined ? { text } : body),
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
      });
      if (!response.ok) throw codedError('http', `HTTP ${response.status}`, String(response.status));
      try {
        return await response.json();
      } catch (_) {
        throw codedError('invalidResponse', 'response is not valid JSON');
      }
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw codedError('timeout', `timed out after ${timeoutMs} ms`, String(timeoutMs));
      }
      if (err && !err.code && err.name === 'TypeError') throw codedError('unreachable', err.message);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * basal-serve protocol (POST /v1/basal, basal typed-decision models).
   *
   * One "choice" question over the text; the option keys are hidden from the model
   * (option_keys: "hide"), so the Polish descriptions alone define the options. Every
   * key but "none" is a topic, and also the category id shown in the bar.
   * (A plain yes/no "noul" question ranks texts well but is poorly calibrated: a car
   * crash scored p(true) ≈ 0.3, so the choice form is used.)
   *
   * The core topics are always asked, even when the user does not hide them: with only one
   * or two options the model is pushed into them (asked about politics alone, a profane rant
   * scored p(politics) ≈ 0.8). Extra topics are asked only when selected, because they draw
   * probability from the core ones (with "clickbait" present a flood scored only 0.24).
   * The hide score is the summed probability of the selected topics.
   *
   * Reply: {"answers": {"topic": {"type": "choice", "choice": "accident",
   *         "probabilities": {"accident": 0.79, ..., "none": 0.21}, "confidence": 0.79}}, "usage": {...}}
   */
  const BASAL_QUESTION = 'topic';
  const BASAL_NONE = 'none';
  const BASAL_TOPICS = Object.freeze({
    accident: 'wypadek, katastrofę, pożar lub klęskę żywiołową',
    violence: 'przemoc, przestępstwo, atak lub wojnę',
    death: 'śmierć, chorobę lub tragedię osobistą',
    profanity: 'wulgaryzmy lub obelgi',
    politics: 'politykę, polityków lub spory polityczne',
    clickbait: 'sensację, szokujący nagłówek lub clickbait',
  });
  const BASAL_NONE_TEXT = 'coś innego, neutralnego lub pozytywnego';
  const BASAL_CORE_TOPICS = Object.freeze(['accident', 'violence', 'death', 'profanity']);
  const BASAL_DEFAULT_TOPICS = BASAL_CORE_TOPICS;

  /** Topics put to the model: the core ones plus the selected extras, in BASAL_TOPICS order. */
  function basalAskedTopics(selected = BASAL_DEFAULT_TOPICS) {
    return Object.keys(BASAL_TOPICS).filter((key) => BASAL_CORE_TOPICS.includes(key) || selected.includes(key));
  }

  function basalRequest(text, selected = BASAL_DEFAULT_TOPICS) {
    const criteria = {};
    for (const key of basalAskedTopics(selected)) criteria[key] = BASAL_TOPICS[key];
    criteria[BASAL_NONE] = BASAL_NONE_TEXT;
    return {
      state: String(text || ''),
      lang: 'pl',
      questions: {
        [BASAL_QUESTION]: {
          type: 'choice',
          instructions: 'Co opisuje tekst?',
          criteria,
          option_keys: 'hide',
        },
      },
    };
  }

  /**
   * basal reply → {hide, reason, category, score}: score = summed probability of the selected
   * topics, hide when it reaches `threshold`; the category is the most probable selected topic.
   * Throws `invalidResponse` when the reply has no probabilities.
   */
  function parseBasalResponse(data, { threshold = 0.5, topics = BASAL_DEFAULT_TOPICS } = {}) {
    const answer = data && data.answers && data.answers[BASAL_QUESTION];
    const probs = answer && answer.probabilities;
    if (!probs || typeof probs !== 'object' || typeof probs[BASAL_NONE] !== 'number') {
      throw codedError('invalidResponse', 'invalid basal response (expected answers.topic.probabilities)');
    }
    let score = 0;
    let category = '';
    for (const key of topics) {
      if (typeof probs[key] !== 'number') continue;
      score += probs[key];
      if (!category || probs[key] > probs[category]) category = key;
    }
    score = Math.round(Math.min(1, score) * 100) / 100;
    const hide = Boolean(category) && score >= threshold;
    return { hide, reason: '', category: hide ? category : '', score };
  }

  /**
   * Transport via the extension's service worker (for content scripts).
   * The service worker reads the endpoint URL from chrome.storage.local itself.
   */
  function createRuntimeTransport(messageType) {
    return async function runtimeTransport({ text }) {
      const response = await chrome.runtime.sendMessage({ type: messageType, text });
      if (!response || !response.ok) {
        const error = (response && response.error) || { code: 'noResponse' };
        throw codedError(error.code, error.detail ? `${error.code}: ${error.detail}` : error.code, error.detail);
      }
      return response.data;
    };
  }

  /**
   * Classification via a local server (a classification model, llama.cpp, Ollama…).
   * Throws when the endpoint is unreachable or the response is invalid —
   * failure handling is provided by FallbackEvaluator.
   */
  class LocalAIEvaluator extends ContentEvaluator {
    constructor({
      endpoint,
      transport = fetchTransport,
      timeoutMs = 4000,
      maxChars = 2000,
      maxConcurrent = 3,
      cacheSize = 300,
    } = {}) {
      super();
      this.endpoint = endpoint;
      this.transport = transport;
      this.timeoutMs = timeoutMs;
      this.maxChars = maxChars;
      this.cacheSize = cacheSize;
      this.cache = new Map();
      this.limiter = new ConcurrencyLimiter(maxConcurrent);
    }

    async evaluate(text) {
      const input = String(text || '').replace(/\s+/g, ' ').trim().slice(0, this.maxChars);
      if (!input) return makeResult(false, '', 'ai');
      if (this.cache.has(input)) return this.cache.get(input);

      const data = await this.limiter.run(() =>
        this.transport({ endpoint: this.endpoint, text: input, timeoutMs: this.timeoutMs })
      );
      if (!data || typeof data.hide !== 'boolean') {
        throw codedError('invalidResponse', 'invalid model response (expected {"hide": boolean, "reason": string})');
      }
      // An empty reason is rendered by the UI as a generic "AI model verdict".
      const reason = typeof data.reason === 'string' ? data.reason.trim().slice(0, 80) : '';
      const category = typeof data.category === 'string' && /^[a-z]+$/.test(data.category) ? data.category : '';
      const result = makeResult(data.hide, data.hide ? reason : '', 'ai', data.hide ? category : '');

      this.cache.set(input, result);
      if (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value);
      return result;
    }
  }

  /**
   * Tries the primary strategy; on error it uses the fallback and stops querying
   * the failing primary strategy for `cooldownMs`.
   */
  class FallbackEvaluator extends ContentEvaluator {
    constructor(primary, fallback, { cooldownMs = 30000, onError = null } = {}) {
      super();
      this.primary = primary;
      this.fallback = fallback;
      this.cooldownMs = cooldownMs;
      this.onError = onError;
      this.retryAt = 0;
    }

    async evaluate(text) {
      if (Date.now() >= this.retryAt) {
        try {
          return await this.primary.evaluate(text);
        } catch (err) {
          this.retryAt = Date.now() + this.cooldownMs;
          if (this.onError) this.onError(err);
        }
      }
      return this.fallback.evaluate(text);
    }
  }

  /**
   * Asks the evaluators in order and returns the first verdict that hides the text
   * (later evaluators are not asked); otherwise the last evaluator's verdict.
   */
  class FirstHitEvaluator extends ContentEvaluator {
    constructor(evaluators) {
      super();
      this.evaluators = evaluators;
    }

    async evaluate(text) {
      let result = makeResult(false, '', 'keyword');
      for (const evaluator of this.evaluators) {
        result = await evaluator.evaluate(text);
        if (result.hide) return result;
      }
      return result;
    }
  }

  /**
   * Builds an evaluator from the settings stored in chrome.storage.local.
   * @param {{keywords: string[], aiEnabled: boolean, aiEndpoint: string, aiMode?: string}} settings
   *        aiMode "both" (default): keywords first, then the model; "ai": the model alone,
   *        keywords only as a fallback while it is unavailable.
   */
  function createEvaluator(settings, options = {}) {
    const keyword = new KeywordEvaluator(settings.keywords, { categories: options.categories });
    if (!settings.aiEnabled) return keyword;
    const ai = new LocalAIEvaluator({
      endpoint: settings.aiEndpoint,
      transport: options.transport || fetchTransport,
      timeoutMs: options.timeoutMs,
      maxChars: options.maxChars,
    });
    const withFallback = new FallbackEvaluator(ai, keyword, { onError: options.onError });
    return settings.aiMode === 'ai' ? withFallback : new FirstHitEvaluator([keyword, withFallback]);
  }

  root.ParaBeneEvaluators = Object.freeze({
    ContentEvaluator,
    KeywordEvaluator,
    LocalAIEvaluator,
    FallbackEvaluator,
    FirstHitEvaluator,
    codedError,
    fetchTransport,
    BASAL_TOPICS,
    BASAL_CORE_TOPICS,
    basalAskedTopics,
    basalRequest,
    parseBasalResponse,
    createRuntimeTransport,
    createEvaluator,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = root.ParaBeneEvaluators;
})(globalThis);
