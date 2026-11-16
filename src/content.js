/*
 * ParaBene – DOM scanning and modification.
 *
 * This file finds content containers (posts, article tiles), extracts their
 * text and passes it to the evaluator (src/evaluators.js). Only the evaluator
 * decides whether something gets hidden — there is no text-scoring logic here.
 * With image evaluation on, the pictures of containers the text did not hide are
 * judged by the service worker (the multimodal model), nearest the viewport first.
 */
(() => {
  'use strict';

  if (globalThis.__parabeneContentLoaded) return;
  globalThis.__parabeneContentLoaded = true;

  const Config = globalThis.ParaBeneConfig;
  const I18n = globalThis.ParaBeneI18n;
  const Evaluators = globalThis.ParaBeneEvaluators;
  if (!Config || !I18n || !Evaluators || !document.documentElement) return;

  const ATTR_CHECKED = 'data-parabene-checked';
  const ATTR_CANDIDATE = 'data-parabene-candidate';
  const ATTR_REVEALED = 'data-parabene-revealed';
  const ATTR_REASON = 'data-parabene-reason';
  const ATTR_SOURCE = 'data-parabene-source';
  const ATTR_CATEGORY = 'data-parabene-category';
  const ATTR_MEDIA = 'data-parabene-media';
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

  /** Pictures are judged when their container comes within this distance of the viewport. */
  const IMAGE_ROOT_MARGIN = '600px 0px';
  /** Rendered size below which a picture is an icon or an avatar (px). */
  const IMAGE_MIN_RENDERED_WIDTH = 80;
  const IMAGE_MIN_RENDERED_HEIGHT = 60;
  /** How long image evaluation pauses after the image server failed. */
  const IMAGE_COOLDOWN_MS = 30000;
  /** Errors that concern one picture only (it is skipped); anything else pauses image evaluation. */
  const IMAGE_SKIP_ERRORS = new Set(['imageFetch', 'imageDecode', 'imageTooSmall']);

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
    i18n: null,
    languageSeq: 0,
    evaluator: null,
    generation: 0,
    observer: null,
    pendingRoots: new Set(),
    fullScanPending: false,
    timer: 0,
    firstQueuedAt: 0,
    hidden: { keyword: 0, ai: 0 },
    hiddenItems: new WeakMap(),
    lastHref: location.href,
    textLengths: new WeakMap(),
    inFlight: new WeakSet(),
    dirty: new WeakSet(),
    statsTimer: 0,
    alive: true,
    images: {
      enabled: false,
      observer: null,
      pending: new Set(),
      visible: new Set(),
      active: 0,
      retryAt: 0,
      retryTimer: 0,
      checked: new WeakMap(),
      listening: new WeakSet(),
    },
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
      if (el.classList.contains(CLASS_HIDDEN) && !hiddenByImage(el)) unhide(el);
      queueImageCheck(el);
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
      if (result.hide) {
        const previous = hiddenSource(el);
        const byImage = hiddenByImage(el);
        hide(el, result);
        state.hiddenItems.set(el, { text });
        if (previous !== hiddenSource(el) || byImage) logHidden(text, result);
      } else {
        // A container hidden because of its picture stays hidden until the picture is judged again.
        if (el.classList.contains(CLASS_HIDDEN) && !hiddenByImage(el)) unhide(el);
        queueImageCheck(el);
      }
    } else if (!stale && !result) {
      queueImageCheck(el);
    }
    if (rerun) evaluateCandidate(el);
  }

  /* ------------------------------------------------------------------ */
  /* Image evaluation (optional, multimodal model via the service worker) */
  /* ------------------------------------------------------------------ */

  function hiddenByImage(el) {
    return el.classList.contains(CLASS_HIDDEN) && el.getAttribute(ATTR_MEDIA) === 'image';
  }

  /** Puts a container in the image queue; it is judged once it comes near the viewport. */
  function queueImageCheck(el) {
    const images = state.images;
    if (!images.enabled || !images.observer || !el.isConnected || el.hasAttribute(ATTR_REVEALED)) return;
    if (el.classList.contains(CLASS_HIDDEN) && !hiddenByImage(el)) return; // already hidden by its text
    images.pending.add(el);
    images.observer.observe(el); // reports the current intersection right away
  }

  function onImageIntersection(entries) {
    const images = state.images;
    for (const entry of entries) {
      if (entry.isIntersecting && images.pending.has(entry.target)) images.visible.add(entry.target);
      else images.visible.delete(entry.target);
    }
    pumpImages();
  }

  function pumpImages() {
    const images = state.images;
    if (!images.enabled || !state.enabled) return;
    const wait = images.retryAt - Date.now();
    if (wait > 0) {
      clearTimeout(images.retryTimer);
      images.retryTimer = setTimeout(pumpImages, wait);
      return;
    }
    for (const el of images.visible) {
      if (images.active >= Config.IMAGE_MAX_CONCURRENT) return;
      images.visible.delete(el);
      images.pending.delete(el);
      if (images.observer) images.observer.unobserve(el);
      if (el.isConnected) checkImages(el);
    }
  }

  /** Re-checks a container when one of its pictures (re)loads — lazy loading, carousels. */
  function listenForLoad(img) {
    if (state.images.listening.has(img)) return;
    state.images.listening.add(img);
    img.addEventListener('load', () => {
      const owner = img.closest(`[${ATTR_CANDIDATE}]`);
      if (owner) queueImageCheck(owner);
    });
  }

  /** The largest pictures of the container itself (not of nested containers such as comments). */
  function pickImages(el) {
    // Inside a hidden container pictures are not rendered: only their natural size counts then.
    const rendered = !el.classList.contains(CLASS_HIDDEN);
    const found = [];
    for (const img of el.querySelectorAll('img')) {
      if (img.closest(`[${ATTR_CANDIDATE}]`) !== el || img.closest(`.${CLASS_BAR}`)) continue;
      listenForLoad(img);
      const src = img.currentSrc || img.src || '';
      if (!/^(https?:|data:image\/)/i.test(src) || /^data:image\/svg|\.svg(?:[?#]|$)/i.test(src)) continue;
      if (!img.complete || Math.min(img.naturalWidth, img.naturalHeight) < Config.IMAGE_MIN_SIDE) continue;
      let area = img.naturalWidth * img.naturalHeight;
      if (rendered) {
        const rect = img.getBoundingClientRect();
        if (rect.width < IMAGE_MIN_RENDERED_WIDTH || rect.height < IMAGE_MIN_RENDERED_HEIGHT) continue;
        area = rect.width * rect.height;
      }
      found.push({ img, src, area });
    }
    found.sort((a, b) => b.area - a.area);
    return found.slice(0, Config.IMAGE_MAX_PER_CONTAINER);
  }

  /**
   * One picture → an evaluator-style result, or null when the picture cannot be judged.
   * Throws when the image server is unavailable.
   */
  async function judgeImage(img, src) {
    const known = state.images.checked.get(img);
    if (known && known.src === src) return known.result;
    const response = await chrome.runtime.sendMessage({ type: Config.MSG.CLASSIFY_IMAGE, url: src });
    let result = null;
    if (response && response.ok) {
      const data = response.data;
      result = { hide: Boolean(data.hide), reason: '', source: 'ai', media: 'image', image: src };
      if (data.hide && data.category) result.category = data.category;
      result.details = {
        score: data.score,
        threshold: data.threshold,
        probabilities: data.probabilities,
        model: data.model,
      };
    } else {
      const error = (response && response.error) || { code: 'noResponse' };
      const skip = IMAGE_SKIP_ERRORS.has(error.code) || (error.code === 'http' && error.detail === '422');
      if (!skip) throw Evaluators.codedError(error.code, `${error.code}: ${error.detail || ''}`, error.detail);
      console.debug('[ParaBene] Picture skipped:', error.code, error.detail || '', src.slice(0, 200));
    }
    state.images.checked.set(img, { src, result });
    return result;
  }

  async function checkImages(el) {
    const images = state.images;
    const generation = state.generation;
    images.active += 1;
    let verdict = null;
    let failed = false;
    try {
      for (const { img, src } of pickImages(el)) {
        const result = await judgeImage(img, src);
        if (result && result.hide) {
          verdict = result;
          break;
        }
      }
    } catch (err) {
      failed = true;
      if (generation === state.generation) {
        images.retryAt = Date.now() + IMAGE_COOLDOWN_MS;
        console.info('[ParaBene] Image model unavailable, pausing image checks for 30 s:', err.message);
      }
    } finally {
      images.active -= 1;
    }

    const current = generation === state.generation && state.enabled && images.enabled;
    if (current && el.isConnected && !el.hasAttribute(ATTR_REVEALED)) {
      if (failed) {
        queueImageCheck(el); // retried after the pause
      } else if (verdict) {
        const textHidden = el.classList.contains(CLASS_HIDDEN) && !hiddenByImage(el);
        if (!textHidden) {
          const known = state.hiddenItems.get(el);
          const isNew = !hiddenByImage(el) || !known || known.image !== verdict.image;
          const text = ownText(el);
          hide(el, verdict);
          state.hiddenItems.set(el, { text, image: verdict.image });
          if (isNew) logHidden(text, verdict);
        }
      } else if (hiddenByImage(el)) {
        unhide(el);
      }
    }
    pumpImages();
  }

  /** (Re)starts image evaluation for new settings; previous verdicts are judged again. */
  function applyImageSettings(settings) {
    const images = state.images;
    if (images.observer) images.observer.disconnect();
    clearTimeout(images.retryTimer);
    images.observer = null;
    images.pending.clear();
    images.visible.clear();
    images.checked = new WeakMap();
    images.retryAt = 0;
    images.enabled = settings.enabled && settings.aiImagesEnabled;
    if (images.enabled) {
      images.observer = new IntersectionObserver(onImageIntersection, { rootMargin: IMAGE_ROOT_MARGIN });
    } else {
      for (const el of document.querySelectorAll(`.${CLASS_HIDDEN}[${ATTR_MEDIA}="image"]`)) unhide(el);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Hiding and restoring                                                */
  /* ------------------------------------------------------------------ */

  /** Builds the localized "(reason: …)" text from a language-neutral evaluator result. */
  function formatReason(result) {
    const { t, has } = state.i18n;
    const categoryKey = result.category ? `category_${result.category}` : '';
    let reason = categoryKey && has(categoryKey) ? t(categoryKey) : result.reason;
    if (!reason) reason = t(result.source === 'ai' ? 'reasonAiDefault' : 'reasonUnknown');
    if (result.media === 'image') return t('barReasonAiImage', reason);
    return t(result.source === 'ai' ? 'barReasonAi' : 'barReason', reason);
  }

  /** Reads back the raw result stored on a hidden container. */
  function storedResult(el) {
    return {
      reason: el.getAttribute(ATTR_REASON) || '',
      source: el.getAttribute(ATTR_SOURCE) || 'keyword',
      category: el.getAttribute(ATTR_CATEGORY) || undefined,
      media: el.getAttribute(ATTR_MEDIA) || undefined,
    };
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
    const message = document.createElement('span');
    message.className = 'parabene-bar__message';
    const reason = document.createElement('span');
    reason.className = 'parabene-bar__reason';
    label.append(message, ' ', reason);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'parabene-bar__btn';
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

  /** Writes all bar texts in the current UI language (also used after a language switch). */
  function labelBar(bar, result) {
    const { t, locale } = state.i18n;
    // The bar is injected into foreign pages — declare its language for screen readers.
    bar.lang = locale;
    bar.querySelector('.parabene-bar__message').textContent = t('barText');
    bar.querySelector('.parabene-bar__reason').textContent = formatReason(result);
    bar.querySelector('.parabene-bar__btn').textContent = t('barReveal');
  }

  function setOrRemoveAttribute(el, name, value) {
    if (value) el.setAttribute(name, value);
    else el.removeAttribute(name);
  }

  /** "keyword" | "ai" for a hidden container, null when it is not hidden. */
  function hiddenSource(el) {
    if (!el.classList.contains(CLASS_HIDDEN)) return null;
    return el.getAttribute(ATTR_SOURCE) === 'ai' ? 'ai' : 'keyword';
  }

  function countHidden(source, delta) {
    if (!source) return;
    state.hidden[source] = Math.max(0, state.hidden[source] + delta);
    scheduleStats();
  }

  /** Recounts hidden containers from the DOM (after in-page navigation). */
  function recountHidden() {
    state.hidden = { keyword: 0, ai: 0 };
    for (const el of document.querySelectorAll(`.${CLASS_HIDDEN}`)) state.hidden[hiddenSource(el)] += 1;
    scheduleStats();
  }

  function hide(el, result) {
    const previous = hiddenSource(el);
    let bar = directBar(el);
    if (!bar) {
      bar = createBar(el);
      el.insertBefore(bar, el.firstChild);
    }
    labelBar(bar, result);
    el.setAttribute(ATTR_REASON, result.reason || '');
    el.setAttribute(ATTR_SOURCE, result.source || 'keyword');
    setOrRemoveAttribute(el, ATTR_CATEGORY, result.category);
    setOrRemoveAttribute(el, ATTR_MEDIA, result.media);
    el.classList.add(CLASS_HIDDEN);
    const current = hiddenSource(el);
    if (current !== previous) {
      countHidden(previous, -1);
      countHidden(current, 1);
    }
  }

  function unhide(el) {
    countHidden(hiddenSource(el), -1);
    const bar = directBar(el);
    if (bar) bar.remove();
    el.removeAttribute(ATTR_REASON);
    el.removeAttribute(ATTR_SOURCE);
    el.removeAttribute(ATTR_CATEGORY);
    el.removeAttribute(ATTR_MEDIA);
    el.classList.remove(CLASS_HIDDEN);
  }

  function reveal(el) {
    const source = hiddenSource(el);
    const item = hiddenByImage(el) ? state.hiddenItems.get(el) : { text: (state.hiddenItems.get(el) || {}).text };
    el.setAttribute(ATTR_REVEALED, 'true');
    unhide(el);
    // "Show anyway" usually means a false positive — worth marking in the log.
    if (source && item && (item.text || item.image)) {
      logEvent(Config.MSG.LOG_REVEALED, { source, text: item.text || '', image: item.image });
    }
  }

  /** If the page rebuilt the inside of a hidden container and removed the bar — insert it again. */
  function repairBar(node) {
    const hidden = node.closest(`.${CLASS_HIDDEN}`);
    if (hidden && !directBar(hidden)) {
      hide(hidden, storedResult(hidden));
    }
  }

  function relabelAll() {
    for (const el of document.querySelectorAll(`.${CLASS_HIDDEN}`)) {
      const bar = directBar(el);
      if (bar) labelBar(bar, storedResult(el));
    }
  }

  function unhideAll() {
    for (const el of document.querySelectorAll(`.${CLASS_HIDDEN}`)) unhide(el);
    for (const bar of document.querySelectorAll(`.${CLASS_BAR}`)) bar.remove();
    state.hidden = { keyword: 0, ai: 0 };
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
      recountHidden();
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

  /**
   * Content scripts cannot fetch extension files, so translations come from the
   * service worker. If that fails, the translator falls back to chrome.i18n.
   */
  async function loadTranslator(locale) {
    try {
      const response = await chrome.runtime.sendMessage({ type: Config.MSG.GET_MESSAGES, locale });
      if (response && response.ok) return I18n.createTranslator(response.locale, response.messages);
      console.warn('[ParaBene] Failed to load translations:', response && response.error);
    } catch (err) {
      console.warn('[ParaBene] Failed to load translations:', err);
    }
    return I18n.createTranslator(locale, null);
  }

  async function updateLanguage(locale) {
    const seq = ++state.languageSeq;
    const translator = await loadTranslator(locale);
    if (seq !== state.languageSeq || !state.alive) return;
    state.i18n = translator;
    relabelAll();
  }

  function applySettings(settings) {
    const previous = state.settings;
    state.settings = settings;
    if (previous && previous.language !== settings.language) updateLanguage(settings.language);
    state.evaluator = buildEvaluator(settings);
    applyImageSettings(settings);
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
    state.images.enabled = false;
    if (state.images.observer) state.images.observer.disconnect();
    clearTimeout(state.images.retryTimer);
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    clearTimeout(state.timer);
    clearTimeout(state.statsTimer);
  }

  /* ------------------------------------------------------------------ */
  /* Log of hidden content (opt-in, kept by the service worker)          */
  /* ------------------------------------------------------------------ */

  function logEvent(type, entry) {
    if (!state.settings || !state.settings.logEnabled || !isContextAlive()) return;
    try {
      chrome.runtime.sendMessage({ type, entry }).catch(() => {});
    } catch (_) {
      /* extension reloaded — nothing to log to */
    }
  }

  function logHidden(text, result) {
    const settings = state.settings;
    const entry = {
      time: new Date().toISOString(),
      url: location.href,
      source: result.source === 'ai' ? 'ai' : 'keyword',
      mode: settings.aiEnabled ? settings.aiMode : 'keywords',
      reason: result.reason || '',
      category: result.category || '',
      fallback: result.fallback === true,
      text,
    };
    if (result.media === 'image') {
      entry.media = 'image';
      entry.image = result.image;
    }
    if (result.details) entry.details = result.details;
    logEvent(Config.MSG.LOG_HIDDEN, entry);
  }

  function currentStats() {
    const { keyword, ai } = state.enabled ? state.hidden : { keyword: 0, ai: 0 };
    return { hidden: keyword + ai, bySource: { keyword, ai } };
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
        .sendMessage(Object.assign({ type: Config.MSG.STATS }, currentStats()))
        .catch(() => {});
    } catch (_) {
      teardown();
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== Config.MSG.GET_STATS) return false;
    sendResponse(Object.assign(currentStats(), { enabled: state.enabled, adapter: adapter.name }));
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
    const sanitized = Config.sanitize(next);
    if (keys.every((key) => key === 'language' || key === 'logEnabled')) {
      // A UI language switch only changes the bar texts and the log switch only affects
      // future hides — no need to re-scan the page.
      const changed = sanitized.language !== state.settings.language;
      state.settings = sanitized;
      if (changed) updateLanguage(sanitized.language);
      return;
    }
    applySettings(sanitized);
  });

  Config.load()
    .then(async (settings) => {
      state.i18n = await loadTranslator(settings.language);
      applySettings(settings);
    })
    .catch((err) => console.warn('[ParaBene] Failed to load settings:', err));
})();
