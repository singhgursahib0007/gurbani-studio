/* Offline - every shabad, bani and the search index, on this device.
 *
 * The service worker already keeps what you happen to open. This is the other
 * half: fetch the whole corpus on purpose, before you need it, so a gurdwara
 * hall with no signal is not the moment you find out which shabads you have.
 *
 * How it is done, and why each part is there:
 *
 *   Packs, not thirteen thousand requests. The build publishes the corpus as
 *   44 packs listed in data/offline.json (see harness/static_site.py). Each
 *   is unpacked into the Cache API under the ORIGINAL file URLs, so the
 *   service worker answers data/shabads/12/6001.json from it and nothing that
 *   reads a shabad has to know offline exists.
 *
 *   The cache is the record. Progress is not kept in localStorage, where it
 *   could disagree with what is really stored: a marker is written into the
 *   cache after each pack is fully stored, and a final marker once the whole
 *   set has been counted. Clear site data and the record goes with the data.
 *
 *   Resumable. Stop it, lose the connection, close the laptop - packs already
 *   marked are skipped next time.
 *
 *   Verified. Every pack is checked against its SHA-256 before a byte of it
 *   is stored, and the finished cache is counted against the manifest before
 *   it is called ready. A captive portal's login page, a truncated download,
 *   a proxy that rewrote something: none of them become "ready".
 *
 *   Space first. The browser's own estimate is consulted before starting,
 *   and persistent storage is requested, so the copy is not quietly evicted
 *   when the disk fills.
 *
 *   Versioned by corpus, not by build. The cache is named for a hash of the
 *   texts, so deploying new CSS does not throw away 100 MB. When the texts do
 *   change, the old copy keeps working until the new one is complete, and
 *   only then is it deleted.
 */

const STATIC = window.GURBANI_STATIC || null;
const BASE = STATIC ? STATIC.base : "data/";
const PREFIX = "gurbani-studio-data-";
const READY = "packs/__ready__";           // marker: the whole set is in
const PARALLEL = 3;
const RETRIES = 3;

const url = (rel) => new URL(BASE + rel, document.baseURI).href;
const markerFor = (pack) => `${pack.path}.done`;

const listeners = new Set();
let state = {
  phase: "checking",   // unsupported | checking | none | partial | downloading
                       // | verifying | ready | update | error
  online: navigator.onLine,
  manifest: null,      // the newest published offline.json, when reachable
  ready: null,         // { version, at, bytes, entries } of the complete copy
  done: 0, total: 0,   // bytes, for the progress bar
  error: null,
  persisted: null,     // true | false | null when the browser cannot say
};
let controller = null;
let running = null;      // the promise of the download in progress, if any
let wakeLock = null;

export const supported = () =>
  !!STATIC && "caches" in window && "serviceWorker" in navigator &&
  window.isSecureContext && !!crypto?.subtle;

/* ---------------------------------------------------------------- events -- */
let lastEmit = 0, pendingEmit = null;
function set(patch, { now = false } = {}) {
  state = { ...state, ...patch };
  // Progress arrives far faster than anyone can read it; ten a second is
  // plenty, and the panel then does not spend the download re-rendering.
  const t = performance.now();
  if (now || t - lastEmit > 100) {
    lastEmit = t; clearTimeout(pendingEmit);
    listeners.forEach((fn) => fn(state));
  } else if (!pendingEmit) {
    pendingEmit = setTimeout(() => { pendingEmit = null; set({}, { now: true }); }, 110);
  }
}

export const offline = {
  get state() { return state; },
  subscribe(fn) { listeners.add(fn); fn(state); return () => listeners.delete(fn); },
  refresh, start, stop, remove,
};

/* ----------------------------------------------------------- what we have -- */
async function dataCaches() {
  return (await caches.keys()).filter((k) => k.startsWith(PREFIX));
}

async function readyRecord(name) {
  const hit = await (await caches.open(name)).match(url(READY));
  return hit ? hit.json() : null;
}

async function fetchManifest() {
  const res = await fetch(url("offline.json"), { cache: "no-store" });
  if (!res.ok) throw new Error(`offline.json: HTTP ${res.status}`);
  const m = await res.json();
  if (m.format !== 1) throw new Error("This copy of the app is out of date. Reload it.");
  return m;
}

/** How many bytes of this manifest are already stored, judged by markers. */
async function alreadyStored(manifest) {
  // caches.open() CREATES a cache that does not exist, so checking progress
  // with it left an empty cache behind - on every visit for people who never
  // downloaded, and straight back after Remove. Only a download creates one.
  if (!(await caches.has(PREFIX + manifest.version))) return 0;
  const cache = await caches.open(PREFIX + manifest.version);
  let bytes = 0;
  for (const f of manifest.files) if (await cache.match(url(f.path))) bytes += f.bytes;
  for (const p of manifest.packs) if (await cache.match(url(markerFor(p)))) bytes += p.bytes;
  return bytes;
}

/**
 * Work out where things stand. Cheap enough to call whenever the panel opens
 * or the connection comes and goes: one small manifest fetch when online,
 * and a handful of cache lookups.
 */
async function refresh() {
  if (!supported()) { set({ phase: "unsupported" }, { now: true }); return state; }
  if (state.phase === "downloading" || state.phase === "verifying") return state;

  let ready = null;
  for (const name of await dataCaches()) {
    const rec = await readyRecord(name);
    if (rec && (!ready || rec.at > ready.at)) ready = rec;
  }

  let manifest = state.manifest;
  if (navigator.onLine) {
    try { manifest = await fetchManifest(); } catch { /* offline in all but name */ }
  }

  let persisted = null;
  try { persisted = await navigator.storage?.persisted?.() ?? null; } catch { /* */ }

  let phase, done = 0;
  const total = manifest?.bytes || ready?.bytes || 0;
  if (ready && (!manifest || manifest.version === ready.version)) {
    phase = "ready"; done = total;
  } else if (manifest) {
    done = await alreadyStored(manifest);
    phase = ready ? "update" : done > 0 ? "partial" : "none";
  } else {
    phase = "none";
  }
  set({ phase, ready, manifest, done, total, persisted, error: null,
        online: navigator.onLine }, { now: true });
  return state;
}

/* -------------------------------------------------------------- download -- */
function start() {
  if (!supported() || running) return running;
  running = download().finally(() => { running = null; });
  return running;
}

async function download() {
  controller = new AbortController();
  const { signal } = controller;

  try {
    set({ phase: "downloading", error: null }, { now: true });
    const manifest = await fetchManifest();
    const cache = await caches.open(PREFIX + manifest.version);
    const have = await alreadyStored(manifest);
    set({ manifest, total: manifest.bytes, done: have });

    await checkSpace(manifest.bytes - have);

    // Ask before the first byte rather than after the last: some browsers
    // only grant it in answer to a click, and the click was just now.
    try { set({ persisted: await navigator.storage?.persist?.() ?? null }); } catch { /* */ }
    holdWakeLock();

    const jobs = [
      ...manifest.files.map((f) => ({ kind: "file", ...f })),
      ...manifest.packs.map((p) => ({ kind: "pack", ...p })),
    ];
    const todo = [];
    for (const job of jobs) {
      const key = job.kind === "file" ? url(job.path) : url(markerFor(job));
      if (!(await cache.match(key))) todo.push(job);
    }

    let done = have;
    const tick = (n) => { done += n; set({ done }); };
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        if (signal.aborted) return;
        await withRetries(() => fetchJob(todo[next++], cache, signal, tick), signal);
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    if (signal.aborted) throw new DOMException("stopped", "AbortError");

    // Count before calling it done. Every file the manifest promises, plus
    // one marker per pack, must actually be in the cache.
    set({ phase: "verifying" }, { now: true });
    const expected = manifest.entries + manifest.packs.length;
    const have2 = (await cache.keys()).length;
    if (have2 < expected) {
      throw new Error(`Only ${have2.toLocaleString()} of ${expected.toLocaleString()} ` +
                      "entries were stored. Try again to fetch the rest.");
    }
    const record = { version: manifest.version, at: Date.now(),
                     bytes: manifest.bytes, entries: manifest.entries };
    await cache.put(url(READY), new Response(JSON.stringify(record),
      { headers: { "Content-Type": "application/json" } }));

    // Only now is the previous copy, if any, let go.
    for (const name of await dataCaches()) {
      if (name !== PREFIX + manifest.version) await caches.delete(name);
    }
    set({ phase: "ready", ready: record, done: manifest.bytes }, { now: true });
    window.dispatchEvent(new CustomEvent("offline-ready", { detail: record }));
  } catch (err) {
    if (err?.name === "AbortError") {
      set({ phase: state.done > 0 ? "partial" : "none" }, { now: true });
      // An update stopped half way still has the complete old copy behind it.
      if (state.ready) set({ phase: "update" }, { now: true });
    } else {
      set({ phase: "error", error: friendly(err) }, { now: true });
    }
  } finally {
    controller = null;
    releaseWakeLock();
  }
}

function stop() { controller?.abort(); }

async function remove() {
  stop();
  // Let a stopping download finish writing its last state first, or it can
  // land after this and resurrect a "paused" copy that no longer exists.
  await running?.catch(() => {});
  for (const name of await dataCaches()) await caches.delete(name);
  set({ phase: "none", ready: null, done: 0, error: null }, { now: true });
  refresh();
}

/* One file or one pack: fetch, count, verify, store. */
async function fetchJob(job, cache, signal, tick) {
  const res = await fetch(url(job.path), { cache: "no-store", signal });
  if (!res.ok) throw new Error(`${job.path}: HTTP ${res.status}`);

  let got = 0;
  try {
    // Read it as a stream so the bar moves within a pack, not only between
    // them. The stream is already decompressed, so it counts the same bytes
    // as the manifest does.
    const reader = res.body.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length; tick(value.length);
    }
    const bytes = new Uint8Array(got);
    let at = 0;
    for (const c of chunks) { bytes.set(c, at); at += c.length; }

    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (hex !== job.sha256) throw new Error(`${job.path} did not arrive intact`);

    if (job.kind === "file") {
      await cache.put(url(job.path), new Response(bytes, {
        headers: { "Content-Type": "text/tab-separated-values; charset=utf-8" } }));
      return;
    }

    const { files } = JSON.parse(new TextDecoder("utf-8").decode(bytes));
    const entries = Object.entries(files);
    for (let i = 0; i < entries.length; i += 200) {
      await Promise.all(entries.slice(i, i + 200).map(([rel, text]) =>
        cache.put(url(rel), new Response(text, {
          headers: { "Content-Type": "application/json; charset=utf-8" } }))));
    }
    // Written last, so a pack interrupted half way through is fetched again
    // whole rather than trusted.
    await cache.put(url(markerFor(job)), new Response(job.sha256));
  } catch (err) {
    tick(-got);    // give the bar back what this attempt claimed
    throw err;
  }
}

async function withRetries(fn, signal) {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); }
    catch (err) {
      if (signal.aborted || err?.name === "AbortError" || attempt >= RETRIES) throw err;
      await new Promise((r) => setTimeout(r, 800 * attempt * attempt));
    }
  }
}

async function checkSpace(needed) {
  const est = await navigator.storage?.estimate?.().catch(() => null);
  if (!est || !est.quota) return;            // the browser will not say; try anyway
  const free = est.quota - (est.usage || 0);
  // Cache storage costs a little more than the bytes it holds.
  if (free < needed * 1.15) {
    throw new Error(`Not enough space: this needs about ${mb(needed * 1.15)}, ` +
                    `and the browser allows ${mb(Math.max(0, free))} more.`);
  }
}

function friendly(err) {
  const m = String(err?.message || err || "");
  if (err?.name === "QuotaExceededError" || /quota/i.test(m)) {
    return "The browser ran out of space for this. Free some disk space and try again.";
  }
  if (err instanceof TypeError && /fetch|network/i.test(m)) {
    return "The connection dropped. What arrived is kept; try again to fetch the rest.";
  }
  return m || "Something went wrong.";
}

export const mb = (b) => `${(b / 1e6).toFixed(b >= 1e8 ? 0 : 1)} MB`;

/* A laptop that sleeps half way through a download stops downloading. */
async function holdWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request?.("screen"); } catch { /* */ }
}
function releaseWakeLock() { wakeLock?.release?.().catch(() => {}); wakeLock = null; }

/* --------------------------------------------------------------- startup -- */
window.addEventListener("online", () => { set({ online: true }, { now: true }); refresh(); });
window.addEventListener("offline", () => {
  set({ online: false }, { now: true });
  // A download that loses the network fails on its next request; stop it
  // cleanly now so it reads "paused", not "error".
  if (state.phase === "downloading") stop();
});
if (supported()) refresh();
else set({ phase: "unsupported" }, { now: true });
