/*
 * ParaBene – settings backup and keyword files (export / import in the panel).
 *
 * Two kinds of files:
 * - keywords (.txt): one phrase per line, lines starting with "#" are comments (the first one
 *   names the format: "# parabene-keywords 1"). Meant to be edited by hand; commas and
 *   semicolons separate phrases too, as in the panel's input. A phrase that itself starts with
 *   "#" or "\" is written with a "\" in front ("\#wypadek"), which the importer removes (as in
 *   .gitignore). The importer also accepts a settings backup (it takes the phrases from it) and a
 *   JSON array of strings.
 * - settings backup (.json): every setting, the keywords among them, plus the learned examples:
 *     { "format": "parabene-settings", "formatVersion": 1, "extension": "ParaBene",
 *       "extensionVersion": "1.0.0", "exportedAt": "<ISO date>",
 *       "settings": { <key>: <value>, … }, "learned": [ … ] }
 *
 * Compatibility with files from other versions:
 * - a setting added later is simply missing from an older file: the current value is kept
 *   (and the user is told). Adding a setting therefore does NOT need a new format version;
 * - a setting unknown to this version (a file from a newer one) is skipped, as is a value that
 *   is not valid here (e.g. a model id this version does not know) — each is listed in a warning;
 * - a change that makes an older file wrong (a setting renamed, a value with a new meaning, a new
 *   structure) raises FORMAT_VERSION and adds a step to MIGRATIONS that upgrades the older format.
 *   Older files are then upgraded step by step before they are read.
 *
 * Loaded by the popup; plain functions without chrome.* calls (testable in Node).
 */
(function (root) {
  'use strict';

  const Config = root.ParaBeneConfig || (typeof require === 'function' ? require('./config.js') : null);

  const SETTINGS_FORMAT = 'parabene-settings';
  const KEYWORDS_FORMAT = 'parabene-keywords';
  const FORMAT_VERSION = 1;
  const KEYWORDS_VERSION = 1;
  /** Larger files are not read (a full backup with 300 examples is well under 1 MB). */
  const MAX_FILE_BYTES = 5 * 1024 * 1024;

  /**
   * MIGRATIONS[n](data) turns the parsed file of format n into format n + 1 (returning a new
   * object). Example for a future format 2 that renamed "aiMode" to "aiStrategy":
   *   1: (data) => { const settings = { ...data.settings }; settings.aiStrategy = settings.aiMode;
   *                  delete settings.aiMode; return { ...data, formatVersion: 2, settings }; },
   */
  const MIGRATIONS = Object.freeze({});

  class BackupError extends Error {
    /** `code` → the panel message "importError_<code>". */
    constructor(code) {
      super(code);
      this.name = 'BackupError';
      this.code = code;
    }
  }

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function stripBom(text) {
    return String(text == null ? '' : text).replace(/^\uFEFF/, '');
  }

  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch (_) {
      throw new BackupError('invalidJson');
    }
  }

  /** Phrases from a file: normalised, without duplicates; wrong ones (type, length) are counted. */
  function cleanKeywords(list) {
    const seen = new Set();
    const keywords = [];
    let skipped = 0;
    for (const item of list) {
      if (typeof item !== 'string') {
        skipped += 1;
        continue;
      }
      const keyword = Config.normalizeKeyword(item);
      if (!keyword) continue;
      if (keyword.length < Config.KEYWORD_MIN_LENGTH || keyword.length > Config.KEYWORD_MAX_LENGTH) {
        skipped += 1;
      } else if (!seen.has(keyword)) {
        seen.add(keyword);
        keywords.push(keyword);
      }
    }
    return { keywords, skipped };
  }

  /* ---------------- Keywords file ---------------- */

  /** A phrase starting with "#" (a comment otherwise) or "\" (the escape itself) gets a "\" in front. */
  function escapeKeyword(keyword) {
    return /^[#\\]/.test(keyword) ? `\\${keyword}` : keyword;
  }

  /** Reverse of escapeKeyword for one (trimmed) phrase of a file. */
  function unescapeKeyword(phrase) {
    const trimmed = phrase.trim();
    return /^\\[#\\]/.test(trimmed) ? trimmed.slice(1) : phrase;
  }

  /** `header`: comment lines (already translated) put under the format line. */
  function buildKeywordsFile(keywords, header) {
    const comments = [`${KEYWORDS_FORMAT} ${KEYWORDS_VERSION}`, ...(header || [])].map((line) => `# ${line}`.trimEnd());
    return [...comments, '', ...keywords.map(escapeKeyword), ''].join('\n');
  }

  /**
   * Text of a keywords file → { keywords, skipped, fromSettings }.
   * Throws BackupError: invalidJson, notParabene, noKeywords (and the codes of parseSettingsFile).
   */
  function parseKeywordsFile(text) {
    const body = stripBom(text).trim();
    let list;
    let fromSettings = false;
    if (body.startsWith('{') || body.startsWith('[')) {
      const data = parseJson(body);
      if (Array.isArray(data)) {
        list = data;
      } else if (isObject(data) && data.format === SETTINGS_FORMAT) {
        const parsed = parseSettingsFile(body);
        // An empty list here would let "Replace the list" wipe every phrase.
        if (!parsed.settings.keywords || parsed.settings.keywords.length === 0) throw new BackupError('noKeywords');
        const skipped = parsed.warnings.find((warning) => warning.code === 'keywordsSkipped');
        return { keywords: parsed.settings.keywords, skipped: skipped ? skipped.count : 0, fromSettings: true };
      } else {
        throw new BackupError('notParabene');
      }
    } else {
      list = body
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith('#'))
        .join('\n')
        .split(/[,;\n]+/)
        .map(unescapeKeyword);
    }
    const { keywords, skipped } = cleanKeywords(list);
    if (keywords.length === 0) throw new BackupError('noKeywords');
    return { keywords, skipped, fromSettings };
  }

  /* ---------------- Settings backup ---------------- */

  /** `settings`: the sanitised settings; `learned`: the stored examples; `version`: the extension's. */
  function buildSettingsFile({ settings, learned, version, now }) {
    const out = {};
    for (const key of Object.keys(Config.DEFAULT_SETTINGS)) out[key] = settings[key];
    const data = {
      format: SETTINGS_FORMAT,
      formatVersion: FORMAT_VERSION,
      extension: 'ParaBene',
      extensionVersion: String(version || ''),
      exportedAt: (now || new Date()).toISOString(),
      settings: out,
      learned: Array.isArray(learned) ? learned : [],
    };
    return JSON.stringify(data, null, 2) + '\n';
  }

  function migrate(data) {
    let current = data;
    for (let version = data.formatVersion; version < FORMAT_VERSION; version += 1) {
      const step = MIGRATIONS[version];
      if (typeof step !== 'function') throw new BackupError('unsupportedVersion');
      current = step(current);
    }
    return current;
  }

  /**
   * Text of a settings backup → {
   *   settings:  the valid settings found in the file (only these are to be written),
   *   learned:   the examples (raw objects, checked again by the service worker) or null,
   *   meta:      { formatVersion, extensionVersion, exportedAt },
   *   warnings:  [{ code, items?, count?, version? }] — what the user should be told:
   *              newerFormat, olderFormat, unknownKeys, invalidValues, missingKeys, keywordsSkipped
   * }.
   * Throws BackupError: invalidJson, notParabene, keywordsFile, unsupportedVersion.
   */
  function parseSettingsFile(text) {
    const body = stripBom(text).trim();
    if (!body.startsWith('{')) {
      throw new BackupError(body.startsWith('[') || body.startsWith('#') ? 'keywordsFile' : 'notParabene');
    }
    let data = parseJson(body);
    if (!isObject(data) || data.format !== SETTINGS_FORMAT) throw new BackupError('notParabene');
    const version = data.formatVersion;
    if (!Number.isInteger(version) || version < 1) throw new BackupError('notParabene');

    const warnings = [];
    if (version > FORMAT_VERSION) {
      warnings.push({ code: 'newerFormat', version });
    } else if (version < FORMAT_VERSION) {
      data = migrate(data);
      warnings.push({ code: 'olderFormat', version });
    }

    const raw = isObject(data.settings) ? data.settings : {};
    const known = Object.keys(Config.DEFAULT_SETTINGS);
    const settings = {};
    const unknown = [];
    const invalid = [];
    for (const [key, value] of Object.entries(raw)) {
      if (!known.includes(key)) {
        unknown.push(key);
      } else if (key === 'keywords') {
        if (!Array.isArray(value)) {
          invalid.push(key);
          continue;
        }
        const { keywords, skipped } = cleanKeywords(value);
        settings.keywords = keywords;
        if (skipped) warnings.push({ code: 'keywordsSkipped', count: skipped });
      } else {
        const clean = Config.validateSetting(key, value);
        if (clean === undefined) invalid.push(key);
        else settings[key] = clean;
      }
    }
    const missing = known.filter((key) => !Object.prototype.hasOwnProperty.call(raw, key));

    let learned = null;
    if (Array.isArray(data.learned)) learned = data.learned.filter(isObject);
    else if (data.learned !== undefined) invalid.push('learned');

    if (unknown.length) warnings.push({ code: 'unknownKeys', items: unknown });
    if (invalid.length) warnings.push({ code: 'invalidValues', items: invalid });
    if (missing.length) warnings.push({ code: 'missingKeys', items: missing });

    const exportedAt = typeof data.exportedAt === 'string' && !Number.isNaN(Date.parse(data.exportedAt)) ? data.exportedAt : '';
    return {
      settings,
      learned,
      meta: {
        formatVersion: version,
        extensionVersion: typeof data.extensionVersion === 'string' ? data.extensionVersion.slice(0, 40) : '',
        exportedAt,
      },
      warnings,
    };
  }

  /** "parabene-settings-20261117-1430.json" style suffix in local time. */
  function fileStamp(now) {
    const date = now || new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  }

  root.ParaBeneBackup = Object.freeze({
    SETTINGS_FORMAT,
    KEYWORDS_FORMAT,
    FORMAT_VERSION,
    KEYWORDS_VERSION,
    MAX_FILE_BYTES,
    BackupError,
    cleanKeywords,
    buildKeywordsFile,
    parseKeywordsFile,
    buildSettingsFile,
    parseSettingsFile,
    fileStamp,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = root.ParaBeneBackup;
})(globalThis);
