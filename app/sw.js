/* Service worker — what makes this an app rather than a page.
 *
 * Installed to a home screen, the app has to open and work with no network:
 * on a plane, in a gurdwara basement, on a phone with no data left. So the
 * shell is precached on install, and everything the reader actually opens is
 * kept as they go.
 *
 * Three strategies, chosen per kind of request:
 *
 *   navigation      network first, falling back to the cached shell. A page
 *                   load should always try for the newest build, but must
 *                   never fail just because there is no signal.
 *   big data files  cache first. lines.tsv is megabytes and changes only when
 *                   the corpus is rebuilt; re-downloading it on every visit
 *                   would be indefensible. Revalidated quietly in the
 *                   background.
 *   everything else stale-while-revalidate: instant from cache, refreshed for
 *                   next time.
 *
 * BUILD is replaced at publish time, so a new deployment lands in a new cache
 * and the old one is deleted on activate.
 */

const BUILD = "__BUILD__";
const CACHE = `gurbani-studio-${BUILD}`;

/* Paths are relative so this works both at the site root and under a
 * repository subpath like /gurbani-search/. */
const SHELL = [
  "./",
  "./index.html",
  "./css/tokens.css",
  "./css/shell.css",
  "./css/controls.css",
  "./css/reader.css",
  "./css/projector.css",
  "./js/main.js",
  "./js/store.js",
  "./js/data.js",
  "./js/offline.js",
  "./js/record.js",
  "./js/ui.js",
  "./js/icons.js",
  "./js/gurmukhi.js",
  "./js/banis-info.js",
  "./js/views/sidebar.js",
  "./js/views/list.js",
  "./js/views/reader.js",
  "./js/views/settings.js",
  "./js/views/projector.js",
  "./js/views/offline-panel.js",
  "./fonts/SantLipi.woff2",
  "./fonts/MuktaMahee.woff2",
  "./fonts/MuktaMahee-700.woff2",
  "./fonts/NotoSansGurmukhi.woff2",
  "./fonts/TiroGurmukhi.woff2",
  "./icon.svg",
  "./khanda.svg",
  "./manifest.webmanifest",
  "./data/meta.json",
];

const BIG = /\/data\/(lines|text-en)\.tsv$/;

/* The offline copy of the corpus lives in its own caches, named for the
 * corpus version rather than the build, written by the page (js/offline.js)
 * and only ever read here. Two consequences:
 *
 *   - It survives deploys. A new build replaces the shell cache; the texts do
 *     not change because the CSS did, and deleting 100 MB someone downloaded
 *     on purpose would be indefensible.
 *   - During an update there can be two: the complete old one and a partial
 *     new one. caches.keys() lists in creation order, so the older, complete
 *     copy answers first until the new one finishes and the page deletes the
 *     old. */
const DATA_PREFIX = "gurbani-studio-data-";

/* The packs and their manifest are downloaded by the page straight into the
 * offline cache. Letting them through here as well would store every pack a
 * second time in the shell cache - another 100 MB for nothing. */
const PASS_THROUGH = /\/data\/(packs\/|offline\.json$)/;

async function fromOfflineCopy(req) {
  for (const name of await caches.keys()) {
    if (!name.startsWith(DATA_PREFIX)) continue;
    const hit = await (await caches.open(name)).match(req, { ignoreSearch: true });
    if (hit) return hit;
  }
  return null;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // Two things matter here. addAll is all-or-nothing, so one missing file
      // would leave the app with no cache at all - each entry is added on its
      // own instead. And each is fetched with cache: "reload", to go past the
      // browser's HTTP cache: without it a stale copy sitting in the CDN edge
      // or the browser can be baked into the precache and served for the whole
      // life of this build.
      .then((c) => Promise.all(SHELL.map((u) =>
        fetch(new Request(u, { cache: "reload" }))
          .then((res) => (res.ok ? c.put(u, res) : null))
          .catch(() => null),
      )))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        // Only this app's own old shell caches. Not the offline copy, and not
        // anything else on the origin: on GitHub Pages this app shares
        // singhgursahib0007.github.io with the phone app, and "delete every
        // cache that is not mine" used to delete the other app's caches too.
        keys.filter((k) => k.startsWith("gurbani-studio-") &&
                           !k.startsWith(DATA_PREFIX) && k !== CACHE)
            .map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("./index.html", copy));
          return res;
        })
        .catch(() => caches.match("./index.html").then((r) => r || caches.match("./"))),
    );
    return;
  }

  if (PASS_THROUGH.test(url.pathname)) return;

  // Anything the offline copy holds is served from it: immutable for this
  // corpus version, so there is nothing to revalidate.
  if (url.pathname.includes("/data/") && !url.pathname.endsWith("/meta.json")) {
    event.respondWith(
      fromOfflineCopy(req).then((hit) => hit || fromShell(req, BIG.test(url.pathname))),
    );
    return;
  }

  event.respondWith(fromShell(req, BIG.test(url.pathname)));
});

/* The pre-offline behaviour, unchanged: big files cache-first, everything
 * else stale-while-revalidate. */
function fromShell(req, big) {
  if (big) {
    return caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        return res;
      });
      return hit || net;
    });
  }
  return caches.match(req).then((hit) => {
    const net = fetch(req)
      .then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        return res;
      })
      .catch(() => hit || Response.error());
    return hit || net;
  });
}
