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

  if (message.type === Config.MSG.MODEL_STATE && isBuiltinDocument(sender)) {
    builtinTask(async () => {
      const model = await reportedModel(message);
      if (!model) return;
      if (message.state === 'ready') {
        await customLoaded(model);
        await announceReady(model);
      } else {
        await recordBuiltinState(model, message.state, message.error);
      }
    }).catch(() => {});
    return false;
  }

  if (message.type === Config.MSG.MODEL_TEST && isBuiltinDocument(sender)) {
    builtinTask(() => recordCustomTest(message)).catch(() => {});
    return false;
  }

  if (message.type === Config.MSG.MODEL_TRIAL_CHECK && isBuiltinDocument(sender)) {
    syncBuiltin();
    return false;
  }

  const customActions = {
    [Config.MSG.CUSTOM_CHECK]: () => customModelInfo(message.url),
    [Config.MSG.CUSTOM_START]: () => startCustomTrial(message.url, message.accepted === true),
    [Config.MSG.CUSTOM_STATUS]: customStatus,
    [Config.MSG.CUSTOM_KEEP]: keepCustom,
    [Config.MSG.CUSTOM_DISCARD]: discardCustom,
  };
  if (Object.prototype.hasOwnProperty.call(customActions, message.type) && isExtensionPage(sender)) {
    customActions[message.type]().then(
      (data) => sendResponse({ ok: true, data }),
      (err) => sendResponse({ ok: false, error: describeError(err) })
    );
    return true;
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
      // While another basal version is tried, the document holds it alone: keywords meanwhile.
      const custom = await readCustom();
      if (custom && custom.state === 'trial') throw Evaluators.codedError('customTrial', 'another basal version is being tried');
      // Without the chosen model's file nothing is asked and nothing is downloaded: the user downloads it in the panel.
      const model = await chosenModel(aiModel, custom);
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
 * The user picks one of Config.BUILTIN_MODELS (`aiModel`), or the other basal version kept in the
 * panel's "Advanced" section (Config.CUSTOM_MODEL_KEY, see "Another basal version" below); the
 * document holds one model at a time (told apart by id and address) and is closed and opened again
 * for another one. While another version is on trial the document holds that one, whatever the
 * settings say.
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

/**
 * Runs the tasks that open, close or question the document one after another. Resolves with the
 * task's result or rejects with its error (the panel shows it); a failed task is logged and does
 * not stop the next one. A caller that does not wait for the outcome adds `.catch(() => {})`.
 */
function builtinTask(task) {
  const result = builtinSync.then(() => task());
  builtinSync = result.catch((err) => console.warn('[ParaBene] Built-in model:', err));
  return result;
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

/** Whether the document's status (`data`) is about this model: the same id and the same file. */
function holds(data, model) {
  return Boolean(data) && data.model === model.id && data.url === model.url;
}

/**
 * Opens the document and starts the download or the load, or closes the document (see above).
 * First the other basal version is looked after: the checks after a browser start, a trial whose
 * time is up, files waiting to be removed (see "Another basal version").
 */
function syncBuiltin() {
  // Never rejects: an error is logged, and the next sync (a change of the settings or the records,
  // the next start) tries again.
  return builtinTask(async () => {
    await checkCustomAfterStart();
    await expireCustomTrial();
    await processRemovals();
    const { enabled, aiEnabled, aiProtocol, aiModel } = await Config.load();
    const custom = await readCustom();
    const trial = custom && custom.state === 'trial' ? customEntry(custom) : null;
    const model = trial || (await chosenModel(aiModel, custom));
    const active = trial || (aiProtocol === 'builtin' ? model : null);
    // A download belongs to the chosen model of the built-in format (or to the version on trial):
    // choosing another model or format cancels it, so it does not start again by itself when the
    // user comes back.
    const all = custom && custom.state !== 'rejected' ? [...Config.BUILTIN_MODELS, customEntry(custom)] : Config.BUILTIN_MODELS;
    for (const other of all) {
      if (active && other.id === active.id && other.url === active.url) continue;
      if ((await builtinRecord(other)).state === 'requested') await writeBuiltinRecord(other, 'missing');
    }
    const { state } = await builtinRecord(model);
    const wanted = Boolean(trial) || (aiProtocol === 'builtin' && (state === 'requested' || (state === 'stored' && enabled && aiEnabled)));
    // A kept version that is not loaded now (the AI model was switched off, another model was
    // chosen) loses its mark: its load was ended on purpose, the browser did not hang.
    if (custom && custom.state === 'kept' && custom.loading && !(wanted && model.custom)) {
      await writeCustom(Object.assign({}, custom, { loading: false }));
    }
    if (!wanted) {
      if (await hasBuiltinDocument()) await chrome.offscreen.closeDocument();
      return;
    }
    const testing = Boolean(trial) && custom.phase === 'download';
    const load = { type: Config.MSG.BUILTIN_LOAD, model: model.id, url: model.url, download: testing || state === 'requested' };
    if (testing) load.test = customTestBodies();
    await openBuiltin();
    let reply = await sendBuiltin(load);
    if (reply && reply.ok && !holds(reply.data, model)) {
      // The document holds another model: a new document for this one.
      await chrome.offscreen.closeDocument();
      await openBuiltin();
      reply = await sendBuiltin(load);
    }
    // A kept version is marked while it loads: a load that never ends (the browser hung) is undone
    // after the next browser start (checkCustomAfterStart).
    if (!trial && model.custom && reply && reply.ok && reply.data.status !== 'ready' && !custom.loading) {
      await writeCustom(Object.assign({}, custom, { loading: true }));
    }
  }).catch(() => {});
}

chrome.runtime.onStartup.addListener(syncBuiltin);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const keys = ['enabled', 'aiEnabled', 'aiProtocol', 'aiModel', Config.BUILTIN_STORAGE_KEY, Config.CUSTOM_MODEL_KEY];
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
    const custom = await readCustom();
    if (aiProtocol !== 'builtin' || (custom && custom.state === 'trial')) return;
    const model = await chosenModel(aiModel, custom);
    if ((await builtinRecord(model)).state !== 'stored') await writeBuiltinRecord(model, 'requested');
  });
  await syncBuiltin();
}

/**
 * For the panel (and checkBuiltinFile), about the chosen model: { model, status, progress?, error?,
 * stored? } with status "missing" | "downloading" | "loading" | "ready" | "stored" (on disk, not in
 * memory) | "error" (`stored`: the file is there, so the error is not about the download) | "trial"
 * (another basal version is being tried: the chosen model is not used meanwhile).
 * The records are checked against the document: an open document is asked for its state; with no
 * document and no download running, one is opened for a moment to ask whether the file is in the
 * storage — a file without a record (downloaded by an earlier version, or a record lost with the
 * settings) is then used as it is, and a record without a file (removed by the browser) is dropped.
 */
async function builtinStatus() {
  let live = null;
  let model = null;
  let trial = false;
  await builtinTask(async () => {
    const { aiProtocol, aiModel } = await Config.load();
    const custom = await readCustom();
    model = await chosenModel(aiModel, custom);
    trial = Boolean(custom && custom.state === 'trial');
    if (trial) return;
    if (await hasBuiltinDocument()) {
      const reply = await sendBuiltin({ type: Config.MSG.BUILTIN_STATUS, model: model.id, url: model.url });
      if (!reply || !reply.ok || !holds(reply.data, model)) return;
      live = reply.data;
      // The document's reports (MODEL_STATE) are not acknowledged: take the same facts from its status.
      if (live.stored) await recordBuiltinState(model, 'stored');
      else if (live.status === 'error') await recordBuiltinState(model, 'failed', live.error);
    } else if (aiProtocol === 'builtin' && ['missing', 'stored'].includes((await builtinRecord(model)).state)) {
      await openBuiltin();
      const reply = await sendBuiltin({ type: Config.MSG.BUILTIN_STATUS, model: model.id, url: model.url, check: true });
      if (reply && reply.ok) await recordBuiltinState(model, reply.data.stored ? 'stored' : 'missing');
    }
  });
  const about = { model: model.id };
  if (trial) return Object.assign(about, { status: 'trial' });
  // No document answered: close one opened only to look, or open one that is wanted.
  if (!live) await syncBuiltin();
  const record = await builtinRecord(model);
  const stored = record.state === 'stored';
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
      sendBuiltin({ type: Config.MSG.BUILTIN_EVALUATE, model: model.id, url: model.url, body }),
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
/* Another basal version (the panel's "Advanced" section)              */
/* ------------------------------------------------------------------ */

/*
 * The slot and its states are described in src/config.js ("Another basal version"). The panel
 * checks an address (customModelInfo: the file's size from the Hugging Face API, never any page
 * text), starts a trial (startCustomTrial), keeps the version (keepCustom) or drops it
 * (discardCustom). The trial runs in the offscreen document: download, load, self-test
 * (recordCustomTest). Files of versions that are no longer used are removed from the storage by a
 * document that holds no model (processRemovals).
 */

/** Files of other versions waiting to be removed: an array of addresses in chrome.storage.local. */
const CUSTOM_REMOVALS_KEY = 'customModelRemovals';
/** In chrome.storage.session (emptied when the browser or the extension starts again). */
const SESSION_STARTED_KEY = 'builtinSessionStarted';
const CUSTOM_INFO_TIMEOUT_MS = 15000;

/**
 * The self-test: one short text (it warms the GPU up and is not timed against the limits), then a
 * neutral and an accident report of ~500 characters each. The verdicts (default topics and
 * sensitivity) are compared with the expected ones; a model that gets them wrong is not refused,
 * the panel only says so.
 */
const CUSTOM_TEST_TEXTS = Object.freeze([
  { hide: false, text: 'Dzisiaj w parku miejskim zakwitły pierwsze magnolie.' },
  {
    hide: false,
    text:
      'Biblioteka miejska zaprasza w sobotę na dzień otwarty. Od godziny 10 czytelnicy mogą zwiedzać ' +
      'magazyny, w których przechowywane są stare mapy i pierwsze wydania książek. Dla dzieci ' +
      'przygotowano warsztaty ilustracji i głośne czytanie baśni, a dla dorosłych spotkanie z autorką ' +
      'powieści o historii miasta. Wstęp jest bezpłatny, ale na warsztaty obowiązują zapisy przez stronę ' +
      'internetową biblioteki. Organizatorzy przypominają, że w budynku działa kawiarnia, a w ogrodzie ' +
      'ustawiono stoliki z grami planszowymi.',
  },
  {
    hide: true,
    text:
      'Na drodze krajowej pod Grójcem doszło w nocy do tragicznego wypadku. Samochód osobowy zjechał ' +
      'na przeciwległy pas i zderzył się czołowo z ciężarówką. Kierowca osobówki zginął na miejscu, a ' +
      'dwoje pasażerów z ciężkimi obrażeniami przetransportowano śmigłowcem do szpitala. Strażacy przez ' +
      'ponad godzinę wycinali poszkodowanych z wraku. Droga była zablokowana do rana, a policja ustala ' +
      'przyczyny zdarzenia i apeluje do świadków o kontakt. To już trzeci śmiertelny wypadek na tym ' +
      'odcinku w tym roku.',
  },
]);

function customTestBodies() {
  return CUSTOM_TEST_TEXTS.map(({ text }) => Evaluators.basalRequest(text, Config.DEFAULT_AI_TOPICS));
}

/** The record of the slot (Config.CUSTOM_MODEL_KEY), or null when there is none or it is not valid. */
async function readCustom() {
  const key = Config.CUSTOM_MODEL_KEY;
  const value = (await chrome.storage.local.get(key))[key];
  const valid =
    value && typeof value === 'object' && Config.CUSTOM_MODEL_STATES.includes(value.state) && Config.parseCustomModelUrl(value.url);
  return valid ? value : null;
}

/** Writes the record of the slot; null removes it. */
async function writeCustom(value) {
  if (value) await chrome.storage.local.set({ [Config.CUSTOM_MODEL_KEY]: value });
  else await chrome.storage.local.remove(Config.CUSTOM_MODEL_KEY);
}

/** The model entry of the slot's record. */
function customEntry(custom) {
  return Config.customModel(custom.url, custom.bytes);
}

/** The model `aiModel` stands for: the kept other version, or a built-in model (the default one for anything else). */
async function chosenModel(aiModel, custom) {
  if (aiModel === Config.CUSTOM_MODEL_ID) {
    const record = custom === undefined ? await readCustom() : custom;
    if (record && record.state === 'kept') return customEntry(record);
  }
  return Config.builtinModel(aiModel);
}

/** The model a report of the document is about, or null when it is not one the settings know (any more). */
async function reportedModel(message) {
  if (message.model === Config.CUSTOM_MODEL_ID) {
    const custom = await readCustom();
    return custom && custom.state !== 'rejected' && custom.url === message.url ? customEntry(custom) : null;
  }
  const model = Config.isBuiltinModel(message.model) ? Config.builtinModel(message.model) : null;
  return model && model.url === message.url ? model : null;
}

/**
 * The other version is no longer chosen: when `aiModel` named it, the default model is chosen;
 * any other choice (e.g. pico, chosen before a trial) stays.
 */
async function unchooseCustom() {
  const { aiModel } = await chrome.storage.local.get('aiModel');
  if (aiModel === Config.CUSTOM_MODEL_ID) await chrome.storage.local.set({ aiModel: Config.DEFAULT_BUILTIN_MODEL });
}

async function queueRemoval(url) {
  const urls = (await chrome.storage.local.get(CUSTOM_REMOVALS_KEY))[CUSTOM_REMOVALS_KEY];
  const list = Array.isArray(urls) ? urls.filter((item) => typeof item === 'string') : [];
  if (!list.includes(url)) await chrome.storage.local.set({ [CUSTOM_REMOVALS_KEY]: [...list, url] });
}

/**
 * Ends a trial (or a version) without keeping it: `reason` and `extra` (test, error) stay in the
 * record for the panel; the file goes, and pages use the model chosen in the list again
 * (unchooseCustom). Call only from a builtinTask.
 */
async function rejectCustom(custom, reason, extra) {
  await writeCustom(Object.assign({ url: custom.url, name: custom.name, bytes: custom.bytes, state: 'rejected', reason }, extra));
  await writeBuiltinRecord(customEntry(custom), 'missing');
  await queueRemoval(custom.url);
  await unchooseCustom();
}

/**
 * Once per browser session (and after an install or a reload of the extension): a trial still
 * running was never kept, so it is rejected; a kept version whose load never ended (the browser
 * hung or was closed while it loaded) is no longer chosen. Call only from a builtinTask.
 */
async function checkCustomAfterStart() {
  if (!chrome.storage.session) return;
  if ((await chrome.storage.session.get(SESSION_STARTED_KEY))[SESSION_STARTED_KEY]) return;
  await chrome.storage.session.set({ [SESSION_STARTED_KEY]: true });
  const custom = await readCustom();
  if (!custom) return;
  if (custom.state === 'trial') {
    await rejectCustom(custom, 'restart', custom.test ? { test: custom.test } : undefined);
  } else if (custom.state === 'kept' && custom.loading) {
    await writeCustom(Object.assign({}, custom, { loading: false, reverted: true }));
    await unchooseCustom();
  }
}

/** A trial that passed the self-test and was not kept in time is rejected. Call only from a builtinTask. */
async function expireCustomTrial() {
  const custom = await readCustom();
  if (custom && custom.state === 'trial' && custom.phase === 'tested' && !(Date.now() < custom.deadline)) {
    await rejectCustom(custom, 'expired', { test: custom.test });
  }
}

/** The document has the model in memory: a kept version is no longer marked as loading. Call only from a builtinTask. */
async function customLoaded(model) {
  if (!model.custom) return;
  const custom = await readCustom();
  if (custom && custom.state === 'kept' && custom.url === model.url && (custom.loading || custom.reverted)) {
    await writeCustom(Object.assign({}, custom, { loading: false, reverted: false }));
  }
}

/**
 * The document has `model` in memory: when it is the model pages use now (the built-in format, no
 * trial), the tabs are told, so content judged with keywords meanwhile — during a trial, while the
 * model was downloaded or loaded — is judged again by the model. Call only from a builtinTask.
 */
async function announceReady(model) {
  const { aiProtocol, aiModel } = await Config.load();
  const custom = await readCustom();
  if (aiProtocol !== 'builtin' || (custom && custom.state === 'trial')) return;
  const chosen = await chosenModel(aiModel, custom);
  if (chosen.id !== model.id || chosen.url !== model.url) return;
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id >= 0) chrome.tabs.sendMessage(tab.id, { type: Config.MSG.MODEL_READY }).catch(() => {});
  }
}

/**
 * Removes the files waiting for it, in a document opened for this alone (the one open may hold
 * one of them in memory). The file of the version in the slot and the built-in models' files are
 * kept. Call only from a builtinTask.
 */
async function processRemovals() {
  const urls = (await chrome.storage.local.get(CUSTOM_REMOVALS_KEY))[CUSTOM_REMOVALS_KEY];
  if (!Array.isArray(urls) || urls.length === 0) return;
  const custom = await readCustom();
  const inUse = custom && custom.state !== 'rejected' ? custom.url : null;
  const list = urls.filter(
    (url) => typeof url === 'string' && url !== inUse && Config.parseCustomModelUrl(url) && !Config.BUILTIN_MODELS.some((m) => m.url === url)
  );
  if (list.length > 0) {
    if (await hasBuiltinDocument()) await chrome.offscreen.closeDocument();
    await openBuiltin();
    const reply = await sendBuiltin({ type: Config.MSG.BUILTIN_REMOVE, urls: list });
    if (!reply || !reply.ok) {
      console.warn('[ParaBene] Could not remove model files:', reply && reply.error);
      return; // tried again on the next sync
    }
  }
  await chrome.storage.local.remove(CUSTOM_REMOVALS_KEY);
}

/**
 * The panel's "Check": the address must name a basal decision file pinned to a commit; its size
 * comes from the Hugging Face API (the list of the commit's files). Resolves with
 * { url, name, bytes, level: "ok" | "large" | "tooLarge" }.
 */
async function customModelInfo(value) {
  const parsed = Config.parseCustomModelUrl(value);
  if (!parsed) throw Evaluators.codedError('customInvalidUrl', 'not an address of a basal decision file');
  // The field starts with the default model's address, as an example: that file is a built-in model already.
  if (Config.BUILTIN_MODELS.some((model) => model.url === parsed.url)) throw Evaluators.codedError('customBuiltin', 'a built-in model');
  let entries;
  try {
    const response = await fetch(Config.customModelInfoUrl(parsed), {
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(CUSTOM_INFO_TIMEOUT_MS),
    });
    // Hugging Face answers 401 for a repository that does not exist (or is private).
    if ([401, 403, 404].includes(response.status)) throw Evaluators.codedError('customNotFound', `HTTP ${response.status}`);
    if (!response.ok) throw Evaluators.codedError('customInfoFailed', `HTTP ${response.status}`, `HTTP ${response.status}`);
    entries = await response.json();
  } catch (err) {
    if (err && err.code) throw err;
    throw Evaluators.codedError('customInfoFailed', String(err && err.message ? err.message : err), String(err && err.message ? err.message : err));
  }
  const entry = Array.isArray(entries) ? entries.find((item) => item && item.type === 'file' && item.path === parsed.file) : null;
  if (!entry) throw Evaluators.codedError('customNotFound', 'no such file in this commit');
  const bytes = entry.lfs && Number.isFinite(entry.lfs.size) ? entry.lfs.size : entry.size;
  if (!(Number.isFinite(bytes) && bytes > 0)) throw Evaluators.codedError('customInfoFailed', 'no file size', 'no file size');
  const level = bytes > Config.CUSTOM_MAX_BYTES ? 'tooLarge' : bytes > Config.CUSTOM_WARN_BYTES ? 'large' : 'ok';
  return { url: parsed.url, name: Config.customModel(parsed.url).name, bytes, level };
}

/**
 * The panel's "Download and test": checks the address and the size again (the panel may be out of
 * date), then puts the version on trial; the document then downloads, loads and tests it. A trial
 * already running is left alone. `accepted`: the user confirmed the risk of a large file.
 */
async function startCustomTrial(url, accepted) {
  const { aiProtocol } = await Config.load();
  if (aiProtocol !== 'builtin') throw Evaluators.codedError('customNotBuiltin', 'only for the built-in model');
  const info = await customModelInfo(url);
  if (info.level === 'tooLarge') throw Evaluators.codedError('customTooLarge', 'file too large', String(info.bytes));
  if (info.level === 'large' && !accepted) throw Evaluators.codedError('customConsent', 'the risk was not confirmed');
  await builtinTask(async () => {
    const previous = await readCustom();
    if (previous && previous.state === 'trial') return;
    if (previous && previous.url !== info.url) await queueRemoval(previous.url);
    const entry = Config.customModel(info.url, info.bytes);
    await writeCustom({ url: info.url, name: entry.name, bytes: info.bytes, state: 'trial', phase: 'download', startedAt: Date.now() });
    if ((await builtinRecord(entry)).state !== 'stored') await writeBuiltinRecord(entry, 'requested');
    await unchooseCustom();
    // A fresh document: the memory of the model it held is freed, and the self-test runs in it once.
    if (await hasBuiltinDocument()) await chrome.offscreen.closeDocument();
  });
  await syncBuiltin();
  return customStatus();
}

/** The outcome of the self-test the document reports. Call only from a builtinTask. */
async function recordCustomTest(message) {
  const custom = await readCustom();
  if (!custom || custom.state !== 'trial' || custom.phase !== 'download' || custom.url !== message.url) return;
  if (message.ok !== true) {
    const raw = message.error && typeof message.error.code === 'string' ? message.error : { code: 'modelFailed' };
    const error = { code: raw.code };
    if (raw.detail != null) error.detail = String(raw.detail);
    await rejectCustom(custom, raw.code === 'customTooLarge' ? 'tooLarge' : 'testFailed', { error });
    return;
  }
  const test = judgeCustomTest(message.times, message.replies);
  if (!test.passed) {
    await rejectCustom(custom, 'testFailed', { test });
    return;
  }
  await writeCustom(Object.assign({}, custom, { phase: 'tested', test, deadline: Date.now() + Config.CUSTOM_KEEP_MS }));
  // The document also wakes the service worker then (MODEL_TRIAL_CHECK): this one may be stopped before.
  setTimeout(syncBuiltin, Config.CUSTOM_KEEP_MS + 500);
}

/**
 * { passed, times, slowest, slow, expected, total, error? }: `slowest` is the longest decision
 * after the warm-up one; above Config.CUSTOM_TEST_MAX_MS the version is refused, above
 * CUSTOM_TEST_WARN_MS the panel warns. `expected` of `total` verdicts were the expected ones.
 */
function judgeCustomTest(times, replies) {
  const total = CUSTOM_TEST_TEXTS.length;
  const valid =
    Array.isArray(times) && Array.isArray(replies) && times.length === total && replies.length === total && times.every(Number.isFinite);
  if (!valid) return { passed: false, error: { code: 'invalidResponse' } };
  const threshold = Config.AI_SENSITIVITIES[Config.DEFAULT_AI_SENSITIVITY];
  let expected = 0;
  try {
    CUSTOM_TEST_TEXTS.forEach((sample, index) => {
      const verdict = Evaluators.parseBasalResponse(replies[index], { threshold, topics: Config.DEFAULT_AI_TOPICS });
      if (verdict.hide === sample.hide) expected += 1;
    });
  } catch (err) {
    return { passed: false, times, error: describeError(err) };
  }
  const slowest = Math.max(...times.slice(1));
  return {
    passed: slowest <= Config.CUSTOM_TEST_MAX_MS,
    times,
    slowest,
    slow: slowest > Config.CUSTOM_TEST_WARN_MS,
    expected,
    total,
  };
}

/** The panel's "Keep": only a version that passed the self-test, before its time is up; it becomes the chosen model. */
async function keepCustom() {
  let error = null;
  await builtinTask(async () => {
    const custom = await readCustom();
    if (!custom || custom.state !== 'trial' || custom.phase !== 'tested') {
      error = Evaluators.codedError('customNotTested', 'no tested version to keep');
      return;
    }
    if (!(Date.now() < custom.deadline)) {
      await rejectCustom(custom, 'expired', { test: custom.test });
      error = Evaluators.codedError('customExpired', 'the time to keep it is up');
      return;
    }
    // One write: the version is kept and chosen together, or neither (the panel then shows the error).
    await chrome.storage.local.set({
      [Config.CUSTOM_MODEL_KEY]: { url: custom.url, name: custom.name, bytes: custom.bytes, state: 'kept', test: custom.test, keptAt: Date.now() },
      aiModel: Config.CUSTOM_MODEL_ID,
    });
  });
  if (error) throw error;
  return customStatus();
}

/** The panel's "Reject" / "Remove": empties the slot; its file goes, and if it was chosen the default model is chosen instead. */
async function discardCustom() {
  await builtinTask(async () => {
    const custom = await readCustom();
    if (!custom) return;
    if (custom.state !== 'rejected') {
      await writeBuiltinRecord(customEntry(custom), 'missing');
      await queueRemoval(custom.url);
      await unchooseCustom();
    }
    await writeCustom(null);
  });
  return customStatus();
}

/**
 * For the panel: { custom: <the slot's record> | null, live: { status, progress } | null, now }.
 * `live` is the document's state while a trial downloads, loads or tests.
 */
async function customStatus() {
  let live = null;
  await builtinTask(async () => {
    await expireCustomTrial();
    const custom = await readCustom();
    if (!custom || custom.state !== 'trial' || custom.phase !== 'download' || !(await hasBuiltinDocument())) return;
    const entry = customEntry(custom);
    const reply = await sendBuiltin({ type: Config.MSG.BUILTIN_STATUS, model: entry.id, url: entry.url });
    if (reply && reply.ok && holds(reply.data, entry)) live = { status: reply.data.status, progress: reply.data.progress };
  });
  return { custom: await readCustom(), live, now: Date.now() };
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
