/*
 * ParaBene – shared configuration.
 * Loaded by the content scripts, the popup and the service worker (importScripts).
 */
(function (root) {
  'use strict';

  const DEFAULT_ENDPOINT = 'http://localhost:8000/classify';

  /**
   * Request formats the AI evaluator can speak:
   * - simple: POST {"text"} → {"hide", "reason"} (README, "Local AI endpoint contract"),
   * - basal:  basal-serve's typed-decision API (POST /v1/basal, see src/evaluators.js),
   * - builtin: no server; the model runs in the browser (see "Built-in model" below).
   */
  const AI_PROTOCOLS = Object.freeze(['simple', 'basal', 'builtin']);
  const DEFAULT_PROTOCOL = 'simple';
  const DEFAULT_ENDPOINTS = Object.freeze({
    simple: DEFAULT_ENDPOINT,
    basal: 'http://localhost:8000',
  });

  /** basal-serve's decision route, appended when the endpoint is a bare server address. */
  const BASAL_PATH = '/v1/basal';

  /**
   * Built-in model (`aiProtocol: "builtin"`): the basal decision model runs inside the browser, in
   * an offscreen document the service worker opens once and keeps in the background
   * (offscreen/offscreen.js). llama.cpp compiled to WebAssembly (vendor/wllama) runs the GGUF file
   * on the GPU through WebGPU; there is no CPU fallback (a decision takes 4–20 s on the CPU).
   * The model file is downloaded once from Hugging Face (a pinned revision) into the extension's
   * own storage; page text never leaves the browser. It asks the same question as the basal
   * protocol, so sensitivity and topics apply.
   * Measured on an Apple M4 Pro: 0.33 s for a short text, 0.53 s for 500 characters, 1.2 s for
   * 2,000; decisions are made one at a time, hence the generous timeout.
   */
  const BUILTIN_MODEL_NAME = 'basal-2.0-mini-Q5_K_M';
  const BUILTIN_MODEL_URL =
    'https://huggingface.co/Remek/basal-2.0-mini-GGUF/resolve/b6b79ac00da308d93b39c6ca500792ce2ee83a6f/' +
    'basal-2.0-mini-Q5_K_M-decision.gguf';
  const BUILTIN_PAGE = 'offscreen/offscreen.html';
  const BUILTIN_TIMEOUT_MS = 30000;
  /** Tokens of context: 2,000 characters of Polish text are ~500 tokens with the question. */
  const BUILTIN_CONTEXT = 4096;

  /** Protocols that ask the basal question (sensitivity and topics apply to them). */
  function usesBasalQuestion(protocol) {
    return protocol === 'basal' || protocol === 'builtin';
  }

  /**
   * How keywords and the AI model work together:
   * - both: a keyword match hides at once (no request); otherwise the model decides,
   * - ai:   the model decides alone; keywords are used only while the model is unavailable.
   */
  const AI_MODES = Object.freeze(['both', 'ai']);
  const DEFAULT_AI_MODE = 'both';

  /**
   * basal: sensitivity → hide threshold for the summed probability of the selected topics
   * (a higher sensitivity hides more, with more false positives).
   */
  const AI_SENSITIVITIES = Object.freeze({ low: 0.7, medium: 0.5, high: 0.3 });
  const DEFAULT_AI_SENSITIVITY = 'medium';

  /**
   * basal: topics the model can recognise (the ids are also category ids, shown in the bar
   * via "category_<id>"). Prompts live in src/evaluators.js (BASAL_TOPICS).
   */
  const AI_TOPICS = Object.freeze(['accident', 'violence', 'death', 'profanity', 'politics', 'clickbait']);
  const DEFAULT_AI_TOPICS = Object.freeze(['accident', 'violence', 'death', 'profanity']);

  /**
   * Optional image evaluation (`aiImagesEnabled`): pictures inside the containers are judged by a
   * separate basal-serve server running a multimodal model (basal-omni, `--media on`), so the fast
   * text model keeps its own server. It shares the sensitivity and the hidden topics with the text
   * model; topics that make no sense for a picture (IMAGE_SKIPPED_TOPICS) are not asked.
   * One image is ~1.8 s of server time (requests are served one at a time), hence the generous
   * timeout (the first request after a server start also loads the model) and the low concurrency.
   */
  const DEFAULT_IMAGE_ENDPOINT = 'http://localhost:8011';
  const IMAGE_SKIPPED_TOPICS = Object.freeze(['clickbait']);
  const IMAGE_TIMEOUT_MS = 30000;
  const IMAGE_MAX_CONCURRENT = 2;
  /** Pictures smaller than this (natural and rendered size, px) are icons, avatars or emoji. */
  const IMAGE_MIN_SIDE = 100;
  /** At most this many of the largest pictures of a container are judged. */
  const IMAGE_MAX_PER_CONTAINER = 2;
  /** Pictures are scaled down to this longest side before sending (the model sees ~280 tokens anyway). */
  const IMAGE_MAX_SEND_SIDE = 768;
  const IMAGE_MAX_BYTES = 15 * 1024 * 1024;

  /**
   * Learning from revealed content (opt-in, `learnEnabled`, see src/learning.js): content revealed
   * with "Show anyway" and not hidden again becomes an example; similar content hidden for the same
   * reason is then let through with a "Hide" bar. Similarity (`learnSimilarity`) → the cosine
   * threshold: on Polish news snippets the same story from two portals scored ~0.5, another
   * accident of the same kind ~0.25–0.3, an unrelated text ~0.1.
   * Examples are kept by the service worker in chrome.storage.local (LEARN_STORAGE_KEY, newest
   * LEARN_MAX_ENTRIES); revealed content still waiting for confirmation is kept under
   * LEARN_PENDING_KEY until its tab leaves the page or the user scrolls far past it.
   */
  const LEARN_SIMILARITIES = Object.freeze({ strict: 0.45, medium: 0.33, loose: 0.2 });
  const DEFAULT_LEARN_SIMILARITY = 'medium';
  const LEARN_STORAGE_KEY = 'learned';
  const LEARN_PENDING_KEY = 'learnPending';
  const LEARN_MAX_ENTRIES = 300;
  const LEARN_MAX_TEXT = 2000;

  /**
   * UI languages. Each code must have a matching _locales/<code>/messages.json.
   * Names are endonyms (each language in its own name), as is the convention
   * for language pickers.
   */
  const UI_LANGUAGES = Object.freeze({
    pl: 'Polski',
    en: 'English',
  });
  const DEFAULT_LANGUAGE = 'pl';

  /** Profanity stems — shown in the placeholder bar under the "profanity" category. */
  const PROFANITY = Object.freeze([
    'kurw',
    'skurw',
    'chuj',
    'huj',
    'pierdol',
    'spierdal',
    'wypierdal',
    'odpierdal',
    'jebać',
    'jeban',
    'jebi',
    'jebn',
    'pojeb',
    'zajeb',
    'wyjeb',
    'pizd',
  ]);

  /**
   * Default phrases. Matching is anchored at the start of a word, so a stem
   * (e.g. "tragedi") covers all inflected forms: tragedia, tragedii, tragedię…
   */
  const DEFAULT_KEYWORDS = Object.freeze([
    'wypadek',
    'wypadku',
    'wypadki',
    'wypadków',
    'karambol',
    'zginął',
    'zginęła',
    'zginęli',
    'zginęło',
    'nie żyje',
    'śmierć',
    'śmierci',
    'śmiertel',
    'zwłok',
    'ofiary',
    'tragedi',
    'katastrof',
    'pożar',
    'strzelanin',
    'zabójstw',
    'zabójc',
    'morderstw',
    'zamordowa',
    'nożownik',
    'przemoc',
    'pobicie',
    ...PROFANITY,
  ]);

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    keywords: DEFAULT_KEYWORDS,
    aiEnabled: false,
    aiEndpoint: DEFAULT_ENDPOINT,
    aiProtocol: DEFAULT_PROTOCOL,
    aiMode: DEFAULT_AI_MODE,
    aiSensitivity: DEFAULT_AI_SENSITIVITY,
    aiTopics: DEFAULT_AI_TOPICS,
    aiImagesEnabled: false,
    aiImagesEndpoint: DEFAULT_IMAGE_ENDPOINT,
    logEnabled: false,
    learnEnabled: false,
    learnSimilarity: DEFAULT_LEARN_SIMILARITY,
    language: DEFAULT_LANGUAGE,
  });

  const MSG = Object.freeze({
    CLASSIFY: 'parabene:classify',
    CLASSIFY_IMAGE: 'parabene:classifyImage',
    TEST_IMAGES: 'parabene:testImages',
    STATS: 'parabene:stats',
    GET_STATS: 'parabene:getStats',
    GET_MESSAGES: 'parabene:getMessages',
    LOG_HIDDEN: 'parabene:logHidden',
    LOG_REVEALED: 'parabene:logRevealed',
    LOG_CLEAR: 'parabene:logClear',
    LEARN_PENDING: 'parabene:learnPending',
    LEARN_COMMIT: 'parabene:learnCommit',
    LEARN_CANCEL: 'parabene:learnCancel',
    LEARN_FORGET: 'parabene:learnForget',
    // service worker → offscreen document (the built-in model)
    BUILTIN_LOAD: 'parabene:builtin:load',
    BUILTIN_EVALUATE: 'parabene:builtin:evaluate',
  });

  /**
   * Log of hidden content (opt-in, `logEnabled`): kept by the service worker in
   * chrome.storage.local under LOG_STORAGE_KEY, never sent anywhere; the panel
   * exports it as a .jsonl file for later analysis. Only the newest LOG_MAX_ENTRIES
   * are kept, each text capped at LOG_MAX_TEXT characters.
   */
  const LOG_STORAGE_KEY = 'hideLog';
  const LOG_MAX_ENTRIES = 1000;
  const LOG_MAX_TEXT = 2000;

  const AI_TIMEOUT_MS = 4000;
  const AI_MAX_CHARS = 2000;
  const KEYWORD_MIN_LENGTH = 3;
  const KEYWORD_MAX_LENGTH = 80;

  function normalizeKeyword(value) {
    return String(value == null ? '' : value)
      .normalize('NFC')
      .replace(/\s+/g, ' ')
      .trim()
      .toLocaleLowerCase('pl');
  }

  function uniqueKeywords(list) {
    const seen = new Set();
    const out = [];
    for (const item of list) {
      const keyword = normalizeKeyword(item);
      if (!keyword || seen.has(keyword)) continue;
      seen.add(keyword);
      out.push(keyword);
    }
    return out;
  }

  function isValidEndpoint(value) {
    try {
      const url = new URL(String(value));
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (_) {
      return false;
    }
  }

  function isSupportedProtocol(value) {
    return AI_PROTOCOLS.includes(value);
  }

  function isSupportedMode(value) {
    return AI_MODES.includes(value);
  }

  function isSupportedSimilarity(value) {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LEARN_SIMILARITIES, value);
  }

  function isSupportedSensitivity(value) {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(AI_SENSITIVITIES, value);
  }

  /** Known topic ids only, without duplicates, in AI_TOPICS order. */
  function sanitizeTopics(list) {
    const chosen = new Set(Array.isArray(list) ? list : []);
    return AI_TOPICS.filter((topic) => chosen.has(topic));
  }

  /**
   * The URL a request actually goes to: for basal a bare server address
   * (http://host:port or http://host:port/) gets BASAL_PATH; any other path is kept.
   */
  function resolveEndpoint(endpoint, protocol) {
    if (protocol !== 'basal') return endpoint;
    try {
      const url = new URL(String(endpoint));
      if (url.pathname === '/' || url.pathname === '') {
        url.pathname = BASAL_PATH;
        return url.toString();
      }
    } catch (_) {
      /* invalid URLs are reported by isValidEndpoint */
    }
    return endpoint;
  }

  /**
   * Local, uncommitted settings file (.env in the extension directory, see .env.example).
   * Applied by the service worker on every install / reload of the extension.
   */
  const ENV_FILE = '.env';
  const ENV_KEYS = Object.freeze({
    PARABENE_ENABLED: 'enabled',
    PARABENE_AI_ENABLED: 'aiEnabled',
    PARABENE_AI_PROTOCOL: 'aiProtocol',
    PARABENE_AI_ENDPOINT: 'aiEndpoint',
    PARABENE_AI_MODE: 'aiMode',
    PARABENE_AI_SENSITIVITY: 'aiSensitivity',
    PARABENE_AI_TOPICS: 'aiTopics',
    PARABENE_AI_IMAGES_ENABLED: 'aiImagesEnabled',
    PARABENE_AI_IMAGES_ENDPOINT: 'aiImagesEndpoint',
    PARABENE_LOG_ENABLED: 'logEnabled',
    PARABENE_LEARN_ENABLED: 'learnEnabled',
    PARABENE_LEARN_SIMILARITY: 'learnSimilarity',
    PARABENE_LANGUAGE: 'language',
  });
  const BOOLEAN_SETTINGS = new Set(['enabled', 'aiEnabled', 'aiImagesEnabled', 'logEnabled', 'learnEnabled']);

  /**
   * .env text (KEY=VALUE lines, # comments, optional quotes) → partial settings.
   * Unknown keys and invalid values are skipped and listed in `ignored`.
   */
  function parseEnv(text) {
    const settings = {};
    const ignored = [];
    for (const rawLine of String(text || '').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) {
        ignored.push(line);
        continue;
      }
      const name = match[1];
      let value = match[2].trim();
      if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
      else value = value.replace(/\s+#.*$/, '');
      const key = ENV_KEYS[name];
      if (!key) {
        ignored.push(name);
      } else if (BOOLEAN_SETTINGS.has(key)) {
        if (/^(true|1|yes|on)$/i.test(value)) settings[key] = true;
        else if (/^(false|0|no|off)$/i.test(value)) settings[key] = false;
        else ignored.push(name);
      } else if (key === 'aiProtocol' && !isSupportedProtocol(value)) {
        ignored.push(name);
      } else if ((key === 'aiEndpoint' || key === 'aiImagesEndpoint') && !isValidEndpoint(value)) {
        ignored.push(name);
      } else if (key === 'aiMode' && !isSupportedMode(value)) {
        ignored.push(name);
      } else if (key === 'aiSensitivity' && !isSupportedSensitivity(value)) {
        ignored.push(name);
      } else if (key === 'learnSimilarity' && !isSupportedSimilarity(value)) {
        ignored.push(name);
      } else if (key === 'aiTopics') {
        // Comma- or space-separated ids; an empty value means "no topics".
        const topics = value.split(/[\s,;]+/).filter(Boolean);
        if (topics.every((topic) => AI_TOPICS.includes(topic))) settings[key] = sanitizeTopics(topics);
        else ignored.push(name);
      } else if (key === 'language' && !isSupportedLanguage(value)) {
        ignored.push(name);
      } else {
        settings[key] = value;
      }
    }
    return { settings, ignored };
  }

  function isSupportedLanguage(value) {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(UI_LANGUAGES, value);
  }

  function sanitize(raw) {
    const s = Object.assign({}, DEFAULT_SETTINGS, raw || {});
    const endpoint = typeof s.aiEndpoint === 'string' ? s.aiEndpoint.trim() : '';
    const imagesEndpoint = typeof s.aiImagesEndpoint === 'string' ? s.aiImagesEndpoint.trim() : '';
    return {
      enabled: s.enabled !== false,
      keywords: uniqueKeywords(Array.isArray(s.keywords) ? s.keywords : DEFAULT_KEYWORDS),
      aiEnabled: s.aiEnabled === true,
      aiEndpoint: endpoint || DEFAULT_ENDPOINT,
      aiProtocol: isSupportedProtocol(s.aiProtocol) ? s.aiProtocol : DEFAULT_PROTOCOL,
      aiMode: isSupportedMode(s.aiMode) ? s.aiMode : DEFAULT_AI_MODE,
      aiSensitivity: isSupportedSensitivity(s.aiSensitivity) ? s.aiSensitivity : DEFAULT_AI_SENSITIVITY,
      aiTopics: Array.isArray(s.aiTopics) ? sanitizeTopics(s.aiTopics) : [...DEFAULT_AI_TOPICS],
      aiImagesEnabled: s.aiImagesEnabled === true,
      aiImagesEndpoint: imagesEndpoint || DEFAULT_IMAGE_ENDPOINT,
      logEnabled: s.logEnabled === true,
      learnEnabled: s.learnEnabled === true,
      learnSimilarity: isSupportedSimilarity(s.learnSimilarity) ? s.learnSimilarity : DEFAULT_LEARN_SIMILARITY,
      language: isSupportedLanguage(s.language) ? s.language : DEFAULT_LANGUAGE,
    };
  }

  /**
   * Reads settings from chrome.storage.local. Missing keys (e.g. on first run)
   * are filled in with default values and persisted.
   */
  async function load() {
    const keys = Object.keys(DEFAULT_SETTINGS);
    const stored = await chrome.storage.local.get(keys);
    const missing = {};
    for (const key of keys) {
      if (stored[key] === undefined) missing[key] = DEFAULT_SETTINGS[key];
    }
    if (Object.keys(missing).length > 0) {
      await chrome.storage.local.set(JSON.parse(JSON.stringify(missing)));
    }
    return sanitize(Object.assign({}, stored, missing));
  }

  /**
   * Map of phrase → category id. The id (not the phrase) is shown as the reason
   * for hiding, translated via the "category_<id>" message.
   */
  function categories() {
    const map = new Map();
    for (const word of PROFANITY) map.set(normalizeKeyword(word), 'profanity');
    return map;
  }

  root.ParaBeneConfig = Object.freeze({
    DEFAULT_ENDPOINT,
    AI_PROTOCOLS,
    DEFAULT_PROTOCOL,
    DEFAULT_ENDPOINTS,
    BASAL_PATH,
    BUILTIN_MODEL_NAME,
    BUILTIN_MODEL_URL,
    BUILTIN_PAGE,
    BUILTIN_TIMEOUT_MS,
    BUILTIN_CONTEXT,
    usesBasalQuestion,
    AI_MODES,
    DEFAULT_AI_MODE,
    AI_SENSITIVITIES,
    DEFAULT_AI_SENSITIVITY,
    AI_TOPICS,
    DEFAULT_AI_TOPICS,
    DEFAULT_IMAGE_ENDPOINT,
    IMAGE_SKIPPED_TOPICS,
    IMAGE_TIMEOUT_MS,
    IMAGE_MAX_CONCURRENT,
    IMAGE_MIN_SIDE,
    IMAGE_MAX_PER_CONTAINER,
    IMAGE_MAX_SEND_SIDE,
    IMAGE_MAX_BYTES,
    LEARN_SIMILARITIES,
    DEFAULT_LEARN_SIMILARITY,
    LEARN_STORAGE_KEY,
    LEARN_PENDING_KEY,
    LEARN_MAX_ENTRIES,
    LEARN_MAX_TEXT,
    ENV_FILE,
    ENV_KEYS,
    UI_LANGUAGES,
    DEFAULT_LANGUAGE,
    DEFAULT_KEYWORDS,
    DEFAULT_SETTINGS,
    PROFANITY,
    MSG,
    LOG_STORAGE_KEY,
    LOG_MAX_ENTRIES,
    LOG_MAX_TEXT,
    AI_TIMEOUT_MS,
    AI_MAX_CHARS,
    KEYWORD_MIN_LENGTH,
    KEYWORD_MAX_LENGTH,
    normalizeKeyword,
    uniqueKeywords,
    isValidEndpoint,
    isSupportedProtocol,
    isSupportedMode,
    isSupportedSensitivity,
    isSupportedSimilarity,
    isSupportedLanguage,
    sanitizeTopics,
    resolveEndpoint,
    parseEnv,
    sanitize,
    load,
    categories,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = root.ParaBeneConfig;
})(globalThis);
