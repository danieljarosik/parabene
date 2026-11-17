# vendor/wllama

A copy of [wllama](https://github.com/ngxson/wllama) 3.13.0: llama.cpp compiled to WebAssembly, with a JavaScript API. MIT licence (`LICENCE`), by Xuan-Son Nguyen and contributors. It is the only third-party code in ParaBene.

## What it is for

It runs ParaBene's **built-in AI model**: the basal decision model, inside the browser, on the graphics card through WebGPU, with no server. See *Built-in model (no server)* in the main [`README.md`](../../README.md#built-in-model-no-server).

ParaBene has no `npm install` and no build step, so the library cannot be installed when the extension is loaded. The files are kept here instead and loaded as they are.

## Who uses it

Only one file: [`offscreen/offscreen.js`](../../offscreen/offscreen.js).

```
content script  →  service worker  →  offscreen/offscreen.js  →  vendor/wllama  →  GPU
(src/content.js)   (src/background.js)   import { Wllama } from '../vendor/wllama/index.js'
```

- The service worker opens the offscreen document, with the request format `builtin`, while the model file is stored and both the filter and the AI model are on, or while a download the user asked for runs.
- `offscreen.js` creates one `Wllama` object, looks for the stored model file with `modelManager.getModels()`, downloads it with `modelManager.downloadModel()` only when the user asked for that, loads it with `loadModel()` and answers each request with `createSystemOne()`, wllama's decision API.
- Nothing else imports this directory. With the request formats `simple` and `basal`, or with the AI model off, the files are never loaded.

Removing this directory breaks only the built-in model: its requests fail and pages are filtered by keywords.

## Files

| File | Size | What it is |
| --- | ---: | --- |
| `index.js` | 275 KB | The library, an ES module. It carries the code of its workers inside and starts them from `blob:` URLs. |
| `wasm/wllama.wasm` | 10.2 MB | llama.cpp as WebAssembly, with the WebGPU backend. |
| `LICENCE` | 1 KB | wllama's MIT licence. |
| `VERSION.json` | 1 KB | Where the files came from: package, version, tarball address, its SHA-512 and the SHA-256 of each file. |

The model itself (1.17 GB) is not here. `offscreen.js` downloads it from Hugging Face into the extension's own storage, once, and only after the user has clicked **Download model** in the panel.

## Do not edit

The three files are byte-for-byte those of the npm package `@wllama/wllama` 3.13.0. Keep them that way: anyone can then check them against `VERSION.json` or against the package.

To change the version, edit `VERSION`, `TARBALL` and `SHA512` in [`tools/vendor_wllama.py`](../../tools/vendor_wllama.py) and run:

```bash
python3 tools/vendor_wllama.py
```

The script downloads the tarball, refuses it when the SHA-512 differs, and writes the three files and `VERSION.json`. Afterwards load the extension and click **Test** (*Testuj*) in the panel with the built-in model selected.

## How ParaBene uses it

- **The WebAssembly binary comes from this directory.** `offscreen.js` passes its address (`chrome.runtime.getURL('vendor/wllama/wasm/wllama.wasm')`), so nothing is fetched from a CDN.
- **Compatibility mode is off** (`setCompat(null)`). Left on, wllama would download a second build of itself from a CDN in a browser without JSPI or 64-bit WebAssembly memory. An extension must not run code from the network, so in such a browser the model fails to load instead.
- **One thread** (`n_threads: 1`). The GPU does the work; more threads did not make a decision faster, and they would need cross-origin isolation.
- **The manifest** allows WebAssembly on extension pages with `'wasm-unsafe-eval'` in `content_security_policy`.
- **The only network request** made through the library is the model download that `offscreen.js` asks for. A stored model is loaded without one.
