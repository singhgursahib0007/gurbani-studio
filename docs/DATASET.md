# The corpus

Everything in `data/processed/gurbani.sqlite`, field by field.

Related: [ARCHITECTURE](ARCHITECTURE.md) for how it is produced ·
[HARNESS](HARNESS.md) for the pipeline · [GURMUKHI](GURMUKHI.md) for the
search columns.

## At a glance

| | |
|---|---|
| Lines (verses) | 142,405 |
| Shabads | 13,226 |
| Translations | 820,549 across 11 streams |
| Transliterations | 4 schemes, 142,403 lines each |
| Banis | 104, comprising 25,697 lines |
| Writers | 46 |
| Raags | 66 |
| Amrit Keertan index | 2,675 entries |
| Rehat lines | 2,336 |
| Sources | 7 |
| Database size | ~394 MB |

## Where it comes from

**BaniDB**, stewarded by the Khalis Foundation, is the database behind
SikhiToTheMax. It publishes no SQL dump, so the harness walks its public REST
API exhaustively and keeps every response. It is standardised for *lagamatra*
and *padh chhedh* against the SGPC's published pothis.

**Shabad OS** is downloaded whole as a SQLite release asset and kept as an
independent cross-check — a second project transcribing the same scripture
from different printed sources, so disagreements are visible rather than
invisible.

Both are the work of volunteers. The harness rate-limits itself to well under
BaniDB's published limit, and its on-disk cache means a re-run costs nothing.

## Sources

| id | Source | Lines | Angs |
|---|---|---:|---:|
| `G` | Sri Guru Granth Sahib Ji | 60,403 | 1,430 |
| `D` | Dasam Bani | 68,096 | 1,428 |
| `B` | Bhai Gurdas Ji Vaaran | 10,124 | 40 |
| `N` | Bhai Nand Lal Ji | 2,674 | — |
| `R` | Codes of Conduct and other Panthic sources | 756 | — |
| `S` | Bhai Gurdas Singh Ji Vaaran | 352 | 28 |
| `A` | Amrit Keertan | — | — |

`N` and `R` are not paginated by ang; the harness finds their shabads by
sweeping the shabad-id space (see `harness/providers/banidb.py`).

`A` (Amrit Keertan) holds no lines of its own: it is a 2,675-entry *index*
into shabads that live in the other sources, and is stored as such in
`amritkeertan_index`.

## Tables

### `verses` — one row per line of scripture

| column | meaning |
|---|---|
| `verse_id` | BaniDB's verse id. Stable, and the join key for translations. |
| `shabad_id` | the shabad this line belongs to |
| `source_id` | `G`, `D`, `B`, `S`, `N`, `R` |
| `page_no`, `line_no` | ang and line within it |
| `writer_id`, `raag_id` | → `writers`, `raags` |
| `gurmukhi` | **Unicode** Gurmukhi, padh chhedh (words separated) |
| `gurmukhi_ascii` | the same line in the legacy ASCII font encoding |
| `larivaar`, `larivaar_ascii` | the same line written larivaar (words joined) |
| `first_letters` | one Unicode letter per word — `ਜਕਰਵਮਮ` |
| `first_letters_ascii` | the same in ASCII — `jkrvmm`. **The search index.** |
| `main_letters` | consonant skeleton, vowel signs stripped |
| `translit_en/hi/ipa/ur` | Roman, Devanagari, IPA, Shahmukhi |
| `visraam` | JSON: pause markers from three editorial traditions |
| `updated` | upstream last-modified timestamp |

### `translations` — one row per line **per translator**

Long-form on purpose: adding a translator is a row, not a schema change.

| lang | key | translator | lines |
|---|---|---|---:|
| `pu` | `bdb` | BaniDB Punjabi | 125,552 |
| `pu` | `ss` | Prof. Sahib Singh (*Sri Guru Granth Darpan*) | 125,536 |
| `en` | `bdb` | BaniDB English | 107,843 |
| `es` | `sn` | SikhNet Spanish | 60,389 |
| `hi` | `sts` | Sant Singh (Hindi) | 60,381 |
| `en` | `ssk` | Dr. Sant Singh Khalsa | 60,173 |
| `pu` | `ms` | Manmohan Singh (Punjabi) | 60,110 |
| `en` | `ms` | Manmohan Singh | 60,101 |
| `hi` | `ss` | Sahib Singh (Hindi) | 55,415 |
| `pu` | `ft` | Faridkot Teeka | 54,995 |
| `pu` | `pss` | Prof. Sahib Singh — *padd arth* | 50,054 |

`pu.pss` is not a running translation but a **word glossary**:
`ਹੁਕਮਿ = ਹੁਕਮ ਵਿਚ। ਰਜਾਈ = ਰਜ਼ਾ ਵਾਲਾ, ਅਕਾਲ ਪੁਰਖ।`

Punjabi rows carry both `text` (Unicode) and `text_ascii`; English, Hindi and
Spanish rows carry `text` only. The `translators` table holds these
descriptions inside the database, so exports are self-describing.

### `banis` / `bani_verses` / `bani_translations`

The 104 banis, with per-line flags — `exists_sgpc`, `exists_taksal`,
`exists_medium`, `exists_buddhadal` — recording which tradition recites which
line. `is_header` marks headings, `paragraph` groups lines into pauris.

> **Bani lines are not `verses` rows, by design.**
> BaniDB's `/banis` endpoint numbers its verses in a **different id space**
> from `/angs`: bani verse 12 is the ੴ line, while ang verse 12 is an entirely
> different line. Joining the two spaces silently attaches the wrong
> translation to thousands of lines. So bani lines carry their own text and
> translations, and the upstream id is stored under the deliberately
> unambiguous name `banidb_bani_verse_id`. `harness verify` asserts the two
> spaces stay apart.

### Other tables

- `shabads` — grouping, with writer, raag, ang and verse range
- `sources`, `writers` (46), `raags` (66)
- `amritkeertan_headers`, `amritkeertan_index` — 2,675 entries
- `rehat_maryadas` (4), `rehat_chapters`, `rehat_lines` (2,336) — the codes of
  conduct, kept both as published HTML and as plain paragraphs
- `translators`, `translit_schemes` — the data dictionary, in the data
- `provenance` — build time, harness version, upstream attribution
- `verses_fts` — FTS5 over Gurmukhi, transliteration and translations

## The first-letter index

BaniDB matches first-letter searches against a `FirstLetterStr` column with
`LIKE 'jkr%'` (from the start) or `LIKE '%jkr%'` (anywhere). The public API
never returns that column, so the harness recomputes it — and the whole
search rests on getting this right.

**Letters are taken from the Unicode text, not the ASCII text.** ASCII
Gurmukhi writes the sihari *before* its consonant (`isr` = ਸਿਰ), so `word[0]`
would be the wrong letter there; Unicode is in logical order. Each Unicode
letter is then mapped to its ASCII character, making the column
byte-compatible with BaniDB's own.

Two details that are easy to get wrong, and that the corpus settled:

- **Independent vowels.** Unicode has single codepoints for ਆ, ਇ, ਉ …, but the
  ASCII font writes them as a carrier plus a vowel sign, so the first letter
  is the *carrier*: ਉ ("au") indexes as `a`, ਇ as `e`, ਆ as `A`. ਓ is the
  exception — the font has a precomposed `E`. This mapping was derived by
  aligning both columns across all 136,231 lines word by word; every entry
  held for **100%** of occurrences.
- **Subjoined consonants.** ੍ਰ and ੍ਹ are one character in the ASCII font
  (`R`, `H`) but two codepoints in Unicode, so a virama and the letter after
  it are skipped together.

`E` is worth knowing about: BaniDB indexes ਓ-initial lines under it, but
SikhiToTheMax's own keyboard has no `E` key, so those lines cannot be reached
by first-letter search there. Our keyboard adds the key.

### How it is checked

`python3 -m harness verify` proves the index three independent ways:

1. **Reproducibility** — recomputing from the stored Gurmukhi reproduces the
   stored column.
2. **Two derivations** — the index is derived a second time from the *ASCII*
   column by a completely different code path, and the two must agree on every
   line. They currently agree on 142,403 of 142,403.
3. **Against BaniDB itself** (`--online`) — the same first-letter queries run
   locally and against the live API, and every verse the API returns must also
   be found locally.

## Known upstream quirks

Kept rather than papered over, so the data matches its source:

- Two lines in Dasam Bani (`verse_id` 75028, 105805) are **empty** in BaniDB.
  They are kept, because dropping rows would shift nothing but would hide a
  real gap.
- One line (`verse_id` 402153, Bhai Nand Lal) word-splits differently in the
  Unicode and ASCII columns — a hyphen in one, a space in the other.
- One line (`verse_id` 75906, Dasam Bani) has a stray space mid-word
  (`ਸ ੁਬ੍ਰਿਤ`). It is unreachable by first-letter search in BaniDB itself.

## Exports

`python3 -m harness export` writes `data/exports/` (~460 MB):

| file | rows | what |
|---|---:|---|
| `verses.jsonl` | 142,405 | one JSON object per line, everything nested |
| `verses.csv` | 142,405 | flat table for spreadsheets |
| `shabads`, `banis`, `bani_lines`, `amritkeertan`, `rehat_lines`, `writers`, `raags`, `sources`, `translators` `.jsonl` | — | the remaining tables |
| `text/*.txt` | — | readable Gurmukhi + transliteration + English, ang by ang |
| `MANIFEST.json` | — | SHA-256 checksums and provenance |

A verse in `verses.jsonl`:

```json
{
  "verse_id": 1,
  "shabad_id": 1,
  "source": {"id": "G", "english": "Sri Guru Granth Sahib Ji"},
  "ang": 1, "line": 1,
  "writer": {"id": 1, "english": "Guru Nanak Dev Ji"},
  "raag": {"id": 1, "english": "Jap"},
  "gurmukhi": "ੴ ਸਤਿ ਨਾਮੁ ਕਰਤਾ ਪੁਰਖੁ …",
  "gurmukhi_ascii": "<> siq nwmu krqw purKu …",
  "first_letters": "ਸਨਕਪਨਨਅਮਅਸਗਪ",
  "first_letters_ascii": "snkpnnAmAsgp",
  "transliteration": {"en": "…", "hi": "…", "ipa": "…", "ur": "…"},
  "translation": {"en": {"bdb": {"text": "…"}}, "pu": {"ss": {"text": "…"}}},
  "visraam": {"sttm": [{"p": 3, "t": "v"}]}
}
```
