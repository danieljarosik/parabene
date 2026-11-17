#!/usr/bin/env python3
"""Vendors wllama (llama.cpp in WebAssembly, MIT) into vendor/wllama/ for the built-in AI model.

Plain Python, no libraries. Run it only to change the wllama version:

    python3 tools/vendor_wllama.py

It downloads the pinned npm package, checks its SHA-512 and copies three files, unchanged:

    vendor/wllama/index.js          the library (an ES module; it carries its worker code inside)
    vendor/wllama/wasm/wllama.wasm  the WebAssembly binary
    vendor/wllama/LICENCE

plus vendor/wllama/VERSION.json, which records where they came from.
"""
import base64
import hashlib
import io
import json
import sys
import tarfile
import urllib.request
from pathlib import Path

VERSION = "3.13.0"
TARBALL = f"https://registry.npmjs.org/@wllama/wllama/-/wllama-{VERSION}.tgz"
SHA512 = "ZvoRdQAn+E+18EvQ9qS036gudiI9rbZRBJgG/qNICPPwrA0Y6SMMdbziz/j7K/0WxcbJlhaRraVIYsnEy732NA=="

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "vendor" / "wllama"
FILES = {
    "package/esm/index.js": "index.js",
    "package/esm/wasm/wllama.wasm": "wasm/wllama.wasm",
    "package/LICENCE": "LICENCE",
}


def main():
    print(f"Downloading {TARBALL}")
    with urllib.request.urlopen(TARBALL, timeout=120) as response:
        data = response.read()
    digest = base64.b64encode(hashlib.sha512(data).digest()).decode()
    if digest != SHA512:
        print(f"✗ SHA-512 mismatch: got {digest}")
        return 1

    (TARGET / "wasm").mkdir(parents=True, exist_ok=True)
    record = {"package": "@wllama/wllama", "version": VERSION, "tarball": TARBALL, "sha512": SHA512, "files": {}}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        for member, name in FILES.items():
            content = tar.extractfile(member).read()
            (TARGET / name).write_bytes(content)
            record["files"][name] = hashlib.sha256(content).hexdigest()
            print(f"  vendor/wllama/{name}  {len(content):,} bytes")
    (TARGET / "VERSION.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    print(f"✓ wllama {VERSION} vendored")
    return 0


if __name__ == "__main__":
    sys.exit(main())
