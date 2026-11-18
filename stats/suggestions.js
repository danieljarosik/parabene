/*
 * ParaBene – statistics page: what the external reviewer model proposed for an entry.
 *
 * A suggestion ({ verdict, topic, reason, model, time, rejected? }) is only a proposal. When it
 * disagrees with the verdict the extension gave, the user accepts it — it then becomes their
 * correction (`label`) — or rejects it. Nothing here changes the filtering.
 */
import { Store, ctx, t } from './context.js';
import { el, topicName } from './format.js';

/** Does the reviewer agree with the extension's verdict? null when the entry was not reviewed. */
export function agrees(record) {
  if (!record.suggestion) return null;
  return (record.suggestion.verdict === 'hide') === Boolean(record.hidden);
}

/** A disagreement the user has not decided yet: neither accepted (as a correction) nor rejected. */
export function isPending(record) {
  const suggestion = record.suggestion;
  return Boolean(suggestion) && agrees(record) === false && !suggestion.rejected && record.label !== suggestion.verdict;
}

/** The entries filter "larger model": all | with | agree | disagree | pending | without. */
export function matchesSuggestion(record, filter) {
  if (filter === 'with') return Boolean(record.suggestion);
  if (filter === 'without') return !record.suggestion;
  if (filter === 'agree') return agrees(record) === true;
  if (filter === 'disagree') return agrees(record) === false;
  if (filter === 'pending') return isPending(record);
  return true;
}

/** How the reviewer's proposals compare with the extension's verdicts. */
export function agreement(records) {
  const out = { reviewed: 0, agree: 0, overHidden: 0, missed: 0, pending: 0 };
  for (const record of records) {
    const same = agrees(record);
    if (same === null) continue;
    out.reviewed += 1;
    if (same) out.agree += 1;
    else if (record.hidden) out.overHidden += 1; // hidden, the reviewer would show it
    else out.missed += 1; // shown, the reviewer would hide it
    if (isPending(record)) out.pending += 1;
  }
  return out;
}

/** Writes the change to the database and to the record on the page. */
async function change(record, edit) {
  const saved = await Store.update(record.id, edit);
  if (saved) Object.assign(record, { suggestion: saved.suggestion, label: saved.label, labelTime: saved.labelTime });
  if (saved && !saved.label) {
    delete record.label;
    delete record.labelTime;
  }
  return saved;
}

/** Accepting makes the proposal the user's correction. */
const accept = (record) =>
  change(record, (stored) => {
    if (!stored.suggestion) return;
    stored.label = stored.suggestion.verdict;
    stored.labelTime = new Date().toISOString();
    delete stored.suggestion.rejected;
  });

const reject = (record) =>
  change(record, (stored) => {
    if (stored.suggestion) stored.suggestion.rejected = true;
  });

async function decide(record, action) {
  try {
    if (!(await action(record))) return ctx.reload(); // the record is gone
    ctx.render();
  } catch (err) {
    ctx.fail(t('statsWriteFailed', err.message));
  }
}

/** Accepts every undecided proposal among `records`. Resolves with how many were accepted. */
export async function acceptAll(records) {
  let accepted = 0;
  for (const record of records.filter(isPending)) {
    if (await accept(record)) accepted += 1;
  }
  return accepted;
}

/** The line under an entry that shows the proposal, with the buttons while it is undecided. */
export function suggestionNode(record) {
  const suggestion = record.suggestion;
  const node = el('div', 'suggestion');
  const text = suggestion.verdict === 'hide'
    ? t('reviewSuggestionHide', [suggestion.model || '?', topicName(suggestion.topic || 'none')])
    : t('reviewSuggestionShow', suggestion.model || '?');
  node.append(el('span', 'suggestion__verdict', text));
  if (suggestion.reason) node.append(el('span', 'suggestion__reason', suggestion.reason));
  if (agrees(record)) {
    node.append(el('span', 'chip', t('reviewAgrees')));
  } else if (isPending(record)) {
    const yes = el('button', 'btn', t('reviewAccept'));
    yes.type = 'button';
    yes.addEventListener('click', () => decide(record, accept));
    const no = el('button', 'link', t('reviewReject'));
    no.type = 'button';
    no.addEventListener('click', () => decide(record, reject));
    node.append(yes, no);
  } else if (suggestion.rejected) {
    node.append(el('span', 'chip', t('reviewRejected')));
  }
  return node;
}
