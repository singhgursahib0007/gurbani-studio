"""Integrity checks. A dataset you cannot audit is a dataset you cannot trust.

`verify` runs structural checks offline. With ``--online`` it additionally
cross-checks our locally recomputed first-letter index against the live BaniDB
API: we ask both for the same first-letter query and compare the verse ids
they return. That is the real test of whether our reconstruction of BaniDB's
`FirstLetterStr` column is faithful, since the API never exposes that column.
"""
from __future__ import annotations

import json
import random
import sqlite3
import urllib.parse
import urllib.request

from . import config
from .gurmukhi import first_letters_ascii, first_letters_from_ascii


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{config.DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


class Report:
    def __init__(self) -> None:
        self.ok = True
        self.lines: list[str] = []

    def check(self, name: str, passed: bool, detail: str = "") -> None:
        mark = "PASS" if passed else "FAIL"
        self.ok &= passed
        self.lines.append(f"  [{mark}] {name}" + (f" - {detail}" if detail else ""))

    def info(self, text: str) -> None:
        self.lines.append(f"         {text}")

    def render(self) -> None:
        print("\n".join(self.lines))
        print(f"\n{'ALL CHECKS PASSED' if self.ok else 'SOME CHECKS FAILED'}")


def verify(online: bool = False) -> bool:
    if not config.DB_PATH.exists():
        print(f"no database at {config.DB_PATH}; run `build` first")
        return False
    conn = _connect()
    q = lambda sql, *a: conn.execute(sql, a).fetchone()[0]   # noqa: E731
    r = Report()

    print("Structural checks")
    n_verses = q("SELECT count(*) FROM verses")
    r.check("verses present", n_verses > 50_000, f"{n_verses:,} verses")

    blanks = conn.execute(
        "SELECT verse_id, source_id FROM verses "
        "WHERE gurmukhi IS NULL OR gurmukhi = ''").fetchall()
    # BaniDB itself publishes a couple of empty rows in Dasam Bani. We keep
    # them (dropping rows would silently change verse ids) but they must stay
    # rare and accounted for.
    r.check("blank lines are only the known upstream blanks", len(blanks) <= 5,
            f"{len(blanks)} blank: " +
            ", ".join(f"{b['verse_id']}({b['source_id']})" for b in blanks[:5]))

    orphan = q("""SELECT count(*) FROM verses v LEFT JOIN shabads s
                  ON v.shabad_id = s.shabad_id
                  WHERE v.shabad_id IS NOT NULL AND s.shabad_id IS NULL""")
    r.check("no verse points at a missing shabad", orphan == 0, f"{orphan} orphans")

    orphan_t = q("""SELECT count(*) FROM translations t LEFT JOIN verses v
                    ON t.verse_id = v.verse_id WHERE v.verse_id IS NULL""")
    r.check("no translation points at a missing verse", orphan_t == 0)

    blank_b = q("SELECT count(*) FROM bani_verses WHERE gurmukhi IS NULL OR gurmukhi=''")
    r.check("every bani line carries its own text", blank_b == 0, f"{blank_b} blank")

    # The two id spaces must stay apart: a bani line's BaniDB id is NOT a
    # verses.verse_id, and conflating them corrupts translations wholesale.
    bleed = q("""SELECT count(*) FROM bani_verses b JOIN verses v
                 ON v.verse_id = b.banidb_bani_verse_id
                 WHERE v.gurmukhi = b.gurmukhi""")
    total_b = q("SELECT count(*) FROM bani_verses")
    r.check("bani ids are kept in their own space",
            total_b > 0 and bleed < total_b * 0.01,
            f"{bleed} of {total_b} bani ids coincide with a same-text verse "
            f"(expected near zero - the spaces are unrelated)")

    undoc = q("""SELECT count(DISTINCT t.lang || '.' || t.translator)
                 FROM translations t LEFT JOIN translators d
                 ON d.lang = t.lang AND d.translator = t.translator
                 WHERE d.name IS NULL""")
    r.check("every translation stream is documented", undoc == 0,
            f"{undoc} undocumented")

    # SGGS is the one corpus whose shape is externally known.
    sggs_pages = q("SELECT max(page_no) FROM verses WHERE source_id='G'")
    r.check("SGGS spans 1430 angs", sggs_pages == 1430, f"max ang {sggs_pages}")
    sggs_lines = q("SELECT count(*) FROM verses WHERE source_id='G'")
    r.check("SGGS line count in the expected range",
            57_000 <= sggs_lines <= 63_000, f"{sggs_lines:,} lines")

    print("\nFirst-letter index checks")
    blank = q("""SELECT count(*) FROM verses
                 WHERE (first_letters_ascii IS NULL OR first_letters_ascii='')
                 AND length(gurmukhi) > 12""")
    r.check("substantial lines all have first letters", blank == 0,
            f"{blank} blank")

    # Independent second opinion: derive the same index from the ASCII column
    # instead of the Unicode one and require the two routes to agree.
    rows = conn.execute(
        "SELECT verse_id, gurmukhi, gurmukhi_ascii, first_letters_ascii "
        "FROM verses WHERE gurmukhi_ascii != '' AND gurmukhi != ''").fetchall()
    disagree, untokenised = [], []
    for r_ in rows:
        if first_letters_from_ascii(r_["gurmukhi_ascii"]) == r_["first_letters_ascii"]:
            continue
        # A handful of upstream lines tokenise differently in the two columns
        # (a hyphen in one, a space in the other), so the two derivations
        # cannot agree. Those are upstream inconsistencies, not index errors.
        if len(r_["gurmukhi"].split()) != len(r_["gurmukhi_ascii"].split()):
            untokenised.append(r_["verse_id"])
        else:
            disagree.append(r_["verse_id"])
    r.check("Unicode-derived and ASCII-derived first letters agree",
            not disagree,
            f"{len(disagree):,} of {len(rows):,} lines disagree" +
            (f" (e.g. {disagree[:5]})" if disagree else ""))
    if untokenised:
        r.info(f"{len(untokenised)} line(s) word-split differently in the "
               f"Unicode and ASCII columns upstream: {untokenised[:5]}")

    # The derivation must be reproducible from the stored text.
    sample = conn.execute(
        "SELECT verse_id, gurmukhi, first_letters_ascii FROM verses "
        "ORDER BY random() LIMIT 3000").fetchall()
    bad = [row["verse_id"] for row in sample
           if first_letters_ascii(row["gurmukhi"]) != row["first_letters_ascii"]]
    r.check("first letters reproducible from stored Gurmukhi", not bad,
            f"{len(bad)} of {len(sample)} sampled disagree")

    over = q("""SELECT count(*) FROM verses WHERE gurmukhi != '' AND
                length(first_letters_ascii) >
                length(gurmukhi) - length(replace(gurmukhi, ' ', '')) + 1""")
    r.check("first letters never outnumber the words", over == 0, f"{over} lines")

    # A line whose every token begins with punctuation ("॥ਇਤ॥") legitimately
    # yields no first letters, exactly as it would in BaniDB. But a line with
    # a word that *starts* with a letter must produce one.
    from .gurmukhi import first_letter_of_word, normalize

    rows = conn.execute(
        "SELECT verse_id, gurmukhi FROM verses "
        "WHERE first_letters = '' AND gurmukhi != ''").fetchall()
    missing = [r_["verse_id"] for r_ in rows
               if any(first_letter_of_word(w)
                      for w in normalize(r_["gurmukhi"]).split())]
    r.check("every line with a letter-initial word yields first letters",
            not missing, f"{len(missing)} lines {missing[:5]}")

    print("\nFull-text index checks")
    fts_n = q("SELECT count(*) FROM verses_fts")
    r.check("FTS row count matches verses", fts_n == n_verses,
            f"{fts_n:,} vs {n_verses:,}")

    if online:
        print("\nCross-check against the live BaniDB API")
        _online_check(conn, r)

    conn.close()
    r.render()
    return r.ok


def _api(path: str) -> dict:
    url = f"{config.BANIDB_BASE}/{path}"
    req = urllib.request.Request(url, headers={"User-Agent": config.USER_AGENT})
    with urllib.request.urlopen(req, timeout=45) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _online_check(conn: sqlite3.Connection, r: Report, trials: int = 12) -> None:
    """Do we return the same verses BaniDB does for a first-letter query?"""
    random.seed(11)
    rows = conn.execute(
        "SELECT first_letters_ascii FROM verses WHERE source_id='G' "
        "AND length(first_letters_ascii) >= 6 ORDER BY random() LIMIT ?",
        (trials,)).fetchall()

    agree = disagree = 0
    for row in rows:
        query = row["first_letters_ascii"][:5]
        try:
            remote = _api(
                f"search/{urllib.parse.quote(query)}"
                f"?searchtype=0&source=G&results=20")
        except Exception as exc:                        # noqa: BLE001
            r.info(f"query {query!r}: API unreachable ({exc}); skipped")
            continue
        remote_ids = {v["verseId"] for v in remote.get("verses", [])}
        if not remote_ids:
            continue
        local_ids = {
            x[0] for x in conn.execute(
                "SELECT verse_id FROM verses WHERE source_id='G' "
                "AND first_letters_ascii LIKE ? ORDER BY verse_id LIMIT 400",
                (query + "%",)).fetchall()
        }
        missing = remote_ids - local_ids
        if missing:
            disagree += 1
            r.info(f"query {query!r}: {len(missing)} of {len(remote_ids)} "
                   f"API results missing locally")
        else:
            agree += 1
    r.check("local first-letter search reproduces BaniDB results",
            disagree == 0 and agree > 0,
            f"{agree} queries agreed, {disagree} disagreed")


def stats() -> None:
    """Human-readable corpus summary."""
    if not config.DB_PATH.exists():
        print(f"no database at {config.DB_PATH}; run `build` first")
        return
    conn = _connect()
    print(f"\n\033[1mGurbaniSearch corpus\033[0m  ({config.DB_PATH})")
    prov = dict(conn.execute("SELECT key, value FROM provenance").fetchall())
    print(f"built {prov.get('built_at')} by harness {prov.get('harness_version')}\n")

    print(f"{'source':<38} {'verses':>8} {'shabads':>8} {'angs':>6}")
    print("-" * 64)
    for row in conn.execute("""
        SELECT s.source_id, s.english, count(v.verse_id) verses,
               count(DISTINCT v.shabad_id) shabads, max(v.page_no) angs
        FROM sources s LEFT JOIN verses v ON v.source_id = s.source_id
        GROUP BY s.source_id ORDER BY verses DESC"""):
        print(f"{row['source_id']} {row['english'][:35]:<36} "
              f"{row['verses']:>8,} {row['shabads']:>8,} {row['angs'] or 0:>6}")
    total = conn.execute("SELECT count(*) FROM verses").fetchone()[0]
    unassigned = conn.execute(
        "SELECT count(*) FROM verses WHERE source_id IS NULL").fetchone()[0]
    print("-" * 64)
    print(f"{'TOTAL':<38} {total:>8,}" +
          (f"   ({unassigned:,} without a source)" if unassigned else ""))

    print("\ntranslations")
    for row in conn.execute("""
        SELECT t.lang, t.translator, d.name, count(*) n
        FROM translations t LEFT JOIN translators d
          ON d.lang=t.lang AND d.translator=t.translator
        GROUP BY 1,2 ORDER BY n DESC"""):
        print(f"  {row['lang']}.{row['translator']:<5} "
              f"{(row['name'] or '?')[:38]:<40} {row['n']:>8,}")

    print("\ntransliterations")
    for code, col in (("en", "translit_en"), ("hi", "translit_hi"),
                      ("ipa", "translit_ipa"), ("ur", "translit_ur")):
        n = conn.execute(
            f"SELECT count(*) FROM verses WHERE {col} IS NOT NULL AND {col} != ''"
        ).fetchone()[0]
        print(f"  {code:<5} {n:>8,}")

    print("\ncollections")
    for label, sql in (
        ("banis", "SELECT count(*) FROM banis"),
        ("bani lines", "SELECT count(*) FROM bani_verses"),
        ("amrit keertan entries", "SELECT count(*) FROM amritkeertan_index"),
        ("rehat maryadas", "SELECT count(*) FROM rehat_maryadas"),
        ("rehat lines", "SELECT count(*) FROM rehat_lines"),
        ("writers", "SELECT count(*) FROM writers"),
        ("raags", "SELECT count(*) FROM raags"),
    ):
        print(f"  {label:<24} {conn.execute(sql).fetchone()[0]:>8,}")
    conn.close()
    print()
