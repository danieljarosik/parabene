/*
 * ParaBene – settings backup, keyword and excluded site files (export / import in the panel).
 *
 * File formats:
 * - keywords (.txt): one phrase per line, lines starting with "#" are comments (the first one
 *   names the format: "# parabene-keywords 1"). Meant to be edited by hand; commas and
 *   semicolons separate phrases too, as in the panel's input. A phrase that itself starts with
 *   "#" or "\" is written with a "\" in front ("\#wypadek"), which the importer removes (as in
 *   .gitignore). The importer also accepts a settings backup (it takes the phrases from it) and a
 *   JSON array of strings.
 * - excluded sites (.txt): one hostname per line, with "# parabene-sites 1" as the first comment.
 *   The importer also accepts HTTP(S) URLs, a JSON array of strings or a settings backup.
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
  const SITES_FORMAT = 'parabene-sites';
  const FORMAT_VERSION = 2;
  const KEYWORDS_VERSION = 1;
  const SITES_VERSION = 1;
  /** Larger files are not read (a full backup with 300 examples is well under 1 MB). */
  const MAX_FILE_BYTES = 5 * 1024 * 1024;

  /**
   * MIGRATIONS[n](data) turns the parsed file of format n into format n + 1 (returning a new
   * object). A rename would be, e.g. for "aiMode" → "aiStrategy":
   *   n: (data) => { const settings = { ...data.settings }; settings.aiStrategy = settings.aiMode;
   *                  delete settings.aiMode; return { ...data, formatVersion: n + 1, settings }; },
   */
  const MIGRATIONS = Object.freeze({
    /**
     * Format 2: "logEnabled" (a log of hidden content) gave way to "evalLogEnabled" (a log of
     * everything evaluated). The old consent covered less, so it is dropped, not carried over:
     * the file then lacks "evalLogEnabled" and the current value is kept.
     */
    1: (data) => {
      const settings = isObject(data.settings) ? { ...data.settings } : data.settings;
      if (isObject(settings)) delete settings[Config.LOG_OLD_SETTING];
      return { ...data, formatVersion: 2, settings };
    },
  });

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

  /** Hostnames from a file: normalised, without duplicates; invalid entries are counted. */
  function cleanSites(list) {
    const sites = new Set();
    let skipped = 0;
    for (const entry of list) {
      const site = Config.normalizeSite(entry);
      if (site) sites.add(site);
      else skipped += 1;
    }
    return { sites: [...sites], skipped };
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

  function buildListFile(format, version, entries, header = []) {
    const comments = [`${format} ${version}`, ...header].map((line) => `# ${line}`.trimEnd());
    return [...comments, '', ...entries, ''].join('\n');
  }

  /** `header`: comment lines (already translated) put under the format line. */
  function buildKeywordsFile(keywords, header) {
    return buildListFile(KEYWORDS_FORMAT, KEYWORDS_VERSION, keywords.map(escapeKeyword), header);
  }

  /**
   * Text of a keywords file → { keywords, skipped, fromSettings }.
   * Throws BackupError: invalidJson, notParabene, noKeywords (and the codes of parseSettingsFile).
   */
  function parseKeywordsFile(text) {
    const body = stripBom(text).trim();
    if (isSitesFile(body)) throw new BackupError('sitesFile');
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

  /* ---------------- Excluded sites file ---------------- */

  function isSitesFile(body) {
    return /^#\s*parabene-sites\b/.test(body);
  }

  function buildSitesFile(sites, header) {
    return buildListFile(SITES_FORMAT, SITES_VERSION, sites, header);
  }

  /**
   * Text of an excluded sites file → { sites, skipped, fromSettings }.
   * Throws BackupError: invalidJson, notParabene, keywordsFile, noSites (and the codes of parseSettingsFile).
   */
  function parseSitesFile(text) {
    const body = stripBom(text).trim();
    if (/^#\s*parabene-keywords\b/.test(body)) throw new BackupError('keywordsFile');
    let list = null;
    let invalidJson = false;
    if (body.startsWith('{')) {
      const data = parseJson(body);
      if (isObject(data) && data.format === SETTINGS_FORMAT) {
        const parsed = parseSettingsFile(body);
        if (!parsed.settings.excludedSites?.length) throw new BackupError('noSites');
        const skipped = parsed.warnings.find((warning) => warning.code === 'sitesSkipped');
        return { sites: parsed.settings.excludedSites, skipped: skipped ? skipped.count : 0, fromSettings: true };
      }
      throw new BackupError('notParabene');
    }
    if (body.startsWith('[')) {
      // A JSON array, or a text file whose first line starts with "[" (an IPv6 host, a typo):
      // that one is read line by line, so a single bad line does not block the rest.
      try {
        list = JSON.parse(body); // starts with "[", so it can only be an array
      } catch (_) {
        invalidJson = true;
      }
    }
    if (!list) {
      list = body.split(/\r?\n/).filter((line) => !line.trim().startsWith('#'))
        .map((entry) => entry.trim())
        .filter(Boolean);
    }
    const { sites, skipped } = cleanSites(list);
    if (sites.length === 0) throw new BackupError(invalidJson ? 'invalidJson' : 'noSites');
    return { sites, skipped, fromSettings: false };
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
   *              newerFormat, olderFormat, unknownKeys, invalidValues, missingKeys, keywordsSkipped,
   *              sitesSkipped, exceptionsSkipped
   * }.
   * Throws BackupError: invalidJson, notParabene, keywordsFile, sitesFile, unsupportedVersion.
   */
  function parseSettingsFile(text) {
    const body = stripBom(text).trim();
    if (isSitesFile(body)) throw new BackupError('sitesFile');
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
      } else if (key === 'excludedSites') {
        // As with phrases, one bad entry does not reject the whole list.
        if (!Array.isArray(value)) {
          invalid.push(key);
          continue;
        }
        const { sites, skipped } = cleanSites(value);
        // Nothing valid in a non-empty list: keep the current list rather than clearing it.
        if (sites.length === 0 && skipped > 0) {
          invalid.push(key);
          continue;
        }
        settings.excludedSites = sites;
        if (skipped) warnings.push({ code: 'sitesSkipped', count: skipped });
      } else if (key === 'keywordExceptions') {
        // As with sites: bad rules are skipped and reported; with no valid rule in a non-empty list
        // the current rules stay rather than being cleared.
        if (!Array.isArray(value)) {
          invalid.push(key);
          continue;
        }
        const { rules, skipped } = Config.cleanExceptions(value);
        if (rules.length === 0 && skipped > 0) {
          invalid.push(key);
          continue;
        }
        settings.keywordExceptions = rules;
        if (skipped) warnings.push({ code: 'exceptionsSkipped', count: skipped });
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
    SITES_FORMAT,
    SITES_VERSION,
    MAX_FILE_BYTES,
    BackupError,
    cleanKeywords,
    buildKeywordsFile,
    parseKeywordsFile,
    buildSitesFile,
    parseSitesFile,
    buildSettingsFile,
    parseSettingsFile,
    fileStamp,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = root.ParaBeneBackup;
})(globalThis);
