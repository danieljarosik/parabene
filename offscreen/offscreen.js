/*
 * ParaBene – offscreen document: the built-in AI model (src/config.js, "Built-in model").
 *
 * The service worker opens this page and keeps it in the background; a service worker itself is
 * stopped after 30 s of inactivity and would load the model again each time. The page keeps the
 * basal decision model with wllama (llama.cpp in WebAssembly, on the GPU through WebGPU) and
 * answers the service worker's messages:
 *   BUILTIN_LOAD      { download } starts loading the stored model file; only with `download: true`
 *                     (the user clicked "Download model") a missing file is downloaded first.
 *                     Returns the current status.
 *   BUILTIN_STATUS    { check } returns the status; with `check: true` also whether the complete
 *                     file is in the storage (`stored`), without loading or downloading anything.
 *   BUILTIN_EVALUATE  { body: <basal request> } → { ok, data: <basal reply> } | { ok: false, error }.
 *                     Never downloads.
 * It tells the service worker what it learns about the file (MODEL_STATE: "stored", "missing",
 * "failed"); a page of this kind cannot write chrome.storage itself.
 *
 * Status: idle → loading → ready, with "downloading" (progress 0..1) before "loading" when the file
 * is fetched; "missing" when there is no file and no permission to download; "error" otherwise.
 * Errors are { code, detail }, translated by the panel ("aiError_<code>"):
 *   noWebGPU        the browser gives no GPU adapter (checked before any download),
 *   modelMissing    the model file is not stored and may not be downloaded,
 *   downloadFailed  the download failed (detail: the error's text),
 *   modelLoading    the model is still being downloaded or loaded (detail: percent downloaded),
 *   modelFailed     loading or a decision failed (detail: the error's text).
 *
 * wllama's decision API takes basal-serve's request (state, questions) but shows the option keys to
 * the model whatever "option_keys" says, so its scores are those of basal-serve asked with visible
 * keys: on 24 Polish texts they differed from the hidden-keys scores by 0.05 on average (0.21 at
 * most), and no decision at the threshold 0.5 changed.
 */
import { Wllama } from '../vendor/wllama/index.js';

const Config = self.ParaBeneConfig;

/** A request waits this long for a model that is being loaded before it reports `modelLoading`. */
const LOAD_WAIT_MS = 10000;

const state = { status: 'idle', progress: 0, error: null };
let wllama = null; // the library object; made once, it also reads the model storage
let ready = false; // the model is in memory
let fileStored = false; // the current load attempt has the complete file
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
  return { status: state.status, progress: state.progress, error: state.error };
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

/** The complete model file in the extension's storage, or null (no network request). */
async function storedModel() {
  const models = await library().modelManager.getModels();
  return models.find((model) => model.url === Config.BUILTIN_MODEL_URL) || null;
}

/** Tells the service worker what is known about the model file (it keeps the record). */
function report(fileState, error) {
  chrome.runtime.sendMessage({ type: Config.MSG.MODEL_STATE, state: fileState, error }).catch(() => {});
}

async function loadModel(download) {
  const adapter = navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
  if (!adapter) throw codedError('noWebGPU');

  let model = await storedModel();
  if (!model) {
    if (!download) throw codedError('modelMissing');
    state.status = 'downloading';
    try {
      model = await library().modelManager.downloadModel(Config.BUILTIN_MODEL_URL, {
        progressCallback: ({ loaded, total }) => {
          state.progress = total > 0 ? loaded / total : 0;
        },
      });
    } catch (err) {
      throw codedError('downloadFailed', err && err.message ? err.message : String(err));
    }
  }
  fileStored = true;
  report('stored');

  state.status = 'loading';
  state.progress = 1;
  // `model` is the stored file: loading it makes no network request.
  await library().loadModel(model, {
    n_ctx: Config.BUILTIN_CONTEXT,
    n_threads: 1, // the GPU does the work: measured, more threads do not make a decision faster
  });
}

/**
 * Loads the model once. `download`: a missing file may be downloaded (the user asked for it).
 * After a failure the next call tries again; nothing here retries by itself.
 */
function ensureLoaded(download) {
  if (ready) return Promise.resolve();
  if (!loading) {
    state.status = 'loading';
    state.progress = 0;
    state.error = null;
    fileStored = false;
    loading = loadModel(download).then(
      () => {
        ready = true;
        state.status = 'ready';
      },
      (err) => {
        const error = describeError(err);
        loading = null;
        if (error.code === 'modelMissing') {
          state.status = 'missing';
          report('missing');
        } else {
          state.status = 'error';
          state.error = error;
          console.warn('[ParaBene] Built-in model failed:', err);
          // A download that was asked for and did not produce the file: the user has to ask again.
          if (download && !fileStored) report('failed', error);
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
  reply.model = Config.BUILTIN_MODEL_NAME;
  return reply;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only the extension's own pages and service worker (content scripts have a tab).
  if (sender.id !== chrome.runtime.id || sender.tab || !message || typeof message.type !== 'string') return false;

  if (message.type === Config.MSG.BUILTIN_LOAD) {
    ensureLoaded(message.download === true).catch(() => {});
    sendResponse({ ok: true, data: snapshot() });
    return false;
  }

  if (message.type === Config.MSG.BUILTIN_STATUS) {
    if (message.check !== true) {
      sendResponse({ ok: true, data: snapshot() });
      return false;
    }
    storedModel().then(
      (model) => sendResponse({ ok: true, data: Object.assign(snapshot(), { stored: Boolean(model) }) }),
      (err) => sendResponse({ ok: false, error: describeError(err) })
    );
    return true;
  }

  if (message.type === Config.MSG.BUILTIN_EVALUATE) {
    evaluate(message.body).then(
      (data) => sendResponse({ ok: true, data }),
      (err) => sendResponse({ ok: false, error: describeError(err) })
    );
    return true;
  }
  return false;
});
