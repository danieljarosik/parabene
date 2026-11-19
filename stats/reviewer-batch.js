/*
 * ParaBene – statistics page: the batches of entries Claude is reviewing.
 *
 * A Message Batch (reviewer-claude.js) is answered later, usually within an hour, so the page
 * cannot wait for it the way it waits for one request per entry. Every batch that was sent is
 * kept in chrome.storage.local under a key of its own — its id, where it was sent, the model, the
 * topics asked about and the numbers of its entries (per request, in the order their texts were
 * sent: an answer names a text by its position), never the key or a text — so the answers can be
 * collected after the page was closed and opened again. The card lists the batches in a table.
 *
 * Several batches can wait at once; an entry that is in one of them is not sent again. While a
 * batch is waiting, the page asks the API for its state when it is opened, once a minute while it
 * stays open, and on "Check now". These requests carry the key and the batch's id, never a text.
 * When a batch has ended, its answers are stored with the entries as proposals (suggestions.js
 * shows them) and its row keeps the outcome until it is removed from the list.
 */
import { Store, ctx, t } from './context.js';
import { dateTime, el, number } from './format.js';
import { batchResults, cancelBatch, createBatch, retrieveBatch } from './reviewer-claude.js';
import { reviewError } from './reviewer-client.js';
import { hostOf, keyFor } from './reviewer-config.js';

export const STORAGE_KEY = 'reviewerBatches';
/** Where the one batch of an earlier version was kept. */
const LEGACY_KEY = 'reviewerBatch';
/** Entries sent in one batch. */
export const BATCH_MAX = 2000;
const POLL_MS = 60000;
/** Ended batches kept in the list (the waiting ones are all kept). */
const KEEP_ENDED = 10;
const STATUSES = ['in_progress', 'canceling', 'ended'];

const $ = (id) => document.getElementById(id);
const els = {
  box: $('review-batches'),
  sending: $('review-batch-sending'),
  check: $('review-batch-check'),
  rows: document.querySelector('#review-batch-table tbody'),
};

/**
 * The batches, newest first:
 *   { id, endpoint, model, topics, entries, groups, total, time, status, result }
 * `entries` are the numbers of the log entries sent and `groups` the same numbers per request of
 * the batch, in the order sent (both emptied once the batch has ended; a batch of an earlier
 * version, with a request per entry, has no groups), `status`
 * is "in_progress" | "canceling" | "ended", `result` the outcome of an ended batch:
 * { done, errors, unanswered, firstError }.
 */
let batches = [];
/** How many entries are being sent right now (0 = none). */
let sending = 0;
/** Requests about the batches are under way. */
let busy = false;
/** Per batch id: why the last request about it failed. Not stored. */
const notes = new Map();
let timer = 0;
/** From the panel: the saved API settings, where a failure to send is shown, and how an error reads. */
let hooks = { config: () => ({}), report: () => {}, describe: (err) => String(err) };

const isWaiting = (batch) => batch.status !== 'ended';
const count = (value) => (Number.isFinite(value) && value >= 0 ? value : 0);

function clean(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id || typeof raw.endpoint !== 'string') return null;
  const status = STATUSES.includes(raw.status) ? raw.status : raw.canceling === true ? 'canceling' : 'in_progress';
  const result = raw.result && typeof raw.result === 'object' ? raw.result : {};
  return {
    id: raw.id,
    endpoint: raw.endpoint,
    model: typeof raw.model === 'string' ? raw.model : '',
    topics: Array.isArray(raw.topics) ? raw.topics.filter((id) => typeof id === 'string') : [],
    entries: Array.isArray(raw.entries) ? raw.entries.filter(Number.isFinite) : [],
    groups: Array.isArray(raw.groups) ? raw.groups.filter(Array.isArray).map((group) => group.filter(Number.isFinite)) : [],
    total: count(raw.total),
    time: typeof raw.time === 'string' ? raw.time : '',
    status,
    result: status === 'ended' ? {
      done: count(result.done),
      errors: count(result.errors),
      unanswered: count(result.unanswered),
      firstError: typeof result.firstError === 'string' ? result.firstError : '',
    } : null,
  };
}

const cleanList = (raw) => (Array.isArray(raw) ? raw.map(clean).filter(Boolean) : []);

/** The numbers of the entries that are in a waiting batch: they are not sent again. */
export function waitingEntries() {
  const ids = new Set();
  for (const batch of batches) if (isWaiting(batch)) for (const id of batch.entries) ids.add(id);
  return ids;
}

/** A batch is being created right now. */
export function isSending() {
  return sending > 0;
}

/**
 * Where a batch was sent, with the key as it is saved now (a key is never stored with a batch) —
 * only when the saved settings are the Claude API on that same server. Otherwise nothing is asked:
 * the key saved for another API must not go there. Throws `batchKey` then.
 */
function access(batch) {
  const apiKey = keyFor(hooks.config(), 'claude', batch.endpoint);
  if (!apiKey) throw reviewError('batchKey', hostOf(batch.endpoint));
  return { endpoint: batch.endpoint, model: batch.model, apiKey };
}

function schedule() {
  clearTimeout(timer);
  if (batches.some(isWaiting)) timer = setTimeout(checkAll, POLL_MS);
}

/** Changes the batch with this id, wherever the list is by now. */
function patch(id, change) {
  const batch = batches.find((entry) => entry.id === id);
  if (batch) Object.assign(batch, change);
}

async function persist() {
  let ended = 0;
  batches = batches.filter((batch) => isWaiting(batch) || (ended += 1) <= KEEP_ENDED);
  await chrome.storage.local.set({ [STORAGE_KEY]: batches });
  schedule();
}

/** Sends `records` to Claude as one batch and adds it to the list. */
export async function sendBatch(config, records, topics) {
  if (sending || records.length === 0) return;
  sending = records.length;
  hooks.report('', '');
  ctx.render();
  try {
    const batch = await createBatch(config, records, topics);
    batches.unshift(clean({
      id: batch.id,
      endpoint: config.endpoint,
      model: config.model,
      topics,
      entries: records.map((record) => record.id),
      groups: batch.groups,
      total: records.length,
      time: new Date().toISOString(),
      status: 'in_progress',
    }));
    await persist();
  } catch (err) {
    hooks.report(t('reviewBatchNotSent', hooks.describe(err)), 'error');
  }
  sending = 0;
  ctx.render();
}

/** Stores the answers of an ended batch with their entries and notes the outcome in its row. */
async function collect(batch) {
  const outcome = await batchResults(access(batch), batch.id, batch.topics, batch.groups);
  const time = new Date().toISOString();
  let done = 0;
  for (const { id, answer } of outcome.answers) {
    // An entry reviewed meanwhile keeps its proposal (and what the user decided about it).
    const saved = await Store.update(id, (stored) => {
      if (!stored.suggestion) stored.suggestion = Object.assign({}, answer, { model: batch.model, time });
    });
    if (saved) done += 1; // null: the entry was removed from the log while the batch was processed
  }
  patch(batch.id, {
    status: 'ended',
    entries: [],
    groups: [],
    topics: [],
    result: { done, errors: outcome.errors, unanswered: outcome.unanswered, firstError: outcome.firstError },
  });
}

/** Asks the API for the state of every waiting batch and collects the answers of those that have ended. */
async function checkAll() {
  if (busy || !batches.some(isWaiting)) return;
  busy = true;
  renderBatches();
  let collected = false;
  for (const batch of batches.filter(isWaiting)) {
    try {
      const state = await retrieveBatch(access(batch), batch.id);
      if (state.status === 'ended') {
        await collect(batch);
        collected = true;
      } else if (state.status === 'canceling') {
        patch(batch.id, { status: 'canceling' });
      }
      notes.delete(batch.id);
    } catch (err) {
      notes.set(batch.id, t('reviewBatchCheckFailed', hooks.describe(err)));
    }
  }
  await persist();
  busy = false;
  if (collected) await ctx.reload();
  else ctx.render();
}

/** Asks the API to stop a batch; what it had answered by then is still collected. */
async function cancel(id) {
  const batch = batches.find((entry) => entry.id === id);
  if (!batch || busy || !isWaiting(batch)) return;
  busy = true;
  renderBatches();
  try {
    await cancelBatch(access(batch), id);
    patch(id, { status: 'canceling' });
    notes.delete(id);
    await persist();
  } catch (err) {
    notes.set(id, t('reviewBatchCheckFailed', hooks.describe(err)));
  }
  busy = false;
  ctx.render();
  if (!notes.has(id)) checkAll();
}

/** Takes a batch off the list. For a waiting one this gives up its answers. */
async function remove(id) {
  batches = batches.filter((batch) => batch.id !== id);
  notes.delete(id);
  await persist();
  ctx.render();
}

function statusText(batch) {
  if (batch.status !== 'ended') return t(`reviewBatchStatus_${batch.status}`);
  const { done, errors, unanswered } = batch.result;
  return t('reviewBatchStatus_ended', [number(done), number(batch.total), number(errors), number(unanswered)]);
}

function action(name, id, label) {
  const button = el('button', 'link', label);
  button.type = 'button';
  button.dataset.action = name;
  button.dataset.id = id;
  button.disabled = busy;
  return button;
}

function row(batch) {
  const line = el('tr');
  line.dataset.id = batch.id;
  line.dataset.status = batch.status;
  line.append(el('td', 'mono', batch.id), el('td', '', batch.model), el('td', 'num', number(batch.total)),
    el('td', '', batch.time ? dateTime(batch.time) : ''));
  const status = el('td', 'batch__status', statusText(batch));
  const detail = notes.get(batch.id) || (batch.result && batch.result.firstError ? t('reviewBatchFirstError', batch.result.firstError) : '');
  if (detail) status.append(el('div', notes.has(batch.id) ? 'hint hint--error' : 'hint', detail));
  const actions = el('td', 'batch__actions');
  if (batch.status === 'in_progress') actions.append(action('cancel', batch.id, t('reviewBatchCancel')));
  // A waiting batch can only be dropped when it cannot be reached: dropping it gives up its answers.
  if (!isWaiting(batch) || notes.has(batch.id)) actions.append(action('remove', batch.id, t('reviewBatchRemove')));
  line.append(status, actions);
  return line;
}

/** Draws the list of batches (the panel calls it with the rest of the card). */
export function renderBatches() {
  els.box.hidden = batches.length === 0 && !sending;
  els.sending.hidden = !sending;
  els.sending.textContent = sending ? t('reviewBatchSending', number(sending)) : '';
  els.check.hidden = !batches.some(isWaiting);
  els.check.disabled = busy;
  els.rows.replaceChildren(...batches.map(row));
}

async function load() {
  const stored = await chrome.storage.local.get([STORAGE_KEY, LEGACY_KEY]);
  batches = cleanList(stored[STORAGE_KEY]);
  const legacy = clean(stored[LEGACY_KEY]);
  if (legacy && !batches.some((batch) => batch.id === legacy.id)) batches.push(legacy);
  if (LEGACY_KEY in stored) {
    await persist();
    await chrome.storage.local.remove(LEGACY_KEY);
  }
}

export async function initBatches(options) {
  hooks = Object.assign(hooks, options);
  await load();
  els.check.addEventListener('click', checkAll);
  els.rows.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    if (button.dataset.action === 'cancel') cancel(button.dataset.id);
    else remove(button.dataset.id);
  });
  // Another statistics page open in the same browser sent, collected or removed a batch.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(STORAGE_KEY in changes)) return;
    const next = cleanList(changes[STORAGE_KEY].newValue);
    if (JSON.stringify(next) === JSON.stringify(batches)) return; // this page's own change
    batches = next;
    schedule();
    ctx.render();
  });
}

/** Once the page is drawn: looks at the batches left waiting when the page was last closed. */
export function resumeBatches() {
  checkAll();
}
