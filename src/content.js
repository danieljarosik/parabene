/*
 * ParaBene – DOM scanning and modification.
 *
 * This file finds content containers (posts, article tiles), extracts their
 * text and passes it to the evaluator (src/evaluators.js). Only the evaluator
 * decides whether something gets hidden — there is no text-scoring logic here.
 * With image evaluation on, the pictures of containers the text did not hide are
 * judged by the service worker (the multimodal model), nearest the viewport first.
 * With learning on (src/learning.js), revealed content gets a "Hide" bar and becomes an example,
 * and content similar to an example is let through with a "Hide" bar instead of being hidden.
 */
(() => {
  'use strict';

  if (globalThis.__parabeneContentLoaded) return;
  globalThis.__parabeneContentLoaded = true;

  const Config = globalThis.ParaBeneConfig;
  const I18n = globalThis.ParaBeneI18n;
  const Evaluators = globalThis.ParaBeneEvaluators;
  const Learning = globalThis.ParaBeneLearning;
  if (!Config || !I18n || !Evaluators || !Learning || !document.documentElement) return;

  const ATTR_CHECKED = 'data-parabene-checked';
  const ATTR_CANDIDATE = 'data-parabene-candidate';
  const ATTR_REVEALED = 'data-parabene-revealed';
  const ATTR_REASON = 'data-parabene-reason';
  const ATTR_SOURCE = 'data-parabene-source';
  const ATTR_CATEGORY = 'data-parabene-category';
  const ATTR_MEDIA = 'data-parabene-media';
  /** On a visible container with a bar: "revealed" (shown by the user) or "passed" (let through). */
  const ATTR_SHOWN = 'data-parabene-shown';
  /** Pending example id of revealed content, or the ids of the examples that let content through. */
  const ATTR_LEARN = 'data-parabene-learn';
  const CLASS_HIDDEN = 'parabene-hidden';
  const CLASS_SHOWN = 'parabene-shown';
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
  /** Revealed content scrolled this far out of the viewport is confirmed as an example. */
  const LEARN_ROOT_MARGIN = '1000px 0px';
  /** Errors that concern one picture only (it is skipped); anything else pauses image evaluation. */
  const IMAGE_SKIP_ERRORS = new Set(['imageFetch', 'imageDecode', 'imageTooSmall']);
  /**
   * Revealed content stays revealed while the container shows the same content. Pages change it a
   * little on their own (reaction counters, "See more"), so it counts as the same while this share of
   * the word stems of the shorter text is in the other one; texts with fewer stems must be identical.
   */
  const REVEAL_SAME_OVERLAP = 0.6;
  const REVEAL_MIN_STEMS = 4;

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
  /**
   * Inline formatting: text split by these elements is one word (<strong>wypa</strong>dek → "wypadek").
   * Any other element boundary separates words — <span> and <a> included, as pages (Facebook) often
   * lay them out as blocks with no whitespace between them.
   */
  const INLINE_TEXT_TAGS = new Set([
    'abbr', 'b', 'bdi', 'bdo', 'big', 'cite', 'code', 'del', 'dfn', 'em', 'font', 'i', 'ins',
    'kbd', 'mark', 'q', 's', 'samp', 'small', 'strike', 'strong', 'sub', 'sup', 'tt', 'u', 'var', 'wbr',
  ]);

  const state = {
    enabled: false,
    settings: null,
    i18n: null,
    languageSeq: 0,
    evaluator: null,
    generation: 0,
    observer: null,
    pendingRoots: new Set(),
    /** Parents the page removed nodes from: their containers are judged again. */
    removalRoots: new Set(),
    fullScanPending: false,
    timer: 0,
    firstQueuedAt: 0,
    hidden: emptyCounts(),
    hiddenItems: new WeakMap(),
    lastHref: location.href,
    /** Container → the text it was last judged on. */
    texts: new WeakMap(),
    /** Revealed container → { text, image? } it showed when revealed ("Show anyway" applies to that content only). */
    revealed: new WeakMap(),
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
      /** Container → the addresses of its own pictures, to notice pictures added later. */
      signatures: new WeakMap(),
      listening: new WeakSet(),
    },
    learning: {
      enabled: false,
      threshold: Config.LEARN_SIMILARITIES[Config.DEFAULT_LEARN_SIMILARITY],
      matcher: Learning.createMatcher([]),
      corpus: Learning.createCorpus(),
      counted: new WeakSet(),
      observer: null,
      seen: new WeakSet(),
    },
  };

  function emptyCounts() {
    return { keyword: 0, aiText: 0, aiImage: 0, passed: 0 };
  }

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
    let text = '';
    let previous = null;
    // Set when the walk enters an element other than inline formatting (also a skipped one, e.g. a
    // nested container or <br>) — the next text node starts a new word.
    let boundary = false;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
        if (!INLINE_TEXT_TAGS.has(node.localName)) boundary = true;
        if (node.hasAttribute(ATTR_CANDIDATE) || node.matches(IGNORED_TEXT_SEL)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;
      },
    });
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const value = node.nodeValue;
      if (!value) continue;
      if (previous && (boundary || leavesBlock(previous, node, container))) text += ' ';
      text += value;
      previous = node;
      boundary = false;
      if (text.length >= MAX_TEXT_LENGTH) break;
    }
    return text.replace(/\s+/g, ' ').trim();
  }

  /** True when an element other than inline formatting ends between `previous` and the text node `next`. */
  function leavesBlock(previous, next, container) {
    for (let el = previous.parentNode; el && el !== container && !el.contains(next); el = el.parentNode) {
      if (!INLINE_TEXT_TAGS.has(el.localName)) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* Container evaluation                                                */
  /* ------------------------------------------------------------------ */

  async function evaluateCandidate(el) {
    if (!state.enabled || !el.isConnected) return;
    if (state.inFlight.has(el)) {
      state.dirty.add(el);
      return;
    }

    const text = ownText(el);
    if (el.hasAttribute(ATTR_REVEALED)) {
      if (!revealExpired(el, text)) return;
      endReveal(el);
    }
    if (el.hasAttribute(ATTR_CHECKED) && state.texts.get(el) === text) {
      // Same text: only pictures added since may still need judging.
      if (trackImages(el)) queueImageCheck(el);
      return;
    }
    state.texts.set(el, text);
    el.setAttribute(ATTR_CHECKED, 'true');

    if (text.length < MIN_TEXT_LENGTH) {
      if (heldByText(el)) unhide(el);
      queueImageCheck(el);
      return;
    }

    // Before the first await, so the whole batch of a scan is in the page statistics.
    const stems = learnStems(el, text);
    const generation = state.generation;
    const evaluator = state.evaluator;
    state.inFlight.add(el);
    let result = null;
    try {
      result = await evaluator.evaluate(text);
    } catch (err) {
      // "cancelled": the evaluator was replaced (settings changed) — the page is judged again anyway.
      if (!Evaluators.isCancelled(err)) console.warn('[ParaBene] Content evaluation failed:', err);
    } finally {
      state.inFlight.delete(el);
    }

    const rerun = state.dirty.has(el);
    state.dirty.delete(el);

    const stale = generation !== state.generation || !state.enabled;
    if (!stale && result && el.isConnected && !el.hasAttribute(ATTR_REVEALED)) {
      const match = result.hide ? learnedMatch({ text, stems }, result) : null;
      if (match) {
        pass(el, result, match);
        state.hiddenItems.set(el, { text });
        queueImageCheck(el);
      } else if (result.hide) {
        const previous = hiddenSource(el);
        const byImage = hiddenByImage(el);
        const known = state.hiddenItems.get(el);
        hide(el, result);
        state.hiddenItems.set(el, { text });
        // Logged once per content: again when hidden for another reason, or when the page reused
        // the element for other content.
        const sameItem = previous === hiddenSource(el) && !byImage && known && sameContent(known.text || '', text);
        if (!sameItem) logHidden(text, result);
      } else {
        // A container hidden because of its picture stays hidden until the picture is judged again.
        if (heldByText(el)) unhide(el);
        queueImageCheck(el);
      }
    } else if (!stale && !result) {
      queueImageCheck(el);
    }
    if (rerun) evaluateCandidate(el);
  }

  /** True when two texts are the same content, allowing the small changes pages make on their own. */
  function sameContent(a, b) {
    if (a === b) return true;
    const stemsA = new Set(Learning.stems(a).keys());
    const stemsB = new Set(Learning.stems(b).keys());
    const smaller = Math.min(stemsA.size, stemsB.size);
    if (smaller < REVEAL_MIN_STEMS) return false;
    let shared = 0;
    for (const stem of stemsA) if (stemsB.has(stem)) shared += 1;
    return shared / smaller >= REVEAL_SAME_OVERLAP;
  }

  /**
   * True when a revealed container no longer shows the content the user revealed: its text is
   * different, or (revealed because of a picture) that picture is gone — e.g. the page reused the
   * element for another post.
   */
  function revealExpired(el, text = ownText(el)) {
    const revealed = state.revealed.get(el);
    if (!revealed) {
      // Revealed before this script started (the extension was reloaded): keep it for this content.
      state.revealed.set(el, { text });
      return false;
    }
    if (!sameContent(revealed.text, text)) return true;
    if (!revealed.image) return false;
    return !ownImages(el).some((img) => img.currentSrc === revealed.image || img.src === revealed.image);
  }

  /**
   * The container shows other content than the user revealed: it is filtered again. A pending
   * example keeps the revealed content and is confirmed when the tab leaves the page.
   */
  function endReveal(el) {
    state.revealed.delete(el);
    el.removeAttribute(ATTR_REVEALED);
    el.removeAttribute(ATTR_CHECKED);
    if (barKind(el) === 'revealed') unhide(el);
  }

  /* ------------------------------------------------------------------ */
  /* Image evaluation (optional, multimodal model via the service worker) */
  /* ------------------------------------------------------------------ */

  function hiddenByImage(el) {
    return el.classList.contains(CLASS_HIDDEN) && el.getAttribute(ATTR_MEDIA) === 'image';
  }

  /** Hidden, or let through by a learned example (both have a bar and a stored verdict). */
  function isMarked(el) {
    return el.classList.contains(CLASS_HIDDEN) || el.classList.contains(CLASS_SHOWN);
  }

  /** Hidden or let through because of its text (not its picture). */
  function heldByText(el) {
    return isMarked(el) && el.getAttribute(ATTR_MEDIA) !== 'image';
  }

  function heldByImage(el) {
    return isMarked(el) && el.getAttribute(ATTR_MEDIA) === 'image';
  }

  /** Puts a container in the image queue; it is judged once it comes near the viewport. */
  function queueImageCheck(el) {
    const images = state.images;
    if (!images.enabled || !images.observer || !el.isConnected) return;
    if (el.hasAttribute(ATTR_REVEALED)) {
      // Judged again only once it shows other content (e.g. a picture loaded in place of the revealed one).
      if (revealExpired(el)) evaluateCandidate(el);
      return;
    }
    if (el.classList.contains(CLASS_HIDDEN) && !hiddenByImage(el)) return; // already hidden by its text
    trackImages(el);
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
    if (!isContextAlive()) {
      teardown(); // extension reloaded: every request would fail, every 30 s, for as long as the tab lives
      return;
    }
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
      else images.signatures.delete(el); // queued again if the page puts it back
    }
  }

  /**
   * Containers the page has removed leave the image queue. The observer reports only the ones it
   * saw near the viewport, so the others would be kept (with their whole subtree) for good.
   */
  function pruneImageQueue() {
    const images = state.images;
    for (const el of images.pending) {
      if (el.isConnected) continue;
      images.pending.delete(el);
      images.visible.delete(el);
      if (images.observer) images.observer.unobserve(el);
      images.signatures.delete(el); // queued again if the page puts it back
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

  /** The pictures of the container itself (not of nested containers such as comments). */
  function ownImages(el) {
    const own = [];
    for (const img of el.querySelectorAll('img')) {
      if (img.closest(`[${ATTR_CANDIDATE}]`) === el && !img.closest(`.${CLASS_BAR}`)) own.push(img);
    }
    return own;
  }

  /**
   * Listens for the (re)loading of the container's own pictures and tells whether the set of
   * pictures changed since the last call — e.g. a picture added to a post whose text did not change.
   */
  function trackImages(el) {
    const images = state.images;
    if (!images.enabled) return false;
    const sources = [];
    for (const img of ownImages(el)) {
      listenForLoad(img);
      sources.push(img.currentSrc || img.src || '');
    }
    const signature = sources.join('\n');
    const changed = images.signatures.get(el) !== signature;
    images.signatures.set(el, signature);
    return changed;
  }

  /** The largest pictures of the container itself (not of nested containers such as comments). */
  function pickImages(el) {
    // Inside a hidden container pictures are not rendered: only their natural size counts then.
    const rendered = !el.classList.contains(CLASS_HIDDEN);
    const found = [];
    for (const img of ownImages(el)) {
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
    // New settings replace the map: a reply that arrives later must not land in the new one.
    const checked = state.images.checked;
    const known = checked.get(img);
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
    checked.set(img, { src, result });
    return result;
  }

  async function checkImages(el) {
    const images = state.images;
    const generation = state.generation;
    images.active += 1;
    let verdict = null; // the first picture to hide that no learned example lets through
    let passed = null; // { result, match } of the first picture to hide that an example lets through
    let text = null;
    let failed = false;
    let cancelled = false;
    try {
      for (const { img, src } of pickImages(el)) {
        const result = await judgeImage(img, src);
        if (generation !== state.generation) break; // new settings: this check is discarded
        if (!result || !result.hide) continue;
        if (text === null) text = ownText(el);
        const match = learnedMatch({ text }, result);
        if (!match) {
          verdict = result;
          break;
        }
        // Let through by an example — the remaining pictures are still judged.
        if (!passed) passed = { result, match };
      }
    } catch (err) {
      failed = true;
      cancelled = Evaluators.isCancelled(err); // image evaluation was switched off meanwhile
      if (generation === state.generation && !cancelled) {
        images.retryAt = Date.now() + IMAGE_COOLDOWN_MS;
        console.info('[ParaBene] Image model unavailable, pausing image checks for 30 s:', err.message);
      }
    } finally {
      images.active -= 1;
    }

    const current = generation === state.generation && state.enabled && images.enabled;
    if (current && el.isConnected && !el.hasAttribute(ATTR_REVEALED)) {
      const textHidden = el.classList.contains(CLASS_HIDDEN) && !hiddenByImage(el);
      if (failed) {
        if (!cancelled) queueImageCheck(el); // retried after the pause
      } else if (textHidden) {
        // Hidden by its text in the meantime — the pictures do not matter.
      } else if (verdict) {
        const known = state.hiddenItems.get(el);
        const isNew = !hiddenByImage(el) || !known || known.image !== verdict.image;
        hide(el, verdict);
        if (isNew) logHidden(text, verdict);
        state.hiddenItems.set(el, { text, image: verdict.image });
      } else if (passed) {
        pass(el, passed.result, passed.match);
        state.hiddenItems.set(el, { text, image: passed.result.image });
      } else if (heldByImage(el)) {
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
    images.signatures = new WeakMap();
    images.retryAt = 0;
    images.enabled = settings.enabled && settings.aiImagesEnabled;
    if (images.enabled) {
      images.observer = new IntersectionObserver(onImageIntersection, { rootMargin: IMAGE_ROOT_MARGIN });
    } else {
      for (const el of document.querySelectorAll(`[${ATTR_MEDIA}="image"]`)) {
        if (barKind(el) !== 'revealed') unhide(el);
      }
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
    const note = document.createElement('span');
    note.className = 'parabene-bar__note';
    label.append(message, ' ', reason, note);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'parabene-bar__btn';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (container.classList.contains(CLASS_HIDDEN)) reveal(container);
      else if (container.classList.contains(CLASS_SHOWN)) rehide(container);
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

  /**
   * Writes all bar texts in the current UI language (also used after a language switch).
   * `kind`: "hidden", "revealed" (shown by the user, learning on) or "passed" (let through).
   */
  function labelBar(bar, result, kind) {
    const { t, locale } = state.i18n;
    // The bar is injected into foreign pages — declare its language for screen readers.
    bar.lang = locale;
    const shown = kind === 'revealed' || kind === 'passed';
    bar.classList.toggle('parabene-bar--shown', shown);
    const message = kind === 'revealed' ? 'barRevealedText' : kind === 'passed' ? 'barPassedText' : 'barText';
    bar.querySelector('.parabene-bar__message').textContent = t(message);
    bar.querySelector('.parabene-bar__reason').textContent = formatReason(result);
    const note = kind === 'revealed' ? t('barRevealedNote') : kind === 'passed' ? t('barPassedNote') : '';
    bar.querySelector('.parabene-bar__note').textContent = note ? ` ${note}` : '';
    bar.querySelector('.parabene-bar__btn').textContent = t(shown ? 'barHide' : 'barReveal');
  }

  /** "hidden", "revealed" or "passed" for a container with a bar, null otherwise. */
  function barKind(el) {
    if (el.classList.contains(CLASS_HIDDEN)) return 'hidden';
    if (el.classList.contains(CLASS_SHOWN)) return el.getAttribute(ATTR_SHOWN) === 'passed' ? 'passed' : 'revealed';
    return null;
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

  /**
   * Counter bucket of a hidden container: "keyword", "aiText" (text model) or "aiImage"
   * (image model); null when it is not hidden.
   */
  function hiddenKind(el) {
    const source = hiddenSource(el);
    if (source !== 'ai') return source;
    return el.getAttribute(ATTR_MEDIA) === 'image' ? 'aiImage' : 'aiText';
  }

  /** Counter bucket of a container: a hiddenKind(), "passed" when let through, otherwise null. */
  function countedKind(el) {
    if (el.classList.contains(CLASS_SHOWN)) return el.getAttribute(ATTR_SHOWN) === 'passed' ? 'passed' : null;
    return hiddenKind(el);
  }

  function countHidden(kind, delta) {
    if (!kind) return;
    state.hidden[kind] = Math.max(0, state.hidden[kind] + delta);
    scheduleStats();
  }

  /**
   * Recounts hidden containers from the DOM — the page may have removed (or put back) some of them.
   * `force`: report the stats even when they did not change (after in-page navigation).
   */
  function recountHidden(force) {
    const counts = emptyCounts();
    for (const el of document.querySelectorAll(`.${CLASS_HIDDEN}, .${CLASS_SHOWN}`)) {
      const kind = countedKind(el);
      if (kind) counts[kind] += 1;
    }
    const changed = Object.keys(counts).some((key) => counts[key] !== state.hidden[key]);
    state.hidden = counts;
    if (changed || force) scheduleStats();
  }

  /**
   * Puts the bar on a container and stores the verdict on it. `kind`: "hidden" (the content
   * collapses), "revealed" or "passed" (the content stays visible under a bar with "Hide").
   * `learn` sets ATTR_LEARN (an empty string removes it, undefined keeps it).
   */
  function mark(el, result, kind, learn) {
    const previous = countedKind(el);
    let bar = directBar(el);
    const created = !bar;
    if (created) bar = createBar(el);
    labelBar(bar, result, kind);
    // Labelled before it is inserted: the observer then sees one added bar (which it ignores)
    // instead of text changes inside it, each of which would schedule a scan.
    if (created) el.insertBefore(bar, el.firstChild);
    el.setAttribute(ATTR_REASON, result.reason || '');
    el.setAttribute(ATTR_SOURCE, result.source || 'keyword');
    setOrRemoveAttribute(el, ATTR_CATEGORY, result.category);
    setOrRemoveAttribute(el, ATTR_MEDIA, result.media);
    setOrRemoveAttribute(el, ATTR_SHOWN, kind === 'hidden' ? '' : kind);
    if (learn !== undefined) setOrRemoveAttribute(el, ATTR_LEARN, learn);
    el.classList.toggle(CLASS_HIDDEN, kind === 'hidden');
    el.classList.toggle(CLASS_SHOWN, kind !== 'hidden');
    const current = countedKind(el);
    if (current !== previous) {
      countHidden(previous, -1);
      countHidden(current, 1);
    }
  }

  function hide(el, result) {
    mark(el, result, 'hidden', '');
  }

  /** Lets content through because of learned examples (`match.ids`), with a "Hide" bar. */
  function pass(el, result, match) {
    mark(el, result, 'passed', match.ids.join(' '));
  }

  function unhide(el) {
    countHidden(countedKind(el), -1);
    const bar = directBar(el);
    if (bar) bar.remove();
    el.removeAttribute(ATTR_REASON);
    el.removeAttribute(ATTR_SOURCE);
    el.removeAttribute(ATTR_CATEGORY);
    el.removeAttribute(ATTR_MEDIA);
    el.removeAttribute(ATTR_SHOWN);
    el.removeAttribute(ATTR_LEARN);
    el.classList.remove(CLASS_HIDDEN, CLASS_SHOWN);
    if (state.learning.observer) state.learning.observer.unobserve(el);
  }

  /** "Show anyway". With learning on, the content keeps a "Hide" bar and becomes a pending example. */
  function reveal(el) {
    const source = hiddenSource(el);
    const result = storedResult(el);
    const known = state.hiddenItems.get(el) || {};
    const item = hiddenByImage(el) ? known : { text: known.text };
    el.setAttribute(ATTR_REVEALED, 'true');
    state.revealed.set(el, { text: ownText(el), image: item.image });
    const id = learnable(item, result) ? newLearnId() : '';
    if (id) {
      mark(el, result, 'revealed', id);
      sendLearn(Config.MSG.LEARN_PENDING, {
        id,
        entry: Object.assign({ url: location.href, text: item.text || '', image: item.image }, result),
      });
      watchRevealed(el);
    } else {
      unhide(el);
    }
    // "Show anyway" usually means a false positive — worth marking in the log.
    if (source && (item.text || item.image)) {
      logEvent(Config.MSG.LOG_REVEALED, { source, text: item.text || '', image: item.image });
    }
  }

  /**
   * "Hide" on revealed content cancels its example; on content let through it forgets the
   * examples that let it through (the storage change then re-scans every tab).
   */
  function rehide(el) {
    const learn = el.getAttribute(ATTR_LEARN) || '';
    if (barKind(el) === 'revealed') {
      if (learn) sendLearn(Config.MSG.LEARN_CANCEL, { id: learn });
      el.removeAttribute(ATTR_REVEALED);
      state.revealed.delete(el);
    } else {
      const ids = learn.split(' ').filter(Boolean);
      if (ids.length) sendLearn(Config.MSG.LEARN_FORGET, { ids });
    }
    if (state.learning.observer) state.learning.observer.unobserve(el);
    hide(el, storedResult(el));
  }

  /** If the page rebuilt the inside of a container with a bar and removed the bar — insert it again. */
  function repairBar(node) {
    const marked = node.closest(`.${CLASS_HIDDEN}, .${CLASS_SHOWN}`);
    if (marked && !directBar(marked)) {
      mark(marked, storedResult(marked), barKind(marked));
    }
  }

  function relabelAll() {
    for (const el of document.querySelectorAll(`.${CLASS_HIDDEN}, .${CLASS_SHOWN}`)) {
      const bar = directBar(el);
      if (bar) labelBar(bar, storedResult(el), barKind(el));
    }
  }

  function unhideAll() {
    for (const el of document.querySelectorAll(`.${CLASS_HIDDEN}, .${CLASS_SHOWN}`)) unhide(el);
    for (const bar of document.querySelectorAll(`.${CLASS_BAR}`)) bar.remove();
    state.hidden = emptyCounts();
    scheduleStats();
  }

  /* ------------------------------------------------------------------ */
  /* Learning from revealed content (opt-in, src/learning.js)            */
  /* ------------------------------------------------------------------ */

  /** Stems of a container's text; every container counts once in the page statistics. */
  function learnStems(el, text) {
    const learning = state.learning;
    if (!learning.enabled) return null;
    const stems = Learning.stems(text);
    if (!learning.counted.has(el)) {
      learning.counted.add(el);
      learning.corpus.add(stems);
    }
    return stems;
  }

  /** The examples content about to be hidden is similar to ({ ids, score }), or null. */
  function learnedMatch(item, result) {
    const learning = state.learning;
    if (!learning.enabled || learning.matcher.size === 0) return null;
    const found = learning.matcher.match(item, result, learning.corpus, learning.threshold);
    return found.ids.length ? found : null;
  }

  /** A picture is matched by its address, so only an http(s) picture can be an example. */
  function learnable(item, result) {
    if (!state.learning.enabled) return false;
    if (result.media === 'image') return /^https?:/i.test(item.image || '');
    return (item.text || '').trim().length >= MIN_TEXT_LENGTH;
  }

  /** Content scripts on http:// pages have no crypto.randomUUID(). */
  function newLearnId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function sendLearn(type, payload) {
    if (!isContextAlive()) return;
    try {
      chrome.runtime.sendMessage(Object.assign({ type }, payload)).catch(() => {});
    } catch (_) {
      /* extension reloaded */
    }
  }

  /** Revealed content the user has scrolled far past (without "Hide") is confirmed as an example. */
  function watchRevealed(el) {
    const learning = state.learning;
    if (!learning.observer) {
      learning.observer = new IntersectionObserver(onRevealedIntersection, { rootMargin: LEARN_ROOT_MARGIN });
    }
    learning.observer.observe(el);
  }

  function onRevealedIntersection(entries) {
    const learning = state.learning;
    for (const entry of entries) {
      const el = entry.target;
      if (entry.isIntersecting) {
        learning.seen.add(el);
        continue;
      }
      if (!learning.seen.has(el)) continue;
      learning.observer.unobserve(el);
      const id = el.getAttribute(ATTR_LEARN);
      if (id && barKind(el) === 'revealed') sendLearn(Config.MSG.LEARN_COMMIT, { id });
    }
  }

  function setLearned(entries) {
    state.learning.matcher = Learning.createMatcher(entries);
  }

  async function loadLearned() {
    try {
      const stored = await chrome.storage.local.get(Config.LEARN_STORAGE_KEY);
      setLearned(stored[Config.LEARN_STORAGE_KEY]);
    } catch (err) {
      console.warn('[ParaBene] Failed to load learned examples:', err);
    }
  }

  function applyLearningSettings(settings) {
    const learning = state.learning;
    learning.enabled = settings.enabled && settings.learnEnabled;
    learning.threshold = Config.LEARN_SIMILARITIES[settings.learnSimilarity];
    if (learning.enabled) return;
    // Learning off: revealed content simply stays revealed, without the "Hide" bar.
    if (learning.observer) learning.observer.disconnect();
    learning.observer = null;
    for (const el of document.querySelectorAll(`.${CLASS_SHOWN}[${ATTR_SHOWN}="revealed"]`)) unhide(el);
  }

  function resetChecks() {
    state.generation += 1;
    state.texts = new WeakMap();
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
    // After the extension is reloaded this script can reach neither the model nor the settings.
    if (state.alive && !isContextAlive()) teardown();
    if (!state.enabled || !state.alive) {
      state.pendingRoots.clear();
      state.removalRoots.clear();
      state.fullScanPending = false;
      return;
    }

    const navigated = location.href !== state.lastHref;
    state.lastHref = location.href;
    recountHidden(navigated);

    const roots = state.fullScanPending
      ? [document.body || document.documentElement]
      : collapseRoots([...state.pendingRoots]);
    const removals = [...state.removalRoots];
    state.pendingRoots.clear();
    state.removalRoots.clear();
    state.fullScanPending = false;

    const candidates = new Set();
    for (const root of roots) {
      if (!root.isConnected || root.closest(`.${CLASS_BAR}`)) continue;
      const owner = root.closest(`[${ATTR_CANDIDATE}]`);
      if (owner) candidates.add(owner);
      for (const candidate of adapter.findCandidates(root)) candidates.add(candidate);
      repairBar(root);
    }
    // Something was removed from these: only the container they are in can have changed.
    for (const target of removals) {
      if (!target.isConnected || target.closest(`.${CLASS_BAR}`)) continue;
      const owner = target.closest(`[${ATTR_CANDIDATE}]`);
      if (owner) candidates.add(owner);
      repairBar(target);
    }
    if (removals.length) pruneImageQueue();

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
      // A removed fragment changes the text of its container; a removed container changes the counters.
      for (const node of record.removedNodes) {
        const element = node.nodeType === Node.ELEMENT_NODE;
        if (element ? node.classList.contains(CLASS_BAR) : node.nodeType !== Node.TEXT_NODE) continue;
        if (record.target.nodeType === Node.ELEMENT_NODE) {
          state.removalRoots.add(record.target);
          schedule();
        }
        break;
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
    state.removalRoots.clear();
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
    // Requests still queued by the old evaluator are dropped — nothing is sent with old settings.
    if (state.evaluator) state.evaluator.cancel();
    state.evaluator = buildEvaluator(settings);
    applyImageSettings(settings);
    applyLearningSettings(settings);
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
    if (state.evaluator) state.evaluator.cancel();
    state.images.enabled = false;
    if (state.images.observer) state.images.observer.disconnect();
    clearTimeout(state.images.retryTimer);
    if (state.learning.observer) state.learning.observer.disconnect();
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
    const { keyword, aiText, aiImage, passed } = state.enabled ? state.hidden : emptyCounts();
    return { hidden: keyword + aiText + aiImage, bySource: { keyword, aiText, aiImage }, passed };
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
    if (Config.LEARN_STORAGE_KEY in changes) {
      setLearned(changes[Config.LEARN_STORAGE_KEY].newValue);
      // New or forgotten examples: judge the page again (verdicts mostly come from the caches).
      if (state.learning.enabled && state.enabled) {
        resetChecks();
        start();
      }
    }
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
      await loadLearned();
      applySettings(settings);
    })
    .catch((err) => console.warn('[ParaBene] Failed to load settings:', err));
})();
