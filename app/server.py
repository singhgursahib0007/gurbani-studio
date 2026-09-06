"""A local, dependency-free search server over data/processed/gurbani.sqlite.

Why a server at all, rather than a single HTML file? Because a browser cannot
read a 200 MB SQLite file from ``file://``, and shipping the corpus as JSON
into the page would mean loading the whole thing to search it. A 200-line
stdlib server keeps the data on disk and the queries in SQLite, where they
belong - the page stays fast and the database stays the single source of
truth.

The search modes deliberately mirror SikhiToTheMax's own, including the two
first-letter modes that make its Gurmukhi keyboard useful.
"""
from __future__ import annotations

import json
import re
import sqlite3
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from harness import config                                    # noqa: E402
from harness.gurmukhi import (                                 # noqa: E402
    ASCII_TO_DISPLAY, KEYBOARD_ROWS, LETTER_NAMES, SEARCHABLE_CHARS,
    is_ascii_query, unicode_query_to_ascii,
)

APP_DIR = Path(__file__).resolve().parent

SEARCH_MODES = {
    "first-letters":          "First letters, from the start of the line",
    "first-letters-anywhere": "First letters, anywhere in the line",
    "gurmukhi":               "Full word, Gurmukhi",
    "romanized":              "Full word, romanised transliteration",
    "english":                "Full word, English translation",
    "main-letters":           "Main letters (vowel signs ignored)",
    "ang":                    "Go to an ang (page)",
}


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{config.DB_PATH}?mode=ro", uri=True,
                           check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def _glob_escape(text: str) -> str:
    """Neutralise GLOB's wildcards. The Gurmukhi alphabet contains none of
    these, but a query can arrive from anywhere."""
    out = []
    for ch in text:
        out.append(f"[{ch}]" if ch in "*?[]" else ch)
    return "".join(out)


def _fts_escape(text: str) -> str:
    """Quote each term so user punctuation cannot break FTS5 syntax.

    The final term gets a prefix wildcard, so results appear while the user is
    still typing - "sathigu" finds "sathigur" - which is what makes the
    search feel live rather than all-or-nothing.
    """
    terms = [t for t in re.split(r"\s+", text.strip()) if t]
    if not terms:
        return '""'
    quoted = ['"' + t.replace('"', '""') + '"' for t in terms]
    quoted[-1] += "*"
    return " ".join(quoted)


class Api:
    def __init__(self) -> None:
        self.conn = _db()
        self.lock = threading.Lock()

    def query(self, sql: str, params: tuple = ()) -> list[dict]:
        with self.lock:
            return [dict(r) for r in self.conn.execute(sql, params).fetchall()]

    # -- endpoints ---------------------------------------------------------
    def meta(self) -> dict:
        prov = {r["key"]: r["value"]
                for r in self.query("SELECT key, value FROM provenance")}
        return {
            "sources": self.query(
                "SELECT s.source_id, s.english, s.unicode, "
                "       (SELECT count(*) FROM verses v "
                "          WHERE v.source_id=s.source_id) AS verses, "
                "       (SELECT max(page_no) FROM verses v "
                "          WHERE v.source_id=s.source_id) AS angs "
                "FROM sources s ORDER BY verses DESC"),
            "writers": self.query(
                "SELECT writer_id, english, unicode FROM writers "
                "WHERE english IS NOT NULL ORDER BY writer_id"),
            "translators": self.query(
                "SELECT lang, translator, name, description FROM translators"),
            "banis": self.query(
                "SELECT bani_id, unicode, english, verse_count FROM banis "
                "ORDER BY bani_id"),
            "modes": SEARCH_MODES,
            "keyboard": [
                [{"ascii": ch, "unicode": ASCII_TO_DISPLAY[ch],
                  "name": LETTER_NAMES.get(ASCII_TO_DISPLAY[ch], "")}
                 for ch in row] for row in KEYBOARD_ROWS
            ],
            "provenance": json.loads(prov.get("sources", "{}")),
            "built_at": prov.get("built_at"),
            "totals": {
                "verses": self.query("SELECT count(*) n FROM verses")[0]["n"],
                "shabads": self.query("SELECT count(*) n FROM shabads")[0]["n"],
                "translations":
                    self.query("SELECT count(*) n FROM translations")[0]["n"],
            },
        }

    def search(self, q: str, mode: str, source: str, limit: int) -> dict:
        q = q.strip()
        if not q:
            return {"mode": mode, "query": q, "count": 0, "results": []}

        where, params, order = [], [], "v.verse_id"
        join = ""
        note = None

        if source and source != "all":
            where.append("v.source_id = ?")
            params.append(source)

        if mode in ("first-letters", "first-letters-anywhere", "main-letters"):
            # Accept the query typed either as ASCII font characters or as
            # Unicode Gurmukhi letters; both fold to the ASCII form we index.
            key = q if is_ascii_query(q) else unicode_query_to_ascii(q)
            key = "".join(ch for ch in key if ch in SEARCHABLE_CHARS)
            if not key:
                return {"mode": mode, "query": q, "count": 0, "results": [],
                        "note": "no Gurmukhi letters in that query"}
            # GLOB, not LIKE. SQLite's LIKE is case-insensitive for ASCII,
            # but in the legacy Gurmukhi encoding case *is* the letter:
            # j is ਜ and J is ਝ, k is ਕ and K is ਖ. Matching case-insensitively
            # silently returns lines that begin with different letters
            # altogether. GLOB compares byte for byte, which is what BaniDB
            # itself does with LIKE BINARY.
            if mode == "main-letters":
                where.append("v.main_letters GLOB ?")
                params.append(f"*{_glob_escape(q)}*")
            else:
                esc = _glob_escape(key)
                pattern = f"{esc}*" if mode == "first-letters" else f"*{esc}*"
                where.append("v.first_letters_ascii GLOB ?")
                params.append(pattern)
            note = f"letters: {key}"

        elif mode == "gurmukhi":
            # Same reasoning: the ASCII column is case-significant.
            g = _glob_escape(q)
            where.append("(v.gurmukhi GLOB ? OR v.gurmukhi_ascii GLOB ?)")
            params += [f"*{g}*", f"*{g}*"]

        elif mode in ("english", "romanized"):
            col = "translation_en" if mode == "english" else "translit_en"
            join = "JOIN verses_fts f ON f.rowid = v.verse_id"
            where.append("verses_fts MATCH ?")
            params.append(f"{col} : {_fts_escape(q)}")
            order = "bm25(verses_fts)"

        elif mode == "ang":
            m = re.search(r"\d+", q)
            if not m:
                return {"mode": mode, "query": q, "count": 0, "results": [],
                        "note": "enter an ang number"}
            where.append("v.page_no = ?")
            params.append(int(m.group()))
            order = "v.line_no, v.verse_id"

        else:
            return {"error": f"unknown mode {mode!r}",
                    "modes": list(SEARCH_MODES)}, 400

        clause = " AND ".join(where)
        sql = f"""
            SELECT v.verse_id, v.shabad_id, v.source_id, v.page_no, v.line_no,
                   v.gurmukhi, v.first_letters_ascii, v.translit_en,
                   w.english AS writer, r.english AS raag,
                   (SELECT text FROM translations t WHERE t.verse_id=v.verse_id
                      AND t.lang='en' AND t.translator='bdb') AS translation_en
            FROM verses v
            {join}
            LEFT JOIN writers w ON w.writer_id = v.writer_id
            LEFT JOIN raags   r ON r.raag_id   = v.raag_id
            WHERE {clause}
            ORDER BY {order}
            LIMIT ?"""
        rows = self.query(sql, tuple(params) + (limit,))

        count_sql = f"SELECT count(*) n FROM verses v {join} WHERE {clause}"
        total = self.query(count_sql, tuple(params))[0]["n"]
        return {"mode": mode, "query": q, "count": total,
                "shown": len(rows), "note": note, "results": rows}

    def shabad(self, shabad_id: int) -> dict:
        info = self.query("""
            SELECT s.*, src.english AS source_english, src.unicode AS source_unicode,
                   w.english AS writer, w.unicode AS writer_unicode,
                   r.english AS raag, r.unicode AS raag_unicode
            FROM shabads s
            LEFT JOIN sources src ON src.source_id = s.source_id
            LEFT JOIN writers w ON w.writer_id = s.writer_id
            LEFT JOIN raags   r ON r.raag_id   = s.raag_id
            WHERE s.shabad_id = ?""", (shabad_id,))
        if not info:
            return {"error": "no such shabad"}, 404
        verses = self.query("""
            SELECT verse_id, page_no, line_no, gurmukhi, gurmukhi_ascii,
                   larivaar, first_letters_ascii, translit_en, translit_hi,
                   translit_ipa, translit_ur, visraam
            FROM verses WHERE shabad_id = ? ORDER BY verse_id""", (shabad_id,))
        ids = [v["verse_id"] for v in verses]
        trans = self.query(
            "SELECT verse_id, lang, translator, text FROM translations "
            f"WHERE verse_id IN ({','.join('?' * len(ids))})", tuple(ids)
        ) if ids else []
        by_verse: dict[int, dict] = {}
        for t in trans:
            by_verse.setdefault(t["verse_id"], {}) \
                    .setdefault(t["lang"], {})[t["translator"]] = t["text"]
        for v in verses:
            v["translation"] = by_verse.get(v["verse_id"], {})
            v["visraam"] = json.loads(v["visraam"]) if v["visraam"] else None
        # neighbouring shabads, for previous/next navigation
        nav = self.query("""
            SELECT
              (SELECT max(shabad_id) FROM shabads
                 WHERE source_id = ? AND shabad_id < ?) AS prev,
              (SELECT min(shabad_id) FROM shabads
                 WHERE source_id = ? AND shabad_id > ?) AS next""",
            (info[0]["source_id"], shabad_id, info[0]["source_id"], shabad_id))
        return {"shabad": info[0], "verses": verses, "nav": nav[0]}

    def ang(self, source: str, page: int) -> dict:
        verses = self.query("""
            SELECT v.verse_id, v.shabad_id, v.line_no, v.gurmukhi, v.translit_en,
                   (SELECT text FROM translations t WHERE t.verse_id=v.verse_id
                      AND t.lang='en' AND t.translator='bdb') AS translation_en
            FROM verses v WHERE v.source_id = ? AND v.page_no = ?
            ORDER BY v.line_no, v.verse_id""", (source, page))
        max_ang = self.query(
            "SELECT max(page_no) n FROM verses WHERE source_id = ?",
            (source,))[0]["n"]
        return {"source": source, "ang": page, "max_ang": max_ang,
                "verses": verses}

    def bani(self, bani_id: int) -> dict:
        info = self.query("SELECT * FROM banis WHERE bani_id = ?", (bani_id,))
        if not info:
            return {"error": "no such bani"}, 404
        # Bani lines carry their own text: BaniDB numbers bani verses in a
        # different id space from angs, so they are not joined to `verses`.
        verses = self.query("""
            SELECT seq, is_header, paragraph, exists_sgpc, exists_taksal,
                   exists_medium, exists_buddhadal,
                   gurmukhi, larivaar, translit_en,
                   (SELECT text FROM bani_translations t
                      WHERE t.bani_id = b.bani_id AND t.seq = b.seq
                        AND t.lang = 'en' AND t.translator = 'bdb'
                   ) AS translation_en,
                   (SELECT text FROM bani_translations t
                      WHERE t.bani_id = b.bani_id AND t.seq = b.seq
                        AND t.lang = 'pu' AND t.translator = 'ss'
                   ) AS translation_pu
            FROM bani_verses b WHERE b.bani_id = ? ORDER BY b.seq""", (bani_id,))
        return {"bani": info[0], "verses": verses}


class Handler(BaseHTTPRequestHandler):
    api: Api = None            # set in serve()
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):    # quieter than the default
        if "/api/" in (args[0] if args else ""):
            sys.stderr.write("  %s\n" % (fmt % args))

    def _send(self, payload, status: int = 200, ctype="application/json") -> None:
        if isinstance(payload, tuple):
            payload, status = payload
        body = (json.dumps(payload, ensure_ascii=False).encode("utf-8")
                if ctype == "application/json" else payload)
        self.send_response(status)
        self.send_header("Content-Type", f"{ctype}; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:                                  # noqa: N802
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        qs = parse_qs(parsed.query)
        one = lambda k, d="": qs.get(k, [d])[0]                # noqa: E731

        try:
            if path in ("/", "/index.html"):
                html = (APP_DIR / "index.html").read_bytes()
                return self._send(html, ctype="text/html")

            # The UI is split into CSS and ES modules, so serve those too.
            if path == "/sw.js":
                f = APP_DIR / "sw.js"
                if f.is_file():
                    body = f.read_bytes().replace(b"__BUILD__", b"dev")
                    return self._send(body, ctype="text/javascript")
                return self._send({"error": "not found"}, 404)

            if path in ("/icon.svg", "/khanda.svg", "/manifest.webmanifest"):
                f = APP_DIR / path.lstrip("/")
                kind = ("image/svg+xml" if path.endswith(".svg")
                        else "application/manifest+json")
                if f.is_file():
                    return self._send(f.read_bytes(), ctype=kind)
                return self._send({"error": "not found"}, 404)

            if re.fullmatch(r"/icons/[\w.\-]+", path) and ".." not in path:
                f = (APP_DIR / path.lstrip("/")).resolve()
                if f.is_file() and APP_DIR in f.parents:
                    kind = "image/x-icon" if f.suffix == ".ico" else "image/png"
                    return self._send(f.read_bytes(), ctype=kind)
                return self._send({"error": "not found"}, 404)

            if re.fullmatch(r"/(css|js|fonts)/[\w./-]+", path) and ".." not in path:
                asset = (APP_DIR / path.lstrip("/")).resolve()
                if asset.is_file() and APP_DIR in asset.parents:
                    kind = {"css": "text/css",
                            "js": "text/javascript",
                            "fonts": "font/woff2"}[path.split("/")[1]]
                    return self._send(asset.read_bytes(), ctype=kind)
                return self._send({"error": "not found"}, 404)

            if path == "/api/meta":
                return self._send(self.api.meta())

            if path == "/api/search":
                return self._send(self.api.search(
                    one("q"), one("mode", "first-letters"),
                    one("source", "all"),
                    max(1, min(500, int(one("limit", "100") or 100)))))

            if m := re.fullmatch(r"/api/shabad/(\d+)", path):
                return self._send(self.api.shabad(int(m.group(1))))

            if m := re.fullmatch(r"/api/ang/([A-Za-z])/(\d+)", path):
                return self._send(self.api.ang(m.group(1).upper(),
                                               int(m.group(2))))

            if m := re.fullmatch(r"/api/bani/(\d+)", path):
                return self._send(self.api.bani(int(m.group(1))))

            self._send({"error": "not found", "path": path}, 404)
        except BrokenPipeError:
            pass
        except Exception as exc:                               # noqa: BLE001
            self._send({"error": f"{type(exc).__name__}: {exc}"}, 500)


def serve(port: int = 8080, open_browser: bool = True) -> None:
    if not config.DB_PATH.exists():
        print(f"no database at {config.DB_PATH}\n"
              f"run:  python3 -m harness fetch  &&  python3 -m harness build")
        return
    Handler.api = Api()
    totals = Handler.api.meta()["totals"]
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = f"http://127.0.0.1:{port}/"
    print(f"\n  GurbaniSearch  -  {totals['verses']:,} verses, "
          f"{totals['translations']:,} translations")
    print(f"  serving {config.DB_PATH.name} at {url}")
    print("  press Ctrl-C to stop\n")
    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopped")


if __name__ == "__main__":
    serve(port=int(sys.argv[1]) if len(sys.argv) > 1 else 8080)
