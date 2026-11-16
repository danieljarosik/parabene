/*
 * ParaBene – service worker.
 * - stores the default settings on install,
 * - proxies requests to the local AI model (a fetch from the extension context
 *   is not subject to page CORS or private network restrictions),
 * - shows the number of hidden elements in the current tab on the icon badge.
 */
importScripts('config.js', 'evaluators.js');

const Config = self.ParaBeneConfig;
const Evaluators = self.ParaBeneEvaluators;

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

  if (message.type === Config.MSG.STATS && sender.tab && sender.tab.id >= 0) {
    updateBadge(sender.tab.id, message.hidden);
  }
  return false;
});

async function classify(text) {
  try {
    const { aiEndpoint } = await Config.load();
    if (!Config.isValidEndpoint(aiEndpoint)) throw new Error('nieprawidłowy adres endpointu');
    const data = await Evaluators.fetchTransport({
      endpoint: aiEndpoint,
      text: String(text || '').slice(0, Config.AI_MAX_CHARS),
      timeoutMs: Config.AI_TIMEOUT_MS,
    });
    if (!data || typeof data.hide !== 'boolean') {
      throw new Error('nieprawidłowa odpowiedź (oczekiwano {"hide": boolean, "reason": string})');
    }
    return { ok: true, data: { hide: data.hide, reason: typeof data.reason === 'string' ? data.reason : '' } };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

function describeError(err) {
  const text = err && err.message ? err.message : String(err);
  return text === 'Failed to fetch' ? 'serwer nie odpowiada' : text;
}

function updateBadge(tabId, hidden) {
  const count = Number.isFinite(hidden) ? Math.max(0, Math.floor(hidden)) : 0;
  const text = count === 0 ? '' : count > 999 ? '999+' : String(count);
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#E8833A' }).catch(() => {});
}
