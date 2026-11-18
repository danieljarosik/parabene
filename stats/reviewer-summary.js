/*
 * ParaBene – statistics page: how the reviewer's proposals compare with the extension's verdicts.
 *
 * One line of numbers over the whole log. Each number is a button that shows exactly those
 * entries in the list below: a proposal is not a correction until the user accepts it, so the
 * filter "corrections" does not find them.
 */
import { t } from './context.js';
import { el, number, percent } from './format.js';
import { showEntries } from './entries.js';

/** The parts of the line: the message, its numbers, and the filters that list the entries counted. */
const PARTS = [
  { id: 'reviewed', key: 'reviewSummaryReviewed', count: (stats) => stats.reviewed, filters: { suggestion: 'with' } },
  {
    id: 'agree',
    key: 'reviewSummaryAgree',
    count: (stats) => stats.agree,
    extra: (stats) => [String(percent(stats.agree, stats.reviewed))],
    filters: { suggestion: 'agree' },
  },
  { id: 'overHidden', key: 'reviewSummaryOverHidden', count: (stats) => stats.overHidden, filters: { verdict: 'hidden', suggestion: 'disagree' } },
  { id: 'missed', key: 'reviewSummaryMissed', count: (stats) => stats.missed, filters: { verdict: 'shown', suggestion: 'disagree' } },
  { id: 'pending', key: 'reviewSummaryPending', count: (stats) => stats.pending, filters: { suggestion: 'pending' } },
];

/** Draws the line into `node` for `stats` (suggestions.js: agreement()). */
export function renderAgreement(node, stats) {
  const parts = PARTS.map((part) => {
    const count = part.count(stats);
    const text = t(part.key, [number(count), ...(part.extra ? part.extra(stats) : [])]);
    if (count === 0) return text; // nothing to show
    const button = el('button', 'link', text);
    button.type = 'button';
    button.dataset.part = part.id;
    button.title = t('reviewSummaryShow');
    button.addEventListener('click', () => showEntries(part.filters));
    return button;
  });
  node.replaceChildren(...parts.flatMap((part, index) => (index ? [' · ', part] : [part])), '.');
}
