# AGENTS.md

## Git workflow — flat, linear history
- **Work directly on `main`.** The history is one straight line:
  `main` and `origin/main` point at the same commit after every push.
- **No feature branches, no merge commits.** If a branch was created anyway (e.g. by a tool),
  bring it in with a fast-forward only (`git merge --ff-only <branch>`, rebase first if needed)
  and delete it locally and on `origin` afterwards.
- Never create a merge commit (`git merge --no-ff`, GitHub "Create a merge commit");
  prefer `git pull --ff-only` / `git pull --rebase`.
- Never rewrite history that is already on `origin/main` (no force-push to `main`).
- One commit = one coherent change, with a short imperative title,
  e.g. `Add UI internationalisation (Polish default, English)`.
- Commit messages, tags and PR descriptions are written in **English**.

## Commands
- Run: load the directory as an unpacked extension in `chrome://extensions`
  (Developer mode → Load unpacked), then reload it and the tested tab after every change.
- Check translations: `python3 tools/check_locales.py`   # after any change to `_locales/` or UI texts
- Regenerate icons: `python3 tools/generate_icons.py`
- Update the vendored wllama (only to change its version): `python3 tools/vendor_wllama.py`
- No `npm install`, no bundler, no build step.

## Stack
Chrome extension, Manifest V3. Plain JavaScript, HTML and CSS with no npm dependencies; the only
third-party code is [wllama](https://github.com/ngxson/wllama) (MIT), vendored unchanged in
`vendor/wllama/` for the built-in model (WebGPU, run in an offscreen document).
Tooling scripts are plain Python 3 (standard library only). Settings live in `chrome.storage.local`. The optional AI evaluator uses either the user-configured local endpoint
(`localhost` by default, or the user's own LAN server, e.g. basal-serve) or the built-in model that
runs inside the browser. The only external request is the one-time model download from Hugging Face,
which the user starts with the "Download model" button in the panel, and the log entries the user
sends for review from the statistics page (below).

## Project structure
See the *Architecture* section of `README.md`. Short version: `manifest.json`,
`_locales/{pl,en}/messages.json` (UI texts, Polish is the default), `src/` (content script,
service worker, evaluators, config, i18n), `offscreen/` (hidden page hosting the built-in model),
`vendor/wllama/` (third-party, do not edit), `popup/` (extension panel), `icons/`, `tools/`.

## Language
- Code, comments, documentation (`README.md`, this file) and git messages: English.
- The extension UI is Polish by default (with an English translation) and the default keyword
  list is Polish — the product targets Polish-language websites. The README quotes Polish UI
  labels with an English gloss in italics.
- Nothing user-visible is hard-coded in HTML/JS: every UI string goes through
  `_locales/*/messages.json` in all languages.

## Don't
- Do not add npm dependencies, a bundler or a build step.
- Do not edit `vendor/wllama/` by hand; change it only through `tools/vendor_wllama.py` (pinned SHA-512).
- Do not add other third-party code or load code from the network (wllama's compatibility mode stays off).
- Do not send page text anywhere other than the user-configured local AI endpoint or the built-in model.
  The one exception is "Review by a larger model" on the statistics page (`stats/reviewer-*.js`): it
  sends the texts of log entries — never addresses or verdicts — to the API the user configured, and
  only after the user confirms each run. Never send anything automatically or in the background.
  For a batch sent to the Claude API (`stats/reviewer-batch.js`) the open statistics page may ask
  that API for the batch's state and answers, and "Fetch the list of models" asks the configured API
  for its models; those requests must carry no text of the log.
  The reviewer APIs are called with plain `fetch` (no SDK).
- Do not widen the extension's CSP beyond `'wasm-unsafe-eval'`.
- Do not commit packaged builds or keys (`*.zip`, `*.crx`, `*.pem`, `dist/`, `build/`).
