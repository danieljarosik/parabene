/*
 * ParaBene – statistics page: the headline numbers and the table "who decided".
 */
import { ctx, t } from './context.js';
import { KINDS, day, el, kindOf, number, percent, siteRows } from './format.js';

const tiles = document.getElementById('tiles');
const sources = document.getElementById('sources').tBodies[0];

function tile(label, value, note, small) {
  const node = el('div', 'tile');
  node.append(el('div', 'tile__label', label));
  node.append(el('div', small ? 'tile__value tile__value--small' : 'tile__value', value));
  if (note) node.append(el('div', 'tile__note', note));
  return node;
}

function renderTiles() {
  const { records } = ctx;
  const total = records.length;
  const hidden = records.filter((record) => record.hidden).length;
  const corrected = records.filter((record) => record.label).length;
  const share = (part) => (total ? t('statsShare', String(percent(part, total))) : '');
  const nodes = [
    tile(t('statsTileEvaluated'), number(total)),
    tile(t('statsTileHidden'), number(hidden), share(hidden)),
    tile(t('statsTileShown'), number(total - hidden), share(total - hidden)),
    tile(t('statsTileCorrected'), number(corrected)),
  ];
  if (total) {
    // The first evaluation of any record and the last one of any record.
    let oldest = records[0].time;
    let newest = records[0].lastTime || records[0].time;
    for (const record of records) {
      if (Date.parse(record.time) < Date.parse(oldest)) oldest = record.time;
      const last = record.lastTime || record.time;
      if (Date.parse(last) > Date.parse(newest)) newest = last;
    }
    const sites = t('statsSites', number(siteRows(records).length));
    nodes.push(tile(t('statsTilePeriod'), `${day(oldest)} – ${day(newest)}`, sites, true));
  }
  tiles.replaceChildren(...nodes);
}

function renderSources() {
  const rows = KINDS.map((kind) => {
    const of = ctx.records.filter((record) => kindOf(record) === kind);
    return {
      kind,
      total: of.length,
      hidden: of.filter((record) => record.hidden).length,
      corrected: of.filter((record) => record.label).length,
    };
  }).filter((row) => row.total > 0);
  if (rows.length === 0) {
    const tr = el('tr');
    const td = el('td', 'empty', t('statsEmpty'));
    td.colSpan = 5;
    tr.append(td);
    sources.replaceChildren(tr);
    return;
  }
  sources.replaceChildren(
    ...rows.map((row) => {
      const tr = el('tr');
      tr.append(
        el('td', '', t(`statsSource_${row.kind}`)),
        el('td', 'num', number(row.total)),
        el('td', 'num', number(row.hidden)),
        el('td', 'num', number(row.total - row.hidden)),
        el('td', 'num', number(row.corrected))
      );
      return tr;
    })
  );
}

export function renderSummary() {
  renderTiles();
  renderSources();
}
