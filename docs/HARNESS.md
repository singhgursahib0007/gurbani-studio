# The harness

The ingestion pipeline: how the corpus is fetched, built, checked and
published. A short tour, for anyone extending it.

Related: [ARCHITECTURE](ARCHITECTURE.md) for the shape of the whole system ·
[DATASET](DATASET.md) for what comes out · [DECISIONS](DECISIONS.md) for the
bugs these rules exist to prevent.

## The shape

    fetch  ->  data/raw/          (gzipped upstream responses, untouched)
    build  ->  data/processed/    (one normalised SQLite database)
    export ->  data/exports/      (JSONL, CSV, plain text, checksums)
    verify ->  assertions over the built database
    serve  ->  local JSON API + UI

`data/raw` is the source of truth. `build` is a pure function of it, so
deleting the database and rebuilding gives the same bytes back, offline.

## Commands

```bash
python3 -m harness fetch              # download everything (resumable)
python3 -m harness fetch banidb --stage angs
python3 -m harness fetch --force      # ignore the cache and refetch
python3 -m harness build --rebuild    # drop and rebuild the database
python3 -m harness verify --online    # checks, incl. against the live API
python3 -m harness export             # JSONL, CSV, plain text, checksums
python3 -m harness static             # the publishable site
python3 -m harness stats              # corpus summary
python3 -m harness serve --port 8080  # the app, against a local API
```

Nothing beyond the Python standard library is required.

## Adding a source

1. Register it in `harness/config.py`.
2. Add a fetch stage in `harness/providers/` and list it in `STAGES`.
3. Add a loader in `harness/build.py` and call it from `build()`.
4. Add a check in `harness/verify.py` — a source without a check is a source
   nobody will notice breaking.

## Things worth knowing before you change anything

**Be gentle with the API.** BaniDB is run by volunteers and rate-limits to
250 requests/minute per IP. `harness/net.py` holds a shared token bucket at
4 req/s across all workers. Don't raise it. The on-disk cache means a second
run costs nothing, so there is rarely a reason to refetch.

**Two id spaces, not one.** `/angs` and `/shabads` share a verse-id space.
`/banis` does **not** — its verse 12 is the ੴ line, while ang verse 12 is
something else entirely. Merging them attaches the wrong translation to
thousands of lines. Bani lines therefore keep their own text and their
upstream id is named `banidb_bani_verse_id`. `verify` guards this.

**Derived columns are derived once, at the end.** `first_letters_ascii` and
friends are computed in `build()` from each verse's settled text, never merged
field by field between records. An empty derived value is a real answer — a
line of pure punctuation genuinely has no first letters — and merging would
let one record's index be filled in from another record's text.

**The letter tables were measured, not guessed.** The Unicode→ASCII mapping in
`harness/gurmukhi.py` came from aligning both columns of all 136,231 lines
word by word; every entry held for 100% of occurrences. If you change it,
re-run that alignment. `verify` re-derives the whole index by a second,
independent code path and requires the two to agree on every line.

**Keep upstream quirks visible.** Two blank Dasam Bani lines and a couple of
stray-space corruptions are kept as they are, and reported by `verify`, rather
than cleaned up. Silently fixing a source makes it stop matching the source.
