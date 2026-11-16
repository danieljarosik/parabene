/*
 * ParaBene – learning from revealed content (opt-in, `learnEnabled`).
 *
 * Content the user revealed with "Show anyway" and did not hide again becomes an example
 * (kept by the service worker in chrome.storage.local, key LEARN_STORAGE_KEY). Later content
 * hidden for the same reason is let through when it is similar enough to an example.
 *
 * "Similar" is lexical, computed locally without a model:
 * - words are lower-cased, short words (< 4 letters) and common function words are dropped and
 *   the rest is cut to a 5-letter stem, which covers most Polish inflection
 *   (wypadek / wypadku / wypadkiem → "wypad"),
 * - stems are weighted by how rare they are on the current page (inverse document frequency over
 *   the texts the content script has seen), so page furniture repeated in every post
 *   ("Lubię to", "Udostępnij", the author's name) counts for little,
 * - the score is the cosine similarity of the two weighted vectors (0 – nothing in common,
 *   1 – the same words); LEARN_SIMILARITIES maps the panel setting to the threshold.
 * Pictures are matched by their address only.
 *
 * Loaded by the content scripts and the popup; the service worker only stores the examples.
 */
(function (root) {
  'use strict';

  const STEM_LENGTH = 5;
  const MIN_WORD_LENGTH = 4;
  /** Texts with fewer stems than this match only when (nearly) identical. */
  const MIN_STEMS = 4;
  const SHORT_TEXT_THRESHOLD = 0.9;
  /**
   * Until the page has shown this many texts the word weights are unreliable (page furniture
   * still looks rare), so a stricter threshold applies.
   */
  const MIN_CORPUS = 10;
  const SMALL_CORPUS_THRESHOLD = 0.6;
  const MAX_CHARS = 2000;

  /** Common Polish and English words of 4+ letters that say nothing about the topic. */
  const STOPWORDS = new Set(
    (
      'które który która którzy których którym którą także tylko jednak oraz może można będzie ' +
      'będą został została zostało zostali zostały przez przy jako bardzo więcej sobie tego temu ' +
      'jego jest były było była byli jeszcze gdzie kiedy teraz dziś dzisiaj wszystko wszyscy ' +
      'właśnie około według wśród dlatego ponieważ jeśli jeżeli żeby aby nawet zawsze nigdy ' +
      'tutaj tam this that with from have were been they their there what when which will would ' +
      'about after into more than then them these those your just'
    ).split(' ')
  );

  /** Text → Map(stem → count). */
  function stems(text) {
    const counts = new Map();
    const words = String(text || '')
      .slice(0, MAX_CHARS)
      .normalize('NFC')
      .toLocaleLowerCase('pl')
      .split(/[^\p{L}\p{N}]+/u);
    for (const word of words) {
      if (word.length < MIN_WORD_LENGTH && !(word.length >= 2 && /\p{N}/u.test(word))) continue;
      if (STOPWORDS.has(word) || /^\p{N}+$/u.test(word)) continue;
      const stem = word.slice(0, STEM_LENGTH);
      counts.set(stem, (counts.get(stem) || 0) + 1);
    }
    return counts;
  }

  /** Document frequencies of the stems on the current page (one count per container). */
  function createCorpus() {
    const df = new Map();
    let documents = 0;
    return {
      add(counts) {
        documents += 1;
        for (const stem of counts.keys()) df.set(stem, (df.get(stem) || 0) + 1);
      },
      /** Smoothed inverse document frequency: 1 for a stem in every text, more for rare ones. */
      idf(stem) {
        return Math.log((documents + 1) / ((df.get(stem) || 0) + 1)) + 1;
      },
      get size() {
        return documents;
      },
    };
  }

  function weight(count, idf) {
    return (1 + Math.log(count)) * idf;
  }

  /** Weighted cosine similarity of two stem-count maps (0…1). */
  function similarity(a, b, corpus) {
    if (a.size === 0 || b.size === 0) return 0;
    const idf = (stem) => (corpus ? corpus.idf(stem) : 1);
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (const [stem, count] of a) {
      const w = weight(count, idf(stem));
      normA += w * w;
      const other = b.get(stem);
      if (other) dot += w * weight(other, idf(stem));
    }
    for (const [stem, count] of b) {
      const w = weight(count, idf(stem));
      normB += w * w;
    }
    return dot / Math.sqrt(normA * normB);
  }

  /**
   * What an example applies to: content hidden by the same source (keywords / AI text model /
   * AI image model) for the same reason (category, or the matched phrase).
   */
  function reasonKey(result) {
    const media = result.media === 'image' ? 'image' : 'text';
    const source = result.source === 'ai' ? 'ai' : 'keyword';
    const why = result.category || String(result.reason || '').toLocaleLowerCase('pl');
    return `${source}|${media}|${why}`;
  }

  /**
   * Examples (as stored) → matcher. `match(item, result, corpus, threshold)` returns the ids of
   * all examples the item is similar to (empty when none), best first, with the best score.
   * `item`: { text, image? } of the content about to be hidden; `result`: the verdict.
   */
  function createMatcher(entries) {
    const groups = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || typeof entry.id !== 'string') continue;
      const key = reasonKey(entry);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({
        id: entry.id,
        image: entry.media === 'image' ? entry.image || '' : '',
        stems: entry.media === 'image' ? null : stems(entry.text),
      });
    }

    return {
      size: Array.isArray(entries) ? entries.length : 0,
      match(item, result, corpus, threshold) {
        const group = groups.get(reasonKey(result));
        if (!group) return { ids: [], score: 0 };
        if (result.media === 'image') {
          const ids = group.filter((example) => example.image && example.image === result.image).map((e) => e.id);
          return { ids, score: ids.length ? 1 : 0 };
        }
        const counts = item.stems || stems(item.text);
        if (!corpus || corpus.size < MIN_CORPUS) threshold = Math.max(threshold, SMALL_CORPUS_THRESHOLD);
        const found = [];
        for (const example of group) {
          const short = Math.min(counts.size, example.stems.size) < MIN_STEMS;
          const score = similarity(counts, example.stems, corpus);
          if (score >= (short ? Math.max(threshold, SHORT_TEXT_THRESHOLD) : threshold)) {
            found.push({ id: example.id, score });
          }
        }
        found.sort((a, b) => b.score - a.score);
        return { ids: found.map((f) => f.id), score: found.length ? found[0].score : 0 };
      },
    };
  }

  root.ParaBeneLearning = Object.freeze({
    stems,
    createCorpus,
    similarity,
    reasonKey,
    createMatcher,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = root.ParaBeneLearning;
})(globalThis);
