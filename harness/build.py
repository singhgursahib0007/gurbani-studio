"""Normalise the raw cache into one well-shaped SQLite database.

Design decisions worth knowing:

* **The raw cache is the source of truth.** This step is a pure function of
  ``data/raw`` - deleting the database and rebuilding always reproduces the
  same result, offline. Nothing is fetched here.
* **Everything is kept.** Every translation, every transliteration scheme,
  every visraam (pause) set is preserved verbatim, in its own row rather than
  flattened into a blob, so nothing has to be re-derived later.
* **Both scripts, always.** Each text is stored in Unicode Gurmukhi *and* in
  the legacy ASCII font encoding, because BaniDB's search semantics are
  defined over the ASCII form and STTM-style keyboards emit it.
* **Search columns are derived, not guessed.** ``first_letters_ascii`` is
  recomputed from the Unicode text (see harness/gurmukhi.py) to reproduce
  BaniDB's ``FirstLetterStr`` column, which the public API does not expose.
"""
from __future__ import annotations

import json
import sqlite3
import time
from typing import Any, Iterable

from . import config
from .gurmukhi import first_letters_ascii, first_letters_unicode, main_letters
from .net import iter_cached

RAW = config.RAW_BANIDB

# Who each translation key actually is. Documented in the database itself so
# the exports are self-describing.
TRANSLATORS = [
    ("en", "bdb", "BaniDB English",
     "BaniDB's own corrected English translation."),
    ("en", "ms", "Manmohan Singh",
     "English translation published by the SGPC (8 volumes)."),
    ("en", "ssk", "Dr. Sant Singh Khalsa",
     "The widely circulated English translation."),
    ("pu", "ss", "Prof. Sahib Singh",
     "Sri Guru Granth Darpan - the standard Punjabi exegesis (10 volumes)."),
    ("pu", "ft", "Faridkot Teeka",
     "The classical Punjabi commentary (Faridkot Wala Teeka)."),
    ("pu", "bdb", "BaniDB Punjabi",
     "BaniDB's own Punjabi translation."),
    ("pu", "ms", "Manmohan Singh (Punjabi)",
     "Punjabi half of the SGPC bilingual edition."),
    ("pu", "pss", "Prof. Sahib Singh - padd arth",
     "Word-by-word glossary (padd arth) rather than a running translation: "
     "each difficult word given with its meaning."),
    ("hi", "ss", "Sahib Singh (Hindi)",
     "Hindi rendering of the Sahib Singh exegesis."),
    ("hi", "sts", "Sant Singh (Hindi)",
     "Hindi translation attributed to Sant Singh."),
    ("es", "sn", "SikhNet Spanish",
     "Spanish translation by the SikhNet team."),
]

TRANSLIT_SCHEMES = [
    ("en", "Roman", "Romanised transliteration used by SikhiToTheMax."),
    ("hi", "Devanagari", "Hindi/Devanagari transliteration."),
    ("ipa", "IPA", "International Phonetic Alphabet."),
    ("ur", "Shahmukhi", "Perso-Arabic (Shahmukhi) transliteration."),
]

SCHEMA = """
PRAGMA journal_mode = WAL;

CREATE TABLE sources (
  source_id   TEXT PRIMARY KEY,   -- G, D, B, S, A, N, R
  gurmukhi    TEXT,               -- legacy ASCII font encoding
  unicode     TEXT,
  english     TEXT,
  page_count  INTEGER
);

CREATE TABLE writers (
  writer_id INTEGER PRIMARY KEY,
  gurmukhi  TEXT, unicode TEXT, english TEXT
);

CREATE TABLE raags (
  raag_id INTEGER PRIMARY KEY,
  gurmukhi TEXT, unicode TEXT, english TEXT, raag_with_page TEXT
);

CREATE TABLE shabads (
  shabad_id   INTEGER PRIMARY KEY,
  source_id   TEXT REFERENCES sources(source_id),
  writer_id   INTEGER REFERENCES writers(writer_id),
  raag_id     INTEGER REFERENCES raags(raag_id),
  page_no     INTEGER,
  shabad_name TEXT,
  verse_count INTEGER,
  first_verse_id INTEGER,
  last_verse_id  INTEGER
);

CREATE TABLE verses (
  verse_id  INTEGER PRIMARY KEY,
  shabad_id INTEGER REFERENCES shabads(shabad_id),
  source_id TEXT REFERENCES sources(source_id),
  page_no   INTEGER,
  line_no   INTEGER,
  writer_id INTEGER REFERENCES writers(writer_id),
  raag_id   INTEGER REFERENCES raags(raag_id),

  gurmukhi        TEXT,   -- Unicode Gurmukhi, padh chhedh (word separated)
  gurmukhi_ascii  TEXT,   -- same line in the legacy ASCII font encoding
  larivaar        TEXT,   -- Unicode, words joined (larivaar style)
  larivaar_ascii  TEXT,

  first_letters       TEXT,  -- Unicode, one letter per word
  first_letters_ascii TEXT,  -- BaniDB-compatible FirstLetterStr
  main_letters        TEXT,  -- consonant skeleton, vowel signs stripped

  translit_en  TEXT, translit_hi TEXT, translit_ipa TEXT, translit_ur TEXT,
  visraam      TEXT,   -- JSON: pause markers from sttm / sttm2 / igurbani
  updated      TEXT
);

CREATE TABLE translations (
  verse_id   INTEGER REFERENCES verses(verse_id),
  lang       TEXT,   -- en | pu | es
  translator TEXT,   -- bdb | ms | ssk | ss | ft | sn
  text       TEXT,   -- Unicode
  text_ascii TEXT,   -- legacy encoding, where the source provides one
  PRIMARY KEY (verse_id, lang, translator)
) WITHOUT ROWID;

CREATE TABLE translators (
  lang TEXT, translator TEXT, name TEXT, description TEXT,
  PRIMARY KEY (lang, translator)
) WITHOUT ROWID;

CREATE TABLE translit_schemes (
  code TEXT PRIMARY KEY, name TEXT, description TEXT
);

CREATE TABLE banis (
  bani_id INTEGER PRIMARY KEY,
  gurmukhi TEXT, unicode TEXT, english TEXT, hindi TEXT, ipa TEXT, shahmukhi TEXT,
  source_id TEXT, writer_id INTEGER, raag_id INTEGER, verse_count INTEGER
);

-- Bani lines carry their own text rather than pointing into `verses`.
--
-- This is deliberate and load-bearing: BaniDB's /banis endpoint numbers its
-- verses in a DIFFERENT id space from /angs. Bani verseId 12 is the ੴ line,
-- while ang verseId 12 is a quite different line. Treating the two as one id
-- space silently attaches the wrong translation to thousands of lines, so the
-- two spaces are kept apart and `banidb_bani_verse_id` is named to say so.
CREATE TABLE bani_verses (
  bani_id  INTEGER REFERENCES banis(bani_id),
  seq      INTEGER,
  banidb_bani_verse_id INTEGER,   -- id in BaniDB's bani space, NOT verses.verse_id
  gurmukhi TEXT, gurmukhi_ascii TEXT, larivaar TEXT,
  first_letters TEXT, first_letters_ascii TEXT,
  translit_en TEXT, translit_hi TEXT, translit_ipa TEXT, translit_ur TEXT,
  is_header INTEGER,        -- heading level, 0 for a normal line
  mangal_position TEXT,
  paragraph INTEGER,
  -- which maryada (tradition) includes this line in its recitation
  exists_sgpc INTEGER, exists_medium INTEGER,
  exists_taksal INTEGER, exists_buddhadal INTEGER,
  PRIMARY KEY (bani_id, seq)
) WITHOUT ROWID;

CREATE TABLE bani_translations (
  bani_id INTEGER, seq INTEGER, lang TEXT, translator TEXT, text TEXT,
  PRIMARY KEY (bani_id, seq, lang, translator)
) WITHOUT ROWID;

CREATE TABLE amritkeertan_headers (
  header_id INTEGER PRIMARY KEY, gurmukhi TEXT, unicode TEXT, english TEXT
);

CREATE TABLE amritkeertan_index (
  index_id  INTEGER PRIMARY KEY,
  header_id INTEGER REFERENCES amritkeertan_headers(header_id),
  shabad_id INTEGER,
  source_id TEXT, page_no INTEGER, ang INTEGER, line_no INTEGER,
  writer_id INTEGER, writer_english TEXT,
  gurmukhi TEXT, gurmukhi_ascii TEXT,
  first_letters_ascii TEXT,
  translit_en TEXT, translation_en TEXT
);

CREATE TABLE rehat_maryadas (
  rehat_id INTEGER PRIMARY KEY, name TEXT, alphabet TEXT, chapter_count INTEGER
);

CREATE TABLE rehat_chapters (
  rehat_id INTEGER, chapter_id INTEGER, name TEXT, alphabet TEXT,
  content_html TEXT,       -- the chapter as published, markup intact
  PRIMARY KEY (rehat_id, chapter_id)
) WITHOUT ROWID;

CREATE TABLE rehat_lines (
  rehat_id INTEGER, chapter_id INTEGER, seq INTEGER,
  text TEXT,               -- one paragraph, markup stripped, for reading
  PRIMARY KEY (rehat_id, chapter_id, seq)
) WITHOUT ROWID;

CREATE TABLE provenance (key TEXT PRIMARY KEY, value TEXT);
"""

INDEXES = """
CREATE INDEX idx_verses_shabad   ON verses(shabad_id);
CREATE INDEX idx_verses_source   ON verses(source_id, page_no, line_no);
CREATE INDEX idx_verses_page     ON verses(page_no);
CREATE INDEX idx_verses_writer   ON verses(writer_id);
CREATE INDEX idx_verses_raag     ON verses(raag_id);
-- prefix index for "first letters from the start of the line" search
CREATE INDEX idx_verses_fl       ON verses(first_letters_ascii);
CREATE INDEX idx_trans_lookup    ON translations(lang, translator);
CREATE INDEX idx_ak_shabad       ON amritkeertan_index(shabad_id);
CREATE INDEX idx_shabads_source  ON shabads(source_id, page_no);
"""

FTS = """
CREATE VIRTUAL TABLE verses_fts USING fts5(
  gurmukhi, translit_en, translation_en, translation_pu,
  content='', tokenize='unicode61 remove_diacritics 2'
);
"""


# --- small helpers ---------------------------------------------------------
def _txt(node: Any, key: str) -> str | None:
    if isinstance(node, dict):
        v = node.get(key)
        return v if isinstance(v, str) else None
    return None


def _int(v: Any) -> int | None:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


class Builder:
    """Accumulates rows in memory, then writes them in one transaction.

    The whole corpus is well under a million rows, so a single batched write
    is both simpler and far faster than streaming inserts.
    """

    def __init__(self) -> None:
        self.verses: dict[int, dict] = {}
        self.translations: dict[tuple[int, str, str], tuple] = {}
        self.shabads: dict[int, dict] = {}
        self.writers: dict[int, tuple] = {}
        self.raags: dict[int, tuple] = {}
        self.sources: dict[str, list] = {}
        self.counts: dict[str, int] = {}

    # -- verse ingestion ---------------------------------------------------
    def add_verse(self, v: dict, source_id: str | None = None,
                  shabad_id: int | None = None) -> int | None:
        vid = _int(v.get("verseId"))
        if vid is None:
            return None

        gur_uni = _txt(v.get("verse"), "unicode") or ""
        gur_asc = _txt(v.get("verse"), "gurmukhi") or ""
        writer = v.get("writer") or {}
        raag = v.get("raag") or {}
        wid, rid = _int(writer.get("writerId")), _int(raag.get("raagId"))

        row = {
            "verse_id": vid,
            "shabad_id": _int(v.get("shabadId")) or shabad_id,
            "source_id": source_id,
            "page_no": _int(v.get("pageNo")),
            "line_no": _int(v.get("lineNo")),
            "writer_id": wid,
            "raag_id": rid,
            "gurmukhi": gur_uni,
            "gurmukhi_ascii": gur_asc,
            "larivaar": _txt(v.get("larivaar"), "unicode"),
            "larivaar_ascii": _txt(v.get("larivaar"), "gurmukhi"),
            "translit_en": _txt(v.get("transliteration"), "en"),
            "translit_hi": _txt(v.get("transliteration"), "hi"),
            "translit_ipa": _txt(v.get("transliteration"), "ipa"),
            "translit_ur": _txt(v.get("transliteration"), "ur"),
            "visraam": json.dumps(v.get("visraam"), ensure_ascii=False)
            if v.get("visraam") else None,
            "updated": v.get("updated"),
        }

        prev = self.verses.get(vid)
        if prev is None:
            self.verses[vid] = row
        else:
            # Merge: a verse seen via /angs carries source, writer and raag;
            # the same verse seen inside a bani does not. Never overwrite a
            # known value with a missing one.
            #
            # Only *source* fields are merged. The search columns are derived
            # from the final text in `_derive` below, because an empty derived
            # value is a real answer - a line of pure punctuation genuinely
            # has no first letters - and merging would let one record's index
            # be filled in from a different record's text.
            for k, val in row.items():
                if val not in (None, "") and prev.get(k) in (None, ""):
                    prev[k] = val

        if wid and wid not in self.writers:
            self.writers[wid] = (wid, writer.get("gurmukhi"),
                                 writer.get("unicode"), writer.get("english"))
        if rid and rid not in self.raags:
            self.raags[rid] = (rid, raag.get("gurmukhi"), raag.get("unicode"),
                               raag.get("english"), raag.get("raagWithPage"))

        self._add_translations(vid, v.get("translation") or {})
        return vid

    def _add_translations(self, vid: int, tr: dict) -> None:
        for lang, block in tr.items():
            if not isinstance(block, dict):
                continue
            for translator, val in block.items():
                if isinstance(val, str):
                    text, ascii_text = val, None
                elif isinstance(val, dict):
                    text = val.get("unicode")
                    ascii_text = val.get("gurmukhi")
                else:
                    continue
                if not text and not ascii_text:
                    continue
                self.translations[(vid, lang, translator)] = (
                    vid, lang, translator, text, ascii_text
                )


# --- loaders ---------------------------------------------------------------
def load_metadata(b: Builder) -> None:
    for key, data in iter_cached(RAW, "meta"):
        name = key.rsplit("/", 1)[-1]
        rows = data.get("rows", data) if isinstance(data, dict) else data
        if name == "sources":
            for r in rows:
                b.sources[r["SourceID"]] = [
                    r["SourceID"], r.get("SourceGurmukhi"),
                    r.get("SourceUnicode"), r.get("SourceEnglish"), None,
                ]
        elif name == "writers":
            for r in rows:
                wid = _int(r.get("WriterID"))
                if wid:
                    b.writers[wid] = (wid, r.get("WriterGurmukhi"),
                                      r.get("WriterUnicode"), r.get("WriterEnglish"))
        elif name == "raags":
            for r in rows:
                rid = _int(r.get("RaagID"))
                if rid:
                    b.raags[rid] = (rid, r.get("RaagGurmukhi"), r.get("RaagUnicode"),
                                    r.get("RaagEnglish"), r.get("RaagWithPage"))


def load_angs(b: Builder) -> None:
    n = 0
    for _key, data in iter_cached(RAW, "angs"):
        src = (data.get("source") or {}).get("sourceId")
        if src and src in b.sources:
            page = _int((data.get("source") or {}).get("pageNo"))
            if page:
                cur = b.sources[src][4] or 0
                b.sources[src][4] = max(cur, page)
        for v in data.get("page") or []:
            if b.add_verse(v, source_id=src) is not None:
                n += 1
    b.counts["verses_from_angs"] = n


def load_shabads(b: Builder) -> None:
    n = 0
    for _key, data in iter_cached(RAW, "shabads"):
        info = data.get("shabadInfo") or {}
        verses = data.get("verses") or []
        if not verses:
            continue
        sid = _int(info.get("shabadId"))
        src = (info.get("source") or {}).get("sourceId")
        ids: list[int] = []
        for v in verses:
            vid = b.add_verse(v, source_id=src, shabad_id=sid)
            if vid:
                ids.append(vid)
        if sid:
            b.shabads[sid] = {
                "shabad_id": sid,
                "source_id": src,
                "writer_id": _int((info.get("writer") or {}).get("writerId")),
                "raag_id": _int((info.get("raag") or {}).get("raagId")),
                "page_no": _int(info.get("pageNo")),
                "shabad_name": str(info.get("shabadName"))
                if info.get("shabadName") is not None else None,
                "verse_count": len(ids),
                "first_verse_id": min(ids) if ids else None,
                "last_verse_id": max(ids) if ids else None,
            }
        n += len(ids)
    b.counts["verses_from_shabads"] = n


def load_banis(b: Builder, conn: sqlite3.Connection) -> None:
    """The nitnem banis, kept in their own id space (see the schema comment)."""
    for key, data in iter_cached(RAW, "banis"):
        if key.endswith("_index"):
            continue
        info = data.get("baniInfo") or {}
        bid = _int(info.get("baniID"))
        if not bid:
            continue
        rows, trans = [], []
        for seq, entry in enumerate(data.get("verses") or []):
            inner = entry.get("verse") or {}
            uni = _txt(inner.get("verse"), "unicode") or ""
            tl = inner.get("transliteration") or {}
            rows.append((
                bid, seq, _int(inner.get("verseId")),
                uni, _txt(inner.get("verse"), "gurmukhi"),
                _txt(inner.get("larivaar"), "unicode"),
                first_letters_unicode(uni), first_letters_ascii(uni),
                _txt(tl, "en"), _txt(tl, "hi"), _txt(tl, "ipa"), _txt(tl, "ur"),
                _int(entry.get("header")) or 0,
                entry.get("mangalPosition"), _int(entry.get("paragraph")),
                _int(entry.get("existsSGPC")), _int(entry.get("existsMedium")),
                _int(entry.get("existsTaksal")), _int(entry.get("existsBuddhaDal")),
            ))
            for lang, block in (inner.get("translation") or {}).items():
                if not isinstance(block, dict):
                    continue
                for translator, val in block.items():
                    text = val if isinstance(val, str) else (
                        val.get("unicode") if isinstance(val, dict) else None)
                    if text:
                        trans.append((bid, seq, lang, translator, text))
        conn.execute(
            "INSERT OR REPLACE INTO banis VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (bid, info.get("gurmukhi"), info.get("unicode"), info.get("english"),
             info.get("hindi"), info.get("ipa"), info.get("ur"),
             (info.get("source") or {}).get("sourceId"),
             _int((info.get("writer") or {}).get("writerId")),
             _int((info.get("raag") or {}).get("raagId")), len(rows)),
        )
        conn.executemany(
            "INSERT OR REPLACE INTO bani_verses VALUES " +
            "(" + ",".join("?" * 19) + ")", rows)
        conn.executemany(
            "INSERT OR REPLACE INTO bani_translations VALUES (?,?,?,?,?)", trans)
    b.counts["banis"] = conn.execute("SELECT count(*) FROM banis").fetchone()[0]


def load_amritkeertan(b: Builder, conn: sqlite3.Connection) -> None:
    headers = {}
    for key, data in iter_cached(RAW, "amritkeertan"):
        if key.endswith("_headers"):
            for h in data.get("headers") or []:
                hid = _int(h.get("HeaderID"))
                if hid:
                    headers[hid] = (hid, h.get("Gurmukhi"), h.get("GurmukhiUni"),
                                    (h.get("Translations") or {}).get("en")
                                    if isinstance(h.get("Translations"), dict) else None)
    conn.executemany("INSERT OR REPLACE INTO amritkeertan_headers VALUES (?,?,?,?)",
                     headers.values())

    rows = {}
    for key, data in iter_cached(RAW, "amritkeertan"):
        entries = data.get("index") if isinstance(data, dict) else None
        if not entries:
            continue
        for r in entries:
            iid = _int(r.get("IndexID"))
            if iid is None:
                continue
            uni = r.get("GurmukhiUni") or ""
            tl = r.get("Transliterations") or {}
            tr = r.get("Translations") or {}
            en = tr.get("en") if isinstance(tr, dict) else None
            if isinstance(en, dict):
                en = en.get("bdb") or next(iter(en.values()), None)
            rows[iid] = (
                iid, _int(r.get("HeaderID")), _int(r.get("ShabadID")),
                r.get("SourceID"), _int(r.get("PageNo")), _int(r.get("Ang")),
                _int(r.get("LineNo")), _int(r.get("WriterID")), r.get("WriterEnglish"),
                uni, r.get("Gurmukhi"), first_letters_ascii(uni),
                tl.get("en") if isinstance(tl, dict) else None, en,
            )
    conn.executemany(
        "INSERT OR REPLACE INTO amritkeertan_index VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        rows.values())
    b.counts["amritkeertan_index"] = len(rows)


def load_rehats(b: Builder, conn: sqlite3.Connection) -> None:
    """Codes of conduct.

    Each chapter arrives as a single HTML blob rather than as verses, so we
    keep the markup verbatim in `rehat_chapters.content_html` and also store a
    plain-text, one-paragraph-per-row rendering in `rehat_lines` for reading
    and searching.
    """
    maryadas, chapters, lines = {}, {}, []
    for key, data in iter_cached(RAW, "rehats"):
        if key.endswith("_index"):
            for m in data.get("maryadas") or []:
                rid = _int(m.get("rehatID"))
                maryadas[rid] = [rid, m.get("rehatName"), m.get("alphabet"), 0]
        elif key.endswith("_chapters"):
            rid = _int(data.get("rehatID"))
            for ch in data.get("chapters") or []:
                cid = _int(ch.get("chapterID"))
                chapters.setdefault((rid, cid), [rid, cid, ch.get("chapterName"),
                                                 ch.get("alphabet"), None])
        else:
            rid = _int(data.get("rehatID"))
            for ch in data.get("chapters") or []:
                cid = _int(ch.get("chapterID"))
                html = ch.get("chapterContent") or ""
                row = chapters.setdefault(
                    (rid, cid), [rid, cid, ch.get("chapterName"),
                                 ch.get("alphabet"), None])
                row[2] = row[2] or ch.get("chapterName")
                row[4] = html
                for seq, para in enumerate(_html_paragraphs(html)):
                    lines.append((rid, cid, seq, para))

    for (rid, _cid) in chapters:
        if rid in maryadas:
            maryadas[rid][3] += 1
    conn.executemany("INSERT OR REPLACE INTO rehat_maryadas VALUES (?,?,?,?)",
                     [tuple(v) for v in maryadas.values()])
    conn.executemany("INSERT OR REPLACE INTO rehat_chapters VALUES (?,?,?,?,?)",
                     [tuple(v) for v in chapters.values()])
    conn.executemany("INSERT OR REPLACE INTO rehat_lines VALUES (?,?,?,?)", lines)
    b.counts["rehat_lines"] = len(lines)


def _html_paragraphs(html: str) -> list[str]:
    """Split a chapter blob on line breaks and strip tags, keeping the words."""
    import html as _html
    import re

    text = re.sub(r"<\s*br\s*/?\s*>", "\n", html, flags=re.I)
    text = re.sub(r"<\s*/?\s*(p|div|li|tr)[^>]*>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = _html.unescape(text)
    return [ln.strip() for ln in text.split("\n") if ln.strip()]


# --- entry point -----------------------------------------------------------
def build(rebuild: bool = False) -> None:
    started = time.monotonic()
    if config.DB_PATH.exists():
        if not rebuild:
            print(f"{config.DB_PATH} exists; pass --rebuild to replace it.")
            return
        for suffix in ("", "-wal", "-shm"):
            p = config.DB_PATH.with_name(config.DB_PATH.name + suffix)
            p.unlink(missing_ok=True)

    conn = sqlite3.connect(config.DB_PATH)
    conn.executescript(SCHEMA)

    b = Builder()
    print("reading raw cache...")
    load_metadata(b)
    load_angs(b)
    load_shabads(b)
    load_banis(b, conn)
    load_amritkeertan(b, conn)
    load_rehats(b, conn)

    # Derive shabad rows for any shabad seen only through the ang walk.
    by_shabad: dict[int, list[int]] = {}
    for v in b.verses.values():
        if v["shabad_id"]:
            by_shabad.setdefault(v["shabad_id"], []).append(v["verse_id"])
    for sid, ids in by_shabad.items():
        if sid in b.shabads:
            continue
        head = b.verses[min(ids)]
        b.shabads[sid] = {
            "shabad_id": sid, "source_id": head["source_id"],
            "writer_id": head["writer_id"], "raag_id": head["raag_id"],
            "page_no": head["page_no"], "shabad_name": None,
            "verse_count": len(ids),
            "first_verse_id": min(ids), "last_verse_id": max(ids),
        }

    # Derive the search columns once, from each verse's settled text.
    for v in b.verses.values():
        text = v.get("gurmukhi") or ""
        v["first_letters"] = first_letters_unicode(text)
        v["first_letters_ascii"] = first_letters_ascii(text)
        v["main_letters"] = main_letters(text)

    print(f"writing {len(b.verses):,} verses, {len(b.translations):,} translations...")
    conn.executemany("INSERT OR REPLACE INTO sources VALUES (?,?,?,?,?)",
                     [tuple(v) for v in b.sources.values()])
    conn.executemany("INSERT OR REPLACE INTO writers VALUES (?,?,?,?)",
                     b.writers.values())
    conn.executemany("INSERT OR REPLACE INTO raags VALUES (?,?,?,?,?)",
                     b.raags.values())
    conn.executemany("INSERT OR REPLACE INTO translators VALUES (?,?,?,?)", TRANSLATORS)
    conn.executemany("INSERT OR REPLACE INTO translit_schemes VALUES (?,?,?)",
                     TRANSLIT_SCHEMES)

    vcols = ["verse_id", "shabad_id", "source_id", "page_no", "line_no", "writer_id",
             "raag_id", "gurmukhi", "gurmukhi_ascii", "larivaar", "larivaar_ascii",
             "first_letters", "first_letters_ascii", "main_letters", "translit_en",
             "translit_hi", "translit_ipa", "translit_ur", "visraam", "updated"]
    conn.executemany(
        f"INSERT OR REPLACE INTO verses ({','.join(vcols)}) "
        f"VALUES ({','.join('?' * len(vcols))})",
        ([v.get(c) for c in vcols] for v in b.verses.values()),
    )
    scols = ["shabad_id", "source_id", "writer_id", "raag_id", "page_no",
             "shabad_name", "verse_count", "first_verse_id", "last_verse_id"]
    conn.executemany(
        f"INSERT OR REPLACE INTO shabads ({','.join(scols)}) "
        f"VALUES ({','.join('?' * len(scols))})",
        ([s.get(c) for c in scols] for s in b.shabads.values()),
    )
    conn.executemany("INSERT OR REPLACE INTO translations VALUES (?,?,?,?,?)",
                     b.translations.values())

    print("building indexes and full-text search...")
    conn.executescript(INDEXES)
    conn.executescript(FTS)
    conn.execute("""
      INSERT INTO verses_fts (rowid, gurmukhi, translit_en,
                              translation_en, translation_pu)
      SELECT v.verse_id, v.gurmukhi, v.translit_en,
             (SELECT group_concat(t.text, ' | ') FROM translations t
                WHERE t.verse_id = v.verse_id AND t.lang = 'en'),
             (SELECT group_concat(t.text, ' | ') FROM translations t
                WHERE t.verse_id = v.verse_id AND t.lang = 'pu')
      FROM verses v
    """)

    conn.executemany(
        "INSERT OR REPLACE INTO provenance VALUES (?,?)",
        [("built_at", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())),
         ("harness_version", __import__("harness").__version__),
         ("sources", json.dumps(config.PROVENANCE, ensure_ascii=False)),
         ("counts", json.dumps(b.counts))],
    )
    conn.commit()
    conn.execute("ANALYZE")
    conn.commit()
    conn.close()
    size = config.DB_PATH.stat().st_size / 1e6
    print(f"built {config.DB_PATH} ({size:.1f} MB) in "
          f"{time.monotonic() - started:.0f}s")
