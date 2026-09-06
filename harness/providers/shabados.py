"""Fetch the Shabad OS database - a second, independently edited corpus.

Unlike BaniDB, Shabad OS ships its SQLite file as a release asset, so this
provider is a plain resumable download with checksum recording. We keep it as
a cross-check: two projects transcribing the same scripture from different
printed sources, so disagreements are visible rather than invisible.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import sys
import urllib.request
from pathlib import Path

from .. import config


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download(force: bool = False) -> dict:
    manifest: dict[str, dict] = {}
    dest_dir = config.RAW_SHABADOS
    for name, url in config.SHABADOS_ASSETS.items():
        dest = dest_dir / name
        if dest.exists() and not force:
            print(f"  {name}: already present ({dest.stat().st_size/1e6:.1f} MB)")
        else:
            print(f"  {name}: downloading from {url}")
            tmp = dest.with_suffix(dest.suffix + ".part")
            req = urllib.request.Request(url, headers={"User-Agent": config.USER_AGENT})
            with urllib.request.urlopen(req, timeout=120) as resp, tmp.open("wb") as out:
                total = int(resp.headers.get("Content-Length") or 0)
                seen = 0
                while chunk := resp.read(1 << 20):
                    out.write(chunk)
                    seen += len(chunk)
                    if total and sys.stderr.isatty():
                        pct = 100 * seen / total
                        sys.stderr.write(f"\r    {pct:5.1f}%  {seen/1e6:7.1f} MB")
                        sys.stderr.flush()
            if sys.stderr.isatty():
                sys.stderr.write("\n")
            tmp.replace(dest)
        manifest[name] = {
            "url": url,
            "release": config.SHABADOS_RELEASE,
            "bytes": dest.stat().st_size,
            "sha256": _sha256(dest),
        }
        print(f"  {name}: sha256 {manifest[name]['sha256'][:16]}...")
    (dest_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    return manifest
