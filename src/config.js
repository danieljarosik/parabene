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
   * - basal:  basal-serve's typed-decision API (POST /v1/basal, see src/evaluators.js).
   */
  const AI_PROTOCOLS = Object.freeze(['simple', 'basal']);
  const DEFAULT_PROTOCOL = 'simple';
  const DEFAULT_ENDPOINTS = Object.freeze({
    simple: DEFAULT_ENDPOINT,
    basal: 'http://localhost:8000',
  });

  /** basal-serve's decision route, appended when the endpoint is a bare server address. */
  const BASAL_PATH = '/v1/basal';

  /**
   * How keywords and the AI model work together:
   * - both: a keyword match hides at once (no request); otherwise the model decides,
   * - ai:   the model decides alone; keywords are used only while the server is unavailable.
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
    language: DEFAULT_LANGUAGE,
  });

  const MSG = Object.freeze({
    CLASSIFY: 'parabene:classify',
    STATS: 'parabene:stats',
    GET_STATS: 'parabene:getStats',
    GET_MESSAGES: 'parabene:getMessages',
  });

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
    PARABENE_LANGUAGE: 'language',
  });
  const BOOLEAN_SETTINGS = new Set(['enabled', 'aiEnabled']);

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
      } else if (key === 'aiEndpoint' && !isValidEndpoint(value)) {
        ignored.push(name);
      } else if (key === 'aiMode' && !isSupportedMode(value)) {
        ignored.push(name);
      } else if (key === 'aiSensitivity' && !isSupportedSensitivity(value)) {
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
    return {
      enabled: s.enabled !== false,
      keywords: uniqueKeywords(Array.isArray(s.keywords) ? s.keywords : DEFAULT_KEYWORDS),
      aiEnabled: s.aiEnabled === true,
      aiEndpoint: endpoint || DEFAULT_ENDPOINT,
      aiProtocol: isSupportedProtocol(s.aiProtocol) ? s.aiProtocol : DEFAULT_PROTOCOL,
      aiMode: isSupportedMode(s.aiMode) ? s.aiMode : DEFAULT_AI_MODE,
      aiSensitivity: isSupportedSensitivity(s.aiSensitivity) ? s.aiSensitivity : DEFAULT_AI_SENSITIVITY,
      aiTopics: Array.isArray(s.aiTopics) ? sanitizeTopics(s.aiTopics) : [...DEFAULT_AI_TOPICS],
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
    AI_MODES,
    DEFAULT_AI_MODE,
    AI_SENSITIVITIES,
    DEFAULT_AI_SENSITIVITY,
    AI_TOPICS,
    DEFAULT_AI_TOPICS,
    ENV_FILE,
    ENV_KEYS,
    UI_LANGUAGES,
    DEFAULT_LANGUAGE,
    DEFAULT_KEYWORDS,
    DEFAULT_SETTINGS,
    PROFANITY,
    MSG,
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
