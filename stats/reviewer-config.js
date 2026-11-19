/*
 * ParaBene – statistics page: where the external reviewer model is reached.
 *
 * { provider, endpoint, model, apiKey }, kept in chrome.storage.local under its own key: it is not
 * one of the extension's settings, so it is neither written by a `.env` file nor part of the
 * settings backup (the key must not end up in an exported file).
 *
 * Two kinds of API (`provider`):
 *   openai  any OpenAI-compatible chat completions API: one request per entry, answered at once
 *           (reviewer-client.js)
 *   claude  the Claude API: one Message Batch for all entries, answered later (reviewer-claude.js,
 *           reviewer-batch.js)
 */
export const STORAGE_KEY = 'reviewer';
export const PROVIDERS = ['openai', 'claude'];
export const DEFAULT_PROVIDER = 'openai';
/** Per provider: the address used as the example and, for Claude, when the field is left empty. */
export const DEFAULT_ENDPOINTS = { openai: 'https://api.openai.com/v1', claude: 'https://api.anthropic.com' };
/** Per provider: the model chosen until the user picks one ('' = none: the names differ from server to server). */
export const DEFAULT_MODELS = { openai: '', claude: 'claude-opus-5-5' };

const CLAUDE_HOST = 'api.anthropic.com';

/** The provider of a stored value: what was chosen, or (for a value saved before there was a choice) what the address says. */
function providerOf(value, endpoint) {
  if (PROVIDERS.includes(value.provider)) return value.provider;
  return hostOf(endpoint) === CLAUDE_HOST ? 'claude' : DEFAULT_PROVIDER;
}

/**
 * A model name the provider can know. The models of the Claude API are all named "claude-…": a
 * batch with another name would only fail when it is processed, an hour after it was sent.
 */
export function isValidModel(provider, model) {
  if (typeof model !== 'string' || !model) return false;
  return provider !== 'claude' || /^claude-[\w.-]+$/i.test(model);
}

function clean(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const text = (field, max) => (typeof value[field] === 'string' ? value[field].trim().slice(0, max) : '');
  const endpoint = text('endpoint', 300);
  const provider = providerOf(value, endpoint);
  const model = text('model', 100);
  return { provider, endpoint, model: isValidModel(provider, model) ? model : '', apiKey: text('apiKey', 400) };
}

export async function loadReviewer() {
  return clean((await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]);
}

export async function saveReviewer(config) {
  const value = clean(config);
  await chrome.storage.local.set({ [STORAGE_KEY]: value });
  return value;
}

/** A full http(s) address of the API (its base, or the chat completions route itself). */
export function isValidEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch (_) {
    return false;
  }
}

/**
 * Ready to send: an address and a model name. The Claude API always needs a key; for the others a
 * key is optional (a server of one's own may need none).
 */
export function isComplete(config) {
  if (!isValidEndpoint(config.endpoint) || !config.model) return false;
  return config.provider !== 'claude' || Boolean(config.apiKey);
}

/** The scheme, host and port of an address ('' when it is not one): the server a key belongs to. */
export function originOf(endpoint) {
  try {
    return new URL(endpoint).origin;
  } catch (_) {
    return '';
  }
}

/**
 * The saved key, when it was saved for this kind of API and this server; '' otherwise. A key is
 * never sent to another server than the one it was saved for (e.g. an OpenAI key to the Claude
 * API that a batch was sent to earlier, or a Claude key to an OpenAI-compatible server).
 */
export function keyFor(config, provider, endpoint) {
  const origin = originOf(endpoint);
  return config.apiKey && config.provider === provider && origin && origin === originOf(config.endpoint) ? config.apiKey : '';
}

/** The host a request goes to, for the confirmation ("api.openai.com"). */
export function hostOf(endpoint) {
  try {
    return new URL(endpoint).host;
  } catch (_) {
    return '';
  }
}
