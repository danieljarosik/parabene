/*
 * ParaBene – service worker.
 * - stores the default settings on install,
 * - proxies requests to the local AI model (a fetch from the extension context
 *   is not subject to page CORS or private network restrictions),
 * - optionally judges pictures: fetches them, scales them down and asks the
 *   multimodal basal-serve server (src/config.js, "Optional image evaluation"),
 * - shows the number of hidden elements in the current tab on the icon badge,
 * - keeps the opt-in log of hidden content (chrome.storage.local, exported by the panel),
 * - serves translations to content scripts (they cannot read extension files).
 */
importScripts('config.js', 'i18n.js', 'evaluators.js');

const Config = self.ParaBeneConfig;
const I18n = self.ParaBeneI18n;
const Evaluators = self.ParaBeneEvaluators;

/** locale → Promise<messages>; lives as long as the service worker. */
const messageCache = new Map();

chrome.runtime.onInstalled.addListener(() => {
  applyEnvFile()
    .then(() => Config.load())
    .catch((err) => console.warn('[ParaBene] Failed to save default settings:', err));
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
  await chrome.storage.local.set(settings);
  console.info(`[ParaBene] Applied settings from ${Config.ENV_FILE}:`, Object.keys(settings));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message.type !== 'string') return false;

  if (message.type === Config.MSG.CLASSIFY) {
    classify(message.text).then(sendResponse);
    return true;
  }

  if (message.type === Config.MSG.CLASSIFY_IMAGE && typeof message.url === 'string') {
    classifyImage(message.url).then(sendResponse);
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

  if (message.type === Config.MSG.LOG_HIDDEN || message.type === Config.MSG.LOG_REVEALED) {
    queueLog(message.type, message.entry);
    return false;
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
 */
async function classify(text) {
  let endpoint = '';
  try {
    const { aiEndpoint, aiProtocol, aiSensitivity, aiTopics } = await Config.load();
    if (!Config.isValidEndpoint(aiEndpoint)) throw Evaluators.codedError('invalidEndpoint', 'invalid endpoint URL');
    const input = String(text || '').slice(0, Config.AI_MAX_CHARS);
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
/* Image evaluation (basal-omni, optional)                             */
/* ------------------------------------------------------------------ */

/** Shared by all tabs: the server answers one request at a time anyway. */
const imageLimiter = new Evaluators.ConcurrencyLimiter(Config.IMAGE_MAX_CONCURRENT);
/** endpoint + topics + picture URL → the model's raw reply (the threshold is applied on every use). */
const imageCache = new Map();
const IMAGE_CACHE_SIZE = 500;
const IMAGE_FETCH_TIMEOUT_MS = 10000;

/**
 * Judges the picture at `url` (http(s) or data:). Errors with the codes imageFetch, imageDecode,
 * imageTooSmall and an HTTP 422 concern this picture only; any other error means the server is
 * unavailable (the content script then pauses image evaluation for a while).
 */
async function classifyImage(url) {
  let endpoint = '';
  try {
    const { aiImagesEndpoint, aiSensitivity, aiTopics } = await Config.load();
    if (!Config.isValidEndpoint(aiImagesEndpoint)) {
      throw Evaluators.codedError('invalidEndpoint', 'invalid image endpoint URL');
    }
    endpoint = Config.resolveEndpoint(aiImagesEndpoint, 'basal');
    const key = `${endpoint}\n${aiTopics.join(',')}\n${url}`;
    let reply = imageCache.get(key);
    if (!reply) {
      reply = await imageLimiter.run(async () => {
        const image = await loadImage(url);
        return Evaluators.fetchTransport({
          endpoint,
          body: Evaluators.basalImageRequest(image, aiTopics),
          timeoutMs: Config.IMAGE_TIMEOUT_MS,
        });
      });
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
    blob = await response.blob();
  } catch (err) {
    throw Evaluators.codedError('imageFetch', `image fetch failed: ${err.message}`);
  }
  if (blob.size > Config.IMAGE_MAX_BYTES) throw Evaluators.codedError('imageFetch', `image too large: ${blob.size} B`);

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
/* Log of hidden content                                               */
/* ------------------------------------------------------------------ */

const LOG_FLUSH_MS = 1000;
const logQueue = [];
let logTimer = 0;
let logWrite = Promise.resolve();

/** Entries arrive in bursts while a page loads — they are written to storage in batches. */
function queueLog(type, entry) {
  if (!entry || typeof entry.text !== 'string') return;
  if (!entry.text && !(typeof entry.image === 'string' && entry.image)) return;
  logQueue.push({ type, entry });
  if (!logTimer) logTimer = setTimeout(flushLog, LOG_FLUSH_MS);
}

/**
 * The same text hidden for the same reason (e.g. after a page reload) is logged once;
 * a container hidden because of its picture is identified by the picture.
 */
function logKey(entry) {
  return entry.image ? `image\n${entry.image}` : `${entry.source}\n${entry.text}`;
}

/** Picture address for the log: a data: URL is replaced by its type (it can be megabytes long). */
function logImageUrl(value) {
  const url = String(value || '');
  if (url.startsWith('data:')) return url.split(/[;,]/)[0].slice(0, 100);
  return url.slice(0, 1000);
}

function flushLog() {
  logTimer = 0;
  const batch = logQueue.splice(0);
  logWrite = logWrite
    .then(async () => {
      const { logEnabled } = await Config.load();
      if (!logEnabled) return;
      const stored = await chrome.storage.local.get(Config.LOG_STORAGE_KEY);
      const entries = Array.isArray(stored[Config.LOG_STORAGE_KEY]) ? stored[Config.LOG_STORAGE_KEY] : [];
      const index = new Map(entries.map((entry) => [logKey(entry), entry]));
      let changed = false;
      for (const { type, entry } of batch) {
        const clean = sanitizeLogEntry(entry);
        const existing = index.get(logKey(clean));
        if (type === Config.MSG.LOG_REVEALED) {
          if (existing && !existing.revealed) {
            existing.revealed = true;
            changed = true;
          }
        } else if (!existing) {
          entries.push(clean);
          index.set(logKey(clean), clean);
          changed = true;
        }
      }
      if (!changed) return;
      await chrome.storage.local.set({ [Config.LOG_STORAGE_KEY]: entries.slice(-Config.LOG_MAX_ENTRIES) });
    })
    .catch((err) => console.warn('[ParaBene] Failed to write the log:', err));
}

/** Keeps only the known fields, with sane types and lengths. */
function sanitizeLogEntry(raw) {
  const entry = {
    time: typeof raw.time === 'string' ? raw.time : new Date().toISOString(),
    url: String(raw.url || '').slice(0, 500),
    source: raw.source === 'ai' ? 'ai' : 'keyword',
    mode: ['keywords', 'both', 'ai'].includes(raw.mode) ? raw.mode : 'keywords',
    reason: String(raw.reason || '').slice(0, 200),
    category: typeof raw.category === 'string' ? raw.category.slice(0, 40) : '',
    fallback: raw.fallback === true,
    revealed: false,
    text: String(raw.text).slice(0, Config.LOG_MAX_TEXT),
  };
  if (raw.image) {
    entry.media = 'image';
    entry.image = logImageUrl(raw.image);
  }
  if (raw.details && typeof raw.details === 'object') entry.details = raw.details;
  return entry;
}
