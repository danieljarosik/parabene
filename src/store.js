/*
 * ParaBene – the log of evaluated content (opt-in, `logEnabled`).
 *
 * One record per evaluated text: what was judged, where, by what (keywords, the AI text model,
 * the AI image model), the verdict (hidden or shown) with the model's numbers, and the user's
 * correction if any. It is kept in IndexedDB (database "parabene", store "evaluations") in the
 * extension's own origin and never sent anywhere; the statistics page (stats/) reads it and the
 * panel exports it as a .jsonl file.
 *
 * Loaded by the service worker (the only writer of evaluations), the statistics page (which
 * writes the corrections) and the panel. Content scripts cannot open this database: they send
 * their verdicts to the service worker.
 *
 * Record:
 *   id        auto-incremented; a higher id is a newer record
 *   key       SHA-256 of what identifies the content and its verdict (see keyText): the same
 *             text judged the same way again (a page reload) updates the record instead of
 *             adding one — `count` and `lastTime` tell how often and when last
 *   time, lastTime   ISO timestamps of the first and the last evaluation
 *   url, host
 *   hidden    1 | 0 (a number, so it can be indexed)
 *   source    "keyword" | "ai";  media: "image" + image (address) for a verdict about a picture
 *   mode      "keywords" | "both" | "ai" at the time
 *   reason, category, fallback, details { score, threshold, probabilities, model }
 *   revealed  the user clicked "Show anyway";  learned: hidden but let through by a learned example
 *   text      the evaluated text (at most Config.LOG_MAX_TEXT characters)
 *   label     "hide" | "show": the user's correction (what the verdict should have been);
 *             absent when not corrected. Labelled records are not removed when the log is full.
 */
(function (root) {
  'use strict';

  const Config = root.ParaBeneConfig;
  const DB_NAME = 'parabene';
  const DB_VERSION = 1;
  const STORE = 'evaluations';
  const CHANNEL = 'parabene-log';

  let opening = null;

  function open() {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          store.createIndex('key', 'key', { unique: true });
          store.createIndex('hidden', 'hidden');
          store.createIndex('label', 'label'); // only corrected records have the property
        };
        request.onsuccess = () => {
          const db = request.result;
          // Another context wants to upgrade or delete the database: let it.
          db.onversionchange = () => {
            db.close();
            opening = null;
          };
          resolve(db);
        };
        request.onerror = () => {
          opening = null;
          reject(request.error);
        };
      });
    }
    return opening;
  }

  function done(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function finished(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('transaction aborted'));
    });
  }

  /* ---------------- change notifications between the extension's pages ---------------- */

  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;

  function notify() {
    if (channel) channel.postMessage('changed');
  }

  /** Calls `callback` when another context has changed the log. Returns a function that stops it. */
  function subscribe(callback) {
    if (!channel) return () => {};
    const listener = () => callback();
    channel.addEventListener('message', listener);
    return () => channel.removeEventListener('message', listener);
  }

  /* ---------------- identity of a record ---------------- */

  /**
   * The same content with the same verdict is one record. A picture verdict is identified by the
   * picture (a data: picture is logged as its type only, so the text tells such pictures apart).
   */
  function keyText(entry) {
    const verdict = `${entry.source}\n${entry.hidden ? 'hidden' : 'shown'}`;
    if (!entry.image) return `${verdict}\n${entry.text}`;
    return entry.image.startsWith('data:') ? `image\n${entry.image}\n${entry.text}` : `image\n${entry.image}`;
  }

  async function keyOf(entry) {
    const bytes = new TextEncoder().encode(keyText(entry));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  /** Picture address for the log: a data: URL is replaced by its type (it can be megabytes long). */
  function imageUrl(value) {
    const url = String(value || '');
    if (url.startsWith('data:')) return url.split(/[;,]/)[0].slice(0, 100);
    return url.slice(0, 1000);
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (_) {
      return '';
    }
  }

  function cleanDetails(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const details = {};
    for (const key of ['score', 'threshold']) {
      if (typeof raw[key] === 'number' && Number.isFinite(raw[key])) details[key] = raw[key];
    }
    if (raw.probabilities && typeof raw.probabilities === 'object') {
      const probabilities = {};
      for (const [key, value] of Object.entries(raw.probabilities).slice(0, 12)) {
        if (typeof value === 'number' && Number.isFinite(value)) probabilities[String(key).slice(0, 40)] = value;
      }
      details.probabilities = probabilities;
    }
    if (typeof raw.model === 'string' && raw.model) details.model = raw.model.slice(0, 100);
    return Object.keys(details).length ? details : null;
  }

  /** Keeps only the known fields, with sane types and lengths (entries come from content scripts). */
  function sanitize(raw) {
    const url = String(raw.url || '').slice(0, 500);
    const entry = {
      time: typeof raw.time === 'string' && !Number.isNaN(Date.parse(raw.time)) ? raw.time : new Date().toISOString(),
      url,
      host: hostOf(url),
      hidden: raw.hidden === false || raw.hidden === 0 ? 0 : 1,
      source: raw.source === 'ai' ? 'ai' : 'keyword',
      mode: ['keywords', 'both', 'ai'].includes(raw.mode) ? raw.mode : 'keywords',
      reason: String(raw.reason || '').slice(0, 200),
      category: typeof raw.category === 'string' ? raw.category.slice(0, 40) : '',
      fallback: raw.fallback === true,
      revealed: raw.revealed === true,
      learned: raw.learned === true,
      text: String(raw.text || '').slice(0, Config.LOG_MAX_TEXT),
    };
    if (raw.image) {
      entry.media = 'image';
      entry.image = imageUrl(raw.image);
    }
    const details = cleanDetails(raw.details);
    if (details) entry.details = details;
    return entry;
  }

  /* ---------------- writing ---------------- */

  /**
   * Adds evaluations (already sanitized). One that is already recorded is counted again.
   * Then removes the oldest uncorrected records above Config.LOG_MAX_ENTRIES.
   * Resolves with the number of new records.
   */
  async function add(entries) {
    if (entries.length === 0) return 0;
    const keyed = await Promise.all(entries.map(async (entry) => Object.assign({}, entry, { key: await keyOf(entry) })));
    const db = await open();
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    const index = store.index('key');
    const seen = new Map(); // key → record handled earlier in this batch
    let added = 0;
    for (const entry of keyed) {
      const known = seen.get(entry.key) || (await done(index.get(entry.key)));
      if (known) {
        known.count = (known.count || 1) + 1;
        known.lastTime = entry.time;
        if (entry.learned) known.learned = true;
        if (known.id !== undefined) store.put(known);
        seen.set(entry.key, known);
      } else {
        const record = Object.assign({ count: 1, lastTime: entry.time }, entry);
        record.id = await done(store.add(record));
        seen.set(entry.key, record);
        added += 1;
      }
    }
    let excess = (await done(store.count())) - Config.LOG_MAX_ENTRIES;
    if (excess > 0) {
      await new Promise((resolve, reject) => {
        const cursorRequest = store.openCursor();
        cursorRequest.onerror = () => reject(cursorRequest.error);
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor || excess <= 0) return resolve();
          if (!cursor.value.label) {
            cursor.delete();
            excess -= 1;
          }
          cursor.continue();
        };
      });
    }
    await finished(transaction);
    notify();
    return added;
  }

  /** Marks the record of a hidden content the user chose to see ("Show anyway"). */
  async function markRevealed(entry) {
    const key = await keyOf(Object.assign({}, entry, { hidden: 1 }));
    const db = await open();
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    const record = await done(store.index('key').get(key));
    if (record && !record.revealed) {
      record.revealed = true;
      store.put(record);
    }
    await finished(transaction);
    if (record) notify();
  }

  /** The user's correction: "hide" | "show", or null to take it back. Resolves with the record. */
  async function setLabel(id, label) {
    const db = await open();
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    const record = await done(store.get(id));
    if (record) {
      if (label === 'hide' || label === 'show') {
        record.label = label;
        record.labelTime = new Date().toISOString();
      } else {
        delete record.label;
        delete record.labelTime;
      }
      store.put(record);
    }
    await finished(transaction);
    if (record) notify();
    return record || null;
  }

  async function clear() {
    const db = await open();
    const transaction = db.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).clear();
    await finished(transaction);
    notify();
  }

  /* ---------------- reading ---------------- */

  /** All records, oldest first. */
  async function all() {
    const db = await open();
    return done(db.transaction(STORE).objectStore(STORE).getAll());
  }

  /** { total, hidden, shown, corrected } without reading the records. */
  async function counts() {
    const db = await open();
    const store = db.transaction(STORE).objectStore(STORE);
    const [total, hidden, corrected] = await Promise.all([
      done(store.count()),
      done(store.index('hidden').count(IDBKeyRange.only(1))),
      done(store.index('label').count()),
    ]);
    return { total, hidden, shown: total - hidden, corrected };
  }

  /**
   * The log as JSON Lines: a header with the extension version and the settings at export time,
   * then one evaluation per line ("type": "hidden" | "shown"; "label" when the user corrected it).
   */
  function toJsonl(records, settings, version) {
    const meta = {
      type: 'meta',
      extension: 'ParaBene',
      version,
      exportedAt: new Date().toISOString(),
      entries: records.length,
      settings: {
        aiEnabled: settings.aiEnabled,
        aiProtocol: settings.aiProtocol,
        aiModel: settings.aiProtocol === 'builtin' ? settings.aiModel : undefined,
        aiMode: settings.aiMode,
        aiSensitivity: settings.aiSensitivity,
        aiThreshold: Config.AI_SENSITIVITIES[settings.aiSensitivity],
        aiTopics: settings.aiTopics,
        aiImagesEnabled: settings.aiImagesEnabled,
        keywords: settings.keywords,
      },
    };
    const lines = records.map((record) => {
      const { id: _id, key: _key, hidden, ...rest } = record;
      return Object.assign({ type: hidden ? 'hidden' : 'shown' }, rest);
    });
    return [meta, ...lines].map((line) => JSON.stringify(line)).join('\n') + '\n';
  }

  root.ParaBeneStore = Object.freeze({
    sanitize,
    add,
    markRevealed,
    setLabel,
    clear,
    all,
    counts,
    subscribe,
    toJsonl,
  });
})(globalThis);
