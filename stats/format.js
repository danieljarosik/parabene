/*
 * ParaBene – statistics page: small helpers for building nodes, formatting values and reading a
 * record of the log (src/store.js describes a record).
 */
import { ctx, t } from './context.js';

/** The sources a verdict can come from, in the order they are listed. */
export const KINDS = ['keyword', 'aiText', 'aiImage', 'fallback'];

/** A new element with a class and text. Page text always goes in as text, never as markup. */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export const number = (value) => ctx.i18n.formatNumber(value);

/** A score or probability with two decimals, in the UI language. */
export const decimal = (value) => number(Math.round(value * 100) / 100);

export function percent(part, whole) {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

function formatDate(iso, options) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(ctx.i18n.locale, options).format(date);
}

export const dateTime = (iso) => formatDate(iso, { dateStyle: 'short', timeStyle: 'short' });
export const day = (iso) => formatDate(iso, { dateStyle: 'medium' });

/** Who decided: "keyword" | "aiText" | "aiImage" | "fallback" (keywords while the AI model was unavailable). */
export function kindOf(record) {
  if (record.media === 'image') return 'aiImage';
  if (record.source === 'ai') return 'aiText';
  return record.fallback ? 'fallback' : 'keyword';
}

/** The name of a topic or category id, in the UI language. */
export function topicName(id) {
  if (id === 'none') return t('statsTopicNone');
  const key = `category_${id}`;
  return ctx.i18n.has(key) ? t(key) : id;
}

/** Why a content was hidden: the category (a profane phrase is not shown itself) or the phrase. */
export function reasonOf(record) {
  return record.category ? topicName(record.category) : record.reason || '';
}

/** Per site: { host, total, hidden, corrected }, the most evaluated first. */
export function siteRows(records) {
  const sites = new Map();
  for (const record of records) {
    const host = record.host || '';
    const row = sites.get(host) || { host, total: 0, hidden: 0, corrected: 0 };
    row.total += 1;
    if (record.hidden) row.hidden += 1;
    if (record.label) row.corrected += 1;
    sites.set(host, row);
  }
  return [...sites.values()].sort((a, b) => b.total - a.total || a.host.localeCompare(b.host));
}
