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
   * on the GPU through WebGPU; there is no CPU fallback (a decision takes 6–20 s on the CPU).
   * The user picks the model (`aiModel`) from BUILTIN_MODELS. Its file comes from Hugging Face (a
   * pinned revision) and is kept in the extension's own storage; page text never leaves the
   * browser. A file is downloaded only when the user clicks "Download model" in the panel; until
   * the file of the chosen model is stored the built-in model is off and keywords are used (see
   * BUILTIN_STORAGE_KEY). It asks the same question as the basal protocol, so sensitivity and
   * topics apply. Decisions are made one at a time, hence the generous timeout.
   */

  /**
   * The models the built-in format can run: only files that carry basal's decision metadata
   * ("-decision.gguf") and that were loaded and measured in the browser. `url` pins a revision,
   * `bytes` is the file size (shown in the panel), `note` the message with a hint for choosing.
   * Measured on an Apple M4 Pro (WebGPU), one decision for a text of ~100 / 500 / 2,000 characters:
   *   basal-omni-pico   0.17 / 0.29 / 0.64 s   (0.8B; text only, like every GGUF port)
   *   basal-2.0-mini    0.33 / 0.53 / 1.18 s   (1.5B)
   * Left out: basal-2.0-mini Q8_0 (1.70 GB; the same verdicts and times as Q5_K_M) and
   * basal-2.0-4.5B Q5_K_M (3.42 GB; it works, but 0.93 / 1.50 / 3.45 s: twenty tiles take 30 s,
   * the whole timeout).
   * The ids are stored in the settings: do not rename them.
   */
  const HF = 'https://huggingface.co/Remek/';
  const BUILTIN_MODELS = Object.freeze(
    [
      {
        id: 'basal-omni-pico-q8',
        name: 'basal-omni-pico (Q8_0)',
        bytes: 812839616,
        note: 'aiModelNote_pico',
        url: `${HF}basal-omni-pico-GGUF/resolve/f13a8cd528e446dc705131373371e0755e3ad1cf/basal-omni-pico-Q8_0-decision.gguf`,
      },
      {
        id: 'basal-2.0-mini-q5',
        name: 'basal-2.0-mini (Q5_K_M)',
        bytes: 1168139424,
        note: 'aiModelNote_mini',
        url: `${HF}basal-2.0-mini-GGUF/resolve/b6b79ac00da308d93b39c6ca500792ce2ee83a6f/basal-2.0-mini-Q5_K_M-decision.gguf`,
      },
    ].map(Object.freeze)
  );
  const DEFAULT_BUILTIN_MODEL = 'basal-2.0-mini-q5';

  function isBuiltinModel(id) {
    return BUILTIN_MODELS.some((model) => model.id === id);
  }

  /** The model with this id, or the default one for an unknown id. */
  function builtinModel(id) {
    return BUILTIN_MODELS.find((model) => model.id === id) || BUILTIN_MODELS.find((model) => model.id === DEFAULT_BUILTIN_MODEL);
  }

  const BUILTIN_PAGE = 'offscreen/offscreen.html';
  const BUILTIN_TIMEOUT_MS = 30000;
  /** Tokens of context: 2,000 characters of Polish text are ~500 tokens with the question. */
  const BUILTIN_CONTEXT = 4096;

  /**
   * What the service worker knows about the model files, in chrome.storage.local: an object
   * { <model id>: { url, state, error? } }; a record counts only while its `url` is the model's
   * current one. No record = "missing".
   * - requested: the user clicked "Download model"; the offscreen document may download the file,
   * - stored:    the offscreen document found the complete file in its storage; the model is used,
   * - failed:    the download (or the check for WebGPU before it) failed, with `error`; the user
   *              has to click again — nothing is downloaded again by itself.
   * Only the chosen model of the built-in format can be "requested": choosing another model or
   * another request format cancels a download.
   */
  const BUILTIN_STORAGE_KEY = 'builtinModels';
  const BUILTIN_STATES = Object.freeze(['requested', 'stored', 'failed']);

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
    excludedSites: Object.freeze([]),
    aiEnabled: false,
    aiEndpoint: DEFAULT_ENDPOINT,
    aiProtocol: DEFAULT_PROTOCOL,
    aiModel: DEFAULT_BUILTIN_MODEL,
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
    LOG_VERDICT: 'parabene:logVerdict',
    LOG_REVEALED: 'parabene:logRevealed',
    LOG_CLEAR: 'parabene:logClear',
    LEARN_PENDING: 'parabene:learnPending',
    LEARN_COMMIT: 'parabene:learnCommit',
    LEARN_CANCEL: 'parabene:learnCancel',
    LEARN_FORGET: 'parabene:learnForget',
    // panel → service worker: examples restored from a settings backup (src/backup.js)
    LEARN_IMPORT: 'parabene:learnImport',
    // panel → service worker (the built-in model's file)
    MODEL_STATUS: 'parabene:modelStatus',
    MODEL_DOWNLOAD: 'parabene:modelDownload',
    // offscreen document → service worker: the file is stored / missing / could not be downloaded
    MODEL_STATE: 'parabene:modelState',
    // service worker → offscreen document (the built-in model); each names the model by id
    BUILTIN_LOAD: 'parabene:builtin:load',
    BUILTIN_STATUS: 'parabene:builtin:status',
    BUILTIN_EVALUATE: 'parabene:builtin:evaluate',
  });

  /**
   * Log of evaluated content (opt-in, `logEnabled`): every judged text, hidden or shown, kept by
   * the service worker in IndexedDB (src/store.js), never sent anywhere; the statistics page
   * (STATS_PAGE) shows it and lets the user correct verdicts, the panel exports it as a .jsonl
   * file. Only the newest LOG_MAX_ENTRIES are kept (corrected ones stay), each text capped at
   * LOG_MAX_TEXT characters. LOG_STORAGE_KEY is where versions up to 1.0 kept the log of hidden
   * content in chrome.storage.local: it is moved into the database once.
   */
  const LOG_STORAGE_KEY = 'hideLog';
  const LOG_MAX_ENTRIES = 10000;
  const STATS_PAGE = 'stats/stats.html';
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

  /** Keeps the hostname of an HTTP(S) address or a bare host, normalised by the URL parser. */
  function normalizeSite(value) {
    if (typeof value !== 'string') return '';
    const input = value.trim();
    if (!input || /[\s\\]/.test(input)) return '';
    const address = /^https?:\/\/[^/?#]/i.test(input);
    const authority = address ? input.slice(input.indexOf('://') + 3).split(/[/?#]/, 1)[0] : input;
    if (/[/?#@]/.test(authority)) return '';
    try {
      const url = new URL(address ? input : `https://${input}`);
      if (url.username || url.password) return '';
      const host = url.hostname.replace(/\.$/, '');
      if (host.startsWith('[')) return host; // The URL parser already checked the IPv6 address.
      // Underscores are not valid in DNS hostnames, but browsers open such hosts (news_room.example.com).
      const label = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;
      return host.length <= 253 && host.split('.').every((part) => label.test(part)) ? host : '';
    } catch (_) {
      return '';
    }
  }

  /**
   * Hostname of a page address reported by the browser (tab or sender URL), as the content script
   * sees it in location.hostname; '' for anything other than HTTP(S).
   */
  function siteHost(url) {
    try {
      const parsed = new URL(String(url));
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      return parsed.hostname.toLowerCase().replace(/\.$/, '');
    } catch (_) {
      return '';
    }
  }

  function isSiteExcluded(sites, hostname) {
    const host = hostname.toLowerCase().replace(/\.$/, '');
    return sites.some((site) => host === site || host.endsWith(`.${site}`));
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
    PARABENE_AI_MODEL: 'aiModel',
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
      } else if (key === 'aiModel' && !isBuiltinModel(value)) {
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

  /**
   * One setting checked on its own (a value read from a backup file, see src/backup.js): the clean
   * value, or undefined when the key is unknown or the value is not valid for it. Unlike sanitize()
   * nothing is replaced with a default, so the caller can tell the user what was skipped.
   */
  function validateSetting(key, value) {
    if (BOOLEAN_SETTINGS.has(key)) return typeof value === 'boolean' ? value : undefined;
    switch (key) {
      case 'keywords':
        return Array.isArray(value) && value.every((item) => typeof item === 'string') ? uniqueKeywords(value) : undefined;
      case 'excludedSites': {
        if (!Array.isArray(value)) return undefined;
        const sites = value.map(normalizeSite);
        return sites.every(Boolean) ? [...new Set(sites)] : undefined;
      }
      case 'aiEndpoint':
      case 'aiImagesEndpoint':
        return typeof value === 'string' && isValidEndpoint(value.trim()) ? value.trim() : undefined;
      case 'aiProtocol':
        return isSupportedProtocol(value) ? value : undefined;
      case 'aiModel':
        return isBuiltinModel(value) ? value : undefined;
      case 'aiMode':
        return isSupportedMode(value) ? value : undefined;
      case 'aiSensitivity':
        return isSupportedSensitivity(value) ? value : undefined;
      case 'aiTopics':
        return Array.isArray(value) && value.every((topic) => AI_TOPICS.includes(topic)) ? sanitizeTopics(value) : undefined;
      case 'learnSimilarity':
        return isSupportedSimilarity(value) ? value : undefined;
      case 'language':
        return isSupportedLanguage(value) ? value : undefined;
      default:
        return undefined;
    }
  }

  function sanitize(raw) {
    const s = Object.assign({}, DEFAULT_SETTINGS, raw || {});
    const endpoint = typeof s.aiEndpoint === 'string' ? s.aiEndpoint.trim() : '';
    const imagesEndpoint = typeof s.aiImagesEndpoint === 'string' ? s.aiImagesEndpoint.trim() : '';
    return {
      enabled: s.enabled !== false,
      keywords: uniqueKeywords(Array.isArray(s.keywords) ? s.keywords : DEFAULT_KEYWORDS),
      excludedSites: Array.isArray(s.excludedSites) ? [...new Set(s.excludedSites.map(normalizeSite).filter(Boolean))] : [],
      aiEnabled: s.aiEnabled === true,
      aiEndpoint: endpoint || DEFAULT_ENDPOINT,
      aiProtocol: isSupportedProtocol(s.aiProtocol) ? s.aiProtocol : DEFAULT_PROTOCOL,
      aiModel: isBuiltinModel(s.aiModel) ? s.aiModel : DEFAULT_BUILTIN_MODEL,
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
   * are filled in with default values and persisted. The optional site list stays absent until edited.
   */
  async function load() {
    const keys = Object.keys(DEFAULT_SETTINGS);
    const stored = await chrome.storage.local.get(keys);
    const missing = {};
    for (const key of keys) {
      if (stored[key] === undefined && key !== 'excludedSites') missing[key] = DEFAULT_SETTINGS[key];
    }
    if (Object.keys(missing).length === 0) return sanitize(stored);
    await chrome.storage.local.set(JSON.parse(JSON.stringify(missing)));
    // Read again: a change saved while the defaults were being written (e.g. a site excluded in the
    // panel) has already been announced, before the caller could listen for it.
    const fresh = await chrome.storage.local.get(keys);
    return sanitize(Object.assign({}, missing, fresh));
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
    BUILTIN_MODELS,
    DEFAULT_BUILTIN_MODEL,
    isBuiltinModel,
    builtinModel,
    BUILTIN_PAGE,
    BUILTIN_TIMEOUT_MS,
    BUILTIN_CONTEXT,
    BUILTIN_STORAGE_KEY,
    BUILTIN_STATES,
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
    normalizeSite,
    siteHost,
    isSiteExcluded,
    PROFANITY,
    MSG,
    LOG_STORAGE_KEY,
    LOG_MAX_ENTRIES,
    STATS_PAGE,
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
    validateSetting,
    sanitize,
    load,
    categories,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = root.ParaBeneConfig;
})(globalThis);
