#!/usr/bin/env python3
"""Validates _locales/*/messages.json (plain Python, no libraries).

Checks that:
  - every locale is valid JSON and every entry has a "message",
  - every locale has exactly the same keys as the default locale,
  - every $name$ used in a message is defined in its "placeholders",
  - a key's placeholders are the same in every locale,
  - every message key referenced in the code exists in the default locale.

Usage: python3 tools/check_locales.py   (exit code 1 on errors)
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCALES = ROOT / "_locales"
CODE_GLOBS = ["manifest.json", "src/*.js", "popup/*.js", "popup/*.html"]

# Static references to message keys in the code.
REFERENCE_PATTERNS = [
    re.compile(r"__MSG_([A-Za-z0-9_@]+)__"),
    re.compile(r"data-i18n(?:-[a-z-]+)?=\"([A-Za-z0-9_@]+)\""),
    re.compile(r"\bt\(\s*'([A-Za-z0-9_@]+)'"),
    re.compile(r"\bplural\(\s*'([A-Za-z0-9_@]+)'"),
]
PLURAL_CALL = re.compile(r"\bplural\(\s*'([A-Za-z0-9_@]+)'")
PLACEHOLDER_REF = re.compile(r"\$([A-Za-z0-9_@]+)\$")


def load(path):
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def main():
    manifest = load(ROOT / "manifest.json")
    default = manifest.get("default_locale")
    errors = []
    if not default:
        errors.append("manifest.json: missing default_locale")
        default = "pl"

    locales = {}
    for directory in sorted(p for p in LOCALES.iterdir() if p.is_dir()):
        try:
            locales[directory.name] = load(directory / "messages.json")
        except (OSError, json.JSONDecodeError) as exc:
            errors.append(f"{directory.name}: {exc}")

    if default not in locales:
        errors.append(f"default locale '{default}' has no messages.json")
        return report(errors, locales)

    reference = locales[default]
    for code, messages in locales.items():
        for key, entry in messages.items():
            if not isinstance(entry, dict) or not isinstance(entry.get("message"), str):
                errors.append(f"{code}: '{key}' has no \"message\"")
                continue
            defined = {name.lower() for name in entry.get("placeholders", {})}
            for name in PLACEHOLDER_REF.findall(entry["message"]):
                if name.lower() not in defined:
                    errors.append(f"{code}: '{key}' uses undefined placeholder ${name}$")
            if key in reference and code != default:
                expected = {n.lower() for n in reference[key].get("placeholders", {})}
                if defined != expected:
                    errors.append(f"{code}: '{key}' placeholders {sorted(defined)} != {default} {sorted(expected)}")
        if code != default:
            for key in sorted(set(reference) - set(messages)):
                errors.append(f"{code}: missing '{key}'")
            for key in sorted(set(messages) - set(reference)):
                errors.append(f"{code}: '{key}' is not in the default locale '{default}'")

    known = {key.lower() for key in reference}
    for pattern in CODE_GLOBS:
        for path in sorted(ROOT.glob(pattern)):
            text = path.read_text(encoding="utf-8")
            for regex in REFERENCE_PATTERNS:
                for key in regex.findall(text):
                    lookup = f"{key}_other" if regex is PLURAL_CALL else key
                    if lookup.lower() not in known:
                        errors.append(f"{path.relative_to(ROOT)}: unknown message '{lookup}'")

    return report(errors, locales)


def report(errors, locales):
    if errors:
        print("\n".join(f"✗ {error}" for error in errors))
        return 1
    counts = ", ".join(f"{code}: {len(messages)}" for code, messages in locales.items())
    print(f"✓ Translations OK ({counts})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
