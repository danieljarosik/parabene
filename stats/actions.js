/*
 * ParaBene – statistics page: the controls at the top (recording on/off, download, clear) and
 * the notice under them.
 */
import { Config, Store, ctx, t } from './context.js';
import { resetEntries } from './entries.js';

const toggle = document.getElementById('log-enabled');
const downloadButton = document.getElementById('download');
const clearButton = document.getElementById('clear');
const notice = document.getElementById('notice');
let clearArmedTimer = 0;
let failure = '';
let failureTimer = 0;

/** Hands a generated file to the browser's downloads. */
function saveFile(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function download() {
  if (ctx.records.length === 0) return;
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const oldestFirst = [...ctx.records].sort((a, b) => a.id - b.id); // in the order recorded
  const file = Store.toJsonl(oldestFirst, ctx.settings, chrome.runtime.getManifest().version);
  saveFile(`parabene-log-${stamp}.jsonl`, file, 'application/x-ndjson');
}

/** The first click arms the button, a second one within a few seconds clears the log. */
async function clearLog() {
  if (!clearArmedTimer) {
    clearButton.textContent = t('logClearConfirm');
    clearArmedTimer = setTimeout(() => {
      clearArmedTimer = 0;
      clearButton.textContent = t('logClear');
    }, 4000);
    return;
  }
  clearTimeout(clearArmedTimer);
  clearArmedTimer = 0;
  try {
    // Through the service worker, which queues it after any log write in progress.
    const response = await chrome.runtime.sendMessage({ type: Config.MSG.LOG_CLEAR });
    if (!(response && response.ok)) throw new Error((response && response.error && response.error.detail) || '?');
    resetEntries();
    await ctx.reload();
  } catch (err) {
    showFailure(t('logClearFailed', err.message));
  }
  clearButton.textContent = t('logClear');
}

function renderNotice() {
  let text = failure;
  if (!text && !ctx.settings.evalLogEnabled) text = t(ctx.records.length ? 'statsLogOffNote' : 'statsLogOffEmpty');
  notice.hidden = !text;
  notice.textContent = text;
  notice.classList.toggle('notice--error', Boolean(failure));
}

/** Shows an error for a few seconds ('' removes it). */
export function showFailure(text) {
  clearTimeout(failureTimer);
  failure = text;
  if (text) failureTimer = setTimeout(() => showFailure(''), 8000);
  renderNotice();
}

export function renderActions() {
  toggle.checked = ctx.settings.evalLogEnabled;
  downloadButton.disabled = ctx.records.length === 0;
  clearButton.disabled = ctx.records.length === 0;
  if (!clearArmedTimer) clearButton.textContent = t('logClear');
  renderNotice();
}

export function bindActions() {
  toggle.addEventListener('change', () => chrome.storage.local.set({ evalLogEnabled: toggle.checked }));
  downloadButton.addEventListener('click', download);
  clearButton.addEventListener('click', clearLog);
}
