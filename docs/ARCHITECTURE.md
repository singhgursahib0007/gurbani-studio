# Architecture

How the pieces fit, and why the seams are where they are.

## The shape of it

```
  BaniDB REST API ──┐
                    ├──▶  data/raw/       every upstream response, gzipped
  Shabad OS SQLite ─┘         │
                         build │            pure function, offline
                              ▼
                      data/processed/gurbani.sqlite
                              │
              ┌───────────────┼───────────────┐
              │               │               │
          export           serve           static
              │               │               │
              ▼               ▼               ▼
      JSONL · CSV · txt   local API      site/  →  GitHub Pages
                              │               │
                              └──── app/ ─────┘
                                one interface
```

This repository is standalone: it carries the pipeline, the app and the
documentation, and depends on no other project. The corpus itself is not in
`main` — at 394 MB it exceeds GitHub's 100 MB file limit — but it is fully
reproducible from `harness fetch && harness build`, and the *published* site on
`gh-pages` carries all the data the app reads, so the deployed app depends on
nothing outside its own origin.

| Stage | Command | Reads | Writes |
|---|---|---|---|
| Fetch | `harness fetch` | the network | `data/raw/` |
| Build | `harness build` | `data/raw/` | `data/processed/gurbani.sqlite` |
| Verify | `harness verify` | the database | a pass/fail report |
| Publish | `harness static` | the database + `app/` | `site/` |

A fresh clone needs `fetch` then `build` once (about 25 minutes) before
`serve` and `static` have anything to work with. See
[DEPLOY](DEPLOY.md#where-the-corpus-lives).

## Two rules everything follows

**`data/raw` is the source of truth, and `build` is a pure function of it.**
Delete the database, rebuild, and you get the same bytes back with no network.

**The app has one implementation and two data paths.** `app/index.html` is the
same file whether served by `harness serve` against a local API or published
as static files; it picks its path at runtime from a marker the static build
injects, and `app/js/data.js` presents one interface over both.

## Why no build step in the app

Plain ES modules and CSS custom properties. No bundler, no transpiler, no
lockfile — what runs in production is the source you edit, a stack trace
points at a real line, and there is no toolchain to expire. The cost is a
request per module on a cold load; the service worker caches them after the
first visit.

## Where the interesting problems are

- **[The desktop interface](DESKTOP.md)** — three panes, keyboard-first, and a
  reading column that stays readable on a wide screen.
- **[The script layer](GURMUKHI.md)** — first-letter search means
  reconstructing a column the API does not expose, in an encoding where case
  is meaningful and vowels are written before the letters they modify.
- **[The corpus](DATASET.md)** — two sources, eleven translation streams, and
  an upstream that numbers bani verses in a different id space from ang verses.

## Sizes

| | |
|---|---|
| `data/processed/gurbani.sqlite` | 394 MB, gitignored, rebuildable |
| `site/` | 124 MB across ~13,400 files |
| App source | ~2,300 lines of JS and CSS |
| Harness | ~2,400 lines of Python, no dependencies |
| First page load, published | ~40 KB gzipped |
| Search index, on first search | 4.6 MB gzipped, then cached |
