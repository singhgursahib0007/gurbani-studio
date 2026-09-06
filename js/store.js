/* Preferences, saved items and window state.
 *
 * Everything the reader chooses is mirrored to localStorage on change, so the
 * app opens exactly as they left it - including the shape of the window: pane
 * widths, whether the sidebar is showing, the reading measure. On a desktop
 * those are as much a preference as the theme.
 *
 * Reads are wrapped in try/catch because private windows and blocked site
 * data make localStorage throw rather than return null.
 */

const KEY = "gurbani.studio.v1";
const PREFS_VERSION = 1;

export const DEFAULTS = Object.freeze({
  prefsVersion: PREFS_VERSION,

  /* appearance */
  theme: "auto",             // auto | light | sepia | dark | night
  gurFont: "Sant Lipi",
  gurWeight: 400,
  textScale: 1,
  translitScale: 1,
  translationScale: 1,
  align: "center",
  measure: 40,               // reading column width, in rem

  /* what shows under each line */
  larivaar: false,
  transliteration: true,
  translationEn: true,
  translationEnAlt: false,
  translationPa: true,
  showAttribution: false,

  /* window */
  sidebarWidth: 248,
  listWidth: 372,
  sidebarVisible: true,
  keyboardRef: false,        // the on-screen keyboard legend

  /* reading */
  autoScrollSpeed: 30,

  /* collections */
  favourites: [],
  saved: [],
  lastRead: null,
  progress: {},
  baniSort: "category",
  searchMode: "anywhere",
});

let state = load();
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* full or blocked */ }
}

export const store = {
  get all() { return state; },
  get(k) { return state[k]; },

  set(k, v) {
    if (state[k] === v) return;
    state = { ...state, [k]: v };
    persist();
    emit(k);
  },

  update(patch) {
    state = { ...state, ...patch };
    persist();
    emit(Object.keys(patch));
  },

  toggle(k) { this.set(k, !state[k]); },

  /* --- favourites ------------------------------------------------------ */
  isFavourite(id) { return state.favourites.includes(id); },
  toggleFavourite(id) {
    const favs = state.favourites.includes(id)
      ? state.favourites.filter((f) => f !== id)
      : [...state.favourites, id];
    this.set("favourites", favs);
    return favs.includes(id);
  },

  /* --- saved ------------------------------------------------------------ */
  isSaved(id) { return state.saved.some((s) => s.id === id); },
  toggleSaved(entry) {
    const exists = state.saved.some((s) => s.id === entry.id);
    this.set("saved", exists
      ? state.saved.filter((s) => s.id !== entry.id)
      : [{ ...entry, at: Date.now() }, ...state.saved]);
    return !exists;
  },

  /* --- reading position -------------------------------------------------
   * Stored as the index of the topmost visible line, never a pixel offset:
   * pixels stop meaning anything the moment type size, the measure or a
   * translation toggle reflows the page. A line index survives all of those.
   */
  getProgress(key) { return state.progress?.[key] || null; },
  setProgress(key, line) {
    const cur = state.progress?.[key];
    if (cur && cur.line === line) return;
    const next = { ...state.progress, [key]: { line, at: Date.now() } };
    const keys = Object.keys(next);
    if (keys.length > 60) {
      keys.sort((a, b) => (next[b].at || 0) - (next[a].at || 0));
      for (const k of keys.slice(60)) delete next[k];
    }
    this.set("progress", next);
  },

  /* --- resets ------------------------------------------------------------ */
  resetAppearance() {
    const keep = (({ favourites, saved, lastRead, progress,
                     sidebarWidth, listWidth }) =>
      ({ favourites, saved, lastRead, progress, sidebarWidth, listWidth }))(state);
    state = { ...DEFAULTS, ...keep };
    persist();
    emit("*");
  },

  resetEverything() {
    state = { ...DEFAULTS };
    persist();
    emit("*");
  },

  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};

function emit(keys) {
  const changed = Array.isArray(keys) ? keys : [keys];
  listeners.forEach((fn) => fn(state, changed));
}

/* --- applying preferences to the document ------------------------------- */
const media = window.matchMedia("(prefers-color-scheme: dark)");

export const FONTS = [
  { value: "Sant Lipi", label: "Sant Lipi", note: "Built for Gurbani" },
  { value: "Mukta Mahee", label: "Mukta Mahee", note: "Even and modern" },
  { value: "Noto Sans Gurmukhi", label: "Noto Sans", note: "Wide and plain" },
  { value: "Anek Gurmukhi", label: "Anek", note: "Compact" },
];
export const WEIGHTS = [
  { value: 400, label: "Regular" },
  { value: 500, label: "Medium" },
  { value: 700, label: "Bold" },
];
export const THEMES = [
  { value: "auto",  label: "Auto",  bg: "linear-gradient(135deg,#fff 50%,#0C1524 50%)", fg: "#7FA8E8" },
  { value: "light", label: "Light", bg: "#FFFFFF", fg: "#12294B" },
  { value: "sepia", label: "Sepia", bg: "#FBF4E6", fg: "#3B2E1B" },
  { value: "dark",  label: "Dark",  bg: "#0C1524", fg: "#EEF3FA" },
  { value: "night", label: "Night", bg: "#000000", fg: "#C8D2E0" },
];

export const resolveTheme = (pref = state.theme) =>
  pref !== "auto" ? pref : (media.matches ? "dark" : "light");

export function applyTheme() {
  document.documentElement.setAttribute("data-theme", resolveTheme());
}

export function applyVars() {
  const r = document.documentElement.style;
  r.setProperty("--gur-font", `"${state.gurFont}"`);
  r.setProperty("--gur-weight", String(state.gurWeight));
  r.setProperty("--reader-scale", String(state.textScale));
  r.setProperty("--translit-scale", String(state.translitScale));
  r.setProperty("--translation-scale", String(state.translationScale));
  r.setProperty("--reader-align", state.align === "start" ? "start" : "center");
  r.setProperty("--reader-measure", `${state.measure}rem`);
  r.setProperty("--sidebar-w", `${state.sidebarWidth}px`);
  r.setProperty("--list-w", `${state.listWidth}px`);
}

media.addEventListener?.("change", () => { if (state.theme === "auto") applyTheme(); });

store.subscribe((_s, keys) => {
  if (keys === "*" || keys.includes("theme")) applyTheme();
  if (keys === "*" || ["textScale", "translitScale", "translationScale", "align",
       "gurFont", "gurWeight", "measure", "sidebarWidth", "listWidth"]
       .some((k) => keys.includes(k))) applyVars();
});
