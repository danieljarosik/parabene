/*
 * ParaBene – panel: the card of the log of evaluated content.
 *
 * Shows how much is in the log (src/store.js) and opens the statistics page (stats/), where the
 * log is browsed, corrected, downloaded and cleared. The switch that turns recording on is an
 * ordinary setting and stays with the other switches in popup.js.
 */
(function (root) {
  'use strict';

  const Config = root.ParaBeneConfig;
  const Store = root.ParaBeneStore;

  /**
   * @param {{t: Function, formatNumber: Function, showFeedback: Function}} ui  the panel's own
   *        helpers: a message in the UI language, a number in it, and a hint's text with its kind.
   * @returns {{render: Function, refresh: Function}}  render(settings) draws the card again (after
   *        a settings or language change); refresh() reads the counts from the log first.
   */
  function create({ t, formatNumber, showFeedback }) {
    const count = document.getElementById('log-count');
    const status = document.getElementById('log-status');
    const open = document.getElementById('log-open');
    let counts = { total: 0, hidden: 0, shown: 0, corrected: 0 };
    let enabled = false;
    let failure = '';

    function render(settings) {
      if (settings) enabled = settings.evalLogEnabled;
      count.textContent = formatNumber(counts.total);
      if (failure) {
        showFeedback(status, t('logReadFailed', failure), 'error');
      } else if (counts.total === 0) {
        showFeedback(status, t(enabled ? 'logEmpty' : 'logOff'), null);
      } else {
        const numbers = [counts.total, counts.hidden, counts.shown, counts.corrected].map(formatNumber);
        showFeedback(status, t('logSummary', numbers), null);
      }
    }

    async function refresh() {
      try {
        counts = await Store.counts();
        failure = '';
      } catch (err) {
        failure = err && err.message ? err.message : String(err);
      }
      render();
    }

    open.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL(Config.STATS_PAGE) });
    });
    Store.subscribe(refresh); // the service worker has written new evaluations

    return { render, refresh };
  }

  root.ParaBeneLogCard = Object.freeze({ create });
})(globalThis);
