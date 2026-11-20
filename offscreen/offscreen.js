/*
 * ParaBene – offscreen document: the built-in AI model (src/config.js, "Built-in model").
 *
 * The service worker opens this page and keeps it in the background; a service worker itself is
 * stopped after 30 s of inactivity and would load the model again each time. The page keeps ONE
 * basal decision model (one of Config.BUILTIN_MODELS, fixed by the first message that names it)
 * with wllama (llama.cpp in WebAssembly, on the GPU through WebGPU). For another model the
 * service worker closes the page and opens a new one. Messages from the service worker, each
 * with `model` (an id) and, for another basal version (Config.CUSTOM_MODEL_ID), its `url`:
 *   BUILTIN_LOAD      { model, download, test? } starts loading the stored model file; only with
 *                     `download: true` (the user clicked "Download model") a missing file is
 *                     downloaded first. Returns the current status. With `test` (basal requests,
 *                     for a version on trial) the page then makes these decisions once, measures
 *                     them and reports the outcome (MODEL_TEST); after a test that worked it asks
 *                     the service worker to look at the trial again when its time is up
 *                     (MODEL_TRIAL_CHECK).
 *   BUILTIN_STATUS    { model, check } returns the status; with `check: true` also whether the
 *                     complete file of `model` is in the storage (`stored`), without loading or
 *                     downloading anything.
 *   BUILTIN_EVALUATE  { model, body: <basal request> } → { ok, data: <basal reply> } | { ok: false, error }.
 *                     Never downloads.
 *   BUILTIN_REMOVE    { urls } removes the files of other basal versions from the storage (the
 *                     service worker sends it to a page that holds no model).
 * It tells the service worker what it learns about a file (MODEL_STATE: "stored", "missing",
 * "failed", and "ready" once the model is in memory); a page of this kind cannot write
 * chrome.storage itself. The download of another basal version is stopped as soon as its size
 * (Content-Length) or the bytes that arrived exceed Config.CUSTOM_MAX_BYTES, and a stored file
 * larger than that is never loaded; the self-test then fails with "customTooLarge" (MODEL_TEST).
 * A self-test that has not ended after Config.CUSTOM_TEST_TIMEOUT_MS fails with "timeout".
 *
 * Status (of this page's model): idle → loading → ready, or idle → downloading (progress 0..1) →
 * loading → ready when the file may be downloaded; "missing" when there is no file and no
 * permission to download; "error" otherwise. Errors are { code, detail }, translated by the panel
 * ("aiError_<code>"):
 *   noWebGPU        the browser gives no GPU adapter (checked before any download),
 *   modelMissing    the model file is not stored and may not be downloaded,
 *   downloadFailed  the download failed (detail: the error's text),
 *   modelLoading    the model is still being loaded, or this page holds another model,
 *   modelFailed     loading or a decision failed (detail: the error's text).
 *
 * wllama's decision API takes basal-serve's request (state, questions) but shows the option keys to
 * the model whatever "option_keys" says, so its scores are those of basal-serve asked with visible
 * keys: on 24 Polish texts (basal-2.0-mini) they differed from the hidden-keys scores by 0.05 on
 * average (0.21 at most), and no decision at the threshold 0.5 changed.
 */
import { Wllama } from '../vendor/wllama/index.js';

const Config = self.ParaBeneConfig;

/** A request waits this long for a model that is being loaded before it reports `modelLoading`. */
const LOAD_WAIT_MS = 10000;

const state = { status: 'idle', progress: 0, error: null };
let current = null; // this page's model (an entry of Config.BUILTIN_MODELS)
let wllama = null; // the library object; made once, it also reads the model storage
let ready = false; // the model is in memory
let fileStored = false; // the complete file of `current` is known to be in the storage
let downloadError = null; // a download that failed on this page is not started again by it
let loading = null;

function codedError(code, detail) {
  const err = new Error(detail ? `${code}: ${detail}` : code);
  err.code = code;
  err.detail = detail;
  return err;
}

function describeError(err) {
  if (err && err.code) return { code: err.code, detail: err.detail };
  return { code: 'modelFailed', detail: err && err.message ? err.message : String(err) };
}

function snapshot() {
  return {
    model: current ? current.id : null,
    url: current ? current.url : null,
    status: state.status,
    progress: state.progress,
    error: state.error,
    stored: fileStored,
  };
}

/** The model a message names: a built-in one by its id, another basal version by its address. */
function knownModel(message) {
  if (message.model === Config.CUSTOM_MODEL_ID) return Config.customModel(message.url);
  return Config.BUILTIN_MODELS.find((model) => model.id === message.model) || null;
}

function library() {
  if (!wllama) {
    const quiet = () => {};
    wllama = new Wllama(
      { default: chrome.runtime.getURL('vendor/wllama/wasm/wllama.wasm') },
      { logger: { debug: quiet, log: quiet, warn: console.warn, error: console.error } }
    );
    // No compatibility mode: in a browser without JSPI or 64-bit WebAssembly memory wllama would
    // otherwise download a second build of itself from a CDN and run it. Loading then fails instead.
    wllama.setCompat(null);
  }
  return wllama;
}

/** The complete file of `model` in the extension's storage, or null (no network request). */
async function storedFile(model) {
  const files = await library().modelManager.getModels();
  return files.find((file) => file.url === model.url) || null;
}

/** Tells the service worker what is known about a model's file (it keeps the records). */
function report(model, fileState, error) {
  chrome.runtime.sendMessage({ type: Config.MSG.MODEL_STATE, model: model.id, url: model.url, state: fileState, error }).catch(() => {});
}

/** The outcome of the self-test of another basal version (or why it could not run). */
function reportTest(model, outcome) {
  chrome.runtime.sendMessage(Object.assign({ type: Config.MSG.MODEL_TEST, model: model.id, url: model.url }, outcome)).catch(() => {});
}

async function loadModel(download) {
  const adapter = navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
  if (!adapter) throw codedError('noWebGPU');

  let file = await storedFile(current);
  if (!file) {
    if (!download) throw codedError('modelMissing');
    // The size the API gave was checked; this is the size the download really has. Without a
    // Content-Length `total` is 0 until the end, so the bytes that arrived are counted as well.
    let tooLarge = 0;
    const abort = new AbortController();
    try {
      file = await library().modelManager.downloadModel(current.url, {
        signal: abort.signal,
        progressCallback: ({ loaded, total }) => {
          state.progress = total > 0 ? loaded / total : 0;
          const size = Math.max(loaded, total);
          if (current.custom && !tooLarge && size > Config.CUSTOM_MAX_BYTES) {
            tooLarge = size;
            abort.abort();
          }
        },
      });
    } catch (err) {
      if (tooLarge) throw codedError('customTooLarge', String(tooLarge));
      throw codedError('downloadFailed', err && err.message ? err.message : String(err));
    }
  }
  // Also a file stored earlier (or one whose download ended before the check above saw its size)
  // is not loaded into memory when it is larger than the limit.
  if (current.custom && !(file.size > 0 && file.size <= Config.CUSTOM_MAX_BYTES)) {
    throw codedError('customTooLarge', String(file.size));
  }
  fileStored = true;
  report(current, 'stored');

  state.status = 'loading';
  state.progress = 1;
  // `file` is the stored file: loading it makes no network request.
  await library().loadModel(file, {
    n_ctx: Config.BUILTIN_CONTEXT,
    n_threads: 1, // the GPU does the work: measured, more threads do not make a decision faster
  });
}

/**
 * Loads this page's model once. `download`: a missing file may be downloaded (the user asked for
 * it). After a failed load the next call tries again; a failed download is never started again by
 * this page (the service worker opens a new page when the user asks again).
 */
function ensureLoaded(download) {
  if (ready) return Promise.resolve();
  if (!loading) {
    if (download && downloadError) {
      report(current, 'failed', downloadError);
      return Promise.reject(codedError(downloadError.code, downloadError.detail));
    }
    state.status = download ? 'downloading' : 'loading';
    state.progress = 0;
    state.error = null;
    fileStored = false;
    loading = loadModel(download).then(
      () => {
        ready = true;
        state.status = 'ready';
        report(current, 'ready');
      },
      (err) => {
        const error = describeError(err);
        loading = null;
        if (error.code === 'modelMissing') {
          state.status = 'missing';
          report(current, 'missing');
        } else {
          state.status = 'error';
          state.error = error;
          console.warn('[ParaBene] Built-in model failed:', err);
          // A download that was asked for and did not produce the file: the user has to ask again.
          if (download && !fileStored) {
            downloadError = error;
            report(current, 'failed', error);
          }
          // A library object whose load failed is not reused.
          if (fileStored && wllama) {
            wllama.exit().catch(() => {});
            wllama = null;
          }
        }
        throw codedError(error.code, error.detail);
      }
    );
    loading.catch(() => {}); // reported through `state` and to the requests that wait for it
  }
  return loading;
}

async function evaluate(body) {
  if (!ready) {
    const percent = () => String(Math.floor(state.progress * 100));
    // A download takes minutes: answer at once, the page uses keywords meanwhile.
    if (state.status === 'downloading') throw codedError('modelLoading', percent());
    let timer;
    const waited = new Promise((resolve) => {
      timer = setTimeout(resolve, LOAD_WAIT_MS, 'waiting');
    });
    try {
      if ((await Promise.race([ensureLoaded(false), waited])) === 'waiting') {
        throw codedError('modelLoading', percent());
      }
    } finally {
      clearTimeout(timer);
    }
  }
  const reply = await wllama.createSystemOne(body);
  reply.model = current.name;
  return reply;
}

let testStarted = false;

/**
 * The self-test of another basal version: loads it (downloading the file the user asked for),
 * then makes each decision of `bodies` one after another and measures it. The service worker
 * judges the replies and the times.
 */
async function selfTest(model, bodies) {
  let timer;
  try {
    await ensureLoaded(true);
    const times = [];
    const replies = [];
    // A decision that never answers would leave the trial (and pages on keywords) running for good:
    // after Config.CUSTOM_TEST_TIMEOUT_MS the test fails, and the service worker closes this page.
    const timeoutMs = Config.CUSTOM_TEST_TIMEOUT_MS;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(codedError('timeout', String(timeoutMs))), timeoutMs);
    });
    for (const body of bodies) {
      const started = performance.now();
      replies.push(await Promise.race([wllama.createSystemOne(body), timeout]));
      times.push(Math.round(performance.now() - started));
    }
    clearTimeout(timer);
    reportTest(model, { ok: true, times, replies });
    // The service worker may have been stopped meanwhile: wake it when the time to keep the model is up.
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: Config.MSG.MODEL_TRIAL_CHECK }).catch(() => {});
    }, Config.CUSTOM_KEEP_MS + 1000);
  } catch (err) {
    clearTimeout(timer);
    reportTest(model, { ok: false, error: describeError(err) });
  }
}

/** Removes the files (complete or not) of other basal versions; the built-in models' files are never touched. */
async function removeFiles(urls) {
  const cache = library().modelManager.cacheManager;
  for (const url of urls) {
    if (Config.parseCustomModelUrl(url) && !Config.BUILTIN_MODELS.some((model) => model.url === url)) await cache.delete(url);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only the extension's own pages and service worker (content scripts have a tab).
  if (sender.id !== chrome.runtime.id || sender.tab || !message || typeof message.type !== 'string') return false;
  if (message.type === Config.MSG.BUILTIN_REMOVE) {
    // Only on a page that holds no model (the service worker opens one for this).
    if (current || !Array.isArray(message.urls)) {
      sendResponse({ ok: false, error: { code: 'modelFailed', detail: 'cannot remove files here' } });
      return false;
    }
    removeFiles(message.urls).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: describeError(err) })
    );
    return true;
  }

  const types = [Config.MSG.BUILTIN_LOAD, Config.MSG.BUILTIN_STATUS, Config.MSG.BUILTIN_EVALUATE];
  if (!types.includes(message.type)) return false;

  const model = knownModel(message);
  if (!model) {
    sendResponse({ ok: false, error: { code: 'modelFailed', detail: 'unknown model' } });
    return false;
  }

  if (message.type === Config.MSG.BUILTIN_STATUS) {
    if (message.check !== true) {
      sendResponse({ ok: true, data: snapshot() });
      return false;
    }
    storedFile(model).then(
      (file) => sendResponse({ ok: true, data: Object.assign(snapshot(), { checked: model.id, stored: Boolean(file) }) }),
      (err) => sendResponse({ ok: false, error: describeError(err) })
    );
    return true;
  }

  // Loading and deciding: this page keeps the first model it is asked for.
  if (!current) current = model;
  const other = current.id !== model.id || current.url !== model.url;

  if (message.type === Config.MSG.BUILTIN_LOAD) {
    if (!other && current.custom && Array.isArray(message.test) && !testStarted) {
      testStarted = true;
      selfTest(current, message.test);
    } else if (!other) {
      ensureLoaded(message.download === true).catch(() => {});
    }
    sendResponse({ ok: true, data: snapshot() }); // `model` in it tells the service worker which one is here
    return false;
  }

  if (other) {
    sendResponse({ ok: false, error: { code: 'modelLoading', detail: '0' } });
    return false;
  }
  evaluate(message.body).then(
    (data) => sendResponse({ ok: true, data }),
    (err) => sendResponse({ ok: false, error: describeError(err) })
  );
  return true;
});
