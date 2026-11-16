/*
 * ParaBene – internationalisation.
 *
 * Translations live in the standard Chrome extension format:
 * _locales/<code>/messages.json (see https://developer.chrome.com/docs/extensions/reference/api/i18n).
 * The manifest strings (__MSG_extName__…) are resolved by Chrome itself from the
 * browser language. chrome.i18n.getMessage() cannot switch language at runtime,
 * so the UI loads the messages.json of the language chosen in the settings and
 * formats it with the same rules as chrome.i18n:
 *   - named placeholders ($name$) defined in "placeholders",
 *   - positional substitutions ($1…$9), "$$" for a literal dollar sign,
 *   - message names are case-insensitive.
 * On top of that it supports CLDR plural forms via Intl.PluralRules:
 * plural("keywordsAdded", n) picks keywordsAdded_one / _few / _many / _other.
 *
 * Loaded by the popup, the content scripts and the service worker.
 */
(function (root) {
  'use strict';

  const RTL_LANGUAGES = new Set(['ar', 'fa', 'he', 'ur']);
  const LOCALIZED_ATTRIBUTES = ['placeholder', 'title', 'aria-label', 'alt'];

  function messagesUrl(locale) {
    return chrome.runtime.getURL(`_locales/${locale}/messages.json`);
  }

  /** Normalises a raw messages.json object: lower-case names and placeholder names. */
  function normalizeMessages(raw) {
    const out = Object.create(null);
    for (const [name, entry] of Object.entries(raw || {})) {
      if (!entry || typeof entry.message !== 'string') continue;
      const placeholders = Object.create(null);
      for (const [key, value] of Object.entries(entry.placeholders || {})) {
        if (value && typeof value.content === 'string') placeholders[key.toLowerCase()] = value.content;
      }
      out[name.toLowerCase()] = { message: entry.message, placeholders };
    }
    return out;
  }

  /**
   * Loads _locales/<locale>/messages.json from the extension package.
   * Works in extension pages and in the service worker. Content scripts cannot
   * fetch extension files, so they ask the service worker (MSG.GET_MESSAGES).
   */
  async function loadMessages(locale) {
    const response = await fetch(messagesUrl(locale));
    if (!response.ok) throw new Error(`Missing translations for "${locale}" (HTTP ${response.status})`);
    return normalizeMessages(await response.json());
  }

  function format(entry, substitutions) {
    const subs = substitutions == null ? [] : [].concat(substitutions).map(String);
    const expanded = entry.message.replace(/\$\$|\$([A-Za-z0-9_@]+)\$/g, (match, name) => {
      if (match === '$$') return match;
      const content = entry.placeholders[name.toLowerCase()];
      return content === undefined ? match : content;
    });
    return expanded.replace(/\$(\$|[1-9])/g, (match, token) => {
      if (token === '$') return '$';
      const value = subs[Number(token) - 1];
      return value === undefined ? '' : value;
    });
  }

  /**
   * @param {string} locale       active UI language, e.g. "pl"
   * @param {object} messages     normalised messages of that language
   * @param {object} [fallback]   normalised messages of the default language
   */
  function createTranslator(locale, messages, fallback) {
    const primary = messages || Object.create(null);
    const secondary = fallback || Object.create(null);
    const pluralRules = new Intl.PluralRules(locale);
    const numberFormat = new Intl.NumberFormat(locale);

    const own = (dict, name) => (Object.prototype.hasOwnProperty.call(dict, name) ? dict[name] : null);

    function lookup(key) {
      const name = String(key).toLowerCase();
      return own(primary, name) || own(secondary, name);
    }

    function has(key) {
      return lookup(key) !== null;
    }

    function t(key, substitutions) {
      const entry = lookup(key);
      if (entry) return format(entry, substitutions);
      // Last resort: Chrome's own lookup (browser language / default_locale).
      try {
        const text = chrome.i18n.getMessage(key, substitutions);
        if (text) return text;
      } catch (_) {
        /* chrome.i18n unavailable or invalid key */
      }
      console.warn(`[ParaBene] Missing translation: "${key}" (${locale})`);
      return key;
    }

    /** Picks the CLDR plural form; the formatted count is substitution $1. */
    function plural(key, count, substitutions) {
      const subs = [numberFormat.format(count)].concat(substitutions == null ? [] : substitutions);
      const exact = `${key}_${pluralRules.select(count)}`;
      return t(has(exact) ? exact : `${key}_other`, subs);
    }

    return Object.freeze({
      locale,
      dir: RTL_LANGUAGES.has(locale.split('-')[0]) ? 'rtl' : 'ltr',
      t,
      plural,
      has,
      formatNumber: (value) => numberFormat.format(value),
    });
  }

  /**
   * Translates a DOM subtree declaratively:
   *   <h2 data-i18n="keywordsTitle"></h2>
   *   <input data-i18n-placeholder="keywordPlaceholder" data-i18n-aria-label="keywordInputLabel">
   */
  function localize(rootNode, translator) {
    const scope = rootNode || document;
    for (const el of scope.querySelectorAll('[data-i18n]')) {
      el.textContent = translator.t(el.getAttribute('data-i18n'));
    }
    for (const attr of LOCALIZED_ATTRIBUTES) {
      for (const el of scope.querySelectorAll(`[data-i18n-${attr}]`)) {
        el.setAttribute(attr, translator.t(el.getAttribute(`data-i18n-${attr}`)));
      }
    }
    if (scope === document || scope === document.documentElement) {
      document.documentElement.lang = translator.locale;
      document.documentElement.dir = translator.dir;
    }
  }

  root.ParaBeneI18n = Object.freeze({
    loadMessages,
    normalizeMessages,
    createTranslator,
    localize,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = root.ParaBeneI18n;
})(globalThis);
