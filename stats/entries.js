/*
 * ParaBene – statistics page: the list of evaluated entries, its filters and the corrections.
 *
 * A correction ("should be hidden" / "should not be hidden") is stored with the entry
 * (Store.setLabel) and exported with the log. It does not change the filtering.
 */
import { Store, ctx, t } from './context.js';
import { dateTime, decimal, el, kindOf, number, reasonOf, siteRows, topicName } from './format.js';

const PAGE_SIZE = 50;
const LONG_TEXT = 240;

const $ = (id) => document.getElementById(id);
const controls = {
  verdict: $('filter-verdict'),
  source: $('filter-source'),
  site: $('filter-site'),
  label: $('filter-label'),
  search: $('filter-search'),
};
const found = $('found');
const list = $('entries');
const pager = $('pager');
const newer = $('newer');
const older = $('older');
const pageInfo = $('page-info');
/** Ids of the entries shown in full. */
const expanded = new Set();

function matches(record) {
  const { filters } = ctx;
  if (filters.verdict === 'hidden' && !record.hidden) return false;
  if (filters.verdict === 'shown' && record.hidden) return false;
  if (filters.source !== 'all' && kindOf(record) !== filters.source) return false;
  if (filters.site && record.host !== filters.site) return false;
  if (filters.label === 'corrected' && !record.label) return false;
  if (filters.label === 'uncorrected' && record.label) return false;
  if (filters.search) {
    const haystack = `${record.text}\n${record.url}\n${record.reason}`.toLocaleLowerCase(ctx.i18n.locale);
    if (!haystack.includes(filters.search)) return false;
  }
  return true;
}

/** Stores the user's correction ("hide" | "show", or null to take it back) and draws the page again. */
async function correct(record, label) {
  try {
    const saved = await Store.setLabel(record.id, label);
    if (!saved) return ctx.reload(); // the record is gone (the log was cleared elsewhere)
    delete record.label;
    delete record.labelTime;
    if (saved.label) Object.assign(record, { label: saved.label, labelTime: saved.labelTime });
    ctx.render();
  } catch (err) {
    ctx.fail(t('statsWriteFailed', err.message));
  }
}

function headNode(record) {
  const head = el('div', 'entry__head');
  head.append(el('span', `badge badge--${record.hidden ? 'hidden' : 'shown'}`, t(record.hidden ? 'statsBadgeHidden' : 'statsBadgeShown')));
  head.append(el('span', 'chip', t(`statsSource_${kindOf(record)}`)));
  const reason = record.hidden ? reasonOf(record) : '';
  if (reason) head.append(el('span', 'entry__reason', reason));
  const details = record.details || {};
  if (typeof details.score === 'number') {
    const text = typeof details.threshold === 'number'
      ? t('statsScore', [decimal(details.score), decimal(details.threshold)])
      : t('statsScoreOnly', decimal(details.score));
    head.append(el('span', 'entry__score', text));
  }
  const meta = el('span', 'entry__meta');
  meta.append(`${dateTime(record.lastTime || record.time)} · `);
  if (/^https?:/i.test(record.url)) {
    const link = el('a', '', record.host || record.url);
    link.href = record.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = t('statsOpenPage');
    meta.append(link);
  } else {
    meta.append(record.host || '');
  }
  head.append(meta);
  return head;
}

function textNodes(record, item) {
  if (!record.text) return [el('p', 'entry__text entry__text--none', t('statsNoText'))];
  const full = expanded.has(record.id);
  const nodes = [el('p', full ? 'entry__text' : 'entry__text entry__text--clamped', record.text)];
  if (record.text.length > LONG_TEXT) {
    const more = el('button', 'link', t(full ? 'statsLess' : 'statsMore'));
    more.type = 'button';
    more.addEventListener('click', () => {
      if (expanded.has(record.id)) expanded.delete(record.id);
      else expanded.add(record.id);
      item.replaceWith(entryNode(record));
    });
    nodes.push(more);
  }
  return nodes;
}

/** The model's probability for each topic, the highest first, and the model's name. */
function probabilitiesNode(details) {
  const probs = el('div', 'entry__probs');
  for (const [topic, value] of Object.entries(details.probabilities).sort((a, b) => b[1] - a[1])) {
    const part = el('span');
    part.append(`${topicName(topic)} `, el('b', '', decimal(value)));
    probs.append(part);
  }
  if (details.model) probs.append(el('span', '', details.model));
  return probs;
}

function footNode(record) {
  const foot = el('div', 'entry__foot');
  if (record.label) {
    foot.append(el('span', 'correction', t(record.label === 'hide' ? 'statsLabelHide' : 'statsLabelShow')));
    const undo = el('button', 'link', t('statsUndo'));
    undo.type = 'button';
    undo.addEventListener('click', () => correct(record, null));
    foot.append(undo);
  } else {
    // The correction is the opposite of the verdict.
    const wanted = record.hidden ? 'show' : 'hide';
    const mark = el('button', 'btn', t(wanted === 'show' ? 'statsMarkShow' : 'statsMarkHide'));
    mark.type = 'button';
    mark.addEventListener('click', () => correct(record, wanted));
    foot.append(mark);
  }
  if (record.revealed) foot.append(el('span', 'chip', t('statsFlagRevealed')));
  if (record.learned) foot.append(el('span', 'chip', t('statsFlagLearned')));
  if (record.count > 1) foot.append(el('span', 'chip', t('statsFlagRepeated', number(record.count))));
  return foot;
}

function entryNode(record) {
  const item = el('li', 'entry');
  item.dataset.id = String(record.id);
  item.append(headNode(record), ...textNodes(record, item));
  if (record.details && record.details.probabilities) item.append(probabilitiesNode(record.details));
  item.append(footNode(record));
  return item;
}

function renderSiteFilter() {
  const hosts = siteRows(ctx.records).map((row) => row.host).filter(Boolean);
  if (ctx.filters.site && !hosts.includes(ctx.filters.site)) ctx.filters.site = '';
  controls.site.replaceChildren(new Option(t('statsAllSites'), ''), ...hosts.map((host) => new Option(host, host)));
  controls.site.value = ctx.filters.site;
}

function renderList() {
  const { records } = ctx;
  const matching = records.filter(matches);
  const pages = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  ctx.page = Math.min(ctx.page, pages - 1);
  const from = ctx.page * PAGE_SIZE;
  const slice = matching.slice(from, from + PAGE_SIZE);
  found.textContent = records.length ? t('statsFound', [number(matching.length), number(records.length)]) : '';
  if (slice.length === 0) list.replaceChildren(el('li', 'empty', t(records.length ? 'statsNoMatch' : 'statsEmpty')));
  else list.replaceChildren(...slice.map(entryNode));
  pager.hidden = matching.length <= PAGE_SIZE;
  newer.disabled = ctx.page === 0;
  older.disabled = ctx.page >= pages - 1;
  pageInfo.textContent = matching.length
    ? t('statsPage', [number(from + 1), number(from + slice.length), number(matching.length)])
    : '';
}

export function renderEntries() {
  renderSiteFilter();
  renderList();
}

/** Filters the entries to one site (from the table of sites) and brings the list into view. */
export function showSite(host) {
  ctx.filters.site = host;
  ctx.page = 0;
  renderEntries();
  controls.site.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/** After the log was cleared. */
export function resetEntries() {
  expanded.clear();
  ctx.page = 0;
}

export function bindEntries() {
  const onFilter = (key, read = (value) => value) => {
    const control = controls[key];
    control.addEventListener(control.type === 'search' ? 'input' : 'change', () => {
      ctx.filters[key] = read(control.value);
      ctx.page = 0;
      renderList();
    });
  };
  onFilter('verdict');
  onFilter('source');
  onFilter('site');
  onFilter('label');
  onFilter('search', (value) => value.trim().toLocaleLowerCase(ctx.i18n.locale));
  const turn = (step) => {
    ctx.page = Math.max(0, ctx.page + step);
    renderList();
    list.scrollIntoView({ block: 'start' });
  };
  newer.addEventListener('click', () => turn(-1));
  older.addEventListener('click', () => turn(1));
}
