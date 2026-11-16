/*
 * ParaBene – decision engine.
 *
 * Every evaluator implements `async evaluate(text)` and returns:
 *   { hide: boolean, reason: string, source: "keyword" | "ai" }
 *
 * content.js knows only this contract, so the evaluation strategy
 * (keywords, local AI model, fallback chain) can be swapped without
 * touching the DOM scanning logic.
 */
(function (root) {
  'use strict';

  function makeResult(hide, reason, source) {
    return { hide: Boolean(hide), reason: String(reason || ''), source };
  }

  /** Base interface for content evaluation strategies. */
  class ContentEvaluator {
    /**
     * @param {string} text
     * @returns {Promise<{hide: boolean, reason: string, source: string}>}
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
     */
    constructor(keywords, options = {}) {
      super();
      const categories = options.categories instanceof Map
        ? options.categories
        : new Map(Object.entries(options.categories || {}));

      this.labels = new Map();
      for (const raw of keywords || []) {
        const keyword = normalize(raw);
        if (!keyword || this.labels.has(keyword)) continue;
        this.labels.set(keyword, categories.get(keyword) || keyword);
      }

      const alternatives = [...this.labels.keys()]
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
      return makeResult(true, this.labels.get(matched) || matched, 'keyword');
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
   * HTTP transport: POST {"text": "..."} → {"hide": boolean, "reason": "..."}.
   * Used by the service worker (bypasses page CORS and Private Network Access).
   */
  async function fetchTransport({ endpoint, text, timeoutMs }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ text }),
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (err) {
      if (err && err.name === 'AbortError') throw new Error(`przekroczono limit czasu ${timeoutMs} ms`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Transport via the extension's service worker (for content scripts).
   * The service worker reads the endpoint URL from chrome.storage.local itself.
   */
  function createRuntimeTransport(messageType) {
    return async function runtimeTransport({ text }) {
      const response = await chrome.runtime.sendMessage({ type: messageType, text });
      if (!response || !response.ok) {
        throw new Error((response && response.error) || 'no response from service worker');
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
        throw new Error('invalid model response (expected {"hide": boolean, "reason": string})');
      }
      const reason = typeof data.reason === 'string' && data.reason.trim()
        ? data.reason.trim().slice(0, 80)
        : 'ocena modelu AI';
      const result = makeResult(data.hide, data.hide ? reason : '', 'ai');

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
   * Builds an evaluator from the settings stored in chrome.storage.local.
   * @param {{keywords: string[], aiEnabled: boolean, aiEndpoint: string}} settings
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
    return new FallbackEvaluator(ai, keyword, { onError: options.onError });
  }

  root.ParaBeneEvaluators = Object.freeze({
    ContentEvaluator,
    KeywordEvaluator,
    LocalAIEvaluator,
    FallbackEvaluator,
    fetchTransport,
    createRuntimeTransport,
    createEvaluator,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = root.ParaBeneEvaluators;
})(globalThis);
