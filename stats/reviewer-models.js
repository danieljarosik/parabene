/*
 * ParaBene – statistics page: choosing the reviewer model.
 *
 * The model is chosen from a list: the models the API itself reports ("Fetch the list of models":
 * GET <endpoint>/v1/models of the Claude API, GET <endpoint>/models of an OpenAI-compatible one),
 * or, until that list was fetched, the current Claude models named below. The last choice,
 * "Another name…", takes a name typed by hand — for a server that does not list its models.
 *
 * A fetched list is kept in chrome.storage.local under its own key, for the kind of API and the
 * address it came from. Fetching it sends the key and nothing else, and only on that button.
 */
import { t } from './context.js';
import { listModels as listClaudeModels } from './reviewer-claude.js';
import { listModels as listOpenAiModels, reviewError } from './reviewer-client.js';
import { DEFAULT_MODELS } from './reviewer-config.js';

export const STORAGE_KEY = 'reviewerModels';
const CUSTOM = '__custom__';
const MAX_MODELS = 500;

/** Shown for the Claude API until its own list was fetched: the current models, most capable first. */
const KNOWN_MODELS = {
  openai: [],
  claude: [
    { id: 'claude-fable-5-2', name: 'Claude Fable 5.2' },
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
  ],
};

const els = {
  select: document.getElementById('review-model'),
  custom: document.getElementById('review-model-custom'),
};

/** The list fetched last: { provider, endpoint, models: [{ id, name }] } or null. */
let fetched = null;

function clean(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.models)) return null;
  const models = raw.models
    .filter((model) => model && typeof model.id === 'string' && model.id)
    .map((model) => ({ id: model.id, name: typeof model.name === 'string' && model.name ? model.name : model.id }));
  return { provider: String(raw.provider), endpoint: String(raw.endpoint), models };
}

function modelsFor(provider, endpoint) {
  if (fetched && fetched.provider === provider && fetched.endpoint === endpoint) return fetched.models;
  return KNOWN_MODELS[provider] || [];
}

function option(value, text) {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = text;
  return node;
}

/** The field for a typed name is there only with "Another name…". */
function syncCustom() {
  els.custom.hidden = els.select.value !== CUSTOM;
  els.custom.classList.remove('invalid');
}

/**
 * Fills the list for a kind of API and an address, and chooses `model`: from the list when it is
 * there, as a typed name when it is not, and the default (or the first of the list) when none is given.
 */
export function showModels(provider, endpoint, model) {
  const models = modelsFor(provider, endpoint);
  const has = (id) => models.some((entry) => entry.id === id);
  els.select.replaceChildren(
    ...models.map((entry) => option(entry.id, entry.name === entry.id ? entry.id : `${entry.name} (${entry.id})`)),
    option(CUSTOM, t('reviewModelCustom')),
  );
  els.custom.value = '';
  els.custom.placeholder = DEFAULT_MODELS[provider] || '';
  if (has(model)) els.select.value = model;
  else if (model) {
    els.select.value = CUSTOM;
    els.custom.value = model;
  } else if (has(DEFAULT_MODELS[provider])) els.select.value = DEFAULT_MODELS[provider];
  else els.select.value = models.length ? models[0].id : CUSTOM;
  syncCustom();
}

/** The chosen model's name ('' when "Another name…" is chosen and nothing is typed). */
export function chosenModel() {
  return els.select.value === CUSTOM ? els.custom.value.trim() : els.select.value;
}

/** Marks the choice as refused (a name the API cannot know). */
export function markInvalidModel() {
  els.custom.classList.add('invalid');
}

/** Asks the API of `form` ({ provider, endpoint, apiKey }) for its models and shows them. Resolves with their number. */
export async function refreshModels(form) {
  const list = form.provider === 'claude' ? await listClaudeModels(form) : await listOpenAiModels(form);
  if (list.length === 0) throw reviewError('invalid', 'no models');
  fetched = { provider: form.provider, endpoint: form.endpoint, models: list.slice(0, MAX_MODELS) };
  await chrome.storage.local.set({ [STORAGE_KEY]: fetched });
  showModels(form.provider, form.endpoint, chosenModel());
  return fetched.models.length;
}

/** The texts of the list in the current language. */
export function renderModels() {
  const custom = els.select.querySelector(`option[value="${CUSTOM}"]`);
  if (custom) custom.textContent = t('reviewModelCustom');
}

export async function initModels() {
  fetched = clean((await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]);
  els.select.addEventListener('change', () => {
    syncCustom();
    if (!els.custom.hidden) els.custom.focus();
  });
  els.custom.addEventListener('input', () => els.custom.classList.remove('invalid'));
}
