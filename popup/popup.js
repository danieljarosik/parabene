/* ParaBene – control panel. */
(() => {
  'use strict';

  const Config = globalThis.ParaBeneConfig;
  const I18n = globalThis.ParaBeneI18n;
  const profanity = new Set(Config.PROFANITY.map(Config.normalizeKeyword));

  const els = {
    app: document.querySelector('.app'),
    enabled: document.getElementById('enabled'),
    enabledState: document.getElementById('enabled-state'),
    hiddenCount: document.getElementById('hidden-count'),
    statHint: document.getElementById('stat-hint'),
    keywordForm: document.getElementById('keyword-form'),
    keywordInput: document.getElementById('keyword-input'),
    keywordFeedback: document.getElementById('keyword-feedback'),
    keywordList: document.getElementById('keyword-list'),
    keywordCount: document.getElementById('keyword-count'),
    keywordEmpty: document.getElementById('keyword-empty'),
    restoreDefaults: document.getElementById('restore-defaults'),
    aiEnabled: document.getElementById('ai-enabled'),
    aiSettings: document.getElementById('ai-settings'),
    aiProtocol: document.getElementById('ai-protocol'),
    aiEndpoint: document.getElementById('ai-endpoint'),
    aiTest: document.getElementById('ai-test'),
    aiStatus: document.getElementById('ai-status'),
    version: document.getElementById('version'),
    language: document.getElementById('language'),
  };

  let settings = Config.sanitize({});
  let activeTabId = null;
  let tabReachable = false;
  let feedbackTimer = 0;
  let recentlyAdded = new Set();

  /* ---------------- Internationalisation ---------------- */

  let i18n = I18n.createTranslator(Config.DEFAULT_LANGUAGE, null);
  let collator = new Intl.Collator(i18n.locale, { sensitivity: 'base' });
  let languageSeq = 0;
  const t = (key, substitutions) => i18n.t(key, substitutions);
  const plural = (key, count, substitutions) => i18n.plural(key, count, substitutions);

  async function loadMessagesSafe(locale) {
    try {
      return await I18n.loadMessages(locale);
    } catch (err) {
      console.warn('[ParaBene]', err);
      return null;
    }
  }

  /** Loads the chosen language (with the default language as fallback) and re-renders the UI. */
  async function applyLanguage(locale) {
    const seq = ++languageSeq;
    const [messages, fallback] = await Promise.all([
      loadMessagesSafe(locale),
      locale === Config.DEFAULT_LANGUAGE ? null : loadMessagesSafe(Config.DEFAULT_LANGUAGE),
    ]);
    if (seq !== languageSeq) return;

    i18n = I18n.createTranslator(locale, messages, fallback);
    collator = new Intl.Collator(locale, { sensitivity: 'base' });
    clearTimeout(feedbackTimer);
    for (const hint of [els.keywordFeedback, els.aiStatus]) hint.classList.remove('hint--ok', 'hint--error');
    I18n.localize(document, i18n);
    render();
  }

  function renderLanguagePicker() {
    if (els.language.options.length === 0) {
      for (const [code, name] of Object.entries(Config.UI_LANGUAGES)) {
        const option = new Option(name, code);
        option.lang = code; // endonym — announce it in its own language
        els.language.add(option);
      }
    }
    els.language.value = settings.language;
  }

  /* ---------------- Render ---------------- */

  function render() {
    els.enabled.checked = settings.enabled;
    els.enabledState.textContent = t(settings.enabled ? 'stateOn' : 'stateOff');
    els.app.classList.toggle('app--off', !settings.enabled);

    els.aiEnabled.checked = settings.aiEnabled;
    els.aiSettings.classList.toggle('ai--inactive', !settings.aiEnabled);
    els.aiProtocol.value = settings.aiProtocol;
    els.aiEndpoint.placeholder = Config.DEFAULT_ENDPOINTS[settings.aiProtocol];
    if (document.activeElement !== els.aiEndpoint) els.aiEndpoint.value = settings.aiEndpoint;

    renderLanguagePicker();
    renderKeywords();
    renderStatHint();
  }

  function renderKeywords() {
    const sorted = [...settings.keywords].sort(collator.compare);
    const fragment = document.createDocumentFragment();
    for (const keyword of sorted) {
      const item = document.createElement('li');
      item.className = 'chip';
      if (profanity.has(keyword)) item.classList.add('chip--masked');
      if (recentlyAdded.has(keyword)) item.classList.add('chip--new');

      const label = document.createElement('span');
      label.className = 'chip__label';
      label.textContent = keyword;

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = t('removeKeywordTitle');
      remove.setAttribute('aria-label', t('removeKeywordLabel', keyword));
      remove.addEventListener('click', () => removeKeyword(keyword));

      item.append(label, remove);
      fragment.append(item);
    }
    els.keywordList.replaceChildren(fragment);
    els.keywordCount.textContent = String(settings.keywords.length);
    els.keywordEmpty.hidden = settings.keywords.length > 0;
    recentlyAdded = new Set();
  }

  function renderStatHint() {
    if (!settings.enabled) {
      els.statHint.textContent = t('statOff');
    } else if (!tabReachable) {
      els.statHint.textContent = t('statUnreachable');
    } else {
      els.statHint.textContent = t('statActive');
    }
  }

  function setCount(value) {
    els.hiddenCount.textContent = Number.isFinite(value) ? i18n.formatNumber(value) : '–';
  }

  /** Shows a message; with `fallbackKey` it reverts to that (translated) hint after a moment. */
  function showFeedback(element, text, kind, fallbackKey) {
    element.textContent = text;
    element.classList.toggle('hint--ok', kind === 'ok');
    element.classList.toggle('hint--error', kind === 'error');
    if (fallbackKey) {
      clearTimeout(feedbackTimer);
      feedbackTimer = setTimeout(() => showFeedback(element, t(fallbackKey), null), 3500);
    }
  }

  /* ---------------- Keywords ---------------- */

  function parseKeywords(raw) {
    return raw
      .split(/[,;\n]+/)
      .map(Config.normalizeKeyword)
      .filter(Boolean);
  }

  async function addKeywords(event) {
    event.preventDefault();
    const candidates = parseKeywords(els.keywordInput.value);
    if (candidates.length === 0) {
      showFeedback(els.keywordFeedback, t('keywordErrorEmpty'), 'error', 'keywordHint');
      return;
    }

    const existing = new Set(settings.keywords);
    const added = [];
    const rejected = [];
    for (const keyword of candidates) {
      if (keyword.length < Config.KEYWORD_MIN_LENGTH || keyword.length > Config.KEYWORD_MAX_LENGTH) {
        rejected.push(keyword);
      } else if (!existing.has(keyword)) {
        existing.add(keyword);
        added.push(keyword);
      }
    }

    if (added.length === 0) {
      const message = rejected.length
        ? t('keywordErrorLength', [Config.KEYWORD_MIN_LENGTH, Config.KEYWORD_MAX_LENGTH])
        : t('keywordErrorDuplicate');
      showFeedback(els.keywordFeedback, message, 'error', 'keywordHint');
      return;
    }

    recentlyAdded = new Set(added);
    await chrome.storage.local.set({ keywords: [...settings.keywords, ...added] });
    els.keywordInput.value = '';
    const sentences = [added.length === 1 ? t('keywordAddedOne', added[0]) : plural('keywordsAdded', added.length)];
    if (rejected.length) sentences.push(t('keywordsSkipped', i18n.formatNumber(rejected.length)));
    showFeedback(els.keywordFeedback, sentences.join(' '), 'ok', 'keywordHint');
  }

  async function removeKeyword(keyword) {
    await chrome.storage.local.set({ keywords: settings.keywords.filter((k) => k !== keyword) });
    showFeedback(els.keywordFeedback, t('keywordRemoved', keyword), 'ok', 'keywordHint');
  }

  async function restoreDefaults() {
    const existing = new Set(settings.keywords);
    const missing = Config.DEFAULT_KEYWORDS.map(Config.normalizeKeyword).filter((k) => !existing.has(k));
    if (missing.length === 0) {
      showFeedback(els.keywordFeedback, t('defaultsAllPresent'), 'ok', 'keywordHint');
      return;
    }
    recentlyAdded = new Set(missing);
    await chrome.storage.local.set({ keywords: [...settings.keywords, ...missing] });
    showFeedback(els.keywordFeedback, plural('defaultsRestored', missing.length), 'ok', 'keywordHint');
  }

  /* ---------------- Local AI model ---------------- */

  async function saveEndpoint() {
    const value = els.aiEndpoint.value.trim();
    if (!Config.isValidEndpoint(value)) {
      els.aiEndpoint.classList.add('input--invalid');
      showFeedback(els.aiStatus, t('aiErrorInvalidUrl', Config.DEFAULT_ENDPOINTS[settings.aiProtocol]), 'error');
      return false;
    }
    els.aiEndpoint.classList.remove('input--invalid');
    if (value !== settings.aiEndpoint) {
      await chrome.storage.local.set({ aiEndpoint: value });
      showFeedback(els.aiStatus, t('aiEndpointSaved'), 'ok', 'aiHint');
    }
    return true;
  }

  /**
   * Switching the protocol also swaps the endpoint when it is still the other protocol's
   * default (a custom address is kept).
   */
  async function saveProtocol() {
    const protocol = els.aiProtocol.value;
    if (!Config.isSupportedProtocol(protocol) || protocol === settings.aiProtocol) return;
    const update = { aiProtocol: protocol };
    if (Object.values(Config.DEFAULT_ENDPOINTS).includes(settings.aiEndpoint)) {
      update.aiEndpoint = Config.DEFAULT_ENDPOINTS[protocol];
    }
    els.aiEndpoint.classList.remove('input--invalid');
    await chrome.storage.local.set(update);
    showFeedback(els.aiStatus, t('aiProtocolSaved'), 'ok', 'aiHint');
  }

  /** Translates a { code, detail } error from the service worker (messages "aiError_<code>"). */
  function describeAiError(error) {
    if (!error) return t('aiError_noResponse');
    const key = `aiError_${error.code}`;
    if (!i18n.has(key)) return t('aiError_unknown', error.detail || error.code || '?');
    return t(key, error.detail == null ? [] : error.detail);
  }

  async function testEndpoint() {
    if (!(await saveEndpoint())) return;
    els.aiTest.disabled = true;
    showFeedback(els.aiStatus, t('aiConnecting'), null);
    try {
      const response = await chrome.runtime.sendMessage({ type: Config.MSG.CLASSIFY, text: t('aiTestText') });
      if (response && response.ok) {
        const { hide, category } = response.data;
        const categoryKey = category ? `category_${category}` : '';
        const reason = categoryKey && i18n.has(categoryKey) ? t(categoryKey) : response.data.reason;
        const message = reason ? t('aiConnectedWithReason', [hide, reason]) : t('aiConnected', hide);
        showFeedback(els.aiStatus, message, 'ok');
      } else {
        showFeedback(els.aiStatus, t('aiConnectionFailed', describeAiError(response && response.error)), 'error');
      }
    } catch (err) {
      const error = t('aiError_unknown', err.message);
      showFeedback(els.aiStatus, t('aiConnectionFailed', error), 'error');
    } finally {
      els.aiTest.disabled = false;
    }
  }

  /* ---------------- Current tab ---------------- */

  async function refreshStats() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      activeTabId = tab ? tab.id : null;
      if (activeTabId == null) throw new Error('no active tab');
      const response = await chrome.tabs.sendMessage(activeTabId, { type: Config.MSG.GET_STATS });
      tabReachable = Boolean(response);
      setCount(response ? response.hidden : NaN);
    } catch (_) {
      tabReachable = false;
      setCount(NaN);
    }
    renderStatHint();
  }

  /* ---------------- Events ---------------- */

  function bind() {
    els.enabled.addEventListener('change', () => {
      chrome.storage.local.set({ enabled: els.enabled.checked });
    });
    els.keywordForm.addEventListener('submit', addKeywords);
    els.restoreDefaults.addEventListener('click', restoreDefaults);
    els.aiEnabled.addEventListener('change', () => {
      chrome.storage.local.set({ aiEnabled: els.aiEnabled.checked });
    });
    els.aiProtocol.addEventListener('change', saveProtocol);
    els.aiEndpoint.addEventListener('change', saveEndpoint);
    els.aiEndpoint.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        saveEndpoint();
      }
    });
    els.aiEndpoint.addEventListener('input', () => els.aiEndpoint.classList.remove('input--invalid'));
    els.aiTest.addEventListener('click', testEndpoint);
    els.language.addEventListener('change', () => {
      if (Config.isSupportedLanguage(els.language.value)) {
        chrome.storage.local.set({ language: els.language.value });
      }
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const keys = Object.keys(Config.DEFAULT_SETTINGS).filter((key) => key in changes);
      if (keys.length === 0) return;
      const next = Object.assign({}, settings);
      for (const key of keys) next[key] = changes[key].newValue;
      const previousLanguage = settings.language;
      settings = Config.sanitize(next);
      if (settings.language !== previousLanguage) {
        applyLanguage(settings.language).catch((err) => console.error('[ParaBene]', err));
      } else {
        render();
      }
      if (keys.includes('enabled')) setTimeout(refreshStats, 400);
    });

    chrome.runtime.onMessage.addListener((message, sender) => {
      if (!message || message.type !== Config.MSG.STATS) return false;
      if (sender.tab && sender.tab.id === activeTabId) {
        tabReachable = true;
        setCount(message.hidden);
        renderStatHint();
      }
      return false;
    });
  }

  async function init() {
    els.version.textContent = `v${chrome.runtime.getManifest().version}`;
    bind();
    settings = await Config.load();
    await applyLanguage(settings.language);
    document.documentElement.classList.remove('i18n-pending');
    await refreshStats();
  }

  init().catch((err) => {
    console.error('[ParaBene]', err);
    I18n.localize(document, i18n);
    els.statHint.textContent = t('loadError');
    document.documentElement.classList.remove('i18n-pending');
  });
})();
