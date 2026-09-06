# Documentation

Seven documents. Each covers one thing, and they link to each other where the
subjects meet.

## Start here

**[ARCHITECTURE](ARCHITECTURE.md)** — the shape of the whole system: four
stages, two rules everything follows, and why the seams are where they are.
Read this first; the rest assume it.

## By what you are doing

| I want to… | Read |
|---|---|
| Understand the interface, or change it | **[DESKTOP](DESKTOP.md)** |
| Query the corpus, or add a field | **[DATASET](DATASET.md)** |
| Change how data is fetched or built | **[HARNESS](HARNESS.md)** |
| Touch anything to do with search or Gurmukhi | **[GURMUKHI](GURMUKHI.md)** |
| Publish, or make the build smaller | **[DEPLOY](DEPLOY.md)** |
| Know why something is the way it is | **[DECISIONS](DECISIONS.md)** |

## The two worth reading whatever you are doing

**[GURMUKHI](GURMUKHI.md)** — the script layer. Two encodings, one of which
stores vowels before the letters they modify and treats case as meaningful.
Every search in the app rests on getting this right, and it is not obvious.

**[DECISIONS](DECISIONS.md)** — the non-obvious calls and the defects behind
them. Each entry exists because the wrong version *looked fine*: translations
attached to the wrong verses, a search returning different letters than asked
for, a panel that closed when you tried to drag a slider in it.

## The rest

**[DESKTOP](DESKTOP.md)** — three panes, the keyboard, immersive reading, and
what is deliberately different from the phone app.

**[DATASET](DATASET.md)** — every table and field of `gurbani.sqlite`, the
eleven translation streams and who made them, and the upstream quirks kept on
purpose.

**[HARNESS](HARNESS.md)** — the ingestion pipeline, the commands, and how to
add a source without breaking the rules in ARCHITECTURE.

**[DEPLOY](DEPLOY.md)** — the static build, what a visit costs in bytes,
offline behaviour, and where the corpus lives (not in `main`).

---

← [Back to the project README](../README.md)
