/*
 * ParaBene – statistics page: how the AI text model's scores are distributed.
 *
 * A histogram of the hide score (0–1) in ten ranges, hidden and shown stacked, with the current
 * hide threshold as a line: it shows what a higher or lower sensitivity would change. The same
 * numbers are available as a table, and each column tells its counts on hover.
 */
import { Config, ctx, t } from './context.js';
import { decimal, el, kindOf, number } from './format.js';

const BINS = 10;
const chart = document.getElementById('scores');
const hint = document.getElementById('scores-hint');
const legend = document.getElementById('scores-legend');
const data = document.getElementById('scores-data');
const tip = document.getElementById('tip');

function showTip(text, event) {
  tip.textContent = text;
  tip.hidden = false;
  const x = Math.min(event.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${event.clientY + 14}px`;
}

function hideTip() {
  tip.hidden = true;
}

/** Counts per score range: [{ hidden, shown }] and how many records had a score. */
function distribution() {
  const bins = Array.from({ length: BINS }, () => ({ hidden: 0, shown: 0 }));
  let scored = 0;
  for (const record of ctx.records) {
    const score = record.details && record.details.score;
    if (kindOf(record) !== 'aiText' || typeof score !== 'number') continue;
    const index = Math.min(BINS - 1, Math.max(0, Math.floor(score * BINS)));
    bins[index][record.hidden ? 'hidden' : 'shown'] += 1;
    scored += 1;
  }
  return { bins, scored };
}

export function renderScores() {
  const { bins, scored } = distribution();
  const threshold = Config.AI_SENSITIVITIES[ctx.settings.aiSensitivity];
  hint.textContent = scored ? t('statsScoresHint', [number(scored), decimal(threshold)]) : t('statsScoresEmpty');
  for (const node of [chart, legend, data]) node.hidden = scored === 0;
  if (scored === 0) return;

  const max = Math.max(...bins.map((bin) => bin.hidden + bin.shown));
  const range = (index) => `${decimal(index / BINS)}–${decimal((index + 1) / BINS)}`;
  const plot = el('div', 'chart__plot');
  bins.forEach((bin, index) => {
    const column = el('div', 'bin');
    const text = t('statsBinTip', [range(index), number(bin.hidden), number(bin.shown)]);
    for (const series of ['shown', 'hidden']) {
      if (bin[series] === 0) continue;
      const segment = el('div', `bin__seg bin__seg--${series}`);
      segment.style.height = `${Math.max(2, (bin[series] / max) * 100)}%`;
      column.append(segment);
    }
    column.append(el('span', 'bin__tick', decimal(index / BINS)));
    if (index === BINS - 1) column.append(el('span', 'bin__tick bin__tick--last', decimal(1)));
    column.addEventListener('mousemove', (event) => showTip(text, event));
    column.addEventListener('mouseleave', hideTip);
    plot.append(column);
  });
  const line = el('div', 'chart__threshold');
  line.style.left = `${threshold * 100}%`;
  plot.append(line);
  chart.replaceChildren(el('span', 'chart__max', number(max)), el('span', 'chart__zero', number(0)), plot);
  chart.setAttribute('aria-label', t('statsScoresAria', [number(scored), decimal(threshold)]));

  data.querySelector('tbody').replaceChildren(
    ...bins.map((bin, index) => {
      const tr = el('tr');
      tr.append(el('td', '', range(index)), el('td', 'num', number(bin.hidden)), el('td', 'num', number(bin.shown)));
      return tr;
    })
  );
}
