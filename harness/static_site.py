"""Generate a fully static site — no server, no database, no build step.

The local app queries SQLite through a small Python server. That is the wrong
shape for GitHub Pages, which serves files and nothing else. So this emits the
same app as plain files:

* `data/lines.tsv`   — one row per line of scripture: ids, ang, and the
  first-letter string. About 13 MB, which the CDN gzips to ~4 MB. The browser
  loads it once and searches it in memory, so every keystroke is local and
  instant with no network at all.
* `data/shabads/…`   — one small JSON file per shabad, with every translation
  and transliteration. Fetched only when a shabad is actually opened or
  scrolled into view, so a visit costs a few KB beyond the index.
* `data/text-en.tsv` — transliteration and English text, loaded *only* if the
  visitor switches to one of those two search modes.

Nothing else changes: `app/index.html` is the same file in both modes and
picks its data path from the `window.GURBANI_STATIC` marker injected below.
"""
from __future__ import annotations

import json
import shutil
import sys
import time
from pathlib import Path

from . import config

sys.path.insert(0, str(config.ROOT))

SHARD = 500        # shabads per directory, to keep folders a sane size

# Which streams the published site carries.
#
# The full corpus has 11 translations, but two of them are near-duplicates:
# pu.bdb matches pu.ss on 99.2% of lines, and en.ssk matches en.bdb on 92.7%.
# Shipping both sides of each pair costs 25 MB and adds nothing a reader would
# notice. en.bdb is also the only English that reaches beyond SGGS into Dasam
# Bani and the Vaarans (107,843 lines vs 60,173), so it is the English of
# record here, with Manmohan Singh kept as a genuinely different voice.
#
# The local database keeps all 11 regardless - this only trims what is
# published. Pass --translations to change it.
DEFAULT_TRANSLATIONS = ("en.bdb", "pu.ss", "en.ms")
DEFAULT_TRANSLITS = ("en",)

# Fields the published site does not need to carry.
#
# `larivaar` is dropped because it is exactly the Gurmukhi line with its
# spaces removed - verified across all 142,405 lines - so the browser derives
# it for free. `visraam` (pause markers) is dropped because the reading view
# does not render them yet; drop this entry when it does.
_DROP_VERSE_FIELDS = ("gurmukhi_ascii", "first_letters_ascii",
                      "larivaar_ascii", "larivaar", "visraam")


def _slim_verse(v: dict, keep_tr: set[tuple[str, str]], keep_tl: set[str]) -> dict:
    for field in _DROP_VERSE_FIELDS:
        v.pop(field, None)
    for code in ("en", "hi", "ipa", "ur"):
        if code not in keep_tl:
            v.pop(f"translit_{code}", None)
    tr = v.get("translation") or {}
    v["translation"] = {
        lang: kept
        for lang, block in tr.items()
        if (kept := {k: t for k, t in block.items() if (lang, k) in keep_tr})
    }
    return v


def _clean(text) -> str:
    """Make a value safe for a TSV cell without altering its words."""
    if text is None:
        return ""
    return str(text).replace("\t", " ").replace("\r", " ").replace("\n", " ")


def build_static(out_dir: Path | None = None, include_text: bool = True,
                 translations: tuple[str, ...] = DEFAULT_TRANSLATIONS,
                 translits: tuple[str, ...] = DEFAULT_TRANSLITS) -> Path:
    from app.server import Api, SEARCH_MODES

    out = Path(out_dir) if out_dir else config.ROOT / "site"
    data = out / "data"
    (data / "shabads").mkdir(parents=True, exist_ok=True)
    (data / "banis").mkdir(parents=True, exist_ok=True)

    api = Api()
    started = time.monotonic()
    keep_tr = {tuple(t.split(".", 1)) for t in translations}
    keep_tl = set(translits)
    print(f"  carrying translations: {', '.join(sorted(translations))}")
    print(f"  carrying transliterations: {', '.join(sorted(translits))}\n")

    # -- 1. the app shell -------------------------------------------------
    html = (config.ROOT / "app" / "index.html").read_text(encoding="utf-8")
    marker = "<!--STATIC_CONFIG-->"
    if marker not in html:
        raise SystemExit("app/index.html is missing the STATIC_CONFIG marker")
    html = html.replace(
        marker,
        '<script>window.GURBANI_STATIC = {base: "data/"};</script>')
    (out / "index.html").write_text(html, encoding="utf-8")

    # The stylesheets and ES modules ship as they are - no bundling, so what
    # runs in production is the same source you edit.
    for folder in ("css", "js", "fonts", "icons"):
        src = config.ROOT / "app" / folder
        dst = out / folder
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(src, dst, ignore=shutil.ignore_patterns("__pycache__"))
    for single in ("icon.svg", "khanda.svg", "manifest.webmanifest"):
        shutil.copy2(config.ROOT / "app" / single, out / single)

    # The service worker carries a build stamp, so a new deployment lands in a
    # fresh cache and the previous one is dropped on activate.
    build_id = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    sw = (config.ROOT / "app" / "sw.js").read_text(encoding="utf-8")
    (out / "sw.js").write_text(sw.replace("__BUILD__", build_id), encoding="utf-8")
    print(f"  sw.js                build {build_id}")
    n_assets = sum(1 for f in ("css", "js", "fonts", "icons")
                   for _ in (out / f).rglob("*")) + 3
    print(f"  css + js + fonts + icons  {n_assets} files")
    # Tell GitHub Pages not to run Jekyll over 13,000 JSON files.
    (out / ".nojekyll").write_text("")

    # -- 2. metadata ------------------------------------------------------
    meta = api.meta()
    meta["modes"] = SEARCH_MODES
    meta["static"] = True
    meta["translators"] = [t for t in meta.get("translators", [])
                           if f"{t['lang']}.{t['translator']}" in set(translations)]
    meta["published_streams"] = {"translations": list(translations),
                                 "transliterations": list(translits)}
    (data / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8")
    print(f"  meta.json            {(data / 'meta.json').stat().st_size / 1024:,.0f} KB")

    # -- 3. the search index ----------------------------------------------
    rows = api.query("""
        SELECT verse_id, shabad_id, source_id, page_no, line_no,
               writer_id, raag_id, first_letters_ascii, gurmukhi
        FROM verses ORDER BY verse_id""")
    with (data / "lines.tsv").open("w", encoding="utf-8") as fh:
        for r in rows:
            fh.write("\t".join((
                str(r["verse_id"]), str(r["shabad_id"] or 0),
                r["source_id"] or "", str(r["page_no"] or 0),
                str(r["line_no"] or 0), str(r["writer_id"] or 0),
                str(r["raag_id"] or 0), _clean(r["first_letters_ascii"]),
                _clean(r["gurmukhi"]))) + "\n")
    index_bytes = (data / "lines.tsv").stat().st_size
    print(f"  lines.tsv            {index_bytes / 1e6:,.1f} MB ({len(rows):,} lines)")

    # Re-write meta with the index size, so the loading bar is honest rather
    # than a guess (gzip hides the real length from Content-Length).
    meta["index_bytes"] = index_bytes
    (data / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8")

    # -- 4. English tier, loaded only on demand ---------------------------
    if include_text:
        text_rows = api.query("""
            SELECT v.verse_id, v.translit_en,
                   (SELECT text FROM translations t WHERE t.verse_id = v.verse_id
                      AND t.lang = 'en' AND t.translator = 'bdb') AS en
            FROM verses v ORDER BY v.verse_id""")
        with (data / "text-en.tsv").open("w", encoding="utf-8") as fh:
            for r in text_rows:
                fh.write(f"{r['verse_id']}\t{_clean(r['translit_en'])}"
                         f"\t{_clean(r['en'])}\n")
        print(f"  text-en.tsv          "
              f"{(data / 'text-en.tsv').stat().st_size / 1e6:,.1f} MB (lazy)")

    # -- 5. one file per shabad -------------------------------------------
    ids = [r["shabad_id"] for r in
           api.query("SELECT shabad_id FROM shabads ORDER BY shabad_id")]
    total = 0
    for n, sid in enumerate(ids, 1):
        payload = api.shabad(sid)
        if isinstance(payload, tuple):          # (body, status) on error
            continue
        for v in payload.get("verses", []):
            _slim_verse(v, keep_tr, keep_tl)
        d = data / "shabads" / str(sid // SHARD)
        d.mkdir(exist_ok=True)
        p = d / f"{sid}.json"
        p.write_text(json.dumps(payload, ensure_ascii=False,
                                separators=(",", ":")), encoding="utf-8")
        total += p.stat().st_size
        if n % 2000 == 0 or n == len(ids):
            print(f"    shabads {n:,}/{len(ids):,}", end="\r", flush=True)
    print(f"  shabads/             {total / 1e6:,.1f} MB "
          f"({len(ids):,} files)          ")

    # -- 6. one file per bani ---------------------------------------------
    bani_ids = [r["bani_id"] for r in
                api.query("SELECT bani_id FROM banis ORDER BY bani_id")]
    btotal = 0
    for bid in bani_ids:
        payload = api.bani(bid)
        if isinstance(payload, tuple):
            continue
        for v in payload.get("verses", []):
            v.pop("larivaar", None)
        p = data / "banis" / f"{bid}.json"
        p.write_text(json.dumps(payload, ensure_ascii=False,
                                separators=(",", ":")), encoding="utf-8")
        btotal += p.stat().st_size
    print(f"  banis/               {btotal / 1e6:,.1f} MB ({len(bani_ids)} files)")

    # -- 7. a README so the published repo explains itself ----------------
    (out / "README.md").write_text(f"""# GurbaniSearch

A static Gurbani search built from [BaniDB](https://github.com/KhalisFoundation/banidb-api),
the database behind [SikhiToTheMax](https://www.sikhitothemax.org).

{meta['totals']['verses']:,} lines · {meta['totals']['shabads']:,} shabads ·
{meta['totals']['translations']:,} translations.

There is no server and no build step. `index.html` loads `data/lines.tsv`
once and searches it in the browser; each shabad is a small JSON file fetched
on demand.

Generated by [the GurbaniSearch harness](https://github.com/KhalisFoundation)
on {time.strftime('%Y-%m-%d')}.

The texts are the work of the Khalis Foundation and the translators credited
in `data/meta.json`; this site only reorganises them.
""", encoding="utf-8")

    size = sum(f.stat().st_size for f in out.rglob("*") if f.is_file())
    print(f"\n  site: {out}  —  {size / 1e6:,.1f} MB total, "
          f"built in {time.monotonic() - started:.0f}s")
    return out
