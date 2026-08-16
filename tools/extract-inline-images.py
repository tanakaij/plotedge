#!/usr/bin/env python3
"""
Move every inline base64 PNG out of index.html and plotedge.manifest.json into
real files under resources/, and rewrite the references to point at them.

WHY
---
index.html was 390 KB, of which 212 KB was four base64 PNGs; the web app
manifest was 298 KB, essentially all of it three more. That is roughly half a
megabyte of image data the browser has to parse as *markup* on every cold
start, and none of it can be cached, revalidated or compressed independently of
the document that carries it. Worse, base64 inflates binary by ~33%, so the
bytes on the wire were larger than the images themselves.

Splitting them out means:
  * index.html drops to ~180 KB, so the shell parses and paints sooner;
  * each icon becomes an independently cacheable file - change one and the
    other six (and the HTML) stay in cache;
  * the service worker can precache them explicitly (see APP_ASSETS);
  * the PNGs can actually be optimised, which base64-in-markup prevented.

WHAT IT DOES NOT DO
-------------------
It does not re-encode at a different size or strip colour profiles beyond
Pillow's own optimiser. The artwork is left pixel-identical; only the container
changes. Re-running is safe: if a reference is already a file path there is
nothing to extract and the file is left alone.
"""

import base64
import io
import json
import pathlib
import re
import sys

try:
    from PIL import Image
except ImportError:
    print("ERROR: Pillow is required (pip install pillow).")
    sys.exit(1)

ROOT = pathlib.Path(__file__).resolve().parent.parent
RES = ROOT / "resources"
INDEX = ROOT / "index.html"
MANIFEST = ROOT / "plotedge.manifest.json"

# Stable, meaningful filenames rather than content hashes: these paths are
# written into the service worker's precache list and into the CI staging step,
# so a name that changes whenever the artwork is retouched would silently break
# both. Keyed by the role the image plays, matched in document order.
INDEX_NAMES = [
    "favicon-128.png",
    "apple-touch-icon-180.png",
    "splash-logo-320.png",
    "welcome-mark-176.png",
]

DATA_URL = re.compile(r"data:image/png;base64,([A-Za-z0-9+/=]{500,})")


def optimise(raw: bytes, path: pathlib.Path) -> int:
    """Write the PNG through Pillow's optimiser. Returns bytes written."""
    img = Image.open(io.BytesIO(raw))
    img.save(path, format="PNG", optimize=True)
    return path.stat().st_size


def extract_index() -> int:
    html = INDEX.read_text(encoding="utf-8")
    before = len(html)
    matches = list(DATA_URL.finditer(html))
    if not matches:
        print("  index.html: no inline PNGs left (already extracted)")
        return 0
    if len(matches) != len(INDEX_NAMES):
        print(
            f"  WARN index.html: found {len(matches)} inline PNGs but "
            f"{len(INDEX_NAMES)} names are configured - aborting rather than "
            f"guessing which is which."
        )
        return 1

    # Replace from the end so earlier match offsets stay valid.
    for name, m in zip(reversed(INDEX_NAMES), reversed(matches)):
        raw = base64.b64decode(m.group(1))
        out = RES / name
        size = optimise(raw, out)
        print(f"  index.html -> resources/{name}  ({len(m.group(1)):,}B b64 -> {size:,}B file)")
        html = html[: m.start()] + f"resources/{name}" + html[m.end() :]

    INDEX.write_text(html, encoding="utf-8")
    print(f"  index.html: {before:,} -> {len(html):,} bytes "
          f"({100 * (before - len(html)) / before:.0f}% smaller)")
    return 0


def extract_manifest() -> int:
    text = MANIFEST.read_text(encoding="utf-8")
    before = len(text)
    data = json.loads(text)
    icons = data.get("icons", [])
    changed = False
    for icon in icons:
        src = icon.get("src", "")
        if not src.startswith("data:"):
            continue
        raw = base64.b64decode(src.split("base64,", 1)[1])
        purpose = (icon.get("purpose") or "any").split()[0]
        sizes = icon.get("sizes", "icon")
        name = f"icon-{sizes}-{purpose}.png"
        out = RES / name
        size = optimise(raw, out)
        print(f"  manifest -> resources/{name}  ({len(src):,}B data URL -> {size:,}B file)")
        icon["src"] = f"resources/{name}"
        changed = True

    if not changed:
        print("  manifest: no inline PNGs left (already extracted)")
        return 0

    # indent=2 keeps it readable now that it is small enough to read.
    text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    MANIFEST.write_text(text, encoding="utf-8")
    print(f"  manifest: {before:,} -> {len(text):,} bytes "
          f"({100 * (before - len(text)) / before:.0f}% smaller)")
    return 0


def main() -> int:
    RES.mkdir(parents=True, exist_ok=True)
    rc = extract_index()
    rc |= extract_manifest()
    print("\nRemember: every file written here must also appear in "
          "plotedge-sw.js APP_ASSETS, or an offline launch will 404 on it.")
    return rc


if __name__ == "__main__":
    sys.exit(main())
