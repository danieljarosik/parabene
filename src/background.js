/*
 * ParaBene – service worker.
 * - stores the default settings on install,
 * - proxies requests to the local AI model (a fetch from the extension context
 *   is not subject to page CORS or private network restrictions),
 * - shows the number of hidden elements in the current tab on the icon badge,
 * - serves translations to content scripts (they cannot read extension files).
 */
importScripts('config.js', 'i18n.js', 'evaluators.js');

const Config = self.ParaBeneConfig;
const I18n = self.ParaBeneI18n;
const Evaluators = self.ParaBeneEvaluators;

/** locale → Promise<messages>; lives as long as the service worker. */
const messageCache = new Map();

chrome.runtime.onInstalled.addListener(() => {
  Config.load().catch((err) => console.warn('[ParaBene] Failed to save default settings:', err));
  chrome.action.setBadgeBackgroundColor({ color: '#E8833A' }).catch(() => {});
});

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
  try {
    const { aiEndpoint } = await Config.load();
    if (!Config.isValidEndpoint(aiEndpoint)) throw Evaluators.codedError('invalidEndpoint', 'invalid endpoint URL');
    const data = await Evaluators.fetchTransport({
      endpoint: aiEndpoint,
      text: String(text || '').slice(0, Config.AI_MAX_CHARS),
      timeoutMs: Config.AI_TIMEOUT_MS,
    });
    if (!data || typeof data.hide !== 'boolean') {
      throw Evaluators.codedError('invalidResponse', 'invalid response (expected {"hide": boolean, "reason": string})');
    }
    return { ok: true, data: { hide: data.hide, reason: typeof data.reason === 'string' ? data.reason : '' } };
  } catch (err) {
    return { ok: false, error: describeError(err) };
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
