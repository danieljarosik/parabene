/*
 * ParaBene – service worker.
 * - stores the default settings on install,
 * - proxies requests to the local AI model (a fetch from the extension context
 *   is not subject to page CORS or private network restrictions),
 * - or keeps the built-in AI model running in an offscreen document and asks it instead
 *   (src/config.js, "Built-in model"),
 * - optionally judges pictures: fetches them, scales them down and asks the
 *   multimodal basal-serve server (src/config.js, "Optional image evaluation"),
 * - shows the number of hidden elements in the current tab on the icon badge,
 * - passes the verdicts of content scripts to the opt-in log of evaluated content (src/log.js),
 * - keeps the examples learned from revealed content (opt-in, src/learning.js) and confirms
 *   pending ones when their tab leaves the page,
 * - serves translations to content scripts (they cannot read extension files).
 */
importScripts('config.js', 'i18n.js', 'evaluators.js', 'store.js', 'log.js');

const Config = self.ParaBeneConfig;
const I18n = self.ParaBeneI18n;
const Evaluators = self.ParaBeneEvaluators;
const Log = self.ParaBeneLog;

/** locale → Promise<messages>; lives as long as the service worker. */
const messageCache = new Map();

chrome.runtime.onInstalled.addListener(() => {
  Log.migrate(); // the log of versions up to 1.0 and its switch (src/log.js)
  applyEnvFile()
    .then(() => Config.load())
    .catch((err) => console.warn('[ParaBene] Failed to save default settings:', err))
    .then(checkBuiltinFile);
  chrome.action.setBadgeBackgroundColor({ color: '#E8833A' }).catch(() => {});
});

/**
 * Copies the settings from the optional, uncommitted .env file (see .env.example)
 * into chrome.storage.local. Runs on install and on every reload of the extension,
 * so editing .env + reloading applies it; changes made in the panel last until then.
 */
async function applyEnvFile() {
  let text;
  try {
    const response = await fetch(chrome.runtime.getURL(Config.ENV_FILE), { cache: 'no-store' });
    if (!response.ok) return;
    text = await response.text();
  } catch (_) {
    return; // no .env file — nothing to apply
  }
  const { settings, ignored } = Config.parseEnv(text);
  if (ignored.length) console.warn(`[ParaBene] ${Config.ENV_FILE}: ignored`, ignored);
  if (Object.keys(settings).length === 0) return;
  if (settings.aiProtocol && !settings.aiEndpoint) {
    // As in the panel: a protocol set alone also swaps an endpoint that is still a default one.
    const { aiEndpoint } = await chrome.storage.local.get('aiEndpoint');
    const fallback = Config.DEFAULT_ENDPOINTS[settings.aiProtocol]; // none for the built-in model
    if (fallback && (aiEndpoint === undefined || Object.values(Config.DEFAULT_ENDPOINTS).includes(aiEndpoint))) {
      settings.aiEndpoint = fallback;
    }
  }
  await chrome.storage.local.set(settings);
  console.info(`[ParaBene] Applied settings from ${Config.ENV_FILE}:`, Object.keys(settings));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message.type !== 'string') return false;

  if (message.type === Config.MSG.CLASSIFY) {
    classify(message.text, message.test === true, sender.url).then(sendResponse);
    return true;
  }

  if (message.type === Config.MSG.CLASSIFY_IMAGE && typeof message.url === 'string') {
    classifyImage(message.url, sender.url).then(sendResponse);
    return true;
  }

  if (message.type === Config.MSG.MODEL_STATUS && isExtensionPage(sender)) {
    builtinStatus().then(
      (data) => sendResponse({ ok: true, data }),
      (err) => sendResponse({ ok: false, error: describeError(err) })
    );
    return true;
  }

  if (message.type === Config.MSG.MODEL_DOWNLOAD && isExtensionPage(sender)) {
    requestBuiltinDownload().then(
      (data) => sendResponse({ ok: true, data }),
      (err) => sendResponse({ ok: false, error: describeError(err) })
    );
    return true;
  }

  if (message.type === Config.MSG.MODEL_STATE && isBuiltinDocument(sender) && Config.isBuiltinModel(message.model)) {
    builtinTask(() => recordBuiltinState(Config.builtinModel(message.model), message.state, message.error));
    return false;
  }

  if (message.type === Config.MSG.TEST_IMAGES) {
    testImages().then(sendResponse);
    return true;
  }

  if (message.type === Config.MSG.GET_MESSAGES) {
    getMessages(message.locale).then(sendResponse);
    return true;
  }

  if (message.type === Config.MSG.LOG_VERDICT || message.type === Config.MSG.LOG_REVEALED) {
    // Only from a content script in a normal window; the entry gets the tab's address from the browser.
    if (sender.tab && sender.tab.id >= 0 && !sender.tab.incognito) Log.queue(message.type, message.entry, sender.url);
    return false;
  }

  if (message.type === Config.MSG.LOG_CLEAR && isExtensionPage(sender)) {
    Log.clear().then(() => sendResponse({ ok: true }), (err) => sendResponse({ ok: false, error: describeError(err) }));
    return true;
  }

  if (message.type === Config.MSG.LEARN_PENDING && sender.tab && sender.tab.id >= 0) {
    learnPending(sender.tab.id, message.id, message.entry);
    return false;
  }
  if (message.type === Config.MSG.LEARN_COMMIT) {
    learnTask(() => commitPending((id) => id === message.id));
    return false;
  }
  if (message.type === Config.MSG.LEARN_CANCEL) {
    learnCancel(message.id);
    return false;
  }
  if (message.type === Config.MSG.LEARN_FORGET && Array.isArray(message.ids)) {
    learnTask(() => forgetLearned(new Set(message.ids)));
    return false;
  }
  if (message.type === Config.MSG.LEARN_IMPORT && isExtensionPage(sender) && Array.isArray(message.entries)) {
    // Queued with the other writes to the examples; the panel shows the outcome (or the real error).
    learnTask(() =>
      importLearned(message.entries).then(
        (data) => sendResponse({ ok: true, data }),
        (err) => sendResponse({ ok: false, error: describeError(err) })
      )
    );
    return true;
  }

  if (message.type === Config.MSG.STATS && sender.tab && sender.tab.id >= 0) {
    updateBadge(sender.tab.id, message.hidden);
  }
  return false;
});

async function getMessages(locale) {
  const code = Config.isSupportedLanguage(locale) ? locale : Config.DEFAULT_LANGUAGE;
  if (!messageCache.has(code)) {
    messageCache.set(
      code,
      I18n.loadMessages(code).catch((err) => {
        messageCache.delete(code);
        throw err;
      })
    );
  }
  try {
    return { ok: true, locale: code, messages: await messageCache.get(code) };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

/**
 * Errors are returned as { code, detail } — the popup translates the code
 * into the UI language (messages "aiError_<code>").
 * Requests still queued in a tab when the filter or the model was switched off are refused
 * ("cancelled"), so no text is sent after that; the panel's connection test (`test`) is always sent.
 */
async function classify(text, test, pageUrl) {
  let endpoint = '';
  try {
    const { enabled, excludedSites, aiEnabled, aiEndpoint, aiProtocol, aiModel, aiSensitivity, aiTopics } = await Config.load();
    if (!test && (!enabled || !aiEnabled || Config.isSiteExcluded(excludedSites, Config.siteHost(pageUrl)))) {
      throw Evaluators.cancelledError();
    }
    const input = String(text || '').slice(0, Config.AI_MAX_CHARS);
    if (aiProtocol === 'builtin') {
      // Without the chosen model's file nothing is asked and nothing is downloaded: the user downloads it in the panel.
      const model = Config.builtinModel(aiModel);
      const record = await builtinRecord(model);
      if (record.state === 'requested') {
        const { progress } = await builtinStatus();
        throw Evaluators.codedError('modelLoading', 'model is being downloaded', String(Math.floor((progress || 0) * 100)));
      }
      if (record.state !== 'stored') throw Evaluators.codedError('modelMissing', 'model file is not downloaded');
      // The model is in memory only while the settings ask for it (syncBuiltin): a test with the
      // filter or the AI model off would load it, and the next start of the service worker would
      // close the document again.
      if (!(enabled && aiEnabled)) throw Evaluators.codedError('builtinOff', 'the built-in model is off');
      const reply = await builtinTransport(model, Evaluators.basalRequest(input, aiTopics));
      const threshold = Config.AI_SENSITIVITIES[aiSensitivity];
      const data = Evaluators.parseBasalResponse(reply, { threshold, topics: aiTopics });
      return { ok: true, data: Object.assign(data, { threshold }) };
    }
    if (!Config.isValidEndpoint(aiEndpoint)) throw Evaluators.codedError('invalidEndpoint', 'invalid endpoint URL');
    const basal = aiProtocol === 'basal';
    endpoint = Config.resolveEndpoint(aiEndpoint, aiProtocol);
    const reply = await Evaluators.fetchTransport({
      endpoint,
      text: input,
      body: basal ? Evaluators.basalRequest(input, aiTopics) : undefined,
      timeoutMs: Config.AI_TIMEOUT_MS,
    });
    if (basal) {
      const threshold = Config.AI_SENSITIVITIES[aiSensitivity];
      const data = Evaluators.parseBasalResponse(reply, { threshold, topics: aiTopics });
      return { ok: true, data: Object.assign(data, { threshold }) };
    }
    const data = reply;
    if (!data || typeof data.hide !== 'boolean') {
      throw Evaluators.codedError('invalidResponse', 'invalid response (expected {"hide": boolean, "reason": string})');
    }
    return { ok: true, data: { hide: data.hide, reason: typeof data.reason === 'string' ? data.reason : '' } };
  } catch (err) {
    return { ok: false, error: describeError(notFoundHint(err, endpoint)) };
  }
}

/* ------------------------------------------------------------------ */
/* Built-in model (offscreen document)                                 */
/* ------------------------------------------------------------------ */

/*
 * The model lives in an offscreen document (offscreen/offscreen.js), not here: a service worker
 * is stopped after 30 s without events and would have to load the model again.
 *
 * The user picks one of Config.BUILTIN_MODELS (`aiModel`); the document holds one model at a time
 * and is closed and opened again for another one.
 *
 * Nothing is downloaded until the user clicks "Download model" in the panel. What is known about
 * each model's file is kept in chrome.storage.local (Config.BUILTIN_STORAGE_KEY): "requested"
 * after that click, "stored" once the document reports the complete file, "failed" when the
 * download did not work; no record means "missing". With the "builtin" request format the
 * document is open, for the chosen model,
 *  - while a requested download runs, whatever the filter and the AI switch say, and
 *  - while the file is stored and both the filter and the AI model are on;
 * otherwise it is closed, which frees the model's memory (it is also opened for a moment when the
 * panel asks whether a file is in the storage, and once after an install or update:
 * builtinStatus, checkBuiltinFile). Choosing another model or another request format cancels a
 * download. This is checked on every start of the service worker (so also when the browser starts
 * and when the extension is installed or reloaded) and when the settings or the records change.
 */
let builtinOpening = null;
/** A message to a document that is not listening yet is sent again this many times, 100 ms apart. */
const BUILTIN_SEND_ATTEMPTS = 50;
let builtinSync = Promise.resolve();

async function hasBuiltinDocument() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

/** Opens the document unless it is open; resolves (once the page has loaded) with true when this call opened it. */
async function openBuiltin() {
  if (!builtinOpening) {
    if (await hasBuiltinDocument()) return false;
    if (!builtinOpening) {
      builtinOpening = chrome.offscreen
        .createDocument({
          url: Config.BUILTIN_PAGE,
          reasons: ['WORKERS'],
          justification: 'Runs the local AI model that classifies page text (WebAssembly and WebGPU in a worker).',
        })
        .then(
          () => true,
          async (err) => {
            // Only one offscreen document may exist: another call may have opened it meanwhile.
            if (await hasBuiltinDocument()) return false;
            throw err;
          }
        )
        .finally(() => {
          builtinOpening = null;
        });
      return builtinOpening;
    }
  }
  await builtinOpening;
  return false;
}

/**
 * Sends a message to the offscreen document and resolves with its answer. A document that exists
 * but has not run its script yet has no listener: the call fails ("Receiving end does not exist")
 * or, when another page of the extension is open (the panel also listens for messages), resolves
 * with no answer. The message is then sent again for a short while.
 */
async function sendBuiltin(message) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await chrome.runtime.sendMessage(message);
      if (response !== undefined || attempt >= BUILTIN_SEND_ATTEMPTS) return response;
    } catch (err) {
      if (attempt >= BUILTIN_SEND_ATTEMPTS || !/Receiving end does not exist/i.test(String(err && err.message))) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Runs the tasks that open, close or question the document one after another. */
function builtinTask(task) {
  const run = () => task().catch((err) => console.warn('[ParaBene] Built-in model:', err));
  builtinSync = builtinSync.then(run, run);
  return builtinSync;
}

/** A message from one of the extension's own pages (the panel), not from a content script. */
function isExtensionPage(sender) {
  return typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
}

function isBuiltinDocument(sender) {
  return !sender.tab && sender.url === chrome.runtime.getURL(Config.BUILTIN_PAGE);
}

/** All records: { <model id>: { url, state, error? } }. */
async function builtinRecords() {
  const key = Config.BUILTIN_STORAGE_KEY;
  const records = (await chrome.storage.local.get(key))[key];
  return records && typeof records === 'object' && !Array.isArray(records) ? records : {};
}

/** The record about a model's file: { state: "missing" | "requested" | "stored" | "failed", error? }. */
async function builtinRecord(model) {
  const record = (await builtinRecords())[model.id];
  const valid = record && record.url === model.url && Config.BUILTIN_STATES.includes(record.state);
  return valid ? record : { state: 'missing' };
}

/** Writes a model's record ("missing" removes it). Call only from a builtinTask: it reads, then writes. */
async function writeBuiltinRecord(model, state, error) {
  const records = await builtinRecords();
  if (state === 'missing') {
    if (!(model.id in records)) return;
    delete records[model.id];
  } else {
    records[model.id] = { url: model.url, state };
    if (error && typeof error.code === 'string') records[model.id].error = { code: error.code, detail: error.detail };
  }
  await chrome.storage.local.set({ [Config.BUILTIN_STORAGE_KEY]: records });
}

/**
 * What the offscreen document found out about a model's file. Only these steps are taken:
 * anything → stored; stored → missing (the browser has removed the file); requested → failed.
 * A "missing" or "failed" report never cancels a download the user asked for or a stored file.
 * Call only from a builtinTask.
 */
async function recordBuiltinState(model, state, error) {
  const current = (await builtinRecord(model)).state;
  if (state === 'stored' && current !== 'stored') await writeBuiltinRecord(model, 'stored');
  else if (state === 'missing' && current === 'stored') await writeBuiltinRecord(model, 'missing');
  else if (state === 'failed' && current === 'requested') await writeBuiltinRecord(model, 'failed', error);
}

/** Opens the document and starts the download or the load, or closes the document (see above). */
function syncBuiltin() {
  return builtinTask(async () => {
    const { enabled, aiEnabled, aiProtocol, aiModel } = await Config.load();
    const model = Config.builtinModel(aiModel);
    // A download belongs to the chosen model of the built-in format: choosing another model or
    // format cancels it, so it does not start again by itself when the user comes back.
    for (const other of Config.BUILTIN_MODELS) {
      if (aiProtocol === 'builtin' && other.id === model.id) continue;
      if ((await builtinRecord(other)).state === 'requested') await writeBuiltinRecord(other, 'missing');
    }
    const { state } = await builtinRecord(model);
    const wanted = aiProtocol === 'builtin' && (state === 'requested' || (state === 'stored' && enabled && aiEnabled));
    if (!wanted) {
      if (await hasBuiltinDocument()) await chrome.offscreen.closeDocument();
      return;
    }
    const load = { type: Config.MSG.BUILTIN_LOAD, model: model.id, download: state === 'requested' };
    await openBuiltin();
    const reply = await sendBuiltin(load);
    if (reply && reply.ok && reply.data.model !== model.id) {
      // The document holds another model: a new document for this one.
      await chrome.offscreen.closeDocument();
      await openBuiltin();
      await sendBuiltin(load);
    }
  });
}

chrome.runtime.onStartup.addListener(syncBuiltin);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const keys = ['enabled', 'aiEnabled', 'aiProtocol', 'aiModel', Config.BUILTIN_STORAGE_KEY];
  if (keys.some((key) => key in changes)) syncBuiltin();
});
syncBuiltin(); // every start of the service worker, including install and reload

/**
 * Where the version with a single built-in model kept its one record, { url, state, error? } as
 * now (Config.BUILTIN_STORAGE_KEY holds one per model).
 */
const LEGACY_BUILTIN_STORAGE_KEY = 'builtinModel';

/**
 * On install and update: the record kept under the legacy key is moved to its model's entry, so a
 * download that was asked for starts again and a failed one keeps its error. An earlier version
 * may also have stored the chosen model's file without any record (it downloaded the file by
 * itself): the file is looked for now, so the model is used again at once instead of only after
 * the panel is next opened. Only the extension's storage is checked; nothing is downloaded that
 * the user did not ask for.
 */
async function checkBuiltinFile() {
  try {
    await builtinTask(migrateLegacyRecord);
    await builtinStatus();
  } catch (err) {
    console.warn('[ParaBene] Built-in model:', err);
  }
}

/**
 * Moves a valid legacy record to the model with its URL, unless that model has a valid record
 * already (a newer one), then removes the legacy key. Call only from a builtinTask.
 */
async function migrateLegacyRecord() {
  const key = LEGACY_BUILTIN_STORAGE_KEY;
  const legacy = (await chrome.storage.local.get(key))[key];
  if (legacy === undefined) return;
  const model = legacy && Config.BUILTIN_MODELS.find((item) => item.url === legacy.url);
  if (model && Config.BUILTIN_STATES.includes(legacy.state) && (await builtinRecord(model)).state === 'missing') {
    await writeBuiltinRecord(model, legacy.state, legacy.error);
  }
  await chrome.storage.local.remove(key);
}

/** The panel's "Download model": remembers the request for the chosen model; syncBuiltin then starts the download. */
async function requestBuiltinDownload() {
  await builtinTask(async () => {
    const { aiProtocol, aiModel } = await Config.load();
    const model = Config.builtinModel(aiModel);
    if (aiProtocol === 'builtin' && (await builtinRecord(model)).state !== 'stored') await writeBuiltinRecord(model, 'requested');
  });
  await syncBuiltin();
}

/**
 * For the panel (and checkBuiltinFile), about the chosen model: { model, status, progress?, error?,
 * stored? } with status "missing" | "downloading" | "loading" | "ready" | "stored" (on disk, not in
 * memory) | "error" (`stored`: the file is there, so the error is not about the download).
 * The records are checked against the document: an open document is asked for its state; with no
 * document and no download running, one is opened for a moment to ask whether the file is in the
 * storage — a file without a record (downloaded by an earlier version, or a record lost with the
 * settings) is then used as it is, and a record without a file (removed by the browser) is dropped.
 */
async function builtinStatus() {
  let live = null;
  let model = null;
  await builtinTask(async () => {
    const { aiProtocol, aiModel } = await Config.load();
    model = Config.builtinModel(aiModel);
    if (await hasBuiltinDocument()) {
      const reply = await sendBuiltin({ type: Config.MSG.BUILTIN_STATUS, model: model.id });
      if (!reply || !reply.ok || reply.data.model !== model.id) return;
      live = reply.data;
      // The document's reports (MODEL_STATE) are not acknowledged: take the same facts from its status.
      if (live.stored) await recordBuiltinState(model, 'stored');
      else if (live.status === 'error') await recordBuiltinState(model, 'failed', live.error);
    } else if (aiProtocol === 'builtin' && ['missing', 'stored'].includes((await builtinRecord(model)).state)) {
      await openBuiltin();
      const reply = await sendBuiltin({ type: Config.MSG.BUILTIN_STATUS, model: model.id, check: true });
      if (reply && reply.ok) await recordBuiltinState(model, reply.data.stored ? 'stored' : 'missing');
    }
  });
  // No document answered: close one opened only to look, or open one that is wanted.
  if (!live) await syncBuiltin();
  const record = await builtinRecord(model);
  const stored = record.state === 'stored';
  const about = { model: model.id };
  if (live && ['downloading', 'loading', 'ready'].includes(live.status)) {
    return Object.assign(about, { status: live.status, progress: live.progress });
  }
  if (live && live.status === 'error') return Object.assign(about, { status: 'error', error: live.error, stored });
  if (stored) return Object.assign(about, { status: 'stored' });
  if (record.state === 'requested') return Object.assign(about, { status: 'downloading', progress: 0 });
  if (record.state === 'failed') {
    return Object.assign(about, { status: 'error', error: record.error || { code: 'downloadFailed' }, stored: false });
  }
  return Object.assign(about, { status: 'missing' });
}

/** Asks the model in the offscreen document; resolves with its basal reply. */
async function builtinTransport(model, body) {
  // Normally syncBuiltin has opened the document. One opened here (the service worker has just
  // started, or the settings were switched off after this request was checked) is checked
  // against the settings again, so it is not left open when they no longer ask for it.
  if (await openBuiltin()) syncBuiltin();
  const timeoutMs = Config.BUILTIN_TIMEOUT_MS;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(Evaluators.codedError('timeout', `timed out after ${timeoutMs} ms`, String(timeoutMs))),
      timeoutMs
    );
  });
  try {
    const response = await Promise.race([
      sendBuiltin({ type: Config.MSG.BUILTIN_EVALUATE, model: model.id, body }),
      timeout,
    ]);
    if (!response || !response.ok) {
      const error = (response && response.error) || { code: 'noResponse' };
      throw Evaluators.codedError(error.code, error.detail ? `${error.code}: ${error.detail}` : error.code, error.detail);
    }
    return response.data;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Image evaluation (basal-omni, optional)                             */
/* ------------------------------------------------------------------ */

/** Shared by all tabs: the server answers one request at a time anyway. */
const imageLimiter = new Evaluators.ConcurrencyLimiter(Config.IMAGE_MAX_CONCURRENT);
/** endpoint + topics + picture address (imageKey) → the model's raw reply (the threshold is applied on every use). */
const imageCache = new Map();
/** The same key → Promise of the reply while the picture is being judged: asked by two tiles or tabs, it is one request. */
const imageRequests = new Map();
const IMAGE_CACHE_SIZE = 500;
const IMAGE_FETCH_TIMEOUT_MS = 10000;
/** A longer picture address is kept in the cache as its SHA-256 digest (a data: URL can be megabytes long). */
const IMAGE_KEY_MAX_URL = 512;

/** The picture address as a cache key of bounded length. */
async function imageKey(url) {
  if (url.length <= IMAGE_KEY_MAX_URL) return url;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

/** Upper bound of the size of the picture inside a data: URL, from the length of the address alone. */
function dataUrlBytes(url) {
  const comma = url.indexOf(',');
  const payload = url.length - comma - 1;
  return /;\s*base64\s*$/i.test(url.slice(0, Math.max(comma, 0))) ? Math.floor((payload * 3) / 4) : payload;
}

function imageTooLargeError() {
  return Evaluators.codedError('imageFetch', `image larger than ${Config.IMAGE_MAX_BYTES} B`);
}

function canClassifyImage(settings, hosts) {
  return settings.enabled && settings.aiImagesEnabled &&
    [...hosts].some((host) => !Config.isSiteExcluded(settings.excludedSites, host));
}

/**
 * Judges the picture at `url` (http(s) or data:). Errors with the codes imageFetch, imageDecode,
 * imageTooSmall and an HTTP 422 concern this picture only; any other error means the server is
 * unavailable (the content script then pauses image evaluation for a while).
 */
async function classifyImage(url, pageUrl) {
  let endpoint = '';
  try {
    // The content script sends only such addresses; nothing else is ever fetched from here.
    if (!/^(https?:|data:image\/)/i.test(url)) throw Evaluators.codedError('imageFetch', 'unsupported picture address');
    // An oversized data: picture is refused before it is hashed or decoded.
    if (/^data:/i.test(url) && dataUrlBytes(url) > Config.IMAGE_MAX_BYTES) throw imageTooLargeError();
    const host = Config.siteHost(pageUrl);
    const settings = await Config.load();
    if (!canClassifyImage(settings, [host])) throw Evaluators.cancelledError();
    const { aiImagesEndpoint, aiSensitivity, aiTopics } = settings;
    if (!Config.isValidEndpoint(aiImagesEndpoint)) {
      throw Evaluators.codedError('invalidEndpoint', 'invalid image endpoint URL');
    }
    endpoint = Config.resolveEndpoint(aiImagesEndpoint, 'basal');
    const key = `${endpoint}\n${aiTopics.join(',')}\n${await imageKey(url)}`;
    let reply = imageCache.get(key);
    if (!reply) {
      let request = imageRequests.get(key);
      if (request) {
        request.hosts.add(host);
      } else {
        const hosts = new Set([host]);
        const pending = imageLimiter
          .run(async () => {
            // A shared request can continue while at least one of its sites still uses image evaluation.
            if (!canClassifyImage(await Config.load(), hosts)) throw Evaluators.cancelledError();
            const image = await loadImage(url);
            if (!canClassifyImage(await Config.load(), hosts)) throw Evaluators.cancelledError();
            return Evaluators.fetchTransport({
              endpoint,
              body: Evaluators.basalImageRequest(image, aiTopics),
              timeoutMs: Config.IMAGE_TIMEOUT_MS,
            });
          })
          .finally(() => imageRequests.delete(key));
        request = { hosts, pending };
        imageRequests.set(key, request);
      }
      reply = await request.pending;
      imageCache.set(key, reply);
      if (imageCache.size > IMAGE_CACHE_SIZE) imageCache.delete(imageCache.keys().next().value);
    }
    const threshold = Config.AI_SENSITIVITIES[aiSensitivity];
    const topics = Evaluators.basalImageTopics(aiTopics);
    const data = Evaluators.parseBasalResponse(reply, { threshold, topics });
    return { ok: true, data: Object.assign(data, { threshold }) };
  } catch (err) {
    return { ok: false, error: describeError(notFoundHint(err, endpoint, 'imagesNotFound')) };
  }
}

/**
 * Picture URL → base64 JPEG, at most IMAGE_MAX_SEND_SIDE px a side, transparency on white.
 * Re-encoding also turns an animated GIF/WebP into its first frame (basal refuses animations).
 */
async function loadImage(url) {
  let blob;
  try {
    const response = await fetch(url, {
      credentials: 'omit',
      cache: 'force-cache',
      signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    blob = await readImageBlob(response);
  } catch (err) {
    if (err && err.code) throw err;
    throw Evaluators.codedError('imageFetch', `image fetch failed: ${err.message}`);
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (err) {
    throw Evaluators.codedError('imageDecode', `cannot decode ${blob.type || 'image'}`);
  }
  try {
    const { width, height } = bitmap;
    if (Math.min(width, height) < Config.IMAGE_MIN_SIDE) {
      throw Evaluators.codedError('imageTooSmall', `${width}x${height}`);
    }
    const scale = Math.min(1, Config.IMAGE_MAX_SEND_SIDE / Math.max(width, height));
    const canvas = new OffscreenCanvas(Math.round(width * scale), Math.round(height * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return encodeCanvas(canvas);
  } finally {
    bitmap.close();
  }
}

/**
 * The response body as a Blob of at most IMAGE_MAX_BYTES. A larger picture is refused on its
 * Content-Length or, without one, as soon as that many bytes have arrived — the rest is not downloaded.
 */
async function readImageBlob(response) {
  const maxBytes = Config.IMAGE_MAX_BYTES;
  if (Number(response.headers.get('content-length')) > maxBytes) {
    if (response.body) response.body.cancel().catch(() => {});
    throw imageTooLargeError();
  }
  const chunks = [];
  if (response.body) {
    const reader = response.body.getReader();
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        reader.cancel().catch(() => {});
        throw imageTooLargeError();
      }
      chunks.push(value);
    }
  }
  return new Blob(chunks, { type: response.headers.get('content-type') || '' });
}

async function encodeCanvas(canvas) {
  const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  const bytes = new Uint8Array(await jpeg.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Panel test: checks that the server's model takes images (GET /v1/models) and judges a generated
 * neutral picture (which also loads the model after a server start — that request can take ~15 s).
 */
async function testImages() {
  let endpoint = '';
  try {
    const { aiImagesEndpoint, aiSensitivity, aiTopics } = await Config.load();
    if (!Config.isValidEndpoint(aiImagesEndpoint)) {
      throw Evaluators.codedError('invalidEndpoint', 'invalid image endpoint URL');
    }
    endpoint = modelsUrl(aiImagesEndpoint);
    const models = await getJson(endpoint, Config.AI_TIMEOUT_MS);
    const model = models && Array.isArray(models.models) ? models.models[0] : null;
    if (!model) throw Evaluators.codedError('invalidResponse', 'no model in /v1/models');
    if (!Array.isArray(model.media) || !model.media.includes('image')) {
      throw Evaluators.codedError('noImageSupport', `${model.name} takes no images`, String(model.name || '?'));
    }

    endpoint = Config.resolveEndpoint(aiImagesEndpoint, 'basal');
    const started = Date.now();
    const reply = await imageLimiter.run(async () =>
      Evaluators.fetchTransport({
        endpoint,
        body: Evaluators.basalImageRequest(await testPicture(), aiTopics),
        timeoutMs: Config.IMAGE_TIMEOUT_MS,
      })
    );
    const threshold = Config.AI_SENSITIVITIES[aiSensitivity];
    const data = Evaluators.parseBasalResponse(reply, { threshold, topics: Evaluators.basalImageTopics(aiTopics) });
    return { ok: true, data: Object.assign(data, { threshold, model: data.model || model.name, ms: Date.now() - started }) };
  } catch (err) {
    return { ok: false, error: describeError(notFoundHint(err, endpoint, 'imagesNotFound')) };
  }
}

/** basal-serve's model list next to its decision route: http://host:port[/prefix]/v1/models. */
function modelsUrl(endpoint) {
  const url = new URL(endpoint);
  const prefix = url.pathname.replace(/\/v1\/(basal|systemone)\/?$/, '').replace(/\/+$/, '');
  url.pathname = `${prefix}/v1/models`;
  url.search = '';
  return url.toString();
}

async function getJson(url, timeoutMs) {
  let response;
  try {
    response = await fetch(url, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw Evaluators.codedError('timeout', `timed out after ${timeoutMs} ms`, String(timeoutMs));
    }
    throw Evaluators.codedError('unreachable', err.message);
  }
  if (!response.ok) throw Evaluators.codedError('http', `HTTP ${response.status}`, String(response.status));
  try {
    return await response.json();
  } catch (_) {
    throw Evaluators.codedError('invalidResponse', 'response is not valid JSON');
  }
}

/** A plain landscape (sky, sun, meadow): a neutral picture the model should not hide. */
async function testPicture() {
  const canvas = new OffscreenCanvas(320, 240);
  const context = canvas.getContext('2d');
  const sky = context.createLinearGradient(0, 0, 0, 160);
  sky.addColorStop(0, '#5aa0e6');
  sky.addColorStop(1, '#cfe6fa');
  context.fillStyle = sky;
  context.fillRect(0, 0, 320, 160);
  context.fillStyle = '#5c9e3c';
  context.fillRect(0, 160, 320, 80);
  context.fillStyle = '#ffd34d';
  context.beginPath();
  context.arc(250, 60, 28, 0, Math.PI * 2);
  context.fill();
  return encodeCanvas(canvas);
}

/** A 404 gets the path it came from, for the panel's hint (`code`: the hint's message). */
function notFoundHint(err, endpoint, code = 'notFound') {
  if (err && err.code === 'http' && err.detail === '404') {
    err.code = code;
    err.detail = pathOf(endpoint);
  }
  return err;
}

/** The path a 404 came from, for the panel's hint. */
function pathOf(endpoint) {
  try {
    return new URL(endpoint).pathname;
  } catch (_) {
    return '?';
  }
}

function describeError(err) {
  if (err && err.code) return { code: err.code, detail: err.detail };
  return { code: 'unknown', detail: err && err.message ? err.message : String(err) };
}

function updateBadge(tabId, hidden) {
  const count = Number.isFinite(hidden) ? Math.max(0, Math.floor(hidden)) : 0;
  const text = count === 0 ? '' : count > 999 ? '999+' : String(count);
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#E8833A' }).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Learning from revealed content (opt-in, src/learning.js)            */
/* ------------------------------------------------------------------ */

/*
 * "Show anyway" makes the revealed content a pending example (LEARN_PENDING_KEY, with its tab).
 * It is confirmed (moved to LEARN_STORAGE_KEY) when the user scrolls far past it (the content
 * script sends LEARN_COMMIT), or when its tab navigates away, reloads or closes. "Hide" on the
 * revealed content cancels it, also after it was confirmed. Pending examples are kept in
 * chrome.storage.local, so a browser restart confirms them instead of losing them.
 */

let learnWrite = Promise.resolve();

/** Storage updates run one after another — tabs send them concurrently. */
function learnTask(task) {
  learnWrite = learnWrite.then(task).catch((err) => console.warn('[ParaBene] Failed to update learned examples:', err));
  return learnWrite;
}

async function readStoredObject(key) {
  const stored = await chrome.storage.local.get(key);
  const value = stored[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function readLearned() {
  const stored = await chrome.storage.local.get(Config.LEARN_STORAGE_KEY);
  const value = stored[Config.LEARN_STORAGE_KEY];
  return Array.isArray(value) ? value : [];
}

function isLearnId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(id);
}

/** Keeps only the known fields, with sane types and lengths; null when there is nothing to learn from. */
function sanitizeLearnEntry(raw, id, time) {
  if (!raw || typeof raw !== 'object') return null;
  const entry = {
    id,
    time: time || new Date().toISOString(),
    url: String(raw.url || '').slice(0, 500),
    source: raw.source === 'ai' ? 'ai' : 'keyword',
    category: typeof raw.category === 'string' ? raw.category.slice(0, 40) : '',
    reason: String(raw.reason || '').slice(0, 200),
    text: String(raw.text || '').slice(0, Config.LEARN_MAX_TEXT),
  };
  if (raw.media === 'image') {
    // Pictures are matched by their address, so a truncated or data: address is useless.
    const image = String(raw.image || '');
    if (!/^https?:/i.test(image) || image.length > 2000) return null;
    entry.media = 'image';
    entry.image = image;
  } else if (!entry.text.trim()) {
    return null;
  }
  return entry;
}

/** Same reason and the same text or picture — a newer example replaces the older one. */
function learnKey(entry) {
  const why = entry.category || entry.reason.toLocaleLowerCase('pl');
  return [entry.source, entry.media || 'text', why, entry.media === 'image' ? entry.image : entry.text].join('\n');
}

function learnPending(tabId, id, raw) {
  if (!isLearnId(id)) return;
  const entry = sanitizeLearnEntry(raw, id);
  if (!entry) return;
  learnTask(async () => {
    const pending = await readStoredObject(Config.LEARN_PENDING_KEY);
    pending[id] = { tabId, entry };
    await chrome.storage.local.set({ [Config.LEARN_PENDING_KEY]: pending });
  });
}

function learnCancel(id) {
  if (!isLearnId(id)) return;
  learnTask(async () => {
    const pending = await readStoredObject(Config.LEARN_PENDING_KEY);
    if (pending[id]) {
      delete pending[id];
      await chrome.storage.local.set({ [Config.LEARN_PENDING_KEY]: pending });
    }
    await forgetLearned(new Set([id]));
  });
}

/** Moves the pending examples selected by `select(id, item)` to the learned ones. */
async function commitPending(select) {
  const pending = await readStoredObject(Config.LEARN_PENDING_KEY);
  const chosen = Object.entries(pending).filter(([id, item]) => select(id, item));
  if (chosen.length === 0) return;
  for (const [id] of chosen) delete pending[id];
  await chrome.storage.local.set({ [Config.LEARN_PENDING_KEY]: pending });

  // Learning switched off in the meantime: the pending examples are dropped.
  const { learnEnabled } = await Config.load();
  if (!learnEnabled) return;
  const added = chosen.map(([, item]) => item.entry).filter((entry) => entry && isLearnId(entry.id));
  const keys = new Set(added.map(learnKey));
  const learned = (await readLearned()).filter((entry) => !keys.has(learnKey(entry)));
  learned.push(...added);
  await chrome.storage.local.set({ [Config.LEARN_STORAGE_KEY]: learned.slice(-Config.LEARN_MAX_ENTRIES) });
}

/**
 * Examples restored from a settings backup (the panel, src/backup.js): each one is checked like a
 * new example, keeps its id and date, and replaces a stored example with the same id or the same
 * reason and text (within the file, a later example replaces an earlier one the same way); the
 * newest LEARN_MAX_ENTRIES are kept. → { imported, tooOld, skipped }: `imported` counts the examples
 * of the file actually kept, `tooOld` those that fell outside the newest LEARN_MAX_ENTRIES.
 */
async function importLearned(entries) {
  const byKey = new Map();
  const keyById = new Map();
  let skipped = 0;
  for (const raw of entries) {
    const time = raw && typeof raw.time === 'string' && !Number.isNaN(Date.parse(raw.time)) ? new Date(raw.time).toISOString() : '';
    const entry = sanitizeLearnEntry(raw, raw && isLearnId(raw.id) ? raw.id : crypto.randomUUID(), time);
    if (!entry) {
      skipped += 1;
      continue;
    }
    // A later duplicate in the file (same id, or same reason and text) wins: ids stay unique.
    const key = learnKey(entry);
    if (keyById.has(entry.id)) byKey.delete(keyById.get(entry.id));
    if (byKey.has(key)) keyById.delete(byKey.get(key).id);
    byKey.delete(key);
    byKey.set(key, entry);
    keyById.set(entry.id, key);
  }
  const imported = [...byKey.values()];
  const learned = (await readLearned()).filter((entry) => !keyById.has(entry.id) && !byKey.has(learnKey(entry)));
  const merged = [...learned, ...imported].sort((a, b) => String(a.time).localeCompare(String(b.time)));
  const kept = merged.slice(-Config.LEARN_MAX_ENTRIES);
  await chrome.storage.local.set({ [Config.LEARN_STORAGE_KEY]: kept });
  const importedSet = new Set(imported);
  const keptImported = kept.filter((entry) => importedSet.has(entry)).length;
  return { imported: keptImported, tooOld: imported.length - keptImported, skipped };
}

async function forgetLearned(ids) {
  const learned = await readLearned();
  const kept = learned.filter((entry) => !ids.has(entry.id));
  if (kept.length !== learned.length) await chrome.storage.local.set({ [Config.LEARN_STORAGE_KEY]: kept });
}

function commitTab(tabId) {
  learnTask(() => commitPending((id, item) => item && item.tabId === tabId));
}

chrome.tabs.onRemoved.addListener((tabId) => commitTab(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A new address (also an in-page navigation) or a reload: the user has left the revealed content.
  if (changeInfo.url || changeInfo.status === 'loading') commitTab(tabId);
});

/** On start-up: pending examples of tabs that no longer exist (e.g. after a browser restart). */
learnTask(async () => {
  const tabs = await chrome.tabs.query({});
  const open = new Set(tabs.map((tab) => tab.id));
  await commitPending((id, item) => !item || !open.has(item.tabId));
});
