/*
 * ParaBene – offscreen document: the built-in AI model (src/config.js, "Built-in model").
 *
 * The service worker opens this page once and keeps it in the background; a service worker itself
 * is stopped after 30 s of inactivity and would load the model again each time. The page loads the
 * basal decision model with wllama (llama.cpp in WebAssembly, on the GPU through WebGPU) and answers
 * the service worker's messages:
 *   BUILTIN_LOAD      starts loading (a download on first use) and returns the current status,
 *   BUILTIN_EVALUATE  { body: <basal request> } → { ok, data: <basal reply> } | { ok: false, error }.
 * Errors are { code, detail }, translated by the panel ("aiError_<code>"):
 *   noWebGPU      the browser gives no GPU adapter,
 *   modelLoading  the model is still being downloaded or loaded (detail: percent downloaded),
 *   modelFailed   loading or a decision failed (detail: the error's text).
 *
 * wllama's decision API takes basal-serve's request (state, questions) but shows the option keys to
 * the model whatever "option_keys" says, so its scores are those of basal-serve asked with visible
 * keys: on 24 Polish texts they differed from the hidden-keys scores by 0.05 on average (0.21 at
 * most), and no decision at the threshold 0.5 changed.
 */
import { Wllama } from '../vendor/wllama/index.js';

const Config = self.ParaBeneConfig;

/** A request waits this long for a model that is loading before it reports `modelLoading`. */
const LOAD_WAIT_MS = 10000;

const state = { status: 'idle', progress: 0, error: null };
let wllama = null;
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

async function loadModel() {
  const adapter = navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
  if (!adapter) throw codedError('noWebGPU');

  const quiet = () => {};
  const instance = new Wllama(
    { default: chrome.runtime.getURL('vendor/wllama/wasm/wllama.wasm') },
    { logger: { debug: quiet, log: quiet, warn: console.warn, error: console.error } }
  );
  // No compatibility mode: in a browser without JSPI or 64-bit WebAssembly memory wllama would
  // otherwise download a second build of itself from a CDN and run it. Loading then fails instead.
  instance.setCompat(null);
  // A model stored complete in the extension's storage is loaded from there without any request
  // (wllama's ModelManager.getModelOrDownload); an interrupted download starts again from the beginning.
  await instance.loadModelFromUrl(Config.BUILTIN_MODEL_URL, {
    n_ctx: Config.BUILTIN_CONTEXT,
    n_threads: 1, // the GPU does the work: measured, more threads do not make a decision faster
    progressCallback: ({ loaded, total }) => {
      state.progress = total > 0 ? loaded / total : 0;
    },
  });
  return instance;
}

/** Loads the model once; after a failure the next call tries again. */
function ensureLoaded() {
  if (!loading) {
    state.status = 'loading';
    state.progress = 0;
    state.error = null;
    loading = loadModel().then(
      (instance) => {
        wllama = instance;
        state.status = 'ready';
        state.progress = 1;
      },
      (err) => {
        loading = null;
        state.status = 'error';
        state.error = describeError(err);
        console.warn('[ParaBene] Built-in model failed to load:', err);
        throw codedError(state.error.code, state.error.detail);
      }
    );
    loading.catch(() => {}); // reported through `state` and to the requests that wait for it
  }
  return loading;
}

async function evaluate(body) {
  if (!wllama) {
    let timer;
    const waited = new Promise((resolve) => {
      timer = setTimeout(resolve, LOAD_WAIT_MS, 'waiting');
    });
    try {
      if ((await Promise.race([ensureLoaded(), waited])) === 'waiting') {
        throw codedError('modelLoading', String(Math.floor(state.progress * 100)));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  // wllama runs the decisions one after another.
  const reply = await wllama.createSystemOne(body);
  reply.model = Config.BUILTIN_MODEL_NAME;
  return reply;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only the extension's own pages and service worker (content scripts have a tab).
  if (sender.id !== chrome.runtime.id || sender.tab || !message || typeof message.type !== 'string') return false;

  if (message.type === Config.MSG.BUILTIN_LOAD) {
    ensureLoaded().catch(() => {});
    sendResponse({ ok: true, data: snapshot() });
    return false;
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
