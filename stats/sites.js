/*
 * ParaBene – statistics page: the table of sites (how much was evaluated and hidden on each).
 * A click on a site filters the entries to it.
 */
import { ctx, t } from './context.js';
import { el, number, percent, siteRows } from './format.js';
import { showSite } from './entries.js';

const SHOWN = 12;
const body = document.getElementById('sites').tBodies[0];
const more = document.getElementById('sites-all');
let all = false;

more.addEventListener('click', () => {
  all = true;
  renderSites();
});

function shareBar(row) {
  const share = percent(row.hidden, row.total);
  const bar = el('div', 'share');
  const track = el('div', 'share__track');
  const fill = el('div', 'share__fill');
  fill.style.width = `${share}%`;
  track.append(fill);
  bar.append(track, el('span', 'share__value', `${share}%`));
  return bar;
}

export function renderSites() {
  const rows = siteRows(ctx.records);
  body.replaceChildren(
    ...(all ? rows : rows.slice(0, SHOWN)).map((row) => {
      const tr = el('tr');
      const name = el('td');
      const link = el('button', 'link', row.host || t('statsSiteUnknown'));
      link.type = 'button';
      link.title = t('statsSiteFilter');
      link.addEventListener('click', () => showSite(row.host));
      name.append(link);
      const share = el('td');
      share.append(shareBar(row));
      tr.append(name, el('td', 'num', number(row.total)), el('td', 'num', number(row.hidden)), share, el('td', 'num', number(row.corrected)));
      return tr;
    })
  );
  more.hidden = all || rows.length <= SHOWN;
  more.textContent = t('statsSitesAll', number(rows.length));
}
