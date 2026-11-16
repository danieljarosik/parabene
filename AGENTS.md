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
- No `npm install`, no bundler, no build step.

## Stack
Chrome extension, Manifest V3. Plain JavaScript, HTML and CSS with no external dependencies;
tooling scripts are plain Python 3 (standard library only). Settings live in
`chrome.storage.local`. The optional AI evaluator talks only to a local endpoint (`localhost`).

## Project structure
See the *Architecture* section of `README.md`. Short version: `manifest.json`,
`_locales/{pl,en}/messages.json` (UI texts, Polish is the default), `src/` (content script,
service worker, evaluators, config, i18n), `popup/` (extension panel), `icons/`, `tools/`.

## Language
- Code, comments, documentation (`README.md`, this file) and git messages: English.
- The extension UI is Polish by default (with an English translation) and the default keyword
  list is Polish — the product targets Polish-language websites. The README quotes Polish UI
  labels with an English gloss in italics.
- Nothing user-visible is hard-coded in HTML/JS: every UI string goes through
  `_locales/*/messages.json` in all languages.

## Don't
- Do not add npm dependencies, a bundler or a build step.
- Do not send page text anywhere other than the user-configured local AI endpoint.
- Do not commit packaged builds or keys (`*.zip`, `*.crx`, `*.pem`, `dist/`, `build/`).
