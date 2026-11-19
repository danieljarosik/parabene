/*
 * ParaBene – statistics page: sending entries to an external, larger model for review.
 *
 * The card holds where the reviewer is (reviewer-config.js), sends the entries of the current
 * filter that have a text and no proposal yet — only after the user has confirmed how many go
 * where — and shows how the proposals compare with the extension's verdicts. An OpenAI-compatible
 * API gets one request per entry (reviewer-client.js), a few at a time; the Claude API gets all of
 * them as one batch that is answered later (reviewer-batch.js lists the batches sent). The model
 * is chosen from a list (reviewer-models.js). The proposals are stored with the entries
 * (suggestions.js shows them). Nothing is ever sent by itself.
 */
import { Store, ctx, t } from './context.js';
import { number } from './format.js';
import { matchingRecords } from './entries.js';
import { BATCH_MAX, initBatches, isSending, renderBatches, resumeBatches, sendBatch, waitingEntries } from './reviewer-batch.js';
import {
  DEFAULT_ENDPOINTS, DEFAULT_MODELS, DEFAULT_PROVIDER, PROVIDERS, STORAGE_KEY, hostOf, isComplete, isValidEndpoint, isValidModel,
  keyFor, loadReviewer, originOf, saveReviewer,
} from './reviewer-config.js';
import { chosenModel, initModels, markInvalidModel, refreshModels, renderModels, showModels } from './reviewer-models.js';
import { review, reviewTopics } from './reviewer-client.js';
import { renderAgreement } from './reviewer-summary.js';
import { acceptAll, agreement, isPending } from './suggestions.js';

/** Entries sent by one click when each is a request of its own, and requests in flight at once. */
const MAX_PER_RUN = 200;
const CONCURRENCY = 3;
/** Errors after which asking again makes no sense: the run stops. */
const FATAL = new Set(['auth', 'unreachable', 'http', 'rate']);

const $ = (id) => document.getElementById(id);
const els = {
  provider: $('review-provider'),
  endpoint: $('review-endpoint'),
  key: $('review-key'),
  refresh: $('review-models-refresh'),
  save: $('review-save'),
  saved: $('review-saved'),
  candidates: $('review-candidates'),
  send: $('review-send'),
  confirm: $('review-confirm'),
  confirmText: $('review-confirm-text'),
  confirmSend: $('review-confirm-send'),
  confirmCancel: $('review-confirm-cancel'),
  running: $('review-running'),
  progress: $('review-progress'),
  progressText: $('review-progress-text'),
  stop: $('review-stop'),
  result: $('review-result'),
  summary: $('review-summary'),
  summaryHint: $('review-summary-hint'),
  acceptAll: $('review-accept-all'),
};

let config = { provider: DEFAULT_PROVIDER, endpoint: '', model: '', apiKey: '' };
/** The run in progress: { controller, done, errors, total } or null. */
let run = null;
/**
 * What the open confirmation names: { config, records, topics }, or null when it is closed.
 * "Send" sends exactly this, whatever changed on the page meanwhile.
 */
let offer = null;
/**
 * The kind of API and the server ({ provider, origin }) the key in the form belongs to: the one the
 * form pointed at when the key was typed, or the saved one for the saved key.
 */
let keyScope = { provider: '', origin: '' };
let resultText = '';
let resultKind = '';
let acceptArmedTimer = 0;
let savedTimer = 0;

function describeError(err) {
  const code = err && err.code;
  const key = `reviewError_${code}`;
  if (code && ctx.i18n.has(key)) return t(key, err.detail == null ? [] : err.detail);
  return t('reviewError_unknown', (err && err.message) || String(err));
}

const isBatched = () => config.provider === 'claude';

/** How many entries one click sends at most. */
const limit = () => (isBatched() ? BATCH_MAX : MAX_PER_RUN);

/**
 * What a click on "Send for review" would send: the entries of the current filter with a text,
 * without a proposal and not waiting in a batch — newest first, at most `limit()`.
 */
function candidates() {
  const waiting = waitingEntries();
  return matchingRecords().filter((record) => record.text && !record.suggestion && !waiting.has(record.id)).slice(0, limit());
}

function topics() {
  return reviewTopics(ctx.settings.aiTopics);
}

function readForm() {
  const provider = PROVIDERS.includes(els.provider.value) ? els.provider.value : DEFAULT_PROVIDER;
  // Claude has one address: an empty field means that one.
  const endpoint = els.endpoint.value.trim() || (provider === 'claude' ? DEFAULT_ENDPOINTS.claude : '');
  return { provider, endpoint, model: chosenModel(), apiKey: els.key.value.trim() };
}

/**
 * The address follows the chosen kind of API when it is empty or still Claude's, and so does the
 * list of models: `model` is the one to choose in it ('' = that API's default).
 */
function onProviderChanged(model = '') {
  const provider = PROVIDERS.includes(els.provider.value) ? els.provider.value : DEFAULT_PROVIDER;
  const typed = els.endpoint.value.trim();
  if (!typed || typed === DEFAULT_ENDPOINTS.claude) els.endpoint.value = provider === 'claude' ? DEFAULT_ENDPOINTS.claude : '';
  els.endpoint.placeholder = DEFAULT_ENDPOINTS[provider];
  els.endpoint.classList.remove('invalid');
  showModels(provider, readForm().endpoint, model);
  syncKey();
}

const scopeOf = (form) => ({ provider: form.provider, origin: originOf(form.endpoint) });

/**
 * A key goes only to the server it belongs to (`keyScope`). When the form points at another kind
 * of API or another server, the key in the field — saved or typed — is replaced by the key saved
 * for that one, or emptied, so neither "Fetch the list of models" nor "Save" sends it there; the
 * saved key comes back when the form points at the saved server again. A key typed before any
 * address was entered belongs to the first address entered. Returns true when a key was taken out
 * of the field (the caller then sends nothing).
 */
function syncKey() {
  const form = readForm();
  const scope = scopeOf(form);
  if (scope.provider === keyScope.provider && scope.origin === keyScope.origin) return false;
  if (form.apiKey && scope.provider === keyScope.provider && !keyScope.origin) {
    keyScope = scope;
    return false;
  }
  const saved = keyFor(config, form.provider, form.endpoint);
  const dropped = Boolean(form.apiKey) && form.apiKey !== saved;
  els.key.value = saved;
  keyScope = scope;
  if (dropped) showSaved(t('reviewKeyCleared'), '');
  return dropped;
}

/** Puts the saved settings into the form. */
function fillForm() {
  els.provider.value = config.provider;
  els.endpoint.value = config.endpoint;
  els.key.value = config.apiKey;
  keyScope = scopeOf(readForm());
  onProviderChanged(config.model);
}

/** The form shows the saved settings `value`, unchanged. */
function formShows(value) {
  const form = readForm();
  return ['provider', 'endpoint', 'model', 'apiKey'].every((field) => form[field] === value[field]);
}

/** The address in the form, or false after marking it as not one. */
function checkedEndpoint(form) {
  const valid = isValidEndpoint(form.endpoint);
  els.endpoint.classList.toggle('invalid', !valid);
  if (!valid) showSaved(t('reviewInvalidEndpoint', DEFAULT_ENDPOINTS[form.provider]), 'error');
  return valid;
}

/** Asks the API in the form (saved or not) which models it has. */
async function fetchModels() {
  if (syncKey()) return; // the key in the field was for another server
  const form = readForm();
  if (!checkedEndpoint(form)) return;
  els.refresh.disabled = true;
  try {
    showSaved(t('reviewModelsFetched', number(await refreshModels(form))), 'ok');
  } catch (err) {
    showSaved(t('reviewModelsFailed', describeError(err)), 'error');
  }
  els.refresh.disabled = false;
}

async function save() {
  if (syncKey()) return false; // the key in the field was for another server
  const form = readForm();
  if (!checkedEndpoint(form)) return false;
  if (!isValidModel(form.provider, form.model)) {
    markInvalidModel();
    showSaved(form.model ? t('reviewInvalidModel', DEFAULT_MODELS.claude) : t('reviewMissingModel'), 'error');
    return false;
  }
  closeConfirm(); // it named the settings saved before
  config = await saveReviewer(form);
  els.endpoint.value = config.endpoint;
  keyScope = scopeOf(readForm());
  showSaved(t('reviewSaved'), 'ok');
  renderReviewer();
  return true;
}

function showSaved(text, kind) {
  clearTimeout(savedTimer);
  els.saved.textContent = text;
  els.saved.className = kind ? `hint hint--${kind}` : 'hint';
  savedTimer = setTimeout(() => {
    els.saved.textContent = '';
  }, kind === 'error' ? 15000 : 5000);
}

function showResult(text, kind) {
  resultText = text;
  resultKind = kind;
}

/**
 * Asks the reviewer at `target` (the settings the confirmation named) about `records`, a few at a
 * time, with the topics `asked`, and stores each proposal as it arrives.
 */
async function start(records, target, asked) {
  const controller = new AbortController();
  const state = { strict: true };
  run = { controller, done: 0, errors: 0, total: records.length };
  showResult('', '');
  renderReviewer();
  const queue = [...records];
  let fatal = null;

  async function worker() {
    while (queue.length && !controller.signal.aborted) {
      const record = queue.shift();
      try {
        const answer = await review(target, record.text, asked, { signal: controller.signal, state });
        const suggestion = Object.assign(answer, { model: target.model, time: new Date().toISOString() });
        const saved = await Store.update(record.id, (stored) => {
          stored.suggestion = suggestion;
        });
        if (saved) record.suggestion = saved.suggestion;
        run.done += 1;
      } catch (err) {
        if (err.code === 'aborted') return;
        if (FATAL.has(err.code)) {
          fatal = fatal || err;
          controller.abort();
          return;
        }
        run.errors += 1; // this entry got no usable answer: the others go on
      }
      renderProgress();
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, records.length) }, worker));
  const { done, errors, total } = run;
  const stopped = controller.signal.aborted && !fatal;
  run = null;
  if (fatal) showResult(t('reviewFailed', [describeError(fatal), number(done), number(total)]), 'error');
  else if (stopped) showResult(t('reviewStopped', [number(done), number(total)]), '');
  else showResult(t('reviewDone', [number(done), number(errors)]), errors ? '' : 'ok');
  ctx.render();
}

function renderProgress() {
  if (!run) return;
  els.progress.max = run.total;
  els.progress.value = run.done + run.errors;
  els.progressText.textContent = t('reviewProgress', [number(run.done), number(run.total), number(run.errors)]);
}

/** Draws the card for the current records, filters and settings. */
export function renderReviewer() {
  const ready = isComplete(config);
  const asked = topics();
  const count = candidates().length;
  if (!ready) els.candidates.textContent = t(isBatched() ? 'reviewNeedConfigClaude' : 'reviewNeedConfig');
  else if (asked.length === 0) els.candidates.textContent = t('reviewNoTopics');
  else els.candidates.textContent = t('reviewCandidates', [number(count), number(limit())]);
  els.send.disabled = !ready || asked.length === 0 || count === 0 || Boolean(run) || isSending();
  renderModels();
  renderBatches();
  els.running.hidden = !run;
  if (run) closeConfirm();
  // the log was read again: an entry the confirmation names may be gone or reviewed meanwhile
  if (offer && !isStillOffered(offer, ctx.records)) expireConfirm();
  renderProgress();

  els.result.hidden = !resultText;
  els.result.textContent = resultText;
  els.result.className = resultKind ? `hint hint--${resultKind}` : 'hint';

  const stats = agreement(ctx.records);
  els.summary.hidden = stats.reviewed === 0;
  els.summaryHint.hidden = stats.reviewed === 0;
  if (stats.reviewed) renderAgreement(els.summary, stats);
  const pending = matchingRecords().filter(isPending).length;
  els.acceptAll.hidden = pending === 0 || Boolean(run);
  if (isSending()) closeConfirm();
  if (!acceptArmedTimer) els.acceptAll.textContent = t('reviewAcceptAll', number(pending));
}

/**
 * Opens the confirmation. What it names — the entries, the server, the model and the topics — is
 * taken now and is what "Send" sends: a filter changed, entries logged or settings edited
 * meanwhile do not change it. Saving other settings (here or in another tab) closes it, and so
 * does an entry it names that is no longer to be sent (see isStillOffered).
 */
function askToSend() {
  const records = candidates();
  if (records.length === 0) return;
  offer = { config: Object.assign({}, config), records, topics: topics() };
  const key = offer.config.provider === 'claude' ? 'reviewConfirmBatch' : 'reviewConfirm';
  els.confirmText.textContent = t(key, [number(records.length), hostOf(offer.config.endpoint), offer.config.model]);
  els.confirm.hidden = false;
  els.confirmSend.focus();
}

function closeConfirm() {
  offer = null;
  els.confirm.hidden = true;
}

/** Closes the confirmation because what it names can no longer be sent; nothing was sent. */
function expireConfirm() {
  closeConfirm();
  showResult(t('reviewConfirmExpired'), 'error');
}

/**
 * Every entry the confirmation names is still in the log (`records`), with the same text, without
 * a proposal and not waiting in a batch (sent from another tab meanwhile) — and the saved settings
 * are still the ones it names.
 */
function isStillOffered(named, records) {
  if (!['provider', 'endpoint', 'model', 'apiKey'].every((field) => named.config[field] === config[field])) return false;
  const byId = new Map(records.map((record) => [record.id, record]));
  const waiting = waitingEntries();
  return named.records.every((record) => {
    const now = byId.get(record.id);
    return Boolean(now) && now.text === record.text && !now.suggestion && !waiting.has(record.id);
  });
}

/**
 * "Send" in the confirmation: sends what it named, once — after reading the log again, so an entry
 * removed (e.g. by clearing the log in another tab) or reviewed meanwhile is never sent.
 */
async function confirmSend() {
  if (!offer || run || isSending()) return;
  const named = offer;
  closeConfirm();
  let records;
  try {
    records = await Store.all();
  } catch (err) {
    ctx.fail(t('statsReadFailed', err && err.message ? err.message : String(err)));
    return;
  }
  if (!isStillOffered(named, records)) {
    expireConfirm();
    ctx.reload();
    return;
  }
  if (run || isSending()) return;
  const { config: target, records: chosen, topics: asked } = named;
  if (target.provider === 'claude') sendBatch(target, chosen, asked);
  else start(chosen, target, asked);
}

/**
 * The settings were saved in another statistics page: the batches are checked with them from now
 * on (an old key is not used any more), the confirmation that named the old ones is closed, and the
 * form shows them unless it holds changes not saved yet.
 */
async function onReviewerChanged(changes, area) {
  if (area !== 'local' || !(STORAGE_KEY in changes)) return;
  const previous = config;
  const next = await loadReviewer();
  if (['provider', 'endpoint', 'model', 'apiKey'].every((field) => next[field] === previous[field])) return; // this page's own save
  const untouched = formShows(previous);
  config = next;
  if (untouched) fillForm();
  if (offer) expireConfirm();
  ctx.render();
}

/** The first click arms the button, a second one within a few seconds accepts the proposals. */
async function acceptFiltered() {
  const records = matchingRecords().filter(isPending);
  if (!acceptArmedTimer) {
    els.acceptAll.textContent = t('reviewAcceptAllConfirm', number(records.length));
    acceptArmedTimer = setTimeout(() => {
      acceptArmedTimer = 0;
      renderReviewer();
    }, 4000);
    return;
  }
  clearTimeout(acceptArmedTimer);
  acceptArmedTimer = 0;
  try {
    await acceptAll(records);
  } catch (err) {
    ctx.fail(t('statsWriteFailed', err.message));
  }
  ctx.render();
}

export async function initReviewer() {
  config = await loadReviewer();
  await initModels();
  fillForm();
  els.provider.addEventListener('change', () => onProviderChanged());
  els.save.addEventListener('click', save);
  els.refresh.addEventListener('click', fetchModels);
  els.endpoint.addEventListener('input', () => els.endpoint.classList.remove('invalid'));
  // When the address is entered (not on every character typed): a list fetched from another address
  // does not describe this one, and a key belongs to its server.
  els.endpoint.addEventListener('change', () => {
    showModels(readForm().provider, readForm().endpoint, chosenModel());
    syncKey();
  });
  // a key typed belongs to the kind of API and the server in the form at that moment
  els.key.addEventListener('input', () => {
    keyScope = scopeOf(readForm());
  });
  chrome.storage.onChanged.addListener(onReviewerChanged);
  els.send.addEventListener('click', askToSend);
  els.confirmCancel.addEventListener('click', closeConfirm);
  els.confirmSend.addEventListener('click', confirmSend);
  els.stop.addEventListener('click', () => run && run.controller.abort());
  els.acceptAll.addEventListener('click', acceptFiltered);
  await initBatches({
    config: () => config,
    describe: describeError,
    report: (text, kind) => showResult(text, kind),
  });
}

/** Once the page is drawn: looks at the batches that were waiting when the page was last closed. */
export function startReviewer() {
  resumeBatches();
}
