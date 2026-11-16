/*
 * ParaBene – shared configuration.
 * Loaded by the content scripts, the popup and the service worker (importScripts).
 */
(function (root) {
  'use strict';

  const DEFAULT_ENDPOINT = 'http://localhost:8000/classify';

  /** Profanity stems — shown in the placeholder bar under the "wulgaryzm" (profanity) category. */
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
  });

  const MSG = Object.freeze({
    CLASSIFY: 'parabene:classify',
    STATS: 'parabene:stats',
    GET_STATS: 'parabene:getStats',
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

  function sanitize(raw) {
    const s = Object.assign({}, DEFAULT_SETTINGS, raw || {});
    const endpoint = typeof s.aiEndpoint === 'string' ? s.aiEndpoint.trim() : '';
    return {
      enabled: s.enabled !== false,
      keywords: uniqueKeywords(Array.isArray(s.keywords) ? s.keywords : DEFAULT_KEYWORDS),
      aiEnabled: s.aiEnabled === true,
      aiEndpoint: endpoint || DEFAULT_ENDPOINT,
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

  /** Map of phrase → category displayed as the reason for hiding. */
  function categories() {
    const map = new Map();
    for (const word of PROFANITY) map.set(normalizeKeyword(word), 'wulgaryzm');
    return map;
  }

  root.ParaBeneConfig = Object.freeze({
    DEFAULT_ENDPOINT,
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
    sanitize,
    load,
    categories,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = root.ParaBeneConfig;
})(globalThis);
