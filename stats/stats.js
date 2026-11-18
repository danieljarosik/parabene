/*
 * ParaBene – statistics page: what was evaluated while browsing and with what result.
 *
 * The page has the extension's origin, so it reads the log of evaluated content straight from the
 * database (src/store.js). This module starts the page and keeps it current; the parts are drawn by
 *   summary.js   headline numbers, who decided (keywords / AI text / AI image)
 *   scores.js    distribution of the AI model's scores against the hide threshold
 *   sites.js     the sites
 *   entries.js   the entries with filters, and the corrections of verdicts
 *   actions.js   recording on/off, download, clear
 * with context.js (shared state) and format.js (helpers).
 */
import { Config, I18n, Store, ctx, t } from './context.js';
import { bindActions, renderActions, showFailure } from './actions.js';
import { bindEntries, renderEntries } from './entries.js';
import { renderScores } from './scores.js';
import { renderSites } from './sites.js';
import { renderSummary } from './summary.js';

let reloadTimer = 0;

function render() {
  renderActions();
  renderSummary();
  renderScores();
  renderSites();
  renderEntries();
}

/** When a record was last evaluated, as a number for sorting. */
const lastSeen = (record) => Date.parse(record.lastTime || record.time) || 0;

/** The records, the most recently evaluated first (a record seen again moves to the top). */
async function readRecords() {
  try {
    ctx.records = (await Store.all()).sort((a, b) => lastSeen(b) - lastSeen(a) || b.id - a.id);
  } catch (err) {
    ctx.records = [];
    showFailure(t('statsReadFailed', err && err.message ? err.message : String(err)));
  }
}

async function reload() {
  await readRecords();
  render();
}

/** New evaluations arrive in bursts while pages load: read the log again shortly after the last one. */
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(reload, 600);
}

async function applyLanguage(locale) {
  const messagesOf = (code) => I18n.loadMessages(code).catch(() => null);
  const [messages, fallback] = await Promise.all([
    messagesOf(locale),
    locale === Config.DEFAULT_LANGUAGE ? null : messagesOf(Config.DEFAULT_LANGUAGE),
  ]);
  ctx.i18n = I18n.createTranslator(locale, messages, fallback);
  I18n.localize(document, ctx.i18n);
  render();
}

function onSettingsChanged(changes, area) {
  if (area !== 'local') return;
  const keys = Object.keys(Config.DEFAULT_SETTINGS).filter((key) => key in changes);
  if (keys.length === 0) return;
  const next = Object.assign({}, ctx.settings);
  for (const key of keys) next[key] = changes[key].newValue;
  const previous = ctx.settings.language;
  ctx.settings = Config.sanitize(next);
  if (ctx.settings.language !== previous) applyLanguage(ctx.settings.language);
  else render();
}

async function init() {
  Object.assign(ctx, { render, reload, fail: showFailure });
  bindActions();
  bindEntries();
  Store.subscribe(scheduleReload);
  chrome.storage.onChanged.addListener(onSettingsChanged);
  ctx.settings = await Config.load();
  await readRecords();
  await applyLanguage(ctx.settings.language);
}

init()
  .catch((err) => {
    console.error('[ParaBene]', err);
    const notice = document.getElementById('notice');
    notice.hidden = false;
    notice.textContent = String(err && err.message ? err.message : err);
  })
  .finally(() => document.documentElement.classList.remove('i18n-pending'));
