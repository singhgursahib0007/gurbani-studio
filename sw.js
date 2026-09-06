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

const BUILD = "20260906-054948";
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
  "./js/main.js",
  "./js/store.js",
  "./js/data.js",
  "./js/ui.js",
  "./js/icons.js",
  "./js/gurmukhi.js",
  "./js/banis-info.js",
  "./js/views/sidebar.js",
  "./js/views/list.js",
  "./js/views/reader.js",
  "./js/views/settings.js",
  "./fonts/SantLipi.woff2",
  "./icon.svg",
  "./khanda.svg",
  "./manifest.webmanifest",
  "./data/meta.json",
];

const BIG = /\/data\/(lines|text-en)\.tsv$/;

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
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
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

  if (BIG.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then((hit) => {
        const net = fetch(req).then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
          return res;
        });
        return hit || net;
      }),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(() => hit);
      return hit || net;
    }),
  );
});
