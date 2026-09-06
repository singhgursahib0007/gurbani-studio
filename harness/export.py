"""Human- and machine-readable exports of the built database.

The SQLite file is the working format, but a dataset should also be readable
by someone with no tooling at all. So we write:

* **JSONL** - one self-contained JSON object per verse, every translation and
  transliteration nested inside it. Stream it with `jq`, load it in pandas,
  feed it to anything.
* **CSV** - a flat table for spreadsheets, with the most-used columns.
* **TXT** - the plain readable text of each source, ang by ang, for reading.

Each run also writes a manifest with row counts and SHA-256 checksums.
"""
from __future__ import annotations

import csv
import hashlib
import json
import sqlite3
import time

from . import config

OUT = config.EXPORTS


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{config.DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _sha256(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _verse_rows(conn: sqlite3.Connection):
    """Yield fully-assembled verse dicts, joined with all their translations."""
    trans: dict[int, dict] = {}
    for row in conn.execute(
            "SELECT verse_id, lang, translator, text, text_ascii FROM translations"):
        node = trans.setdefault(row["verse_id"], {})
        entry = {"text": row["text"]}
        if row["text_ascii"]:
            entry["text_ascii"] = row["text_ascii"]
        node.setdefault(row["lang"], {})[row["translator"]] = entry

    for v in conn.execute("""
        SELECT v.*, s.english AS source_english, s.unicode AS source_unicode,
               w.english AS writer_english, w.unicode AS writer_unicode,
               r.english AS raag_english, r.unicode AS raag_unicode
        FROM verses v
        LEFT JOIN sources s ON s.source_id = v.source_id
        LEFT JOIN writers w ON w.writer_id = v.writer_id
        LEFT JOIN raags   r ON r.raag_id   = v.raag_id
        ORDER BY v.verse_id"""):
        yield {
            "verse_id": v["verse_id"],
            "shabad_id": v["shabad_id"],
            "source": {"id": v["source_id"], "english": v["source_english"],
                       "unicode": v["source_unicode"]},
            "ang": v["page_no"], "line": v["line_no"],
            "writer": {"id": v["writer_id"], "english": v["writer_english"],
                       "unicode": v["writer_unicode"]},
            "raag": {"id": v["raag_id"], "english": v["raag_english"],
                     "unicode": v["raag_unicode"]},
            "gurmukhi": v["gurmukhi"],
            "gurmukhi_ascii": v["gurmukhi_ascii"],
            "larivaar": v["larivaar"],
            "first_letters": v["first_letters"],
            "first_letters_ascii": v["first_letters_ascii"],
            "main_letters": v["main_letters"],
            "transliteration": {k: v[f"translit_{k}"]
                                for k in ("en", "hi", "ipa", "ur")
                                if v[f"translit_{k}"]},
            "translation": trans.get(v["verse_id"], {}),
            "visraam": json.loads(v["visraam"]) if v["visraam"] else None,
            "updated": v["updated"],
        }


def export_jsonl(conn: sqlite3.Connection) -> list:
    path = OUT / "verses.jsonl"
    n = 0
    with path.open("w", encoding="utf-8") as fh:
        for row in _verse_rows(conn):
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
            n += 1
    print(f"  verses.jsonl        {n:>8,} rows")

    extra = []
    for name, sql in (
        ("shabads", "SELECT * FROM shabads ORDER BY shabad_id"),
        ("banis", "SELECT * FROM banis ORDER BY bani_id"),
        ("bani_lines", "SELECT * FROM bani_verses ORDER BY bani_id, seq"),
        ("amritkeertan", "SELECT * FROM amritkeertan_index ORDER BY index_id"),
        ("rehat_lines",
         "SELECT * FROM rehat_lines ORDER BY rehat_id, chapter_id, seq"),
        ("writers", "SELECT * FROM writers ORDER BY writer_id"),
        ("raags", "SELECT * FROM raags ORDER BY raag_id"),
        ("sources", "SELECT * FROM sources ORDER BY source_id"),
        ("translators", "SELECT * FROM translators"),
    ):
        p = OUT / f"{name}.jsonl"
        c = 0
        with p.open("w", encoding="utf-8") as fh:
            for row in conn.execute(sql):
                fh.write(json.dumps(dict(row), ensure_ascii=False) + "\n")
                c += 1
        print(f"  {name + '.jsonl':<20}{c:>8,} rows")
        extra.append(p)
    return [path] + extra


def export_csv(conn: sqlite3.Connection) -> list:
    path = OUT / "verses.csv"
    cols = ["verse_id", "shabad_id", "source_id", "ang", "line",
            "writer_english", "raag_english", "gurmukhi", "gurmukhi_ascii",
            "first_letters_ascii", "translit_en",
            "translation_en_bdb", "translation_pu_ss"]
    n = 0
    with path.open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(cols)
        for row in _verse_rows(conn):
            tr = row["translation"]
            w.writerow([
                row["verse_id"], row["shabad_id"], row["source"]["id"],
                row["ang"], row["line"], row["writer"]["english"],
                row["raag"]["english"], row["gurmukhi"], row["gurmukhi_ascii"],
                row["first_letters_ascii"], row["transliteration"].get("en", ""),
                (tr.get("en", {}).get("bdb") or {}).get("text", ""),
                (tr.get("pu", {}).get("ss") or {}).get("text", ""),
            ])
            n += 1
    print(f"  verses.csv          {n:>8,} rows")
    return [path]


def export_txt(conn: sqlite3.Connection) -> list:
    """Plain readable text, one file per source, grouped by ang."""
    out = []
    d = OUT / "text"
    d.mkdir(exist_ok=True)
    for src in conn.execute(
            "SELECT source_id, english FROM sources ORDER BY source_id"):
        rows = conn.execute("""
            SELECT v.page_no, v.line_no, v.gurmukhi, v.translit_en,
                   (SELECT text FROM translations t WHERE t.verse_id=v.verse_id
                      AND t.lang='en' AND t.translator='bdb') en
            FROM verses v WHERE v.source_id = ?
            ORDER BY v.page_no, v.line_no, v.verse_id""",
            (src["source_id"],)).fetchall()
        if not rows:
            continue
        p = d / f"{src['source_id']}_{src['english'].replace(' ', '_')}.txt"
        with p.open("w", encoding="utf-8") as fh:
            fh.write(f"{src['english']}\n{'=' * len(src['english'])}\n")
            fh.write("Gurmukhi / transliteration / English (BaniDB)\n\n")
            page = None
            for r in rows:
                if r["page_no"] != page:
                    page = r["page_no"]
                    fh.write(f"\n--- Ang {page} ---\n\n")
                fh.write(f"{r['gurmukhi']}\n")
                if r["translit_en"]:
                    fh.write(f"    {r['translit_en']}\n")
                if r["en"]:
                    fh.write(f"    {r['en']}\n")
                fh.write("\n")
        print(f"  text/{p.name:<32}{len(rows):>8,} lines")
        out.append(p)
    return out


def export_all(fmt: str = "all") -> None:
    if not config.DB_PATH.exists():
        print(f"no database at {config.DB_PATH}; run `build` first")
        return
    conn = _connect()
    written = []
    print("exporting to", OUT)
    if fmt in ("all", "jsonl"):
        written += export_jsonl(conn)
    if fmt in ("all", "csv"):
        written += export_csv(conn)
    if fmt in ("all", "txt"):
        written += export_txt(conn)
    conn.close()

    manifest = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "provenance": config.PROVENANCE,
        "files": {
            str(p.relative_to(OUT)): {
                "bytes": p.stat().st_size,
                "sha256": _sha256(p),
            } for p in written
        },
    }
    (OUT / "MANIFEST.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False))
    total = sum(f["bytes"] for f in manifest["files"].values())
    print(f"\nwrote {len(written)} files, {total / 1e6:.1f} MB, "
          f"checksums in {OUT / 'MANIFEST.json'}")
