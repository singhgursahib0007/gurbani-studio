# Offline

Every shabad, every bani and the search index, on this device — so reading,
first-letter search and projector mode work with no connection.

Related: [DEPLOY](DEPLOY.md) for the service worker and the build it ships
with · [PROJECTOR](PROJECTOR.md) for the hall, where this matters most ·
[DECISIONS](DECISIONS.md) for the bugs this found · [ARCHITECTURE](ARCHITECTURE.md)
for where it sits.

## For the person using it

**Settings → Offline → Download**, or the same control in the projector's
**Look** tab. About **25 MB** crosses the network; it unpacks to **113 MB** on
the device. A bar shows progress, the sidebar's corner shows the percentage
while you do other things, and it can be paused and resumed.

Once it reads **Ready offline**, everything works with the connection gone. The
sidebar corner then shows a cloud with a tick; with no connection it reads
**Offline**, in gold if you are covered and red if you are not.

Do it at home, not at the gurdwara. That is the whole point of the feature: a
hall with no signal is the wrong moment to find out which shabads you have.

## Why it is built the way it is

The service worker already kept whatever you happened to open. That is not
offline in any useful sense — it is a cache of the past, and the shabad the
ragi starts next is, by definition, one you have not opened. So this is a
deliberate download of everything, and each part of how it works is there to
stop a specific way that goes wrong.

### Packs, not thirteen thousand requests

The site serves one JSON file per shabad, which is right for reading online.
For downloading everything it is wrong: 13,331 requests is minutes of round
trips, and on a weak connection some fail. So the build *also* publishes the
corpus as **44 packs** — one per shard of 500 shabads, eight for the banis —
described by `data/offline.json`.

The app unpacks each pack into the Cache API **under the original file URLs**.
The service worker then answers `data/shabads/1/681.json` from that cache, so
nothing that reads a shabad knows offline mode exists. Packs carry each file
as a raw string, so the browser stores them without parsing and re-serialising
13,000 shabads.

### The cache is the record

Progress is not kept in `localStorage`, where it could disagree with what is
really stored. Each pack writes a marker into the cache *after* all its files
are in; the whole set writes a final marker only after it has been counted.
Clear the site's data and the record goes with it, because they are the same
thing.

### Resumable

Pause it, lose the connection, close the lid — packs that already have their
marker are skipped next time. A pack interrupted half way has no marker, so it
is fetched again whole rather than trusted. Tested: paused at 44% after 9
packs, resumed, and the remaining 36 were fetched — 45 in all, none twice.

### Verified twice

Every pack is checked against its **SHA-256** from the manifest before a byte of
it is stored, so a captive portal's login page, a truncated transfer or a
proxy that rewrote something is retried, not saved. Then the finished cache is
**counted** — 13,331 files plus 44 markers — before it is called ready.

### Space first, and asked to keep it

`navigator.storage.estimate()` is consulted before starting, and the download
refuses up front, with the numbers, if the browser will not allow the room.
`navigator.storage.persist()` is requested on the click that starts it, since
some browsers only grant it in answer to a gesture. Whether it was granted is
shown: browsers may clear unprotected storage when the disk runs low, and
installing the app (Add to Dock in Safari, Install in Chrome) is what reliably
protects it.

### Versioned by the texts, not by the build

The cache is named for a hash of the packs' hashes: `gurbani-studio-data-78e9b9443fc9`.
It changes when the texts change and not otherwise — two separate builds of
the same corpus give the same version — so deploying new CSS does not ask
anyone to download 100 MB again.

When the texts *do* change, Settings says an update is available, and **the
old copy keeps working until the new one is complete**. During an update there
are two caches; the service worker reads them in creation order, so the older,
complete one answers first. Only when the new one is counted and marked is the
old one deleted.

### A laptop that sleeps stops downloading

A Screen Wake Lock is held for the length of the download, where the browser
supports one.

## When something is not downloaded

With no copy and no connection, opening a shabad says so — **Not available
offline**, and where to fix it — instead of leaving "Opening…" on the screen
for ever. In the projector the message goes to the operator's panel, not over
the Gurbani the hall is looking at, and the slide on screen stays where it is.
Search says it needs its index.

## The service worker, in short

| Request | Served from |
|---|---|
| A page navigation | network, falling back to the cached shell |
| `data/packs/*`, `data/offline.json` | network only — the page stores these itself; letting them through the worker would store every pack twice |
| `data/meta.json` | the shell cache, refreshed each deploy |
| any other `data/…` | the offline copy if it holds it, else as before |
| everything else | the shell cache, revalidated in the background |

On activate, the worker deletes **only its own old shell caches**. Not the
offline copy, and not anything else on the origin — see the next section.

## Two apps, one origin

On GitHub Pages both apps live at `singhgursahib0007.github.io`, and an origin
has one Cache API. Both service workers used to delete "every cache that is not
mine" on activate, so each app's update wiped the other's caches — and would
have wiped a downloaded offline copy every time the phone app was published.
Each now deletes only caches matching its own name. On Vercel the desktop app
has an origin of its own, which is one reason to prefer that address.

## Proven, not assumed

Driven in real headless Chrome over the DevTools protocol, with the local
server **killed** after the download, not merely flagged offline: the app
loaded from cache with all 104 banis; shabad 681 opened with its 11 verses;
Rehras Sahib opened with all 530 lines; `jmTAq` found ਜੋ ਮਾਗਹਿ ਠਾਕੁਰ ਅਪੁਨੇ ਤੇ
ਸੋਈ ਸੋਈ ਦੇਵੈ ॥; projector mode ran. A simulated new deploy replaced the shell
cache and left the offline copy untouched.

## Where it lives

| | |
|---|---|
| `harness/static_site.py` | `_write_offline_packs` — the packs and `offline.json` |
| `app/js/offline.js` | the controller: check, download, verify, resume, remove |
| `app/js/views/offline-panel.js` | the control in Settings and Look, and the sidebar chip |
| `app/sw.js` | serving from the offline copy, and keeping it across deploys |
