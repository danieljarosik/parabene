/*
 * ParaBene – statistics page: what its modules share.
 *
 * `ctx` holds the page's state; the main module (stats.js) fills in `render` and `reload`, so the
 * other modules can ask for the page to be drawn or read again without importing it.
 */
export const Config = self.ParaBeneConfig;
export const I18n = self.ParaBeneI18n;
export const Store = self.ParaBeneStore;

export const ctx = {
  settings: Config.sanitize({}),
  i18n: I18n.createTranslator(Config.DEFAULT_LANGUAGE, null),
  /** All records of the log, newest first. */
  records: [],
  /** What the list of entries shows. */
  filters: { verdict: 'all', source: 'all', site: '', label: 'all', suggestion: 'all', search: '' },
  page: 0,
  /** Draws the whole page again from `records` and `settings`. */
  render: () => {},
  /** Reads the log again, then draws. */
  reload: async () => {},
  /** Shows an error at the top of the page for a few seconds ('' removes it). */
  fail: () => {},
};

/** A message in the UI language. */
export const t = (key, substitutions) => ctx.i18n.t(key, substitutions);
