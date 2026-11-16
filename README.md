# ParaBene – Positive Web & News Filter

**ParaBene** is a lightweight Google Chrome extension (Manifest V3) that hides posts and articles with unwanted content — profanity, accidents, violence and negative sensationalism — on news portals and social media, with special focus on Facebook.

Hidden content does not disappear from the page: it collapses into an unobtrusive bar

> ParaBene ukryło treść (powód: wypadek) **[Pokaż mimo wszystko]**
> *(ParaBene hid this content (reason: accident) [Show anyway])*

so it can be revealed with a single click in case of a false positive.

- Plain JavaScript, HTML and CSS — **no `npm install`, no bundler, no external dependencies**.
- Everything runs locally. Page text never leaves your computer (the optional AI model runs on `localhost`).
- Modular decision engine, ready for plugging in a local AI model (Stage 2).

> The extension's user interface and the default keyword list are in Polish, as ParaBene targets Polish-language websites.

---

## Installation (Linux / Windows / macOS)

The procedure is the same on every system:

1. Get the repository:
   ```bash
   git clone https://github.com/danieljarosik/parabene.git
   ```
   or download the ZIP from GitHub and extract it.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** in the top-right corner.
4. Click **Load unpacked** and select the `parabene` directory (the one containing `manifest.json`).
5. Pin the umbrella icon to the toolbar (puzzle icon → pin next to ParaBene).
6. Reload open tabs — the extension works on pages loaded after installation.

The extension also works in other Chromium-based browsers (Edge, Brave, Opera, Vivaldi), via the same extensions page.

**Updating:** after `git pull`, click the reload icon next to ParaBene in `chrome://extensions` and reload your tabs.

---

## Usage

Click the ParaBene icon to open the panel:

| Element | What it does |
| --- | --- |
| **ON/OFF** switch | Instantly enables or disables the filter in all tabs. When disabled, hidden content comes back. |
| **Ukryte na tej stronie** (*Hidden on this page*) | Number of collapsed elements in the current tab (also shown as a badge on the extension icon). |
| **Słowa kluczowe** (*Keywords*) | Add phrases (several at once — separate them with commas) and remove them with a single click on `×`. Changes apply immediately, without reloading the page. |
| **Przywróć domyślne frazy** (*Restore default phrases*) | Adds missing phrases from the default list (does not remove yours). |
| **Lokalny model AI (localhost)** (*Local AI model*) | Switches evaluation to a local classification server; the address field and the **Testuj** (*Test*) button check the connection. |

Profanity on the panel's keyword list is blurred and revealed on mouse hover. The placeholder bar shows the category „wulgaryzm” (*profanity*) instead of the word itself.

### How keyword matching works

- Case-insensitive, with full support for Polish characters (`ą ć ę ł ń ó ś ź ż`) — „ŚMIERĆ” matches „śmierć”.
- A phrase must match **at the start of a word**, and its end is open. Entering a word stem therefore covers inflected forms:
  - `tragedi` → tragedia, tragedii, tragedię,
  - `pożar` → pożar, pożaru, pożarami,
  - but `pożar` will **not** match „rozpożarowanie”, and `wypadek` will not match „x_wypadek”.
- Multi-word phrases (`nie żyje`) tolerate any whitespace between words.
- Short phrases (min. 3 characters) catch a lot — the shorter the stem, the higher the risk of false positives.

On first run, a default list of Polish phrases is loaded (accidents, death, violence, disasters, basic profanity). You can edit it freely.

---

## How ParaBene finds content

**Facebook** — CSS classes there are randomly generated, so ParaBene relies solely on the accessibility structure: `div[role="article"]`, feed items (`div[role="feed"] > div`) and `div[aria-posinset]`. Each container is evaluated only on its **own** text — a profane comment hides just that comment, not the whole post.

**News portals and other sites** — `<article>` / `role="article"` elements and tiles built around an `h1`–`h3` heading with a link (the algorithm climbs from the heading to the largest ancestor that is still a single tile). Safeguards reject `body`, `main`, the feed, navigation, the page header and footer, as well as containers holding many articles or too much text, so the whole page never gets hidden.

**Dynamically loaded content** (infinite scroll) is handled by a `MutationObserver` with a 200 ms debounce (and a 1 s maximum wait under a continuous stream of changes). Checked nodes get the `data-parabene-checked="true"` attribute. If their text changes (e.g. Facebook first renders an empty post skeleton), they are evaluated again.

**Hiding** never uses `.remove()` — that would break infinite scroll and page scripts. The container gets the `parabene-hidden` class, and CSS hides its children and shows the placeholder bar inserted as the first child.

---

## Architecture

```
parabene/
├── manifest.json          Manifest V3
├── icons/                 icon16/48/128.png (generated by tools/generate_icons.py)
├── src/
│   ├── config.js          default settings, phrase list, chrome.storage.local access
│   ├── evaluators.js      ContentEvaluator, KeywordEvaluator, LocalAIEvaluator, FallbackEvaluator
│   ├── content.js         MutationObserver, container heuristics, hiding/restoring
│   ├── content.css        styles for hidden blocks and the placeholder bar
│   └── background.js      service worker: default settings, local AI proxy, icon badge counter
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
└── tools/
    └── generate_icons.py  icon generator (plain Python, no libraries)
```

`content.js` deals with the DOM only. Whether to hide a piece of text is decided by an evaluator from `evaluators.js` through a shared contract:

```js
class ContentEvaluator {
  async evaluate(text) // → { hide: boolean, reason: string, source: "keyword" | "ai" }
}
```

| Class | Role |
| --- | --- |
| `KeywordEvaluator` | Fast local keyword matching (a single compiled regular expression with the `u` flag). |
| `LocalAIEvaluator` | Sends a `POST` to the local endpoint. Limits concurrent requests (3), caches results and caps text length (2000 characters). |
| `FallbackEvaluator` | Tries the AI model. On error (no server, timeout, invalid response) it falls back to `KeywordEvaluator` and skips the failing server for 30 s. |

All settings live in `chrome.storage.local`:

```json
{
  "enabled": true,
  "keywords": ["wypadek", "śmierć", "..."],
  "aiEnabled": false,
  "aiEndpoint": "http://localhost:8000/classify"
}
```

---

## Local AI endpoint contract (Stage 2)

With **Lokalny model AI (localhost)** enabled, every detected container is evaluated by your server. Requests are sent by the extension's service worker, so **the server does not need to set CORS headers**, and pages' private network restrictions (HTTPS → localhost) do not apply.

**Request**

```http
POST /classify HTTP/1.1
Host: localhost:8000
Content-Type: application/json

{"text": "Tragiczny wypadek na autostradzie A4. Trzy osoby ranne."}
```

- `text` — text of the post or tile (UTF-8, whitespace normalized, max. 2000 characters).

**Response** (`200 OK`, `Content-Type: application/json`)

```json
{"hide": true, "reason": "wypadek drogowy"}
```

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `hide` | `boolean` | yes | `true` — hide the content. |
| `reason` | `string` | no | Short reason shown in the bar (truncated to 80 characters). Defaults to „ocena modelu AI” (*AI model verdict*). |

**Error handling:** a non-`2xx` response, invalid JSON, a missing `hide` field or no response within **4 s** make ParaBene fall back to keywords, and the server is skipped for 30 s. Pages keep working normally even when the server is down.

### Example server (Python, no dependencies)

```python
# classify_server.py — run: python3 classify_server.py
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

NEGATIVE = ("wypadek", "zginął", "tragedi", "przemoc")

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/classify":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", 0))
        text = str(json.loads(self.rfile.read(length) or b"{}").get("text", "")).lower()
        hit = next((word for word in NEGATIVE if word in text), None)
        body = json.dumps({"hide": hit is not None, "reason": hit or ""}, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

HTTPServer(("127.0.0.1", 8000), Handler).serve_forever()
```

Test from the terminal:

```bash
curl -s -X POST http://localhost:8000/classify \
  -H 'Content-Type: application/json' \
  -d '{"text": "Tragiczny wypadek na A4"}'
# {"hide": true, "reason": "wypadek"}
```

### Plugging in a real model

- **Polish classifier (HerBERT, Bazal, etc.)** — call your pipeline in `do_POST` (e.g. `transformers.pipeline("text-classification", model=...)`) and return `{"hide": label in NEGATIVE_LABELS, "reason": label}`.
- **Ollama / llama.cpp** — both have their own APIs, so put a thin adapter in front of them that speaks the same format. Example for Ollama:

  ```python
  import json, urllib.request

  def classify_with_ollama(text):
      prompt = (
          "Decide whether the following text contains violence, accidents, death, profanity or "
          "negative sensationalism. Reply with JSON only: "
          '{"hide": true|false, "reason": "short reason in Polish"}.\n\nText: ' + text
      )
      request = urllib.request.Request(
          "http://localhost:11434/api/generate",
          data=json.dumps({"model": "llama3.1", "prompt": prompt, "format": "json", "stream": False}).encode(),
          headers={"Content-Type": "application/json"},
      )
      with urllib.request.urlopen(request, timeout=3.5) as response:
          answer = json.loads(json.loads(response.read())["response"])
      return {"hide": bool(answer.get("hide")), "reason": str(answer.get("reason", ""))}
  ```

  The model must respond within 4 s. On slower hardware, pick a smaller model.

Set the endpoint address in the panel (the **Adres endpointu** (*Endpoint address*) field). The **Testuj** (*Test*) button sends a sample text and shows the server's response.

---

## Privacy

- No telemetry, analytics or external servers.
- Settings are stored only in `chrome.storage.local`.
- In AI mode, text is sent **only** to the address entered in the panel (`localhost` by default).

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | saving settings and the phrase list |
| `activeTab` | reading the hidden-elements counter from the current tab |
| `host_permissions: <all_urls>` | running the filter on news portals and social media |
| `http://localhost/*`, `http://127.0.0.1/*` | connecting to the local AI model |

## Development

Icons are generated by a plain Python script (no libraries):

```bash
python3 tools/generate_icons.py
```

After every code change, click the reload icon next to ParaBene in `chrome://extensions` and reload the tab you are testing. Content script logs are in the page's DevTools (prefix `[ParaBene]`). Open the service worker logs via the *service worker* link on the extension's card.
