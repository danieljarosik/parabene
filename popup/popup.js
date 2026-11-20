/* ParaBene – control panel. */
(() => {
  'use strict';

  const Config = globalThis.ParaBeneConfig;
  const I18n = globalThis.ParaBeneI18n;
  const Backup = globalThis.ParaBeneBackup;
  const LogCard = globalThis.ParaBeneLogCard;
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
    siteForm: document.getElementById('site-form'),
    siteInput: document.getElementById('site-input'),
    siteFeedback: document.getElementById('site-feedback'),
    siteList: document.getElementById('site-list'),
    siteCount: document.getElementById('site-count'),
    siteEmpty: document.getElementById('site-empty'),
    excludeCurrentSite: document.getElementById('exclude-current-site'),
    sitesExport: document.getElementById('sites-export'),
    sitesImport: document.getElementById('sites-import'),
    keywordForm: document.getElementById('keyword-form'),
    keywordInput: document.getElementById('keyword-input'),
    keywordFeedback: document.getElementById('keyword-feedback'),
    keywordList: document.getElementById('keyword-list'),
    keywordCount: document.getElementById('keyword-count'),
    keywordEmpty: document.getElementById('keyword-empty'),
    restoreDefaults: document.getElementById('restore-defaults'),
    keywordsExport: document.getElementById('keywords-export'),
    keywordsImport: document.getElementById('keywords-import'),
    listImportPanel: document.getElementById('list-import-panel'),
    listImportSummary: document.getElementById('list-import-summary'),
    listImportMerge: document.getElementById('list-import-merge'),
    listImportReplace: document.getElementById('list-import-replace'),
    listImportCancel: document.getElementById('list-import-cancel'),
    aiEnabled: document.getElementById('ai-enabled'),
    aiSettings: document.getElementById('ai-settings'),
    aiProtocol: document.getElementById('ai-protocol'),
    aiEndpoint: document.getElementById('ai-endpoint'),
    aiEndpointLabel: document.getElementById('ai-endpoint-label'),
    aiModel: document.getElementById('ai-model'),
    aiModelSelect: document.getElementById('ai-model-select'),
    aiModelNote: document.getElementById('ai-model-note'),
    aiModelStatus: document.getElementById('ai-model-status'),
    aiModelProgress: document.getElementById('ai-model-progress'),
    aiModelDownload: document.getElementById('ai-model-download'),
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
    backupCard: document.getElementById('backup-card'),
    settingsExport: document.getElementById('settings-export'),
    settingsImport: document.getElementById('settings-import'),
    backupStatus: document.getElementById('backup-status'),
    settingsImportPanel: document.getElementById('settings-import-panel'),
    settingsImportSummary: document.getElementById('settings-import-summary'),
    settingsImportWarnings: document.getElementById('settings-import-warnings'),
    settingsImportApply: document.getElementById('settings-import-apply'),
    settingsImportCancel: document.getElementById('settings-import-cancel'),
    importWindow: document.getElementById('import-window'),
    importTitle: document.getElementById('import-title'),
    importDesc: document.getElementById('import-desc'),
    importDrop: document.getElementById('import-drop'),
    importChoose: document.getElementById('import-choose'),
    importStatus: document.getElementById('import-status'),
    importFile: document.getElementById('import-file'),
    version: document.getElementById('version'),
    language: document.getElementById('language'),
    advancedCard: document.getElementById('advanced-card'),
    sectionOrder: document.getElementById('section-order'),
    layoutReset: document.getElementById('layout-reset'),
    layoutStatus: document.getElementById('layout-status'),
    layoutError: document.getElementById('layout-error'),
    customUrl: document.getElementById('custom-model-url'),
    customCheck: document.getElementById('custom-model-check'),
    customInfo: document.getElementById('custom-model-info'),
    customConsentRow: document.getElementById('custom-model-consent-row'),
    customConsent: document.getElementById('custom-model-consent'),
    customStart: document.getElementById('custom-model-start'),
    customStatus: document.getElementById('custom-model-status'),
    customProgress: document.getElementById('custom-model-progress'),
    customResult: document.getElementById('custom-model-result'),
    customKeep: document.getElementById('custom-model-keep'),
    customDiscard: document.getElementById('custom-model-discard'),
  };

  /**
   * The collapsible cards by section id (Config.COLLAPSIBLE_SECTIONS): the card, its heading button,
   * its body ("<id>-body") and the message key of its title.
   */
  const sections = new Map(
    Config.COLLAPSIBLE_SECTIONS.map((id) => {
      const body = document.getElementById(`${id}-body`);
      const card = body.closest('.card');
      const toggle = card.querySelector('.card__toggle');
      return [id, { card, body, toggle, title: toggle.querySelector('[data-i18n]').getAttribute('data-i18n') }];
    })
  );

  let settings = Config.sanitize({});
  let activeTabId = null;
  let activeSite = '';
  let tabReachable = false;
  /** Hint element → the timer that puts its standing hint back. */
  const feedbackTimers = new Map();
  let recentlyAdded = new Set();
  let stats = null;
  /** The card of the log of evaluated content (popup/log-card.js). */
  let logCard = null;
  let learnedEntries = [];
  let pendingCount = 0;
  let learnClearArmedTimer = 0;
  /**
   * The file kind when this page is the import window (popup.html?import=…), '' in the
   * panel. Choosing a file takes the focus away from the toolbar popup and the browser closes it
   * (always on Linux), file and all, so the panel opens a small window for an import instead.
   */
  const IMPORT_KINDS = ['keywords', 'sites', 'settings'];
  const requestedImport = new URLSearchParams(location.search).get('import');
  const importKind = IMPORT_KINDS.includes(requestedImport) ? requestedImport : '';
  /** Closes the import window once the message of a finished import can be read. */
  let importCloseTimer = 0;
  /** A list file waiting for "Add new" / "Replace list". */
  let listImport = null;
  /** A read settings backup waiting for "Restore": the result of parseSettingsFile. */
  let settingsImport = null;

  /* ---------------- Internationalisation ---------------- */

  let i18n = I18n.createTranslator(Config.DEFAULT_LANGUAGE, null);
  let collator = new Intl.Collator(i18n.locale, { sensitivity: 'base' });
  let languageSeq = 0;
  /** The language the panel shows or is switching to (set before its messages have loaded). */
  let uiLanguage = null;
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
    uiLanguage = locale;
    const [messages, fallback] = await Promise.all([
      loadMessagesSafe(locale),
      locale === Config.DEFAULT_LANGUAGE ? null : loadMessagesSafe(Config.DEFAULT_LANGUAGE),
    ]);
    if (seq !== languageSeq) return;

    i18n = I18n.createTranslator(locale, messages, fallback);
    collator = new Intl.Collator(locale, { sensitivity: 'base' });
    for (const hint of [els.keywordFeedback, els.siteFeedback, els.aiStatus, els.aiImagesStatus, els.backupStatus, els.importStatus, els.layoutStatus]) {
      clearTimeout(feedbackTimers.get(hint));
      feedbackTimers.delete(hint);
      hint.classList.remove('hint--ok', 'hint--error');
    }
    // Unlike the other hints these have no text to translate again: a message in the old language goes.
    els.backupStatus.textContent = '';
    els.importStatus.textContent = '';
    els.layoutStatus.textContent = '';
    els.layoutError.hidden = true;
    I18n.localize(document, i18n);
    if (importKind) document.title = t('importWindowTitle', t(`importTitle_${importKind}`));
    render();
    if (lastModel && settings.aiProtocol === 'builtin') renderModel(lastModel); // its text is set by script
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
    // The built-in model has no server: no address to enter; the state of its file instead (refreshModel).
    const builtin = settings.aiProtocol === 'builtin';
    els.aiEndpoint.hidden = builtin;
    els.aiEndpointLabel.hidden = builtin;
    els.aiModel.hidden = !builtin;
    renderModelPicker();
    els.aiEndpoint.placeholder = Config.DEFAULT_ENDPOINTS[settings.aiProtocol] || '';
    if (document.activeElement !== els.aiEndpoint) els.aiEndpoint.value = settings.aiEndpoint;
    els.aiMode.value = settings.aiMode;
    els.aiImagesEnabled.checked = settings.aiImagesEnabled;
    els.aiImagesSettings.classList.toggle('ai--inactive', !settings.aiImagesEnabled);
    if (document.activeElement !== els.aiImagesEndpoint) els.aiImagesEndpoint.value = settings.aiImagesEndpoint;
    // Sensitivity and topics apply to basal text evaluation (a server or the built-in model) and to image evaluation.
    const basalText = Config.usesBasalQuestion(settings.aiProtocol);
    els.basalSettings.hidden = !basalText && !settings.aiImagesEnabled;
    els.basalSettings.classList.toggle(
      'ai--inactive',
      !(basalText && settings.aiEnabled) && !settings.aiImagesEnabled
    );
    els.aiSensitivity.value = settings.aiSensitivity;
    for (const box of els.aiTopics) box.checked = settings.aiTopics.includes(box.value);
    els.aiTopicsEmpty.hidden = settings.aiTopics.length > 0;

    els.logEnabled.checked = settings.evalLogEnabled;
    els.learnEnabled.checked = settings.learnEnabled;
    els.learnSettings.classList.toggle('ai--inactive', !settings.learnEnabled);
    els.learnSimilarity.value = settings.learnSimilarity;

    renderLanguagePicker();
    renderCustom();
    renderKeywords();
    renderSites();
    renderStatHint();
    renderStats();
    if (logCard) logCard.render(settings);
    renderLearned();
    renderListImport();
    renderSettingsImport();
    renderLayout();
  }

  /* ---------------- Layout: order of the cards, collapsed cards ---------------- */

  /** Puts the cards in the stored order and opens or collapses each one. */
  function renderLayout() {
    const current = [...els.app.querySelectorAll(':scope > [data-section]')].map((card) => card.dataset.section);
    if (current.join() !== settings.sectionOrder.join()) {
      // Moving a card takes the focus out of it (an order changed in another window): give it back.
      const focused = document.activeElement;
      for (const id of settings.sectionOrder) els.advancedCard.before(sections.get(id).card);
      if (focused && focused !== document.activeElement && focused.isConnected) focused.focus({ preventScroll: true });
    }
    for (const [id, { card, body, toggle }] of sections) {
      const collapsed = settings.collapsedSections.includes(id);
      card.classList.toggle('card--collapsed', collapsed);
      body.hidden = collapsed;
      toggle.setAttribute('aria-expanded', String(!collapsed));
    }
    renderSectionOrder();
  }

  /** The list under "Advanced" with a "move up" and a "move down" button for each card. */
  function renderSectionOrder() {
    const order = settings.sectionOrder;
    // The list is drawn anew: a focused button keeps the focus (or its neighbour, once disabled).
    const active = els.sectionOrder.contains(document.activeElement) ? document.activeElement : null;
    const items = order.map((id, index) => {
      const name = t(sections.get(id).title);
      const item = document.createElement('li');
      item.className = 'order__item';
      const position = document.createElement('span');
      position.className = 'order__position';
      position.setAttribute('aria-hidden', 'true');
      position.textContent = `${i18n.formatNumber(index + 1)}.`;
      const label = document.createElement('span');
      label.className = 'order__name';
      label.textContent = name;
      const up = moveButton(id, -1, name, index === 0);
      const down = moveButton(id, 1, name, index === order.length - 1);
      item.append(position, label, up, down);
      return item;
    });
    els.sectionOrder.replaceChildren(...items);
    if (active) {
      const buttons = [...els.sectionOrder.querySelectorAll('.order__move')].filter((button) => button.dataset.id === active.dataset.id);
      const target = buttons.find((button) => button.dataset.step === active.dataset.step && !button.disabled) ||
        buttons.find((button) => !button.disabled);
      if (target) target.focus();
    }
  }

  function moveButton(id, step, name, disabled) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'order__move';
    button.dataset.id = id;
    button.dataset.step = String(step);
    button.disabled = disabled;
    button.textContent = step < 0 ? '↑' : '↓';
    button.title = t(step < 0 ? 'sectionMoveUp' : 'sectionMoveDown');
    button.setAttribute('aria-label', t(step < 0 ? 'sectionMoveUpLabel' : 'sectionMoveDownLabel', name));
    return button;
  }

  /** Applies a layout change at once and stores it (the storage listener then only redraws the layout). */
  function saveLayout(change) {
    settings = Config.sanitize(Object.assign({}, settings, change));
    renderLayout();
    const stored = {};
    for (const key of Object.keys(change)) stored[key] = settings[key];
    chrome.storage.local.set(stored).then(() => { els.layoutError.hidden = true; }, restoreLayout);
  }

  /**
   * A layout change that could not be stored (e.g. the storage is full): the panel goes back to the
   * stored layout, so it does not show one that the next opening would not, and says so — under
   * "Advanced" and, while that card is collapsed, above the cards.
   */
  async function restoreLayout(err) {
    console.error('[ParaBene]', err);
    try {
      const stored = Config.sanitize(await chrome.storage.local.get(Config.PANEL_SETTINGS));
      const layout = {};
      for (const key of Config.PANEL_SETTINGS) layout[key] = stored[key];
      settings = Config.sanitize(Object.assign({}, settings, layout));
      renderLayout();
    } catch (readErr) {
      console.error('[ParaBene]', readErr);
    }
    const message = t('layoutSaveFailed');
    showFeedback(els.layoutStatus, message, 'error');
    els.layoutError.textContent = message;
    els.layoutError.hidden = !settings.collapsedSections.includes('advanced');
  }

  function moveSection(id, step) {
    const order = [...settings.sectionOrder];
    const from = order.indexOf(id);
    const to = from + step;
    if (from < 0 || to < 0 || to >= order.length) return;
    order.splice(to, 0, ...order.splice(from, 1));
    saveLayout({ sectionOrder: order });
    showFeedback(els.layoutStatus, t('sectionMoved', [t(sections.get(id).title), i18n.formatNumber(to + 1), i18n.formatNumber(order.length)]), null);
  }

  function toggleSection(id) {
    const collapsed = settings.collapsedSections;
    saveLayout({ collapsedSections: collapsed.includes(id) ? collapsed.filter((other) => other !== id) : [...collapsed, id] });
  }

  /**
   * The default order with every card of the list open. "Advanced" itself stays as it is: the
   * button and its status line are inside it (the texts say that the reset concerns the list).
   */
  function resetLayout() {
    const collapsed = settings.collapsedSections.filter((id) => !Config.PANEL_SECTIONS.includes(id));
    const unchanged = settings.sectionOrder.join() === Config.PANEL_SECTIONS.join() &&
      collapsed.length === settings.collapsedSections.length;
    if (unchanged) {
      showFeedback(els.layoutStatus, t('layoutAlreadyDefault'), null);
      return;
    }
    saveLayout({ sectionOrder: [...Config.PANEL_SECTIONS], collapsedSections: collapsed });
    showFeedback(els.layoutStatus, t('layoutResetDone'), 'ok');
  }

  function renderChips(list, values, { masked, added, removeTitle, removeLabel, onRemove }) {
    const sorted = [...values].sort(collator.compare);
    const fragment = document.createDocumentFragment();
    for (const value of sorted) {
      const item = document.createElement('li');
      item.className = 'chip';
      if (masked?.has(value)) item.classList.add('chip--masked');
      if (added?.has(value)) item.classList.add('chip--new');

      const label = document.createElement('span');
      label.className = 'chip__label';
      label.textContent = value;

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = t(removeTitle);
      remove.setAttribute('aria-label', t(removeLabel, value));
      remove.addEventListener('click', () => onRemove(value));

      item.append(label, remove);
      fragment.append(item);
    }
    list.replaceChildren(fragment);
  }

  function renderKeywords() {
    renderChips(els.keywordList, settings.keywords, {
      masked: profanity,
      added: recentlyAdded,
      removeTitle: 'removeKeywordTitle',
      removeLabel: 'removeKeywordLabel',
      onRemove: removeKeyword,
    });
    els.keywordCount.textContent = String(settings.keywords.length);
    els.keywordEmpty.hidden = settings.keywords.length > 0;
    // A file without phrases could not be imported back.
    els.keywordsExport.disabled = settings.keywords.length === 0;
    recentlyAdded = new Set();
  }

  function renderSites() {
    const { excludedSites } = settings;
    renderChips(els.siteList, excludedSites, {
      removeTitle: 'removeSiteTitle',
      removeLabel: 'removeSiteLabel',
      onRemove: (site) => changeExcludedSites((current) => current.filter((entry) => entry !== site)).catch(reportSiteError),
    });
    els.siteCount.textContent = i18n.formatNumber(excludedSites.length);
    els.siteEmpty.hidden = excludedSites.length > 0;
    els.sitesExport.disabled = excludedSites.length === 0;
    renderCurrentSiteAction();
  }

  function renderCurrentSiteAction() {
    els.excludeCurrentSite.hidden = !activeSite || Config.isSiteExcluded(settings.excludedSites, activeSite);
  }

  function renderStatHint() {
    if (!settings.enabled) {
      els.statHint.textContent = t('statOff');
    } else if (Config.isSiteExcluded(settings.excludedSites, activeSite)) {
      els.statHint.textContent = t('statSiteExcluded');
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
    if (Config.isSiteExcluded(settings.excludedSites, activeSite)) {
      els.hiddenCount.textContent = i18n.formatNumber(0);
      els.statSplit.hidden = true;
      return;
    }
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

  /* ---------------- Excluded sites ---------------- */

  const SITES_LOCK = 'parabene:excludedSites';

  /** The toolbar and the import window can edit the list at the same time. */
  function changeExcludedSites(change) {
    return navigator.locks.request(SITES_LOCK, async () => {
      const stored = await chrome.storage.local.get('excludedSites');
      const { excludedSites } = Config.sanitize(stored);
      const next = change(excludedSites);
      if (next === excludedSites) return false;
      await chrome.storage.local.set({ excludedSites: next });
      return true;
    });
  }

  function reportSiteError(err) {
    console.error('[ParaBene]', err);
    showFeedback(els.siteFeedback, t('sitesSaveFailed'), 'error', 'sitesHint');
  }

  async function addSite(value, fromCurrentTab) {
    const site = Config.normalizeSite(value);
    if (!site) {
      showFeedback(els.siteFeedback, t('siteInvalid'), 'error', 'sitesHint');
      return;
    }
    const added = await changeExcludedSites((current) => {
      const alreadyExcluded = fromCurrentTab ? Config.isSiteExcluded(current, site) : current.includes(site);
      return alreadyExcluded ? current : [...current, site];
    });
    if (added && !fromCurrentTab && els.siteInput.value === value) els.siteInput.value = '';
    showFeedback(els.siteFeedback, t(added ? 'siteAdded' : 'siteDuplicate', site), added ? 'ok' : 'error', 'sitesHint');
  }

  /* ---------------- Local AI model ---------------- */

  async function saveEndpoint() {
    if (settings.aiProtocol === 'builtin') return true; // no endpoint to save
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
    const fallback = Config.DEFAULT_ENDPOINTS[protocol]; // none for the built-in model
    if (fallback && Object.values(Config.DEFAULT_ENDPOINTS).includes(settings.aiEndpoint)) {
      update.aiEndpoint = fallback;
    }
    els.aiEndpoint.classList.remove('input--invalid');
    await chrome.storage.local.set(update);
    showFeedback(els.aiStatus, t('aiProtocolSaved'), 'ok', 'aiHint');
  }

  /* ---------------- Built-in model: its file ---------------- */

  let modelTimer = null;
  let modelSeq = 0;
  /** The last state the service worker gave, kept to show it again in another language. */
  let lastModel = null;

  /** A file size in gigabytes, in the UI language (1.2 / 1,2). */
  function gigabytes(bytes) {
    return i18n.formatNumber(Math.round(bytes / 1e8) / 10);
  }

  /** The other basal version the user kept ("Advanced"), as a model entry, or null. */
  function keptCustomModel() {
    return customRecord && customRecord.state === 'kept' ? Config.customModel(customRecord.url, customRecord.bytes) : null;
  }

  /** The model `aiModel` stands for (as the service worker resolves it). */
  function chosenModel() {
    const kept = keptCustomModel();
    return settings.aiModel === Config.CUSTOM_MODEL_ID && kept ? kept : Config.builtinModel(settings.aiModel);
  }

  /** The list of built-in models with their sizes (and a kept other version), the chosen one and the hint about it. */
  function renderModelPicker() {
    const chosen = chosenModel();
    const kept = keptCustomModel();
    els.aiModelSelect.replaceChildren(
      ...(kept ? [...Config.BUILTIN_MODELS, kept] : Config.BUILTIN_MODELS).map((model) => {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = t(model.custom ? 'aiModelOptionCustom' : 'aiModelOption', [model.name, gigabytes(model.bytes)]);
        return option;
      })
    );
    els.aiModelSelect.value = chosen.id;
    els.aiModelNote.textContent = t(chosen.note);
    els.aiModelDownload.textContent = t('aiModelDownload', gigabytes(chosen.bytes));
  }

  async function saveModel() {
    const id = els.aiModelSelect.value;
    const allowed = Config.isBuiltinModel(id) || (id === Config.CUSTOM_MODEL_ID && keptCustomModel());
    if (!allowed || id === settings.aiModel) return;
    await chrome.storage.local.set({ aiModel: id }); // the storage listener renders and asks for the new model's state
  }

  /**
   * Shows whether the chosen model's file is stored, and the "Download model" button while it is
   * not: the built-in model is used only after the user has downloaded the file with that button.
   * While a download or a load runs, the state is asked again every second.
   */
  async function refreshModel() {
    clearTimeout(modelTimer);
    // The import window does not show the model card.
    if (importKind || settings.aiProtocol !== 'builtin') return;
    const seq = ++modelSeq;
    let model;
    try {
      const response = await chrome.runtime.sendMessage({ type: Config.MSG.MODEL_STATUS });
      model = response && response.ok ? response.data : { status: 'error', error: response && response.error };
    } catch (err) {
      model = { status: 'error', error: { code: 'unknown', detail: err.message } };
    }
    // Changed while waiting: a newer request, another format or another model.
    if (seq !== modelSeq || settings.aiProtocol !== 'builtin') return;
    if (model.model && model.model !== chosenModel().id) return;
    lastModel = model;
    renderModel(model);
    if (model.status === 'downloading' || model.status === 'loading') modelTimer = setTimeout(refreshModel, 1000);
  }

  function renderModel({ status, progress, error, stored }) {
    const percent = Math.floor((progress || 0) * 100);
    const downloading = status === 'downloading';
    if (status === 'trial') showFeedback(els.aiModelStatus, t('aiModelTrial'), null);
    else if (status === 'missing') showFeedback(els.aiModelStatus, t('aiModelMissing'), null);
    else if (downloading) showFeedback(els.aiModelStatus, t('aiModelDownloading', String(percent)), null);
    else if (status === 'loading') showFeedback(els.aiModelStatus, t('aiModelLoading'), null);
    else if (status === 'error' && stored) showFeedback(els.aiModelStatus, t('aiModelStoredFailed', describeAiError(error)), 'error');
    else if (status === 'error') showFeedback(els.aiModelStatus, t('aiModelFailed', describeAiError(error)), 'error');
    else showFeedback(els.aiModelStatus, t('aiModelStored'), 'ok');
    els.aiModelProgress.hidden = !downloading;
    els.aiModelProgress.value = percent;
    // A stored file that fails to load is not downloaded again: there is nothing to download.
    els.aiModelDownload.hidden = !(status === 'missing' || (status === 'error' && !stored));
    els.aiModelDownload.disabled = false;
  }

  async function downloadModel() {
    els.aiModelDownload.disabled = true;
    try {
      await chrome.runtime.sendMessage({ type: Config.MSG.MODEL_DOWNLOAD });
    } catch (_) {
      /* refreshModel shows what happened */
    }
    await refreshModel();
  }

  /* ---------------- Advanced: another basal version ---------------- */

  /** The slot as the service worker last gave it ({ url, name, bytes, state, … } or null), and the live trial state. */
  let customRecord = null;
  let customLive = null;
  /** The last checked address: { url, name, bytes, level }; an error of the last action: { code, detail }. */
  let customInfo = null;
  let customError = null;
  let customUrlTouched = false;
  let customLoaded = false;
  let customTimer = null;
  let customSeq = 0;
  /** The service worker's clock minus this page's (both are this computer's: normally 0). */
  let clockOffset = 0;

  /** Asks the service worker for the slot; while a trial runs, again every second (progress, time left). */
  async function refreshCustom() {
    clearTimeout(customTimer);
    if (importKind) return;
    const seq = ++customSeq;
    let response = null;
    try {
      response = await chrome.runtime.sendMessage({ type: Config.MSG.CUSTOM_STATUS });
    } catch (_) {
      /* shown as no slot; asked again on the next change */
    }
    if (seq !== customSeq) return;
    if (response && response.ok) {
      customRecord = response.data.custom;
      customLive = response.data.live;
      clockOffset = response.data.now - Date.now();
      customLoaded = true;
    }
    renderModelPicker();
    renderCustom();
    if (customRecord && customRecord.state === 'trial') customTimer = setTimeout(refreshCustom, 1000);
  }

  function seconds(ms) {
    return i18n.formatNumber(Math.round(ms / 100) / 10);
  }

  /** m:ss */
  function clock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  /** An error of the service worker about the other version (messages "customError_<code>", else "aiError_<code>"). */
  function describeCustomError(error) {
    if (error && error.code === 'customTooLarge') {
      return t('customError_customTooLarge', [gigabytes(Number(error.detail) || 0), gigabytes(Config.CUSTOM_MAX_BYTES)]);
    }
    const key = error ? `customError_${error.code}` : '';
    if (key && i18n.has(key)) return t(key, error.detail == null ? [] : String(error.detail));
    return describeAiError(error);
  }

  /** What the self-test found, as sentences. */
  function describeTest(test) {
    if (!test) return '';
    if (test.error) return t('customTestError', describeCustomError(test.error));
    const sentences = [];
    if (Number.isFinite(test.slowest)) {
      if (test.slowest > Config.CUSTOM_TEST_MAX_MS) {
        sentences.push(t('customTestTooSlow', [seconds(test.slowest), seconds(Config.CUSTOM_TEST_MAX_MS)]));
      } else {
        sentences.push(t('customTestTime', seconds(test.slowest)));
        if (test.slow) sentences.push(t('customTestSlow'));
      }
    }
    if (Number.isFinite(test.expected) && Number.isFinite(test.total)) {
      sentences.push(t(test.expected === test.total ? 'customTestVerdictsOk' : 'customTestVerdictsOff', [String(test.expected), String(test.total)]));
    }
    return sentences.join(' ');
  }

  function renderCustom() {
    if (!customLoaded) return;
    const record = customRecord;
    const trial = Boolean(record && record.state === 'trial');
    const builtin = settings.aiProtocol === 'builtin';
    // The field starts with the slot's address or, as an example to change, the default model's.
    if (!customUrlTouched && document.activeElement !== els.customUrl) {
      els.customUrl.value = record ? record.url : Config.builtinModel(Config.DEFAULT_BUILTIN_MODEL).url;
    }
    els.customUrl.disabled = trial;
    els.customCheck.disabled = trial;

    // The checked address (only while the field still holds it), or the last error.
    const info = customInfo && customInfo.url === els.customUrl.value.trim() ? customInfo : null;
    if (customError) showFeedback(els.customInfo, describeCustomError(customError), 'error');
    else if (!builtin && !trial) showFeedback(els.customInfo, t('customNeedsBuiltin'), null);
    else if (info) {
      const size = gigabytes(info.bytes);
      if (info.level === 'tooLarge') {
        showFeedback(els.customInfo, t('customInfoTooLarge', [info.name, size, gigabytes(Config.CUSTOM_MAX_BYTES)]), 'error');
      } else if (info.level === 'large') {
        showFeedback(els.customInfo, t('customInfoLarge', [info.name, size, gigabytes(Config.CUSTOM_WARN_BYTES)]), 'error');
      } else {
        showFeedback(els.customInfo, t('customInfoOk', [info.name, size]), 'ok');
      }
    } else {
      showFeedback(els.customInfo, '', null);
    }
    const startable = Boolean(info) && info.level !== 'tooLarge' && builtin && !trial;
    els.customConsentRow.hidden = !(startable && info.level === 'large');
    if (els.customConsentRow.hidden) els.customConsent.checked = false;
    els.customStart.hidden = !startable;
    els.customStart.disabled = info && info.level === 'large' && !els.customConsent.checked;
    if (info) els.customStart.textContent = t('customStart', gigabytes(info.bytes));

    // The slot.
    let status = '';
    let kind = null;
    let result = '';
    let downloading = false;
    let percent = 0;
    els.customKeep.hidden = true;
    els.customDiscard.hidden = !record;
    if (record && trial && record.phase === 'tested') {
      status = t('customTested', record.name);
      kind = 'ok';
      result = describeTest(record.test);
      els.customKeep.hidden = false;
      els.customKeep.textContent = t('customKeep', clock(record.deadline - (Date.now() + clockOffset)));
      els.customDiscard.textContent = t('customReject');
    } else if (record && trial) {
      const live = customLive || { status: 'downloading', progress: 0 };
      percent = Math.floor((live.progress || 0) * 100);
      downloading = live.status === 'downloading';
      if (downloading) status = t('customDownloading', [record.name, String(percent)]);
      else if (live.status === 'loading') status = t('customLoading', record.name);
      else status = t('customTesting', record.name);
      result = t('customTrialHint');
      els.customDiscard.textContent = t('customCancel');
    } else if (record && record.state === 'kept') {
      status = t('customKept', [record.name, gigabytes(record.bytes)]);
      kind = 'ok';
      result = [record.reverted ? t('customReverted') : '', describeTest(record.test)].filter(Boolean).join(' ');
      els.customDiscard.textContent = t('customRemove');
    } else if (record) {
      const reasonKey = `customRejected_${record.reason}`;
      status = i18n.has(reasonKey) ? t(reasonKey, record.name) : t('customRejected_testFailed', record.name);
      kind = 'error';
      result = record.error ? describeCustomError(record.error) : describeTest(record.test);
      els.customDiscard.textContent = t('customDismiss');
    }
    showFeedback(els.customStatus, status, kind);
    els.customResult.textContent = result;
    els.customProgress.hidden = !downloading;
    els.customProgress.value = percent;
  }

  async function sendCustom(type, extra) {
    try {
      const response = await chrome.runtime.sendMessage(Object.assign({ type }, extra));
      return response || { ok: false, error: { code: 'noResponse' } };
    } catch (err) {
      return { ok: false, error: { code: 'unknown', detail: err.message } };
    }
  }

  /** "Check": the address and the size of its file (asked from Hugging Face by the service worker). */
  async function checkCustom() {
    const url = els.customUrl.value.trim();
    customInfo = null;
    customError = null;
    if (!Config.parseCustomModelUrl(url)) {
      customError = { code: 'customInvalidUrl' };
      renderCustom();
      return;
    }
    els.customCheck.disabled = true;
    showFeedback(els.customInfo, t('customChecking'), null);
    const response = await sendCustom(Config.MSG.CUSTOM_CHECK, { url });
    els.customCheck.disabled = false;
    if (response.ok) customInfo = response.data;
    else customError = response.error;
    renderCustom();
  }

  /** "Download and test": the service worker checks again and starts the trial. */
  async function startCustom() {
    if (!customInfo) return;
    els.customStart.disabled = true;
    customError = null;
    const response = await sendCustom(Config.MSG.CUSTOM_START, { url: customInfo.url, accepted: els.customConsent.checked });
    if (response.ok) {
      customInfo = null;
      customUrlTouched = false;
    } else {
      customError = response.error;
    }
    await refreshCustom();
  }

  /** "Keep" and "Reject" / "Remove" / "Hide". */
  async function customAction(type) {
    els.customKeep.disabled = true;
    els.customDiscard.disabled = true;
    const response = await sendCustom(type);
    els.customKeep.disabled = false;
    els.customDiscard.disabled = false;
    customError = response.ok ? null : response.error;
    // The address stays in the field after the slot is emptied, to be corrected or tried again.
    if (type === Config.MSG.CUSTOM_DISCARD) customUrlTouched = true;
    await refreshCustom();
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

  /* ---------------- Files ---------------- */

  /** Hands a generated file to the browser's downloads. */
  function saveFile(name, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
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


  /* ---------------- Export / import ---------------- */

  function formatDateTime(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '?';
    return new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  function exportKeywords() {
    if (settings.keywords.length === 0) return;
    const now = new Date();
    const header = [
      t('keywordsFileHeader', [formatDateTime(now), chrome.runtime.getManifest().version]),
      t('keywordsFileHint'),
    ];
    const sorted = [...settings.keywords].sort(collator.compare);
    saveFile(`parabene-keywords-${Backup.fileStamp(now)}.txt`, Backup.buildKeywordsFile(sorted, header), 'text/plain');
    showFeedback(els.keywordFeedback, plural('keywordsExported', sorted.length), 'ok', 'keywordHint');
  }

  function exportSites() {
    if (settings.excludedSites.length === 0) return;
    const sorted = [...settings.excludedSites].sort(collator.compare);
    const text = Backup.buildSitesFile(sorted, [t('sitesFileHint')]);
    saveFile(`parabene-sites-${Backup.fileStamp()}.txt`, text, 'text/plain');
    showFeedback(els.siteFeedback, t('sitesExported'), 'ok', 'sitesHint');
  }

  function exportSettings() {
    const now = new Date();
    const text = Backup.buildSettingsFile({
      settings,
      learned: learnedEntries,
      version: chrome.runtime.getManifest().version,
      now,
    });
    saveFile(`parabene-settings-${Backup.fileStamp(now)}.json`, text, 'application/json');
    showFeedback(els.backupStatus, t('settingsExported'), 'ok');
  }

  const IMPORT_WINDOW_WIDTH = 440;
  const IMPORT_WINDOW_HEIGHT = 400;
  /**
   * How long the import window stays open after a successful import, to read its message:
   * BASE + PER_CHAR × the message's length, at most MAX (milliseconds).
   */
  const IMPORT_CLOSE_BASE_MS = 1500;
  const IMPORT_CLOSE_PER_CHAR_MS = 30;
  const IMPORT_CLOSE_MAX_MS = 6000;

  /**
   * Opens the import window for `kind` (see importKind) near the toolbar button, or brings an open
   * one to the front, and closes the popup.
   */
  async function openImportWindow(kind) {
    const urlFor = (which) => chrome.runtime.getURL(`popup/popup.html?import=${which}`);
    const url = urlFor(kind);
    const status = { keywords: els.keywordFeedback, sites: els.siteFeedback, settings: els.backupStatus }[kind];
    try {
      const [open] = typeof chrome.runtime.getContexts === 'function'
        ? await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: IMPORT_KINDS.map(urlFor) })
        : [];
      if (open) {
        // The same import keeps a file already read there; the other one replaces it.
        if (open.documentUrl !== url) await chrome.tabs.update(open.tabId, { url });
        await chrome.windows.update(open.windowId, { focused: true });
      } else {
        const options = { url, type: 'popup', width: IMPORT_WINDOW_WIDTH, height: IMPORT_WINDOW_HEIGHT, focused: true };
        const current = await chrome.windows.getCurrent().catch(() => null);
        if (current && [current.left, current.top, current.width].every(Number.isInteger)) {
          // Under the toolbar, where the popup was. The browser refuses a position half off the screen
          // (e.g. with several monitors): then it places the window itself.
          const left = Math.max(current.left, current.left + current.width - IMPORT_WINDOW_WIDTH - 16);
          await chrome.windows.create({ ...options, left, top: current.top + 72 }).catch(() => chrome.windows.create(options));
        } else {
          await chrome.windows.create(options);
        }
      }
    } catch (err) {
      console.error('[ParaBene]', err);
      showFeedback(status, t('importWindowFailed', err.message || '?'), 'error');
      return;
    }
    window.close();
  }

  /** The import window shows only the import card, with the title and description of its kind. */
  function setupImportWindow() {
    if (!importKind) return;
    document.documentElement.classList.add('import-mode');
    els.importWindow.hidden = false;
    els.importTitle.setAttribute('data-i18n', `importTitle_${importKind}`);
    els.importDesc.setAttribute('data-i18n', `importDesc_${importKind}`);
    // The window grows with what is shown in it (a file's summary, warnings, messages).
    new ResizeObserver(fitImportWindow).observe(els.app);
  }

  /** Fits the import window's height to its content, at most to the screen's. */
  function fitImportWindow() {
    if (document.documentElement.classList.contains('i18n-pending')) return; // no texts yet
    const frame = window.outerHeight - window.innerHeight;
    const height = Math.min(Math.ceil(els.app.getBoundingClientRect().height) + frame, screen.availHeight);
    if (Math.abs(height - window.outerHeight) < 2) return;
    chrome.windows.update(chrome.windows.WINDOW_ID_CURRENT, { height }).catch(() => {});
  }

  function chooseImportFile() {
    clearTimeout(importCloseTimer);
    els.importFile.value = '';
    els.importFile.click();
  }

  /** After a finished import the window has done its job: it closes once the message can be read. */
  function closeImportWindowSoon(message) {
    clearTimeout(importCloseTimer);
    const delay = Math.min(IMPORT_CLOSE_MAX_MS, IMPORT_CLOSE_BASE_MS + message.length * IMPORT_CLOSE_PER_CHAR_MS);
    importCloseTimer = setTimeout(() => window.close(), delay);
  }

  function importErrorText(err) {
    const code = err instanceof Backup.BackupError ? err.code : 'readFailed';
    return t(`importError_${code}`, err && err.message ? err.message : '?');
  }

  /** Reads a chosen or dropped file and shows what importing it would do. */
  async function readImportFile(file) {
    clearTimeout(importCloseTimer);
    listImport = null;
    settingsImport = null;
    renderListImport();
    renderSettingsImport();
    try {
      if (file.size > Backup.MAX_FILE_BYTES) throw new Backup.BackupError('tooLarge');
      const text = await file.text();
      if (importKind === 'keywords') {
        const { keywords, skipped, fromSettings } = Backup.parseKeywordsFile(text);
        listImport = { entries: keywords, skipped, fromSettings };
      } else if (importKind === 'sites') {
        const { sites, skipped, fromSettings } = Backup.parseSitesFile(text);
        listImport = { entries: sites, skipped, fromSettings };
      } else {
        settingsImport = Backup.parseSettingsFile(text);
      }
      showFeedback(els.importStatus, t('importReady', file.name), null);
    } catch (err) {
      showFeedback(els.importStatus, importErrorText(err), 'error');
    }
    renderListImport();
    renderSettingsImport();
  }

  function cancelImport() {
    listImport = null;
    settingsImport = null;
    renderListImport();
    renderSettingsImport();
    showFeedback(els.importStatus, '', null);
    els.importChoose.focus();
  }

  function newEntries(imported, current) {
    const existing = new Set(current);
    return imported.filter((entry) => !existing.has(entry));
  }

  function renderListImport() {
    els.listImportPanel.hidden = !listImport;
    if (!listImport) return;
    const { entries, skipped, fromSettings } = listImport;
    const sites = importKind === 'sites';
    const fresh = newEntries(entries, sites ? settings.excludedSites : settings.keywords).length;
    const sentences = sites
      ? [t('sitesImportSummary', [i18n.formatNumber(entries.length), i18n.formatNumber(fresh)])]
      : [plural('keywordsImportFound', entries.length), t('keywordsImportNew', i18n.formatNumber(fresh))];
    if (skipped) sentences.push(t(sites ? 'sitesSkipped' : 'keywordsSkipped', i18n.formatNumber(skipped)));
    if (fromSettings) sentences.push(t(sites ? 'sitesImportFromSettings' : 'keywordsImportFromSettings'));
    els.listImportSummary.textContent = sentences.join(' ');
    els.listImportMerge.disabled = fresh === 0;
  }

  async function applyListImport(replace) {
    if (!listImport) return;
    const imported = listImport.entries;
    listImport = null;
    renderListImport();
    let message;
    if (importKind === 'sites') {
      const saved = await changeExcludedSites((current) => {
        if (replace) return imported;
        const added = newEntries(imported, current);
        return added.length ? [...current, ...added] : current;
      });
      message = t(saved ? 'sitesImported' : 'sitesImportNothingNew');
    } else if (replace) {
      await chrome.storage.local.set({ keywords: imported });
      message = plural('keywordsReplaced', imported.length);
    } else {
      const added = newEntries(imported, settings.keywords);
      if (added.length) await chrome.storage.local.set({ keywords: [...settings.keywords, ...added] });
      message = added.length ? plural('keywordsAdded', added.length) : t('keywordsImportNothingNew');
    }
    showFeedback(els.importStatus, message, 'ok');
    closeImportWindowSoon(message);
  }

  /** A warning from parseSettingsFile → a list item; setting names are shown as they are stored. */
  function importWarning(warning) {
    const item = document.createElement('li');
    const key = `importWarn_${warning.code}`;
    if (warning.items) {
      const [before, after = ''] = t(key, '\u0000').split('\u0000');
      item.append(before);
      warning.items.forEach((name, index) => {
        if (index) item.append(', ');
        const code = document.createElement('code');
        code.textContent = name;
        item.append(code);
      });
      item.append(after);
    } else if (warning.count !== undefined) {
      item.textContent = t(key, i18n.formatNumber(warning.count));
    } else {
      item.textContent = t(key, [String(warning.version), String(Backup.FORMAT_VERSION)]);
    }
    return item;
  }

  function renderSettingsImport() {
    els.settingsImportPanel.hidden = !settingsImport;
    if (!settingsImport) return;
    const { settings: found, learned, meta, warnings } = settingsImport;
    // The two lists are counted by their entries, not as one setting each.
    const settingCount = Object.keys(found).filter((key) => key !== 'keywords' && key !== 'excludedSites').length;
    const sentences = [
      t('settingsImportSummary', [meta.exportedAt ? formatDateTime(meta.exportedAt) : '?', meta.extensionVersion || '?']),
      t('settingsImportContents', [
        i18n.formatNumber(settingCount),
        found.keywords ? i18n.formatNumber(found.keywords.length) : '–',
        found.excludedSites ? i18n.formatNumber(found.excludedSites.length) : '–',
        i18n.formatNumber(learned ? learned.length : 0),
      ]),
    ];
    els.settingsImportSummary.textContent = sentences.join(' ');
    els.settingsImportWarnings.replaceChildren(...warnings.map(importWarning));
    els.settingsImportApply.disabled = Object.keys(found).length === 0 && !(learned && learned.length);
  }

  async function applySettingsImport() {
    if (!settingsImport) return;
    const { settings: found, learned } = settingsImport;
    settingsImport = null;
    renderSettingsImport();
    // Messages below in the restored language (the storage listener switches it too).
    if (found.language && found.language !== settings.language) await applyLanguage(found.language);
    if ('excludedSites' in found) {
      await navigator.locks.request(SITES_LOCK, () => chrome.storage.local.set(found));
    } else {
      await chrome.storage.local.set(found);
    }
    const sentences = [t('settingsImported')];
    let kind = 'ok';
    if (learned && learned.length) {
      try {
        const response = await chrome.runtime.sendMessage({ type: Config.MSG.LEARN_IMPORT, entries: learned });
        if (!(response && response.ok)) throw Object.assign(new Error(), { described: describeAiError(response && response.error) });
        sentences.push(t('settingsImportedLearned', i18n.formatNumber(response.data.imported)));
        if (response.data.tooOld > 0) {
          sentences.push(t('settingsImportedLearnedTooOld', [i18n.formatNumber(Config.LEARN_MAX_ENTRIES), i18n.formatNumber(response.data.tooOld)]));
        }
        if (response.data.skipped > 0) {
          sentences.push(t('settingsImportedLearnedSkipped', i18n.formatNumber(response.data.skipped)));
        }
      } catch (err) {
        sentences.push(t('settingsImportLearnedFailed', err.described || t('aiError_unknown', err.message)));
        kind = 'error';
      }
    }
    const message = sentences.join(' ');
    showFeedback(els.importStatus, message, kind);
    // A failure stays on screen to be read.
    if (kind === 'ok') closeImportWindowSoon(message);
  }

  /* ---------------- Current tab ---------------- */

  async function refreshStats() {
    // The import window does not show statistics; its own tab is the active one there.
    if (importKind) return;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      activeTabId = tab ? tab.id : null;
      activeSite = Config.siteHost(tab?.url);
      renderCurrentSiteAction();
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

  /** The import window: the file comes from the picker or is dropped onto the window; Escape closes it. */
  function bindImportWindow() {
    const reportFailure = (err) => showFeedback(els.importStatus, importErrorText(err), 'error');
    els.importChoose.addEventListener('click', chooseImportFile);
    els.importFile.addEventListener('change', () => {
      const [file] = els.importFile.files;
      els.importFile.value = '';
      if (file) readImportFile(file);
    });
    els.listImportMerge.addEventListener('click', () => applyListImport(false).catch(reportFailure));
    els.listImportReplace.addEventListener('click', () => applyListImport(true).catch(reportFailure));
    els.listImportCancel.addEventListener('click', cancelImport);
    els.settingsImportApply.addEventListener('click', () => applySettingsImport().catch(reportFailure));
    els.settingsImportCancel.addEventListener('click', cancelImport);

    // dragenter/dragleave also fire between the window's own elements: count them to know when the file leaves.
    let dragDepth = 0;
    const carriesFile = (event) => Boolean(event.dataTransfer && event.dataTransfer.types.includes('Files'));
    const highlight = (on) => els.importDrop.classList.toggle('dropzone--over', on);
    document.addEventListener('dragenter', (event) => {
      if (!carriesFile(event)) return;
      event.preventDefault();
      dragDepth += 1;
      highlight(true);
    });
    document.addEventListener('dragleave', (event) => {
      if (!carriesFile(event)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) highlight(false);
    });
    document.addEventListener('dragover', (event) => {
      if (!carriesFile(event)) return;
      event.preventDefault(); // otherwise the browser opens the dropped file in the window
      event.dataTransfer.dropEffect = 'copy';
    });
    document.addEventListener('drop', (event) => {
      if (!carriesFile(event)) return;
      event.preventDefault();
      dragDepth = 0;
      highlight(false);
      const [file] = event.dataTransfer.files;
      if (file) readImportFile(file);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') window.close();
    });
  }

  function bind() {
    els.enabled.addEventListener('change', () => {
      chrome.storage.local.set({ enabled: els.enabled.checked });
    });
    els.siteForm.addEventListener('submit', (event) => {
      event.preventDefault();
      addSite(els.siteInput.value, false).catch(reportSiteError);
    });
    els.excludeCurrentSite.addEventListener('click', () => addSite(activeSite, true).catch(reportSiteError));
    els.sitesExport.addEventListener('click', exportSites);
    els.sitesImport.addEventListener('click', () => openImportWindow('sites'));
    els.keywordForm.addEventListener('submit', addKeywords);
    els.restoreDefaults.addEventListener('click', restoreDefaults);
    els.keywordsExport.addEventListener('click', exportKeywords);
    els.keywordsImport.addEventListener('click', () => openImportWindow('keywords'));
    els.settingsExport.addEventListener('click', exportSettings);
    els.settingsImport.addEventListener('click', () => openImportWindow('settings'));
    if (importKind) bindImportWindow();
    els.aiEnabled.addEventListener('change', () => {
      chrome.storage.local.set({ aiEnabled: els.aiEnabled.checked });
    });
    els.aiProtocol.addEventListener('change', saveProtocol);
    els.aiModelDownload.addEventListener('click', downloadModel);
    els.aiModelSelect.addEventListener('change', saveModel);
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
      chrome.storage.local.set({ evalLogEnabled: els.logEnabled.checked });
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
    for (const [id, { toggle }] of sections) toggle.addEventListener('click', () => toggleSection(id));
    els.sectionOrder.addEventListener('click', (event) => {
      const button = event.target.closest('.order__move');
      if (button && !button.disabled) moveSection(button.dataset.id, Number(button.dataset.step));
    });
    els.layoutReset.addEventListener('click', resetLayout);
    els.customUrl.addEventListener('input', () => {
      customUrlTouched = true;
      customInfo = null;
      customError = null;
      renderCustom();
    });
    els.customUrl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        checkCustom();
      }
    });
    els.customCheck.addEventListener('click', checkCustom);
    els.customConsent.addEventListener('change', renderCustom);
    els.customStart.addEventListener('click', startCustom);
    els.customKeep.addEventListener('click', () => customAction(Config.MSG.CUSTOM_KEEP));
    els.customDiscard.addEventListener('click', () => customAction(Config.MSG.CUSTOM_DISCARD));
    els.language.addEventListener('change', () => {
      if (Config.isSupportedLanguage(els.language.value)) {
        chrome.storage.local.set({ language: els.language.value });
      }
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (Config.BUILTIN_STORAGE_KEY in changes) refreshModel();
      // A trial began or ended, or the kept version changed: the chosen model's state too (after
      // the slot is known, as refreshModel compares the model it gets with the chosen one).
      if (Config.CUSTOM_MODEL_KEY in changes) refreshCustom().then(refreshModel);
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
      settings = Config.sanitize(next);
      if (keys.every((key) => Config.PANEL_SETTINGS.includes(key))) {
        renderLayout();
        return;
      }
      // Not when the panel already switched (a restored backup): a second switch would clear its message.
      if (settings.language !== uiLanguage) {
        applyLanguage(settings.language).catch((err) => console.error('[ParaBene]', err));
      } else {
        render();
      }
      if (keys.includes('enabled') || keys.includes('excludedSites')) setTimeout(refreshStats, 400);
      if (keys.some((key) => ['aiProtocol', 'aiModel', 'aiEnabled', 'enabled'].includes(key))) {
        if (keys.includes('aiModel') || keys.includes('aiProtocol')) {
          // Another model: do not show the previous one's state while the new one is asked for.
          lastModel = null;
          els.aiModelStatus.textContent = '';
          els.aiModelProgress.hidden = true;
          els.aiModelDownload.hidden = true;
        }
        refreshModel();
      }
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
    setupImportWindow();
    els.version.textContent = `v${chrome.runtime.getManifest().version}`;
    bind();
    settings = await Config.load();
    logCard = LogCard.create({ t, formatNumber: (value) => i18n.formatNumber(value), showFeedback });
    await logCard.refresh();
    await loadLearned();
    await applyLanguage(settings.language);
    document.documentElement.classList.remove('i18n-pending');
    if (importKind) {
      fitImportWindow();
      els.importChoose.focus();
      return;
    }
    await refreshStats();
    await refreshCustom(); // first: the chosen model may be the kept other version
    refreshModel();
  }

  init().catch((err) => {
    console.error('[ParaBene]', err);
    I18n.localize(document, i18n);
    els.statHint.textContent = t('loadError');
    document.documentElement.classList.remove('i18n-pending');
  });
})();
