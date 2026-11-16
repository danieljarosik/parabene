/* ParaBene – control panel. */
(() => {
  'use strict';

  const Config = globalThis.ParaBeneConfig;
  const collator = new Intl.Collator('pl', { sensitivity: 'base' });
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
    aiEndpoint: document.getElementById('ai-endpoint'),
    aiTest: document.getElementById('ai-test'),
    aiStatus: document.getElementById('ai-status'),
    version: document.getElementById('version'),
  };

  const defaultKeywordHint = els.keywordFeedback.textContent.trim();
  const defaultAiHint = els.aiStatus.textContent.trim();

  let settings = Config.sanitize({});
  let activeTabId = null;
  let tabReachable = false;
  let feedbackTimer = 0;
  let recentlyAdded = new Set();

  /* ---------------- Render ---------------- */

  function render() {
    els.enabled.checked = settings.enabled;
    els.enabledState.textContent = settings.enabled ? 'ON' : 'OFF';
    els.app.classList.toggle('app--off', !settings.enabled);

    els.aiEnabled.checked = settings.aiEnabled;
    els.aiSettings.classList.toggle('ai--inactive', !settings.aiEnabled);
    if (document.activeElement !== els.aiEndpoint) els.aiEndpoint.value = settings.aiEndpoint;

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
      remove.title = 'Usuń';
      remove.setAttribute('aria-label', `Usuń „${keyword}”`);
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
      els.statHint.textContent = 'Filtr jest wyłączony.';
    } else if (!tabReachable) {
      els.statHint.textContent = 'Filtr nie działa na tej stronie lub wymaga jej odświeżenia.';
    } else {
      els.statHint.textContent = 'Posty i artykuły zwinięte przez filtr.';
    }
  }

  function setCount(value) {
    els.hiddenCount.textContent = Number.isFinite(value) ? String(value) : '–';
  }

  function showFeedback(element, text, kind, fallbackText) {
    element.textContent = text;
    element.classList.toggle('hint--ok', kind === 'ok');
    element.classList.toggle('hint--error', kind === 'error');
    if (fallbackText) {
      clearTimeout(feedbackTimer);
      feedbackTimer = setTimeout(() => showFeedback(element, fallbackText, null), 3500);
    }
  }

  /* ---------------- Keywords ---------------- */

  function phrases(count) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (count === 1) return '1 frazę';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} frazy`;
    return `${count} fraz`;
  }

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
      showFeedback(els.keywordFeedback, 'Wpisz słowo lub frazę.', 'error', defaultKeywordHint);
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
        ? `Fraza musi mieć od ${Config.KEYWORD_MIN_LENGTH} do ${Config.KEYWORD_MAX_LENGTH} znaków.`
        : 'Ta fraza jest już na liście.';
      showFeedback(els.keywordFeedback, message, 'error', defaultKeywordHint);
      return;
    }

    recentlyAdded = new Set(added);
    await chrome.storage.local.set({ keywords: [...settings.keywords, ...added] });
    els.keywordInput.value = '';
    const suffix = rejected.length ? ` Pominięto za krótkie/długie: ${rejected.length}.` : '';
    const message = added.length === 1 ? `Dodano „${added[0]}”.${suffix}` : `Dodano ${phrases(added.length)}.${suffix}`;
    showFeedback(els.keywordFeedback, message, 'ok', defaultKeywordHint);
  }

  async function removeKeyword(keyword) {
    await chrome.storage.local.set({ keywords: settings.keywords.filter((k) => k !== keyword) });
    showFeedback(els.keywordFeedback, `Usunięto „${keyword}”.`, 'ok', defaultKeywordHint);
  }

  async function restoreDefaults() {
    const existing = new Set(settings.keywords);
    const missing = Config.DEFAULT_KEYWORDS.map(Config.normalizeKeyword).filter((k) => !existing.has(k));
    if (missing.length === 0) {
      showFeedback(els.keywordFeedback, 'Wszystkie domyślne frazy są już na liście.', 'ok', defaultKeywordHint);
      return;
    }
    recentlyAdded = new Set(missing);
    await chrome.storage.local.set({ keywords: [...settings.keywords, ...missing] });
    showFeedback(els.keywordFeedback, `Przywrócono ${phrases(missing.length)} z listy domyślnej.`, 'ok', defaultKeywordHint);
  }

  /* ---------------- Local AI model ---------------- */

  async function saveEndpoint() {
    const value = els.aiEndpoint.value.trim();
    if (!Config.isValidEndpoint(value)) {
      els.aiEndpoint.classList.add('input--invalid');
      showFeedback(els.aiStatus, 'Podaj pełny adres http(s)://, np. http://localhost:8000/classify', 'error');
      return false;
    }
    els.aiEndpoint.classList.remove('input--invalid');
    if (value !== settings.aiEndpoint) {
      await chrome.storage.local.set({ aiEndpoint: value });
      showFeedback(els.aiStatus, 'Zapisano adres endpointu.', 'ok', defaultAiHint);
    }
    return true;
  }

  async function testEndpoint() {
    if (!(await saveEndpoint())) return;
    els.aiTest.disabled = true;
    showFeedback(els.aiStatus, 'Łączenie z lokalnym modelem…', null);
    try {
      const response = await chrome.runtime.sendMessage({
        type: Config.MSG.CLASSIFY,
        text: 'ParaBene: test połączenia z lokalnym modelem.',
      });
      if (response && response.ok) {
        const reason = response.data.reason ? `, powód: „${response.data.reason}”` : '';
        showFeedback(els.aiStatus, `Połączono ✓ Odpowiedź: hide=${response.data.hide}${reason}.`, 'ok');
      } else {
        const error = (response && response.error) || 'brak odpowiedzi';
        showFeedback(els.aiStatus, `Brak połączenia (${error}). Działa zapas: słowa kluczowe.`, 'error');
      }
    } catch (err) {
      showFeedback(els.aiStatus, `Brak połączenia (${err.message}). Działa zapas: słowa kluczowe.`, 'error');
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
    els.aiEndpoint.addEventListener('change', saveEndpoint);
    els.aiEndpoint.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        saveEndpoint();
      }
    });
    els.aiEndpoint.addEventListener('input', () => els.aiEndpoint.classList.remove('input--invalid'));
    els.aiTest.addEventListener('click', testEndpoint);

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const keys = Object.keys(Config.DEFAULT_SETTINGS).filter((key) => key in changes);
      if (keys.length === 0) return;
      const next = Object.assign({}, settings);
      for (const key of keys) next[key] = changes[key].newValue;
      settings = Config.sanitize(next);
      render();
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
    render();
    await refreshStats();
  }

  init().catch((err) => {
    console.error('[ParaBene]', err);
    els.statHint.textContent = 'Nie udało się wczytać ustawień.';
  });
})();
