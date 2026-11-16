/*
 * ParaBene – service worker.
 * - stores the default settings on install,
 * - proxies requests to the local AI model (a fetch from the extension context
 *   is not subject to page CORS or private network restrictions),
 * - shows the number of hidden elements in the current tab on the icon badge,
 * - keeps the opt-in log of hidden content (chrome.storage.local, exported by the panel),
 * - serves translations to content scripts (they cannot read extension files).
 */
importScripts('config.js', 'i18n.js', 'evaluators.js');

const Config = self.ParaBeneConfig;
const I18n = self.ParaBeneI18n;
const Evaluators = self.ParaBeneEvaluators;

/** locale → Promise<messages>; lives as long as the service worker. */
const messageCache = new Map();

chrome.runtime.onInstalled.addListener(() => {
  applyEnvFile()
    .then(() => Config.load())
    .catch((err) => console.warn('[ParaBene] Failed to save default settings:', err));
  chrome.action.setBadgeBackgroundColor({ color: '#E8833A' }).catch(() => {});
});

/**
 * Copies the settings from the optional, uncommitted .env file (see .env.example)
 * into chrome.storage.local. Runs on install and on every reload of the extension,
 * so editing .env + reloading applies it; changes made in the panel last until then.
 */
async function applyEnvFile() {
  let text;
  try {
    const response = await fetch(chrome.runtime.getURL(Config.ENV_FILE), { cache: 'no-store' });
    if (!response.ok) return;
    text = await response.text();
  } catch (_) {
    return; // no .env file — nothing to apply
  }
  const { settings, ignored } = Config.parseEnv(text);
  if (ignored.length) console.warn(`[ParaBene] ${Config.ENV_FILE}: ignored`, ignored);
  if (Object.keys(settings).length === 0) return;
  await chrome.storage.local.set(settings);
  console.info(`[ParaBene] Applied settings from ${Config.ENV_FILE}:`, Object.keys(settings));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message.type !== 'string') return false;

  if (message.type === Config.MSG.CLASSIFY) {
    classify(message.text).then(sendResponse);
    return true;
  }

  if (message.type === Config.MSG.GET_MESSAGES) {
    getMessages(message.locale).then(sendResponse);
    return true;
  }

  if (message.type === Config.MSG.LOG_HIDDEN || message.type === Config.MSG.LOG_REVEALED) {
    queueLog(message.type, message.entry);
    return false;
  }

  if (message.type === Config.MSG.STATS && sender.tab && sender.tab.id >= 0) {
    updateBadge(sender.tab.id, message.hidden);
  }
  return false;
});

async function getMessages(locale) {
  const code = Config.isSupportedLanguage(locale) ? locale : Config.DEFAULT_LANGUAGE;
  if (!messageCache.has(code)) {
    messageCache.set(
      code,
      I18n.loadMessages(code).catch((err) => {
        messageCache.delete(code);
        throw err;
      })
    );
  }
  try {
    return { ok: true, locale: code, messages: await messageCache.get(code) };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

/**
 * Errors are returned as { code, detail } — the popup translates the code
 * into the UI language (messages "aiError_<code>").
 */
async function classify(text) {
  let endpoint = '';
  try {
    const { aiEndpoint, aiProtocol, aiSensitivity, aiTopics } = await Config.load();
    if (!Config.isValidEndpoint(aiEndpoint)) throw Evaluators.codedError('invalidEndpoint', 'invalid endpoint URL');
    const input = String(text || '').slice(0, Config.AI_MAX_CHARS);
    const basal = aiProtocol === 'basal';
    endpoint = Config.resolveEndpoint(aiEndpoint, aiProtocol);
    const reply = await Evaluators.fetchTransport({
      endpoint,
      text: input,
      body: basal ? Evaluators.basalRequest(input, aiTopics) : undefined,
      timeoutMs: Config.AI_TIMEOUT_MS,
    });
    if (basal) {
      const threshold = Config.AI_SENSITIVITIES[aiSensitivity];
      const data = Evaluators.parseBasalResponse(reply, { threshold, topics: aiTopics });
      return { ok: true, data: Object.assign(data, { threshold }) };
    }
    const data = reply;
    if (!data || typeof data.hide !== 'boolean') {
      throw Evaluators.codedError('invalidResponse', 'invalid response (expected {"hide": boolean, "reason": string})');
    }
    return { ok: true, data: { hide: data.hide, reason: typeof data.reason === 'string' ? data.reason : '' } };
  } catch (err) {
    if (err && err.code === 'http' && err.detail === '404') {
      err.code = 'notFound';
      err.detail = pathOf(endpoint);
    }
    return { ok: false, error: describeError(err) };
  }
}

/** The path a 404 came from, for the panel's hint. */
function pathOf(endpoint) {
  try {
    return new URL(endpoint).pathname;
  } catch (_) {
    return '?';
  }
}

function describeError(err) {
  if (err && err.code) return { code: err.code, detail: err.detail };
  return { code: 'unknown', detail: err && err.message ? err.message : String(err) };
}

function updateBadge(tabId, hidden) {
  const count = Number.isFinite(hidden) ? Math.max(0, Math.floor(hidden)) : 0;
  const text = count === 0 ? '' : count > 999 ? '999+' : String(count);
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#E8833A' }).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Log of hidden content                                               */
/* ------------------------------------------------------------------ */

const LOG_FLUSH_MS = 1000;
const logQueue = [];
let logTimer = 0;
let logWrite = Promise.resolve();

/** Entries arrive in bursts while a page loads — they are written to storage in batches. */
function queueLog(type, entry) {
  if (!entry || typeof entry.text !== 'string' || !entry.text) return;
  logQueue.push({ type, entry });
  if (!logTimer) logTimer = setTimeout(flushLog, LOG_FLUSH_MS);
}

/** The same text hidden for the same reason (e.g. after a page reload) is logged once. */
function logKey(entry) {
  return `${entry.source}\n${entry.text}`;
}

function flushLog() {
  logTimer = 0;
  const batch = logQueue.splice(0);
  logWrite = logWrite
    .then(async () => {
      const { logEnabled } = await Config.load();
      if (!logEnabled) return;
      const stored = await chrome.storage.local.get(Config.LOG_STORAGE_KEY);
      const entries = Array.isArray(stored[Config.LOG_STORAGE_KEY]) ? stored[Config.LOG_STORAGE_KEY] : [];
      const index = new Map(entries.map((entry) => [logKey(entry), entry]));
      let changed = false;
      for (const { type, entry } of batch) {
        const clean = sanitizeLogEntry(entry);
        const existing = index.get(logKey(clean));
        if (type === Config.MSG.LOG_REVEALED) {
          if (existing && !existing.revealed) {
            existing.revealed = true;
            changed = true;
          }
        } else if (!existing) {
          entries.push(clean);
          index.set(logKey(clean), clean);
          changed = true;
        }
      }
      if (!changed) return;
      await chrome.storage.local.set({ [Config.LOG_STORAGE_KEY]: entries.slice(-Config.LOG_MAX_ENTRIES) });
    })
    .catch((err) => console.warn('[ParaBene] Failed to write the log:', err));
}

/** Keeps only the known fields, with sane types and lengths. */
function sanitizeLogEntry(raw) {
  const entry = {
    time: typeof raw.time === 'string' ? raw.time : new Date().toISOString(),
    url: String(raw.url || '').slice(0, 500),
    source: raw.source === 'ai' ? 'ai' : 'keyword',
    mode: ['keywords', 'both', 'ai'].includes(raw.mode) ? raw.mode : 'keywords',
    reason: String(raw.reason || '').slice(0, 200),
    category: typeof raw.category === 'string' ? raw.category.slice(0, 40) : '',
    fallback: raw.fallback === true,
    revealed: false,
    text: String(raw.text).slice(0, Config.LOG_MAX_TEXT),
  };
  if (raw.details && typeof raw.details === 'object') entry.details = raw.details;
  return entry;
}
