/* Data access.
 *
 * Two shapes of deployment, one interface. Served by `harness serve` there is
 * a local API; published as a static site there are only files. The static
 * path is the one that has to be careful, because the search index is a few
 * megabytes and it may be opening on a phone.
 *
 * The index is held as ONE string plus an offset table, not as 142,000 parsed
 * rows. Splitting the file would allocate well over a million small strings
 * and cost tens of megabytes; instead we scan a single blob with indexOf -
 * which is native, fast, and allocation-free - and only slice out the handful
 * of rows we are actually about to draw.
 */

const STATIC = window.GURBANI_STATIC || null;
const BASE = STATIC ? STATIC.base : null;

let meta = null;
const shabadCache = new Map();
const baniCache = new Map();

/* ---------------------------------------------------------------- meta -- */
export async function getMeta() {
  if (meta) return meta;
  const url = STATIC ? `${BASE}meta.json` : "/api/meta";
  meta = await (await fetch(url)).json();
  meta._writer = Object.fromEntries(
    (meta.writers || []).map((w) => [w.writer_id, w.english]));
  meta._raag = Object.fromEntries(
    (meta.raags || []).map((r) => [r.raag_id, r.english]));
  meta._source = Object.fromEntries(
    (meta.sources || []).map((s) => [s.source_id, s.english]));
  return meta;
}

/* --------------------------------------------------------------- index -- */
const idx = {
  ready: false,
  raw: "",           // the whole TSV
  rowStart: null,    // Int32Array: offset of each row in `raw`
  flBlob: "",        // "\n" + firstLetters + "\n" + firstLetters + …
  flStart: null,     // Int32Array: offset of each row's letters in flBlob
  n: 0,
};

export const indexReady = () => idx.ready;

/**
 * Load and prepare the search index. `onProgress(fraction, bytes)` is called
 * while downloading so the UI can show something honest rather than a spinner.
 */
export async function loadIndex(onProgress) {
  if (idx.ready) return;
  if (!STATIC) { idx.ready = true; return; }   // the API does the searching

  const res = await fetch(`${BASE}lines.tsv`);
  const expected = (meta && meta.index_bytes) || 17_500_000;
  let text;

  if (res.body && typeof ReadableStream !== "undefined") {
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress?.(Math.min(0.98, received / expected), received);
    }
    const merged = new Uint8Array(received);
    let at = 0;
    for (const c of chunks) { merged.set(c, at); at += c.length; }
    text = new TextDecoder("utf-8").decode(merged);
  } else {
    text = await res.text();
  }
  onProgress?.(1, text.length);

  build(text);
}

function build(text) {
  idx.raw = text;

  // First pass: row offsets, and the first-letter blob.
  const starts = [];
  const flParts = [];
  const flOffsets = [];
  let pos = 0;
  let flPos = 0;
  const len = text.length;

  while (pos < len) {
    const eol = text.indexOf("\n", pos);
    const end = eol === -1 ? len : eol;
    starts.push(pos);

    // Column 7 is first_letters_ascii, column 8 is gurmukhi.
    let t = pos;
    for (let i = 0; i < 7; i++) t = text.indexOf("\t", t) + 1;
    const flEnd = text.indexOf("\t", t);
    const fl = text.slice(t, flEnd === -1 || flEnd > end ? end : flEnd);

    flParts.push(fl);
    flOffsets.push(flPos + 1);          // +1 for the leading "\n"
    flPos += fl.length + 1;

    pos = end + 1;
  }

  idx.n = starts.length;
  idx.rowStart = Int32Array.from(starts);
  idx.flStart = Int32Array.from(flOffsets);
  idx.flBlob = "\n" + flParts.join("\n");
  idx.ready = true;
}

/** Which row does this offset in flBlob belong to? */
function rowAtFlOffset(offset) {
  const a = idx.flStart;
  let lo = 0, hi = a.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (a[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Slice one row out of the raw blob and name its columns. */
function readRow(i) {
  const start = idx.rowStart[i];
  const end = i + 1 < idx.n ? idx.rowStart[i + 1] - 1 : idx.raw.length;
  const c = idx.raw.slice(start, end).split("\t");
  return {
    verse_id: +c[0],
    shabad_id: +c[1],
    source_id: c[2],
    page_no: +c[3],
    line_no: +c[4],
    writer_id: +c[5],
    raag_id: +c[6],
    first_letters: c[7],
    gurmukhi: c[8] || "",
  };
}

/**
 * First-letter search.
 *
 * `mode` is "start" (the line begins with these letters) or "anywhere".
 * Returns at most `limit` rows plus the true total, so the UI can say how
 * many more there are without drawing them.
 */
export function searchLetters(query, { mode = "anywhere", limit = 200 } = {}) {
  if (!idx.ready || !query) return { total: 0, rows: [], mode };

  const needle = mode === "start" ? "\n" + query : query;
  const rows = [];
  let total = 0;
  let at = 0;

  for (;;) {
    const hit = idx.flBlob.indexOf(needle, at);
    if (hit === -1) break;
    total++;
    if (rows.length < limit) {
      const row = readRow(rowAtFlOffset(mode === "start" ? hit + 1 : hit));
      row.matchAt = mode === "start"
        ? 0
        : hit - idx.flStart[rowAtFlOffset(hit)];
      rows.push(row);
    }
    at = hit + 1;
    // Enough to know "hundreds"; counting every one of 9,000 matches while
    // someone is still typing is wasted work.
    if (total > 2000) break;
  }
  return { total, rows, mode, capped: total > 2000 };
}

/**
 * The one entry point the search view calls.
 *
 * Static builds search the in-memory index; running against `harness serve`
 * the API does the work. Both return the same row shape, so the view has no
 * idea which it is talking to.
 */
export async function search(query, { mode = "anywhere", limit = 200 } = {}) {
  if (STATIC) return searchLetters(query, { mode, limit });

  const apiMode = mode === "start" ? "first-letters" : "first-letters-anywhere";
  const res = await fetch(
    `/api/search?q=${encodeURIComponent(query)}&mode=${apiMode}&limit=${limit}`);
  const d = await res.json();
  return {
    total: d.count || 0,
    capped: false,
    mode,
    rows: (d.results || []).map((r) => ({
      verse_id: r.verse_id,
      shabad_id: r.shabad_id,
      source_id: r.source_id,
      page_no: r.page_no,
      line_no: r.line_no,
      gurmukhi: r.gurmukhi,
      writer: r.writer || null,
      first_letters: r.first_letters_ascii || "",
      matchAt: mode === "start"
        ? 0
        : Math.max(0, (r.first_letters_ascii || "").indexOf(query)),
    })),
  };
}

/* -------------------------------------------------------------- records -- */
export async function getShabad(id) {
  if (shabadCache.has(id)) return shabadCache.get(id);
  const url = STATIC
    ? `${BASE}shabads/${Math.floor(id / 500)}/${id}.json`
    : `/api/shabad/${id}`;
  const data = await (await fetch(url)).json();
  shabadCache.set(id, data);
  return data;
}

export async function getBani(id) {
  if (baniCache.has(id)) return baniCache.get(id);
  const url = STATIC ? `${BASE}banis/${id}.json` : `/api/bani/${id}`;
  const data = await (await fetch(url)).json();
  baniCache.set(id, data);
  return data;
}

/** Larivaar is the line with its spaces removed - true for every line. */
export const toLarivaar = (line) => (line || "").replace(/ /g, "");
