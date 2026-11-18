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
  DEFAULT_ENDPOINTS, DEFAULT_MODELS, DEFAULT_PROVIDER, PROVIDERS, hostOf, isComplete, isValidEndpoint, isValidModel, loadReviewer,
  saveReviewer,
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
  const form = readForm();
  if (!checkedEndpoint(form)) return false;
  if (!isValidModel(form.provider, form.model)) {
    markInvalidModel();
    showSaved(form.model ? t('reviewInvalidModel', DEFAULT_MODELS.claude) : t('reviewMissingModel'), 'error');
    return false;
  }
  config = await saveReviewer(form);
  els.endpoint.value = config.endpoint;
  showSaved(t('reviewSaved'), 'ok');
  renderReviewer();
  return true;
}

function showSaved(text, kind) {
  clearTimeout(savedTimer);
  els.saved.textContent = text;
  els.saved.className = `hint hint--${kind}`;
  savedTimer = setTimeout(() => {
    els.saved.textContent = '';
  }, kind === 'error' ? 15000 : 5000);
}

function showResult(text, kind) {
  resultText = text;
  resultKind = kind;
}

/** Asks the reviewer about `records`, a few at a time, and stores each proposal as it arrives. */
async function start(records) {
  const controller = new AbortController();
  const state = { strict: true };
  const asked = topics();
  run = { controller, done: 0, errors: 0, total: records.length };
  showResult('', '');
  renderReviewer();
  const queue = [...records];
  let fatal = null;

  async function worker() {
    while (queue.length && !controller.signal.aborted) {
      const record = queue.shift();
      try {
        const answer = await review(config, record.text, asked, { signal: controller.signal, state });
        const suggestion = Object.assign(answer, { model: config.model, time: new Date().toISOString() });
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
  if (run) els.confirm.hidden = true;
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
  if (isSending()) els.confirm.hidden = true;
  if (!acceptArmedTimer) els.acceptAll.textContent = t('reviewAcceptAll', number(pending));
}

function askToSend() {
  const count = candidates().length;
  if (count === 0) return;
  const key = isBatched() ? 'reviewConfirmBatch' : 'reviewConfirm';
  els.confirmText.textContent = t(key, [number(count), hostOf(config.endpoint), config.model]);
  els.confirm.hidden = false;
  els.confirmSend.focus();
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
  els.provider.value = config.provider;
  els.endpoint.value = config.endpoint;
  els.key.value = config.apiKey;
  await initModels();
  onProviderChanged(config.model);
  els.provider.addEventListener('change', () => onProviderChanged());
  els.save.addEventListener('click', save);
  els.refresh.addEventListener('click', fetchModels);
  els.endpoint.addEventListener('input', () => els.endpoint.classList.remove('invalid'));
  // a list fetched from another address does not describe this one
  els.endpoint.addEventListener('change', () => showModels(readForm().provider, readForm().endpoint, chosenModel()));
  els.send.addEventListener('click', askToSend);
  els.confirmCancel.addEventListener('click', () => {
    els.confirm.hidden = true;
  });
  els.confirmSend.addEventListener('click', () => {
    els.confirm.hidden = true;
    if (isBatched()) sendBatch(config, candidates(), topics());
    else start(candidates());
  });
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
