# Publishing

The app is static files. `harness serve` is for development; anything that
serves a folder can host the published build.

```bash
python3 -m harness static          # writes site/
```

~124 MB: the app shell, the search index, one JSON file per shabad, and the
icon set. This repository publishes from a `gh-pages` branch so `main` stays
quick to clone.

```bash
git worktree add /tmp/ghp gh-pages
rsync -a --delete --exclude '.git' site/ /tmp/ghp/
git -C /tmp/ghp add -A && git -C /tmp/ghp commit -m "Publish"
git -C /tmp/ghp push origin gh-pages
git worktree remove /tmp/ghp
```

## What a visit costs

The CDN gzips text, so these are wire sizes:

| | |
|---|---|
| First load | **~40 KB** — shell, four stylesheets, modules, font |
| Opening a bani or shabad | 2–7 KB, cached after |
| First search | **4.6 MB** — the index, once, then cached and offline |

The index loads only when Search is first used, with real progress, so the
bani catalogue is instant on a cold visit.

## Choosing what to publish

The database keeps all eleven translation streams; the published build carries
three. Two of the eleven are near-duplicates — `pu.bdb` matches `pu.ss` on
99.2% of lines, `en.ssk` matches `en.bdb` on 92.7%.

```bash
python3 -m harness static --translations en.bdb,pu.ss,pu.ft --translits en,ur
```

## Offline

`app/sw.js` precaches the shell, then serves by strategy: navigations network
first with the cached shell as fallback; `lines.tsv` cache first, since it is
megabytes and only changes when the corpus is rebuilt; everything else
stale-while-revalidate. `__BUILD__` is stamped at publish time so each
deployment lands in a fresh cache.

Precache entries are fetched with `cache: "reload"`, so a stale copy in a CDN
edge cannot be baked in for the life of a build.

## Installing

Chrome and Edge offer an install button in the address bar; Safari has
**File → Add to Dock**. It opens in its own window with no browser chrome,
which suits the three-pane layout.

## Where the corpus lives

Not in `main`. `gurbani.sqlite` is 394 MB and **GitHub rejects any file over
100 MB**, so the database is gitignored. That splits the repository in two,
deliberately:

- **`main`** carries the pipeline, the app and the documentation — everything
  needed to *produce* the corpus. A clone is under a megabyte.
- **`gh-pages`** carries the published site, including all the data the app
  reads. That is what makes the deployed app standalone: it depends on nothing
  outside its own origin.

To get a working local corpus in a fresh clone:

```bash
python3 -m harness fetch      # ~25 minutes, resumable, polite to the API
python3 -m harness build
```

Or copy `data/processed/gurbani.sqlite` from another checkout — `build` is a
pure function of `data/raw`, so any copy is identical.

## Bandwidth

Pages has a soft ~100 GB/month limit. At ~40 KB a visit that is effectively
unlimited; only a visitor who runs a first search costs meaningfully more.
