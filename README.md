# ParaBene – Positive Web & News Filter

**ParaBene** is a lightweight Google Chrome extension (Manifest V3) that hides posts and articles with unwanted content — profanity, accidents, violence and negative sensationalism — on news portals and social media, with special focus on Facebook.

Hidden content does not disappear from the page: it collapses into an unobtrusive bar

> ParaBene ukryło treść (powód: wypadek) **[Pokaż mimo wszystko]**
> *(ParaBene hid this content (reason: accident) [Show anyway])*

so it can be revealed with a single click in case of a false positive.

- Plain JavaScript, HTML and CSS — **no `npm install`, no bundler, no external dependencies**.
- Everything runs locally. Page text never leaves your machine or home network (the optional AI model runs on `localhost` or on a server you choose in your LAN); the same goes for pictures with the optional image evaluation.
- Modular decision engine, ready for plugging in a local AI model (Stage 2).

> The user interface is available in **Polish (default) and English** — switch it with the language picker in the panel's footer. The default keyword list is Polish, as ParaBene targets Polish-language websites.

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

Click the ParaBene icon to open the panel. Labels below are given in English, with the Polish (default) UI text in parentheses.

| Element | What it does |
| --- | --- |
| **ON/OFF** switch | Instantly enables or disables the filter in all tabs. When disabled, hidden content comes back. |
| **Hidden on this page** (*Ukryte na tej stronie*) | Number of collapsed elements in the current tab (also shown as a badge on the extension icon), split into **Keywords** (*Słowa kluczowe*), **AI (text)** (*AI (tekst)*) — the text model — and **AI (picture)** (*AI (grafika)*) — the image model. Content hidden by keywords while the AI server is unavailable counts as keywords. The placeholder bar says the same: *AI – text* (*AI – tekst*) or *AI – picture* (*AI – grafika*) after the reason. |
| **Keywords** (*Słowa kluczowe*) | Add phrases (several at once — separate them with commas) and remove them with a single click on `×`. Changes apply immediately, without reloading the page. |
| **Restore default phrases** (*Przywróć domyślne frazy*) | Adds missing phrases from the default list (does not remove yours). |
| **Local AI model (localhost)** (*Lokalny model AI*) | Switches evaluation to a local classification server. **Request format** (*Format zapytań*) picks ParaBene's simple contract or [basal-serve](#basal-serve-v1basal); the address field and the **Test** (*Testuj*) button check the connection. **Keywords and AI model** (*Frazy i model AI*) sets how the two work together (see below); with basal-serve you also pick the **Sensitivity** (*Czułość*) and the **Hidden topics** (*Ukrywane tematy*). |
| **Image evaluation (basal-omni)** (*Ocena grafik (basal-omni)*) | Off by default. Judges the pictures of posts and tiles with a multimodal model on a separate basal-serve server (e.g. port 8011), so the fast text model keeps its own. Works with or without the text model, shares its **Sensitivity** and **Hidden topics**; **Test** (*Testuj*) checks that the server takes images. See [Image evaluation](#image-evaluation-basal-omni). |
| **Log of hidden content** (*Dziennik ukrytych treści*) | Off by default. When on, every hidden item is recorded locally with its text, page address and verdict (keywords, AI text model or AI image model); **Download file (.jsonl)** (*Pobierz plik*) exports it for analysis, **Clear log** (*Wyczyść dziennik*) deletes it (click twice). See [Log of hidden content](#log-of-hidden-content). |
| Language picker (footer, 🌐) | Switches the interface language (*Polski* / *English*). It applies at once to the panel and to the placeholder bars in open tabs, without reloading them. |

Profanity on the panel's keyword list is blurred and revealed on mouse hover. The placeholder bar shows the category *profanity* („wulgaryzm”) instead of the word itself.

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
├── manifest.json          Manifest V3 (name/description via __MSG_*__, default_locale: pl)
├── .env.example           template of the local settings file .env (not committed)
├── _locales/
│   ├── pl/messages.json   Polish UI texts (default)
│   └── en/messages.json   English UI texts
├── icons/                 icon16/48/128.png (generated by tools/generate_icons.py)
├── src/
│   ├── config.js          default settings, phrase list, chrome.storage.local access
│   ├── i18n.js            translation loader/formatter (placeholders, plural forms, DOM localization)
│   ├── evaluators.js      ContentEvaluator, KeywordEvaluator, LocalAIEvaluator, FallbackEvaluator
│   ├── content.js         MutationObserver, container heuristics, hiding/restoring
│   ├── content.css        styles for hidden blocks and the placeholder bar
│   └── background.js      service worker: default settings, local AI proxy (text and pictures), icon badge counter, log, translations for content scripts
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
└── tools/
    ├── generate_icons.py  icon generator (plain Python, no libraries)
    ├── check_locales.py   translation consistency check (plain Python, no libraries)
    └── basal_check.py     basal-serve check and reference client (plain Python, no libraries)
```

`content.js` deals with the DOM only. Whether to hide a piece of text is decided by an evaluator from `evaluators.js` through a shared contract:

```js
class ContentEvaluator {
  async evaluate(text) // → { hide: boolean, reason: string, source: "keyword" | "ai", category?: string,
                      //     details?: { score, threshold, probabilities, model }, fallback?: true }
}
```

`details` carries the AI model's numbers and `fallback` marks a keyword verdict given while the model was unavailable; both are used only by the log of hidden content. Evaluators are language-neutral: `reason` is raw data (the matched phrase or the model's own text) and `category` is an id such as `profanity`. The UI turns them into text in the chosen language; errors from the local model are likewise passed around as `{ code, detail }` and translated by the panel.

| Class | Role |
| --- | --- |
| `KeywordEvaluator` | Fast local keyword matching (a single compiled regular expression with the `u` flag). |
| `LocalAIEvaluator` | Sends a `POST` to the local endpoint. Limits concurrent requests (3), caches results and caps text length (2000 characters). |
| `FallbackEvaluator` | Tries the AI model. On error (no server, timeout, invalid response) it falls back to `KeywordEvaluator` and skips the failing server for 30 s. |
| `FirstHitEvaluator` | Asks evaluators in order and stops at the first one that hides the text. Used by the default *Keywords + AI* mode: a keyword match hides at once, without a request to the model. |

**Keywords and AI model** (`aiMode`):

- `both` (default, *Frazy + AI*) — your keywords still work with the model on: a match hides the text at once; everything else goes to the model. Profanity and your own phrases are never missed because the model was not asked about them.
- `ai` (*Tylko AI*) — the model decides alone; keywords are used only while the server is unavailable.

All settings live in `chrome.storage.local`:

```json
{
  "enabled": true,
  "keywords": ["wypadek", "śmierć", "..."],
  "aiEnabled": false,
  "aiEndpoint": "http://localhost:8000/classify",
  "aiProtocol": "simple",
  "aiMode": "both",
  "aiSensitivity": "medium",
  "aiTopics": ["accident", "violence", "death", "profanity"],
  "aiImagesEnabled": false,
  "aiImagesEndpoint": "http://localhost:8011",
  "logEnabled": false,
  "language": "pl"
}
```

### Local settings file (`.env`)

To keep your own settings (e.g. the address of a server in your LAN) out of git, copy `.env.example` to `.env` in the extension directory and edit it. `.env` is ignored by git.

```bash
cp .env.example .env
```

```ini
PARABENE_AI_ENABLED=true
PARABENE_AI_PROTOCOL=basal
PARABENE_AI_ENDPOINT=http://192.168.1.170:8010
PARABENE_AI_SENSITIVITY=medium
PARABENE_AI_TOPICS=accident,violence,death,profanity,politics
PARABENE_AI_IMAGES_ENABLED=true
PARABENE_AI_IMAGES_ENDPOINT=http://192.168.1.170:8011
```

The service worker reads `.env` on install and on every reload of the extension in `chrome://extensions`, and writes the values into `chrome.storage.local`. So edit `.env`, then reload the extension. Changes made in the panel last until the next reload. Supported keys: `PARABENE_ENABLED`, `PARABENE_AI_ENABLED` (`true`/`false`), `PARABENE_AI_PROTOCOL` (`simple`/`basal`), `PARABENE_AI_ENDPOINT`, `PARABENE_AI_MODE` (`both`/`ai`), `PARABENE_AI_SENSITIVITY` (`low`/`medium`/`high`), `PARABENE_AI_TOPICS` (comma-separated ids from `accident`, `violence`, `death`, `profanity`, `politics`, `clickbait`; empty = none), `PARABENE_AI_IMAGES_ENABLED` (`true`/`false`), `PARABENE_AI_IMAGES_ENDPOINT`, `PARABENE_LOG_ENABLED` (`true`/`false`) and `PARABENE_LANGUAGE` (`pl`/`en`). Unknown keys and invalid values are skipped with a warning in the service worker console. Without a `.env` file nothing changes.

### Internationalisation (i18n)

UI texts use the standard Chrome extension format — [`_locales/<lang>/messages.json`](https://developer.chrome.com/docs/extensions/reference/api/i18n) — with a `description` for translators and named placeholders with examples for every message. Nothing user-visible is hard-coded in HTML or JavaScript.

- **Manifest** strings (`__MSG_extName__`, `__MSG_extDescription__`) are resolved by Chrome from the browser language, falling back to `default_locale` (`pl`).
- **Panel and placeholder bars** follow the `language` setting chosen by the user (default `pl`). `chrome.i18n.getMessage()` cannot switch language at runtime, so `src/i18n.js` loads the chosen `messages.json` and formats it with the same rules as `chrome.i18n` (`$name$` placeholders, `$1…$9`, `$$`, case-insensitive names). Missing keys fall back to the default language, then to `chrome.i18n`.
- **Plural forms** follow CLDR rules via `Intl.PluralRules`: `plural('keywordsAdded', n)` picks `keywordsAdded_one` / `_few` / `_many` / `_other` (Polish needs all four: 1 frazę, 2 frazy, 5 fraz). Numbers are formatted with `Intl.NumberFormat`.
- **HTML** is translated declaratively: `data-i18n="key"` sets the text, `data-i18n-placeholder`, `data-i18n-title`, `data-i18n-aria-label` and `data-i18n-alt` set attributes; `<html lang/dir>` and the bar's `lang` attribute follow the UI language.
- **Content scripts** cannot read extension files, so they get translations from the service worker (`parabene:getMessages`).

**Adding a language** (e.g. German):

1. Copy `_locales/en/messages.json` to `_locales/de/messages.json` and translate every `message` (keep the keys and placeholders; add `_one`/`_few`/`_many`/`_other` variants as German plural rules require — `_other` is always the fallback).
2. Add `de: 'Deutsch'` to `UI_LANGUAGES` in `src/config.js` (the name is written in the language itself).
3. Run `python3 tools/check_locales.py`.

---

## Local AI endpoint contract (Stage 2)

With **Local AI model (localhost)** (*Lokalny model AI*) enabled, every detected container is evaluated by your server. Requests are sent by the extension's service worker, so **the server does not need to set CORS headers**, and pages' private network restrictions (HTTPS → localhost) do not apply.

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
| `reason` | `string` | no | Short reason shown in the bar (truncated to 80 characters). Defaults to *AI model verdict* („ocena modelu AI”), in the UI language. |

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

Set the endpoint address in the panel (the **Endpoint URL** (*Adres endpointu*) field). The **Test** (*Testuj*) button sends a sample text and shows the server's response.

### basal-serve (`/v1/basal`)

Instead of writing an adapter, pick **basal-serve (/v1/basal)** under **Request format** (*Format zapytań*) and enter the server address, e.g. `http://192.168.1.170:8010` (`/v1/basal` is appended to a bare address; a full route such as `http://192.168.1.170:8010/v1/basal` also works). A 404 from the server shows a hint about the path and the request format. ParaBene then speaks basal's typed-decision API directly (tested with `Remek/basal-2.0-mini-MLX-8bit`). Each container is one request with one `choice` question:

```json
{
  "state": "Wypadek na S6 koło Żukowa, dwa auta rozbite, korek na 4 km.",
  "lang": "pl",
  "questions": {
    "topic": {
      "type": "choice",
      "instructions": "Co opisuje tekst?",
      "option_keys": "hide",
      "criteria": {
        "accident": "wypadek, katastrofę, pożar lub klęskę żywiołową",
        "violence": "przemoc, przestępstwo, atak lub wojnę",
        "death": "śmierć, chorobę lub tragedię osobistą",
        "profanity": "wulgaryzmy lub obelgi",
        "none": "coś innego, neutralnego lub pozytywnego"
      }
    }
  }
}
```

```json
{"model": "basal-2.0-mini-MLX-8bit",
 "answers": {"topic": {"type": "choice", "choice": "accident",
   "probabilities": {"accident": 0.57, "violence": 0.02, "death": 0.01, "profanity": 0.01, "none": 0.39},
   "confidence": 0.57}},
 "usage": {"input_tokens": 112, "questions": 1, "latency_ms": 160}}
```

**Hidden topics** (`aiTopics`) pick which topics count; the bar shows the most probable selected topic, e.g. *(powód: wypadek, AI)*.

| Topic id | Panel label | Description sent to the model | Default |
| --- | --- | --- | --- |
| `accident` | *wypadek* (accident) | wypadek, katastrofę, pożar lub klęskę żywiołową | ✓ |
| `violence` | *przemoc* (violence) | przemoc, przestępstwo, atak lub wojnę | ✓ |
| `death` | *śmierć lub tragedia* (death or tragedy) | śmierć, chorobę lub tragedię osobistą | ✓ |
| `profanity` | *wulgaryzm* (profanity) | wulgaryzmy lub obelgi | ✓ |
| `politics` | *polityka* (politics) | politykę, polityków lub spory polityczne | |
| `clickbait` | *sensacja / clickbait* (sensationalism / clickbait) | sensację, szokujący nagłówek lub clickbait | |

The four default topics are always part of the question, even when unchecked: with only one or two options the model gets pushed into them (asked about politics alone, a profane rant scored p(politics) ≈ 0.8). `politics` and `clickbait` are added only when checked, as they draw probability away from the others (with `clickbait` present, a flood report scored only 0.24 for the disaster topics).

The **hide score** is the summed probability of the checked topics. **Sensitivity** (`aiSensitivity`, `AI_SENSITIVITIES` in `src/config.js`) sets the threshold: *low* 0.7, *medium* 0.5 (default), *high* 0.3. The **Test** (*Testuj*) button shows the score of its sample text and the threshold, which helps when tuning it. On a set of 20 Polish news snippets the defaults at *medium* hid all 10 about accidents, disasters, crime, death and profanity, and none of the 10 neutral, political or merely sensational ones. The choice form is used because a plain yes/no (`noul`) question ranks texts well but is poorly calibrated on this model (a car crash scored p(true) ≈ 0.3). `max_error` / `abstain` are not used: this model certifies only `choice` at `max_error` 0.05, with a confidence threshold of ≈ 0.97, so nearly every answer abstains.

Warm requests take ~150–300 ms. Check a server and see the raw contract with the bundled script, which also contains a reusable client (`BasalClient`):

```bash
python3 tools/basal_check.py --url http://192.168.1.170:8010
```

### Image evaluation (basal-omni)

Turn on **Image evaluation (basal-omni)** (*Ocena grafik (basal-omni)*) to judge pictures as well. It needs a second basal-serve server with a multimodal model and media enabled; the text model keeps its own, much faster server:

```bash
basal-serve --model Remek/basal-omni-1.0-mini --mode eager --media on --host 0.0.0.0 --port 8011
```

Enter its address in the panel (default `http://localhost:8011`; `/v1/basal` is appended) and click **Test** (*Testuj*): it checks `GET /v1/models` (a model without `"image"` in `media`, e.g. the text-only `basal-2.0-mini`, is reported) and sends a generated landscape. The first request after a server start loads the model and takes ~15 s.

**What is judged.** After a container's text has been checked and has not hidden it, its pictures are judged: `<img>` elements of the container itself (not of nested containers such as comments), at least 100 px a side (natural size) and rendered at least 80 × 60 px, so icons, avatars and emoji are skipped; SVG is skipped. At most the two largest pictures of a container are asked about, one request each. A picture loaded later (lazy loading, carousels) triggers a new check. A container hidden because of its picture shows *(powód: wypadek, AI – grafika)* (*reason: accident, AI – picture*) and counts as **AI model** (*Model AI*).

**Viewport first.** One picture is ~1.8 s of server time and the server answers one request at a time, so containers are judged only when they come within 600 px of the viewport (an `IntersectionObserver`), at most two requests at once across all tabs. On a photo-heavy portal this kept up with steady scrolling (16 pictures in ~50 s).

**How a picture is sent.** The service worker fetches the picture from the address the page uses (without cookies), scales it to at most 768 px a side and re-encodes it as JPEG (transparency on white; an animated GIF becomes its first frame, which basal would otherwise refuse) and sends it in basal's `media` field with an empty `state`:

```json
{
  "state": "",
  "lang": "pl",
  "media": [{"type": "image", "data": "<base64 JPEG>"}],
  "questions": {
    "topic": {
      "type": "choice",
      "instructions": "Co przedstawia obraz?",
      "option_keys": "hide",
      "criteria": {
        "accident": "wypadek, katastrofę, pożar lub klęskę żywiołową",
        "violence": "przemoc, broń, walkę zbrojną lub zniszczenia wojenne",
        "death": "śmierć, zwłoki, krew lub rannych ludzi",
        "profanity": "wulgarny gest, nagość lub obsceniczne treści",
        "none": "coś innego, neutralnego lub pozytywnego"
      }
    }
  }
}
```

The score, threshold and hidden topics work as for text. `politics` (*polityków, wiec lub wydarzenie polityczne*) is asked when checked; `clickbait` is never asked about a picture. Results are cached per picture address in the service worker (500 entries), so a sensitivity change or a page reload does not ask again. Pictures that cannot be fetched or decoded (or that the server refuses with HTTP 422) are skipped; any other error pauses image evaluation in that tab for 30 s, and the requests time out after 30 s.

Measured with `Remek/basal-omni-1.0-mini` on 20 photos at the default topics:

| Picture | Score | Picture | Score |
| --- | --- | --- | --- |
| car crash | 0.97 | cat, dog, pizza, fries, mountains | 0.00 |
| destroyed tank | 0.95 | hospital corridor, politician at a podium | 0.00 |
| burning warehouse / wildfire | 0.83 / 0.88 | fire station building | 0.01 |
| flooded street | 0.83 | cemetery with candles (All Saints' Day) | 0.03 |
| police car after a collision | 0.77 | kids' boxing match / military parade | 0.15 / 0.25 |

The model judges what it sees, not the context: a firefighting drill with real flames scored 0.88 (accident), as a real fire would, and a politician at a podium scored only 0.35 for `politics`.

Asking about several pictures in one request is not faster (~1.5 s each) and blurs the verdict (a tank among three neutral photos scored 0.07), and the picture size does not change the time (the model sees ~280 tokens of any picture). The model was trained on text decisions; its picture answers are zero-shot, so check the log on your own pages. `tools/basal_check.py --url http://localhost:8011 --image photo.jpg` asks the same question about a file.

---

## Log of hidden content

Turn on **Record hidden content** (*Zapisuj ukryte treści*) in the panel (or set `PARABENE_LOG_ENABLED=true` in `.env`) to collect material for tuning the keywords, the sensitivity and the topics. The service worker keeps the log in `chrome.storage.local` (key `hideLog`). It is written in batches once a second and holds the newest 1,000 entries, each text capped at 2,000 characters. The same text hidden for the same reason (e.g. after a page reload) is recorded once. Only items hidden after the switch is turned on are recorded, so reload the page to record what is already hidden on it.

**Download file (.jsonl)** (*Pobierz plik*) saves `parabene-log-YYYYMMDD-HHMM.jsonl` ([JSON Lines](https://jsonlines.org/)): a header line with the version and the settings at export time, then one hidden item per line.

```json
{"type":"meta","extension":"ParaBene","version":"1.0.0","exportedAt":"2026-11-16T09:12:00.000Z","entries":2,"settings":{"aiEnabled":true,"aiProtocol":"basal","aiMode":"both","aiSensitivity":"medium","aiThreshold":0.5,"aiTopics":["accident","violence","death","profanity"],"keywords":["wypadek","..."]}}
{"type":"hidden","time":"2026-11-16T09:10:41.120Z","url":"https://www.example.pl/","source":"keyword","mode":"both","reason":"wypadek","category":"","fallback":false,"revealed":false,"text":"Wypadek na S6 koło Żukowa..."}
{"type":"hidden","time":"2026-11-16T09:10:42.305Z","url":"https://www.example.pl/","source":"ai","mode":"both","reason":"","category":"violence","fallback":false,"revealed":true,"text":"...","details":{"score":0.58,"threshold":0.5,"probabilities":{"accident":0.04,"violence":0.51,"death":0.03,"profanity":0,"none":0.42},"model":"basal-2.0-mini-MLX-8bit"}}
```

| Field | Meaning |
| --- | --- |
| `source` | `keyword` — hidden by a phrase from the list; `ai` — hidden by the AI model (the text model, or the image model when `media` is `"image"`). |
| `mode` | `keywords` (AI off), `both` or `ai` (`aiMode`) at the time of hiding. |
| `reason` | The matched phrase (keywords) or the model's own reason (simple protocol). |
| `category` | Category id, e.g. `profanity` for a profane phrase or the basal topic. |
| `fallback` | `true` when keywords decided because the AI server was unavailable. |
| `revealed` | `true` when you clicked **Show anyway** (*Pokaż mimo wszystko*), usually a false positive. |
| `details` | AI only: the hide `score`, the `threshold`, basal's `probabilities` per topic and the `model` name. |
| `media`, `image` | Only for items hidden because of a picture: `"image"` and the picture's address (a `data:` URL is reduced to its type). Such items are recorded once per picture. |
| `text` | The text that was evaluated (the AI model received at most its first 2,000 characters). |

---

## Privacy

- No telemetry, analytics or external servers.
- Settings are stored only in `chrome.storage.local`.
- The log of hidden content is off by default. When on, it stays in `chrome.storage.local` and leaves the browser only as a file you download yourself. It contains page addresses and texts, so review it before sharing.
- With image evaluation on, pictures are fetched by the extension from the address the page loads them from (without cookies) and sent **only** to the image server entered in the panel.
- In AI mode, text is sent **only** to the address entered in the panel (`localhost` by default; enter a LAN address such as `http://192.168.1.170:8010/v1/basal` only for a server you run yourself).

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | saving settings and the phrase list |
| `activeTab` | reading the hidden-elements counter from the current tab |
| `host_permissions: <all_urls>` | running the filter on news portals and social media; fetching pictures for the optional image evaluation |
| `http://localhost/*`, `http://127.0.0.1/*` | connecting to the local AI model |

## Development

Icons are generated by a plain Python script (no libraries):

```bash
python3 tools/generate_icons.py
```

Translations are checked by another plain Python script — run it after every change to `_locales/` or to UI texts. It verifies that all languages have the same keys and placeholders and that every key referenced in the code exists:

```bash
python3 tools/check_locales.py
```

After every code change, click the reload icon next to ParaBene in `chrome://extensions` and reload the tab you are testing. Content script logs are in the page's DevTools (prefix `[ParaBene]`). Open the service worker logs via the *service worker* link on the extension's card.
