#!/usr/bin/env python3
"""Checks a basal-serve decision server and shows how to query it (plain Python, no libraries).

basal-serve (basal typed-decision models, e.g. Remek/basal-2.0-mini-MLX-8bit) answers typed questions about a
text in one request. ParaBene's "basal-serve (/v1/basal)" request format uses it (src/evaluators.js).

Request: POST <url>/v1/basal (alias of /v1/systemone)
  {"state": "<text>",                       # the text the questions are about
   "lang": "pl",                            # optional: "pl" | "en", the prompt language
   "questions": {"<name>": {
       "type": "choice" | "noul" | "score" | "multi" | ...,
       "instructions": "<the question>",
       "criteria": {"<key>": "<description>", ...},   # choice/score/multi; noul: optional {"true", "false"}
       "option_keys": "show" | "hide",      # optional: "hide" = only the descriptions are shown to the model
       "max_error": 0.05}}}                 # optional: adds "abstain" (needs a certified threshold, /v1/models)

Response: {"model": "...", "answers": {"<name>": {
       "type": "choice", "choice": "<key>",                # noul: "noul": p(true) instead of "choice"
       "probabilities": {"<key>": p, ...},  # noul: {"true": p, "false": 1 - p}
       "confidence": <max p>,
       "abstain": bool}},                   # only with max_error; true also when the type has no certificate
   "usage": {"input_tokens", "questions", "latency_ms", ...}}
Errors: 422 invalid request, 503 starting / overloaded / out of memory, 401/403 API key; body {"error": ...}.

Usage: python3 tools/basal_check.py [--url http://192.168.1.170:8010] [--text "..."]
Reuse: from basal_check import BasalClient, choice, yes_no
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.request

DEFAULT_URL = "http://192.168.1.170:8010"
SAMPLE = "Wypadek na S6 koło Żukowa, dwa auta rozbite, korek na 4 km."


class BasalError(RuntimeError):
    def __init__(self, status, message):
        super().__init__(f"HTTP {status}: {message}" if status else message)
        self.status = status


def choice(question, criteria, **opts):
    """A choice question; criteria: {key: description}. opts: option_keys, max_error, coverage, ..."""
    return {"type": "choice", "instructions": question, "criteria": criteria, **opts}


def yes_no(question, true=None, false=None, **opts):
    """A noul (yes/no) question; true / false: optional descriptions of the two sides."""
    crit = {k: v for k, v in (("true", true), ("false", false)) if v}
    return {"type": "noul", "instructions": question, **({"criteria": crit} if crit else {}), **opts}


class BasalClient:
    """Blocking client: decide(state, {name: question}) -> ({name: answer}, raw response, round-trip ms)."""

    def __init__(self, url=DEFAULT_URL, timeout=30, lang=None, api_key=None):
        self.base = url.rstrip("/")
        self.timeout = timeout
        self.lang = lang
        self.headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if api_key:
            self.headers["Authorization"] = f"Bearer {api_key}"

    def _call(self, method, path, body=None):
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(self.base + path, data=data, headers=self.headers, method=method)
        start = time.perf_counter()
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            raise BasalError(exc.code, exc.read().decode("utf-8", "replace")[:500]) from None
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise BasalError(0, f"{self.base} unreachable: {exc}") from None
        ms = (time.perf_counter() - start) * 1000
        try:
            return json.loads(raw), ms
        except ValueError:
            raise BasalError(200, f"reply is not JSON: {raw[:200]!r}") from None

    def models(self):
        return self._call("GET", "/v1/models")[0]["models"]

    def decide(self, state, questions, **fields):
        body = {"state": state, "questions": questions, **({"lang": self.lang} if self.lang else {}), **fields}
        reply, ms = self._call("POST", "/v1/basal", body)
        answers = reply.get("answers") if isinstance(reply, dict) else None
        if not isinstance(answers, dict):
            raise BasalError(200, f"reply has no answers: {str(reply)[:200]}")
        return answers, reply, ms


def picked(answer):
    """The chosen key of an answer: "choice" for choice/score, true/false for noul."""
    if answer.get("type") == "noul":
        return answer["noul"] >= 0.5
    return answer.get("choice")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--text", default=SAMPLE)
    parser.add_argument("--timeout", type=float, default=30)
    args = parser.parse_args()

    client = BasalClient(args.url, timeout=args.timeout, lang="pl")
    try:
        for model in client.models():
            print(f"model: {model['name']} (released {model.get('release_date', '?')}, "
                  f"certified max_error: {model.get('certified') or 'none'})")
        questions = {
            # Binary assessment as a two-option choice: a bare noul question scores this text p(true) ≈ 0.3.
            "tragedy": choice("Co opisuje tekst?", {
                "yes": "wypadek, przemoc lub tragedię",
                "no": "coś innego, neutralnego lub pozytywnego",
            }, option_keys="hide", max_error=0.05),
            "category": choice("Do jakiej kategorii należy tekst?", {
                "traffic": "ruch drogowy",
                "politics": "polityka",
                "other": "inne",
            }, max_error=0.05),
        }
        answers, reply, ms = client.decide(args.text, questions)
    except BasalError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1

    print(f"\nround trip: {ms:.0f} ms (server: {reply.get('usage', {}).get('latency_ms', '?')} ms)")
    print("raw response:")
    print(json.dumps(reply, ensure_ascii=False, indent=2))
    print("\nsummary:")
    for name, answer in answers.items():
        probs = ", ".join(f"{k}={p:.2f}" for k, p in answer["probabilities"].items())
        print(f"  {name:9} -> {picked(answer)!s:8} confidence={answer['confidence']:.2f} "
              f"abstain={answer.get('abstain')}  [{probs}]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
