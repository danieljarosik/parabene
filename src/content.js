/*
 * ParaBene – DOM scanning and modification.
 *
 * This file finds content containers (posts, article tiles), extracts their
 * text and passes it to the evaluator (src/evaluators.js). Only the evaluator
 * decides whether something gets hidden — there is no text-scoring logic here.
 */
(() => {
  'use strict';

  if (globalThis.__parabeneContentLoaded) return;
  globalThis.__parabeneContentLoaded = true;

  const Config = globalThis.ParaBeneConfig;
  const Evaluators = globalThis.ParaBeneEvaluators;
  if (!Config || !Evaluators || !document.documentElement) return;

  const ATTR_CHECKED = 'data-parabene-checked';
  const ATTR_CANDIDATE = 'data-parabene-candidate';
  const ATTR_REVEALED = 'data-parabene-revealed';
  const ATTR_REASON = 'data-parabene-reason';
  const CLASS_HIDDEN = 'parabene-hidden';
  const CLASS_BAR = 'parabene-bar';

  const DEBOUNCE_MS = 200;
  const MAX_WAIT_MS = 1000;
  const STATS_DEBOUNCE_MS = 250;
  const MIN_TEXT_LENGTH = 3;
  const MAX_TEXT_LENGTH = 20000;

  const MAX_TILE_TEXT = 1500;
  const MAX_TILE_CLIMB = 6;
  const MAX_CONTAINER_TEXT = 6000;
  const MAX_HEADINGS_IN_CONTAINER = 4;

  const HEADING_SEL = 'h1, h2, h3';
  const HEADING_LINK_SEL = 'h1 a[href], h2 a[href], h3 a[href], a[href] h1, a[href] h2, a[href] h3';
  const ARTICLE_SEL = 'article, [role="article"], shreddit-post';
  const PAGE_LEVEL_SEL = [
    'html',
    'body',
    'main',
    'nav',
    'body > header',
    'body > footer',
    '[role="main"]',
    '[role="feed"]',
    '[role="banner"]',
    '[role="navigation"]',
    '[role="contentinfo"]',
  ].join(', ');
  const PAGE_LEVEL_DESCENDANT_SEL = 'main, [role="main"], [role="feed"]';
  const IGNORED_TEXT_SEL = [
    'script',
    'style',
    'noscript',
    'template',
    'textarea',
    'select',
    '[contenteditable]:not([contenteditable="false"])',
    `.${CLASS_BAR}`,
  ].join(', ');

  const state = {
    enabled: false,
    settings: null,
    evaluator: null,
    generation: 0,
    observer: null,
    pendingRoots: new Set(),
    fullScanPending: false,
    timer: 0,
    firstQueuedAt: 0,
    hiddenCount: 0,
    lastHref: location.href,
    textLengths: new WeakMap(),
    inFlight: new WeakSet(),
    dirty: new WeakSet(),
    statsTimer: 0,
    alive: true,
  };

  /* ------------------------------------------------------------------ */
  /* Container detection heuristics                                     */
  /* ------------------------------------------------------------------ */

  function selfAndDescendants(root, selector) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return [];
    const out = root.matches(selector) ? [root] : [];
    for (const el of root.querySelectorAll(selector)) out.push(el);
    return out;
  }

  /**
   * Facebook: CSS class names are randomly generated, so we rely solely on
   * accessibility attributes and the feed structure. Comments are nested
   * role="article" elements — each container is judged only by its own text,
   * so a profane comment hides just that comment, not the whole post.
   */
  const facebookAdapter = {
    name: 'facebook',
    selector: 'div[role="article"], div[role="feed"] > div, div[aria-posinset]',
    findCandidates(root) {
      return selfAndDescendants(root, this.selector).filter(
        (el) => !el.matches(PAGE_LEVEL_SEL) && !el.querySelector(PAGE_LEVEL_DESCENDANT_SEL)
      );
    },
  };

  /**
   * News portals and all other sites: <article> / role="article" elements and
   * tiles built around a linked h1–h3 heading. Safeguards reject page-level
   * containers (main, feed, navigation) and lists of multiple articles.
   */
  const genericAdapter = {
    name: 'generic',
    findCandidates(root) {
      if (!root || root.nodeType !== Node.ELEMENT_NODE) return [];
      const found = new Set();

      for (const article of selfAndDescendants(root, ARTICLE_SEL)) {
        if (isValidContainer(article)) found.add(article);
      }

      const headings = new Set();
      const enclosing = root.closest(HEADING_SEL);
      if (enclosing && isLinkedHeading(enclosing)) headings.add(enclosing);
      for (const el of selfAndDescendants(root, HEADING_LINK_SEL)) {
        const heading = el.matches(HEADING_SEL) ? el : el.closest(HEADING_SEL);
        if (heading) headings.add(heading);
      }
      for (const heading of headings) {
        const tile = tileForHeading(heading);
        if (tile) found.add(tile);
      }
      return [...found];
    },
  };

  function isLinkedHeading(heading) {
    return Boolean(heading.querySelector('a[href]') || heading.closest('a[href]'));
  }

  function isValidContainer(el) {
    if (el.matches(PAGE_LEVEL_SEL)) return false;
    if (el.querySelector(PAGE_LEVEL_DESCENDANT_SEL)) return false;
    if ((el.textContent || '').length > MAX_CONTAINER_TEXT) return false;
    if (el.querySelectorAll(HEADING_SEL).length > MAX_HEADINGS_IN_CONTAINER) return false;
    if (el.matches(ARTICLE_SEL) && el.querySelectorAll(ARTICLE_SEL).length > 1) return false;
    return true;
  }

  /** Climbs up from the heading to the largest ancestor that is still a single tile. */
  function tileForHeading(heading) {
    if (heading.closest(`.${CLASS_BAR}`)) return null;
    let tile = heading;
    for (let depth = 0; depth < MAX_TILE_CLIMB; depth += 1) {
      const parent = tile.parentElement;
      if (!parent || parent.matches(PAGE_LEVEL_SEL)) break;
      if (parent.matches(ARTICLE_SEL)) {
        if (isValidContainer(parent)) return parent;
        break;
      }
      if (parent.querySelectorAll(HEADING_SEL).length > 1) break;
      if ((parent.textContent || '').length > MAX_TILE_TEXT) break;
      tile = parent;
    }
    return isValidContainer(tile) ? tile : null;
  }

  const adapter = /(^|\.)facebook\.com$/i.test(location.hostname) ? facebookAdapter : genericAdapter;

  /* ------------------------------------------------------------------ */
  /* Text extraction                                                     */
  /* ------------------------------------------------------------------ */

  /** Container text, excluding nested containers (e.g. comments) and editable fields. */
  function ownText(container) {
    const parts = [];
    let length = 0;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
        if (node.hasAttribute(ATTR_CANDIDATE) || node.matches(IGNORED_TEXT_SEL)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;
      },
    });
    while (walker.nextNode()) {
      const value = walker.currentNode.nodeValue;
      if (!value) continue;
      parts.push(value);
      length += value.length;
      if (length >= MAX_TEXT_LENGTH) break;
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  /* ------------------------------------------------------------------ */
  /* Container evaluation                                                */
  /* ------------------------------------------------------------------ */

  async function evaluateCandidate(el) {
    if (!state.enabled || !el.isConnected || el.hasAttribute(ATTR_REVEALED)) return;
    if (state.inFlight.has(el)) {
      state.dirty.add(el);
      return;
    }

    const text = ownText(el);
    if (el.hasAttribute(ATTR_CHECKED) && state.textLengths.get(el) === text.length) return;
    state.textLengths.set(el, text.length);
    el.setAttribute(ATTR_CHECKED, 'true');

    if (text.length < MIN_TEXT_LENGTH) {
      if (el.classList.contains(CLASS_HIDDEN)) unhide(el);
      return;
    }

    const generation = state.generation;
    const evaluator = state.evaluator;
    state.inFlight.add(el);
    let result = null;
    try {
      result = await evaluator.evaluate(text);
    } catch (err) {
      console.warn('[ParaBene] Content evaluation failed:', err);
    } finally {
      state.inFlight.delete(el);
    }

    const rerun = state.dirty.has(el);
    state.dirty.delete(el);

    const stale = generation !== state.generation || !state.enabled;
    if (!stale && result && el.isConnected && !el.hasAttribute(ATTR_REVEALED)) {
      if (result.hide) hide(el, result);
      else if (el.classList.contains(CLASS_HIDDEN)) unhide(el);
    }
    if (rerun) evaluateCandidate(el);
  }

  /* ------------------------------------------------------------------ */
  /* Hiding and restoring                                                */
  /* ------------------------------------------------------------------ */

  function formatReason(result) {
    const reason = result.reason || 'niechciana treść';
    return result.source === 'ai' ? `${reason}, AI` : reason;
  }

  function directBar(el) {
    for (const child of el.children) {
      if (child.classList.contains(CLASS_BAR)) return child;
    }
    return null;
  }

  function createBar(container) {
    const bar = document.createElement('div');
    bar.className = CLASS_BAR;
    bar.setAttribute('role', 'note');

    const icon = document.createElement('span');
    icon.className = 'parabene-bar__icon';
    icon.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.className = 'parabene-bar__text';
    label.append('ParaBene ukryło treść ');
    const reason = document.createElement('span');
    reason.className = 'parabene-bar__reason';
    label.append(reason);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'parabene-bar__btn';
    button.textContent = 'Pokaż mimo wszystko';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      reveal(container);
    });

    // The bar may end up inside a link or a clickable post — clicking it
    // must not open the article.
    bar.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });

    bar.append(icon, label, button);
    return bar;
  }

  function hide(el, result) {
    const reason = formatReason(result);
    let bar = directBar(el);
    if (!bar) {
      bar = createBar(el);
      el.insertBefore(bar, el.firstChild);
    }
    bar.querySelector('.parabene-bar__reason').textContent = `(powód: ${reason})`;
    el.setAttribute(ATTR_REASON, reason);
    if (!el.classList.contains(CLASS_HIDDEN)) {
      el.classList.add(CLASS_HIDDEN);
      state.hiddenCount += 1;
      scheduleStats();
    }
  }

  function unhide(el) {
    const bar = directBar(el);
    if (bar) bar.remove();
    el.removeAttribute(ATTR_REASON);
    if (el.classList.contains(CLASS_HIDDEN)) {
      el.classList.remove(CLASS_HIDDEN);
      state.hiddenCount = Math.max(0, state.hiddenCount - 1);
      scheduleStats();
    }
  }

  function reveal(el) {
    el.setAttribute(ATTR_REVEALED, 'true');
    unhide(el);
  }

  /** If the page rebuilt the inside of a hidden container and removed the bar — insert it again. */
  function repairBar(node) {
    const hidden = node.closest(`.${CLASS_HIDDEN}`);
    if (hidden && !directBar(hidden)) {
      hide(hidden, { reason: hidden.getAttribute(ATTR_REASON) || '', source: 'keyword' });
    }
  }

  function unhideAll() {
    for (const el of document.querySelectorAll(`.${CLASS_HIDDEN}`)) unhide(el);
    for (const bar of document.querySelectorAll(`.${CLASS_BAR}`)) bar.remove();
    state.hiddenCount = 0;
    scheduleStats();
  }

  function resetChecks() {
    state.generation += 1;
    state.textLengths = new WeakMap();
    for (const el of document.querySelectorAll(`[${ATTR_CHECKED}]`)) el.removeAttribute(ATTR_CHECKED);
  }

  /* ------------------------------------------------------------------ */
  /* DOM observation                                                     */
  /* ------------------------------------------------------------------ */

  function queueRoot(node) {
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!el) return;
    state.pendingRoots.add(el);
    schedule();
  }

  /** Debounce with a maximum wait — a continuous stream of mutations cannot starve the scan. */
  function schedule() {
    const now = performance.now();
    if (!state.firstQueuedAt) state.firstQueuedAt = now;
    clearTimeout(state.timer);
    const wait = Math.max(0, Math.min(DEBOUNCE_MS, state.firstQueuedAt + MAX_WAIT_MS - now));
    state.timer = setTimeout(flush, wait);
  }

  function collapseRoots(roots) {
    const set = new Set(roots);
    return roots.filter((root) => {
      for (let p = root.parentElement; p; p = p.parentElement) {
        if (set.has(p)) return false;
      }
      return true;
    });
  }

  function flush() {
    state.timer = 0;
    state.firstQueuedAt = 0;
    if (!state.enabled || !state.alive) {
      state.pendingRoots.clear();
      state.fullScanPending = false;
      return;
    }

    if (location.href !== state.lastHref) {
      state.lastHref = location.href;
      state.hiddenCount = document.querySelectorAll(`.${CLASS_HIDDEN}`).length;
      scheduleStats();
    }

    const roots = state.fullScanPending
      ? [document.body || document.documentElement]
      : collapseRoots([...state.pendingRoots]);
    state.pendingRoots.clear();
    state.fullScanPending = false;

    const candidates = new Set();
    for (const root of roots) {
      if (!root.isConnected || root.closest(`.${CLASS_BAR}`)) continue;
      const owner = root.closest(`[${ATTR_CANDIDATE}]`);
      if (owner) candidates.add(owner);
      for (const candidate of adapter.findCandidates(root)) candidates.add(candidate);
      repairBar(root);
    }

    // Mark all containers first so that ownText() skips nested ones.
    for (const candidate of candidates) candidate.setAttribute(ATTR_CANDIDATE, '');
    for (const candidate of candidates) evaluateCandidate(candidate);
  }

  function onMutations(records) {
    for (const record of records) {
      if (record.type === 'characterData') {
        queueRoot(record.target);
        continue;
      }
      for (const node of record.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (!node.classList.contains(CLASS_BAR)) queueRoot(node);
        } else if (node.nodeType === Node.TEXT_NODE) {
          queueRoot(node);
        }
      }
    }
  }

  function start() {
    if (!state.observer) {
      state.observer = new MutationObserver(onMutations);
      state.observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    }
    state.fullScanPending = true;
    schedule();
  }

  function stop() {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    clearTimeout(state.timer);
    state.timer = 0;
    state.firstQueuedAt = 0;
    state.pendingRoots.clear();
    state.fullScanPending = false;
    resetChecks();
    unhideAll();
  }

  /* ------------------------------------------------------------------ */
  /* Settings, stats, messaging                                          */
  /* ------------------------------------------------------------------ */

  function buildEvaluator(settings) {
    return Evaluators.createEvaluator(settings, {
      categories: Config.categories(),
      transport: Evaluators.createRuntimeTransport(Config.MSG.CLASSIFY),
      timeoutMs: Config.AI_TIMEOUT_MS + 1000,
      maxChars: Config.AI_MAX_CHARS,
      onError: (err) => console.info('[ParaBene] Local AI model unavailable, falling back to keywords:', err.message),
    });
  }

  function applySettings(settings) {
    state.settings = settings;
    state.evaluator = buildEvaluator(settings);
    if (!settings.enabled) {
      state.enabled = false;
      stop();
      return;
    }
    state.enabled = true;
    // Re-evaluate everything without revealing first — elements that no longer
    // match get unhidden and new matches get hidden (no flicker).
    resetChecks();
    start();
  }

  function isContextAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  /** After the extension is reloaded, the old content script loses API access — shut it down then. */
  function teardown() {
    state.alive = false;
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    clearTimeout(state.timer);
    clearTimeout(state.statsTimer);
  }

  function scheduleStats() {
    clearTimeout(state.statsTimer);
    state.statsTimer = setTimeout(sendStats, STATS_DEBOUNCE_MS);
  }

  function sendStats() {
    if (!isContextAlive()) {
      teardown();
      return;
    }
    try {
      chrome.runtime
        .sendMessage({ type: Config.MSG.STATS, hidden: state.enabled ? state.hiddenCount : 0 })
        .catch(() => {});
    } catch (_) {
      teardown();
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== Config.MSG.GET_STATS) return false;
    sendResponse({
      hidden: state.enabled ? state.hiddenCount : 0,
      enabled: state.enabled,
      adapter: adapter.name,
    });
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !state.settings || !state.alive) return;
    const keys = Object.keys(Config.DEFAULT_SETTINGS).filter((key) => key in changes);
    if (keys.length === 0) return;
    const next = Object.assign({}, state.settings);
    for (const key of keys) {
      const value = changes[key].newValue;
      next[key] = value === undefined ? Config.DEFAULT_SETTINGS[key] : value;
    }
    applySettings(Config.sanitize(next));
  });

  Config.load()
    .then(applySettings)
    .catch((err) => console.warn('[ParaBene] Failed to load settings:', err));
})();
