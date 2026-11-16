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
    statSplit: document.getElementById('stat-split'),
    statKeyword: document.getElementById('stat-keyword'),
    statAiText: document.getElementById('stat-ai-text'),
    statAiImage: document.getElementById('stat-ai-image'),
    statPassedItem: document.getElementById('stat-passed-item'),
    statPassed: document.getElementById('stat-passed'),
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
    aiMode: document.getElementById('ai-mode'),
    aiImagesEnabled: document.getElementById('ai-images-enabled'),
    aiImagesSettings: document.getElementById('ai-images-settings'),
    aiImagesEndpoint: document.getElementById('ai-images-endpoint'),
    aiImagesTest: document.getElementById('ai-images-test'),
    aiImagesStatus: document.getElementById('ai-images-status'),
    basalSettings: document.getElementById('basal-settings'),
    aiSensitivity: document.getElementById('ai-sensitivity'),
    aiTopics: [...document.querySelectorAll('#ai-topics input[type="checkbox"]')],
    aiTopicsEmpty: document.getElementById('ai-topics-empty'),
    learnEnabled: document.getElementById('learn-enabled'),
    learnSettings: document.getElementById('learn-settings'),
    learnSimilarity: document.getElementById('learn-similarity'),
    learnCount: document.getElementById('learn-count'),
    learnStatus: document.getElementById('learn-status'),
    learnList: document.getElementById('learn-list'),
    learnClear: document.getElementById('learn-clear'),
    logEnabled: document.getElementById('log-enabled'),
    logCount: document.getElementById('log-count'),
    logStatus: document.getElementById('log-status'),
    logDownload: document.getElementById('log-download'),
    logClear: document.getElementById('log-clear'),
    version: document.getElementById('version'),
    language: document.getElementById('language'),
  };

  let settings = Config.sanitize({});
  let activeTabId = null;
  let tabReachable = false;
  /** Hint element → the timer that puts its standing hint back. */
  const feedbackTimers = new Map();
  let recentlyAdded = new Set();
  let stats = null;
  let logEntries = [];
  let clearArmedTimer = 0;
  let learnedEntries = [];
  let pendingCount = 0;
  let learnClearArmedTimer = 0;

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
    for (const hint of [els.keywordFeedback, els.aiStatus, els.aiImagesStatus]) {
      clearTimeout(feedbackTimers.get(hint));
      feedbackTimers.delete(hint);
      hint.classList.remove('hint--ok', 'hint--error');
    }
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
    els.aiMode.value = settings.aiMode;
    els.aiImagesEnabled.checked = settings.aiImagesEnabled;
    els.aiImagesSettings.classList.toggle('ai--inactive', !settings.aiImagesEnabled);
    if (document.activeElement !== els.aiImagesEndpoint) els.aiImagesEndpoint.value = settings.aiImagesEndpoint;
    // Sensitivity and topics apply to basal-serve text evaluation and to image evaluation.
    const basalText = settings.aiProtocol === 'basal';
    els.basalSettings.hidden = !basalText && !settings.aiImagesEnabled;
    els.basalSettings.classList.toggle(
      'ai--inactive',
      !(basalText && settings.aiEnabled) && !settings.aiImagesEnabled
    );
    els.aiSensitivity.value = settings.aiSensitivity;
    for (const box of els.aiTopics) box.checked = settings.aiTopics.includes(box.value);
    els.aiTopicsEmpty.hidden = settings.aiTopics.length > 0;

    els.logEnabled.checked = settings.logEnabled;
    els.learnEnabled.checked = settings.learnEnabled;
    els.learnSettings.classList.toggle('ai--inactive', !settings.learnEnabled);
    els.learnSimilarity.value = settings.learnSimilarity;

    renderLanguagePicker();
    renderKeywords();
    renderStatHint();
    renderStats();
    renderLog();
    renderLearned();
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

  /** `value`: {hidden, bySource: {keyword, aiText, aiImage}} from the content script, or null when unknown. */
  function setStats(value) {
    stats = value && Number.isFinite(value.hidden) ? value : null;
    renderStats();
  }

  function renderStats() {
    els.hiddenCount.textContent = stats ? i18n.formatNumber(stats.hidden) : '–';
    const bySource = stats && stats.bySource;
    const passed = (stats && stats.passed) || 0;
    els.statSplit.hidden = !bySource || (stats.hidden === 0 && passed === 0);
    els.statPassedItem.hidden = passed === 0;
    els.statPassed.textContent = i18n.formatNumber(passed);
    if (bySource) {
      els.statKeyword.textContent = i18n.formatNumber(bySource.keyword || 0);
      els.statAiText.textContent = i18n.formatNumber(bySource.aiText || 0);
      els.statAiImage.textContent = i18n.formatNumber(bySource.aiImage || 0);
    }
  }

  /**
   * Shows a message; with `fallbackKey` it reverts to that (translated) hint after a moment.
   * Every hint has its own timer, and a new message cancels the pending revert of the one it
   * replaces (a test result must not be wiped by the revert of "address saved").
   */
  function showFeedback(element, text, kind, fallbackKey) {
    clearTimeout(feedbackTimers.get(element));
    feedbackTimers.delete(element);
    element.textContent = text;
    element.classList.toggle('hint--ok', kind === 'ok');
    element.classList.toggle('hint--error', kind === 'error');
    if (fallbackKey) {
      feedbackTimers.set(element, setTimeout(() => showFeedback(element, t(fallbackKey), null), 3500));
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

  /* ---------------- Image evaluation ---------------- */

  async function saveImagesEndpoint() {
    const value = els.aiImagesEndpoint.value.trim();
    if (!Config.isValidEndpoint(value)) {
      els.aiImagesEndpoint.classList.add('input--invalid');
      showFeedback(els.aiImagesStatus, t('aiErrorInvalidUrl', Config.DEFAULT_IMAGE_ENDPOINT), 'error');
      return false;
    }
    els.aiImagesEndpoint.classList.remove('input--invalid');
    if (value !== settings.aiImagesEndpoint) {
      await chrome.storage.local.set({ aiImagesEndpoint: value });
      showFeedback(els.aiImagesStatus, t('aiEndpointSaved'), 'ok', 'aiImagesHint');
    }
    return true;
  }

  async function testImagesEndpoint() {
    if (!(await saveImagesEndpoint())) return;
    els.aiImagesTest.disabled = true;
    showFeedback(els.aiImagesStatus, t('aiImagesConnecting'), null);
    try {
      const response = await chrome.runtime.sendMessage({ type: Config.MSG.TEST_IMAGES });
      if (response && response.ok) {
        const { model, ms, score, threshold } = response.data;
        const seconds = i18n.formatNumber(Math.round(ms / 100) / 10);
        const sentences = [t('aiImagesConnected', [model || '?', seconds])];
        if (typeof score === 'number' && typeof threshold === 'number') {
          sentences.push(t('aiScore', [i18n.formatNumber(score), i18n.formatNumber(threshold)]));
        }
        showFeedback(els.aiImagesStatus, sentences.join(' '), 'ok');
      } else {
        const error = describeAiError(response && response.error);
        showFeedback(els.aiImagesStatus, t('aiImagesConnectionFailed', error), 'error');
      }
    } catch (err) {
      showFeedback(els.aiImagesStatus, t('aiImagesConnectionFailed', t('aiError_unknown', err.message)), 'error');
    } finally {
      els.aiImagesTest.disabled = false;
    }
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
      const response = await chrome.runtime.sendMessage({ type: Config.MSG.CLASSIFY, text: t('aiTestText'), test: true });
      if (response && response.ok) {
        const { hide, category } = response.data;
        const categoryKey = category ? `category_${category}` : '';
        const reason = categoryKey && i18n.has(categoryKey) ? t(categoryKey) : response.data.reason;
        const sentences = [reason ? t('aiConnectedWithReason', [hide, reason]) : t('aiConnected', hide)];
        const { score, threshold } = response.data;
        if (typeof score === 'number' && typeof threshold === 'number') {
          sentences.push(t('aiScore', [i18n.formatNumber(score), i18n.formatNumber(threshold)]));
        }
        showFeedback(els.aiStatus, sentences.join(' '), 'ok');
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

  /* ---------------- Log of hidden content ---------------- */

  async function loadLog() {
    const stored = await chrome.storage.local.get(Config.LOG_STORAGE_KEY);
    setLogEntries(stored[Config.LOG_STORAGE_KEY]);
  }

  function setLogEntries(value) {
    logEntries = Array.isArray(value) ? value : [];
    renderLog();
  }

  function renderLog() {
    const total = logEntries.length;
    els.logCount.textContent = i18n.formatNumber(total);
    els.logDownload.disabled = total === 0;
    els.logClear.disabled = total === 0;
    if (!clearArmedTimer) els.logClear.textContent = t('logClear');
    if (total === 0) {
      els.logStatus.textContent = t(settings.logEnabled ? 'logEmpty' : 'logOff');
      return;
    }
    const ai = logEntries.filter((entry) => entry.source === 'ai');
    const aiImage = ai.filter((entry) => entry.media === 'image').length;
    const revealed = logEntries.filter((entry) => entry.revealed).length;
    els.logStatus.textContent = t('logSummary', [
      i18n.formatNumber(total - ai.length),
      i18n.formatNumber(ai.length - aiImage),
      i18n.formatNumber(aiImage),
      i18n.formatNumber(revealed),
    ]);
  }

  /** JSON Lines: a header with the extension version and the settings, then one hidden item per line. */
  function buildLogFile() {
    const manifest = chrome.runtime.getManifest();
    const meta = {
      type: 'meta',
      extension: 'ParaBene',
      version: manifest.version,
      exportedAt: new Date().toISOString(),
      entries: logEntries.length,
      settings: {
        aiEnabled: settings.aiEnabled,
        aiProtocol: settings.aiProtocol,
        aiMode: settings.aiMode,
        aiSensitivity: settings.aiSensitivity,
        aiThreshold: Config.AI_SENSITIVITIES[settings.aiSensitivity],
        aiTopics: settings.aiTopics,
        aiImagesEnabled: settings.aiImagesEnabled,
        keywords: settings.keywords,
      },
    };
    const lines = [meta, ...logEntries.map((entry) => Object.assign({ type: 'hidden' }, entry))];
    return lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
  }

  function downloadLog() {
    if (logEntries.length === 0) return;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    const blob = new Blob([buildLogFile()], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `parabene-log-${stamp}.jsonl`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  /** The first click arms the button, a second one within a few seconds clears the log. */
  async function clearLog() {
    if (!clearArmedTimer) {
      els.logClear.textContent = t('logClearConfirm');
      clearArmedTimer = setTimeout(() => {
        clearArmedTimer = 0;
        renderLog();
      }, 4000);
      return;
    }
    clearTimeout(clearArmedTimer);
    clearArmedTimer = 0;
    // Through the service worker, which queues it after any log write in progress.
    await chrome.runtime.sendMessage({ type: Config.MSG.LOG_CLEAR });
  }

  /* ---------------- Learning from revealed content ---------------- */

  async function loadLearned() {
    const stored = await chrome.storage.local.get([Config.LEARN_STORAGE_KEY, Config.LEARN_PENDING_KEY]);
    learnedEntries = Array.isArray(stored[Config.LEARN_STORAGE_KEY]) ? stored[Config.LEARN_STORAGE_KEY] : [];
    pendingCount = countPending(stored[Config.LEARN_PENDING_KEY]);
  }

  function countPending(value) {
    return value && typeof value === 'object' ? Object.keys(value).length : 0;
  }

  /** The reason an example was hidden for, as in the bar: category name or the matched phrase. */
  function learnedReason(entry) {
    const key = entry.category ? `category_${entry.category}` : '';
    if (key && i18n.has(key)) return t(key);
    return entry.reason || t(entry.source === 'ai' ? 'reasonAiDefault' : 'reasonUnknown');
  }

  function learnedSourceLabel(entry) {
    if (entry.media === 'image') return t('learnSource_aiImage');
    return t(entry.source === 'ai' ? 'learnSource_aiText' : 'learnSource_keyword');
  }

  function learnedSnippet(entry) {
    if (entry.media === 'image') {
      let host = '?';
      try {
        host = new URL(entry.image).hostname;
      } catch (_) {
        /* stored addresses are http(s) URLs */
      }
      return t('learnImageItem', host);
    }
    const text = String(entry.text || '').replace(/\s+/g, ' ').trim();
    return text.length > 120 ? `${text.slice(0, 119)}…` : text;
  }

  function renderLearned() {
    const total = learnedEntries.length;
    els.learnCount.textContent = i18n.formatNumber(total);
    els.learnClear.disabled = total === 0;
    if (!learnClearArmedTimer) els.learnClear.textContent = t('learnClear');

    const sentences = [];
    if (!settings.learnEnabled) sentences.push(t('learnOff'));
    else sentences.push(total ? plural('learnSummary', total) : t('learnEmpty'));
    if (settings.learnEnabled && pendingCount > 0) sentences.push(plural('learnPendingSummary', pendingCount));
    els.learnStatus.textContent = sentences.join(' ');

    const fragment = document.createDocumentFragment();
    for (const entry of [...learnedEntries].reverse()) {
      const item = document.createElement('li');
      item.className = 'learned__item';
      if (entry.category === 'profanity') item.classList.add('learned__item--masked');

      const body = document.createElement('div');
      body.className = 'learned__body';
      const tag = document.createElement('span');
      const sourceClass = entry.media === 'image' ? 'source--image' : entry.source === 'ai' ? 'source--ai' : '';
      tag.className = `learned__tag source ${sourceClass}`.trim();
      tag.title = learnedSourceLabel(entry);
      tag.textContent = learnedReason(entry);
      const text = document.createElement('span');
      text.className = 'learned__text';
      const snippet = learnedSnippet(entry);
      text.textContent = snippet;
      text.title = entry.url || '';
      body.append(tag, text);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = t('learnRemoveTitle');
      remove.setAttribute('aria-label', t('learnRemoveLabel', snippet.slice(0, 60)));
      remove.addEventListener('click', () => forgetLearned([entry.id]));

      item.append(body, remove);
      fragment.append(item);
    }
    els.learnList.replaceChildren(fragment);
  }

  /** Removal goes through the service worker, which serialises all writes to the examples. */
  function forgetLearned(ids) {
    chrome.runtime.sendMessage({ type: Config.MSG.LEARN_FORGET, ids }).catch(() => {});
  }

  /** The first click arms the button, a second one within a few seconds forgets every example. */
  function clearLearned() {
    if (!learnClearArmedTimer) {
      els.learnClear.textContent = t('learnClearConfirm');
      learnClearArmedTimer = setTimeout(() => {
        learnClearArmedTimer = 0;
        renderLearned();
      }, 4000);
      return;
    }
    clearTimeout(learnClearArmedTimer);
    learnClearArmedTimer = 0;
    forgetLearned(learnedEntries.map((entry) => entry.id));
  }

  /* ---------------- Current tab ---------------- */

  async function refreshStats() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      activeTabId = tab ? tab.id : null;
      if (activeTabId == null) throw new Error('no active tab');
      const response = await chrome.tabs.sendMessage(activeTabId, { type: Config.MSG.GET_STATS });
      tabReachable = Boolean(response);
      setStats(response);
    } catch (_) {
      tabReachable = false;
      setStats(null);
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
    els.aiMode.addEventListener('change', () => {
      if (Config.isSupportedMode(els.aiMode.value)) chrome.storage.local.set({ aiMode: els.aiMode.value });
    });
    els.aiSensitivity.addEventListener('change', () => {
      if (Config.isSupportedSensitivity(els.aiSensitivity.value)) {
        chrome.storage.local.set({ aiSensitivity: els.aiSensitivity.value });
      }
    });
    for (const box of els.aiTopics) {
      box.addEventListener('change', () => {
        const topics = els.aiTopics.filter((item) => item.checked).map((item) => item.value);
        chrome.storage.local.set({ aiTopics: Config.sanitizeTopics(topics) });
      });
    }
    els.aiEndpoint.addEventListener('change', saveEndpoint);
    els.aiEndpoint.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        saveEndpoint();
      }
    });
    els.aiEndpoint.addEventListener('input', () => els.aiEndpoint.classList.remove('input--invalid'));
    els.aiTest.addEventListener('click', testEndpoint);
    els.aiImagesEnabled.addEventListener('change', () => {
      chrome.storage.local.set({ aiImagesEnabled: els.aiImagesEnabled.checked });
    });
    els.aiImagesEndpoint.addEventListener('change', saveImagesEndpoint);
    els.aiImagesEndpoint.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        saveImagesEndpoint();
      }
    });
    els.aiImagesEndpoint.addEventListener('input', () => els.aiImagesEndpoint.classList.remove('input--invalid'));
    els.aiImagesTest.addEventListener('click', testImagesEndpoint);
    els.logEnabled.addEventListener('change', () => {
      chrome.storage.local.set({ logEnabled: els.logEnabled.checked });
    });
    els.learnEnabled.addEventListener('change', () => {
      chrome.storage.local.set({ learnEnabled: els.learnEnabled.checked });
    });
    els.learnSimilarity.addEventListener('change', () => {
      if (Config.isSupportedSimilarity(els.learnSimilarity.value)) {
        chrome.storage.local.set({ learnSimilarity: els.learnSimilarity.value });
      }
    });
    els.learnClear.addEventListener('click', clearLearned);
    els.logDownload.addEventListener('click', downloadLog);
    els.logClear.addEventListener('click', clearLog);
    els.language.addEventListener('change', () => {
      if (Config.isSupportedLanguage(els.language.value)) {
        chrome.storage.local.set({ language: els.language.value });
      }
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (Config.LOG_STORAGE_KEY in changes) setLogEntries(changes[Config.LOG_STORAGE_KEY].newValue);
      if (Config.LEARN_STORAGE_KEY in changes || Config.LEARN_PENDING_KEY in changes) {
        if (Config.LEARN_STORAGE_KEY in changes) {
          const value = changes[Config.LEARN_STORAGE_KEY].newValue;
          learnedEntries = Array.isArray(value) ? value : [];
        }
        if (Config.LEARN_PENDING_KEY in changes) pendingCount = countPending(changes[Config.LEARN_PENDING_KEY].newValue);
        renderLearned();
      }
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
        setStats(message);
        renderStatHint();
      }
      return false;
    });
  }

  async function init() {
    els.version.textContent = `v${chrome.runtime.getManifest().version}`;
    bind();
    settings = await Config.load();
    await loadLog();
    await loadLearned();
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
