/* The shell: three panes, draggable dividers, and the keyboard.
 *
 * The whole app can be driven without a mouse — ⌘K to search, arrows through
 * results, Return to open, ⌘\ to read without chrome. That is the point of a
 * desktop build; if it needed a pointer for everything it would just be the
 * phone app in a bigger window.
 */

import { el, iconBtn, popover, popItem, toast, MOD } from "./ui.js";
import { Icons } from "./icons.js";
import { store, applyTheme, applyVars } from "./store.js";
import { sidebar } from "./views/sidebar.js";
import { listPane } from "./views/list.js";
import { readerPane } from "./views/reader.js";
import { openAppearance, openSettings } from "./views/settings.js";

applyTheme();
applyVars();

const app = document.getElementById("app");

const reader = readerPane({ onSaveChanged: () => list.refresh() });
const list = listPane({ onOpen: (what) => reader.open(what) });
const side = sidebar({
  onSelect: (key) => {
    if (key === "search") list.setMode("search");
    else if (key === "saved") list.setMode("saved");
    else list.setMode("banis", { group: key.slice("banis:".length) });
  },
  onSettings: openSettings,
  onAppearance: openAppearance,
});

const d1 = el("div.divider.d1", { role: "separator", "aria-label": "Resize sidebar" });
const d2 = el("div.divider.d2", { role: "separator", "aria-label": "Resize list" });
app.append(side.root, d1, list.root, d2, reader.root);

if (!store.get("sidebarVisible")) app.classList.add("no-sidebar");

/* --- dragging the dividers ------------------------------------------------ */
function draggable(divider, key, min, max) {
  divider.addEventListener("mousedown", (e) => {
    e.preventDefault();
    divider.classList.add("dragging");
    const startX = e.clientX;
    const startW = store.get(key);
    const move = (ev) => {
      const w = Math.round(Math.min(max, Math.max(min, startW + ev.clientX - startX)));
      // Set the variable directly while dragging; the store write happens once
      // on release, so a drag is one history entry and not two hundred.
      document.documentElement.style.setProperty(
        key === "sidebarWidth" ? "--sidebar-w" : "--list-w", `${w}px`);
      divider.dataset.w = String(w);
    };
    const up = () => {
      divider.classList.remove("dragging");
      if (divider.dataset.w) store.set(key, Number(divider.dataset.w));
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
  divider.addEventListener("dblclick", () => store.set(key, min + 60));
}
draggable(d1, "sidebarWidth", 190, 380);
draggable(d2, "listWidth", 280, 560);

/* --- shortcuts ------------------------------------------------------------ */
function toggleSidebar() {
  const showing = !app.classList.toggle("no-sidebar");
  store.set("sidebarVisible", showing);
}

function toggleFocus() {
  const on = app.classList.toggle("focus-mode");
  toast(on ? `Focus mode · ${MOD}\\ to leave` : "Focus mode off", { ms: 1600 });
}

document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);

  if (mod && e.key.toLowerCase() === "k") {
    e.preventDefault(); side.setCurrent("search"); list.setMode("search"); return;
  }
  if (mod && e.key.toLowerCase() === "b") { e.preventDefault(); toggleSidebar(); return; }
  if (mod && e.key === "\\") { e.preventDefault(); toggleFocus(); return; }
  if (mod && e.key.toLowerCase() === "p") { e.preventDefault(); palette(); return; }
  if (mod && e.key === ",") { e.preventDefault(); openSettings(document.querySelector(".side-foot .ib:last-child")); return; }
  if (mod && e.key.toLowerCase() === "j") { e.preventDefault(); reader.toggleAuto(); return; }
  if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); reader.toggleSaveWhole(); return; }

  if (typing) return;

  // Slash focuses search the way it does in every other reading app.
  if (e.key === "/") { e.preventDefault(); list.focusField(); return; }
  if (e.key === "ArrowDown") { e.preventDefault(); list.moveSelection(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); list.moveSelection(-1); }
  else if (e.key === "Enter") { e.preventDefault(); list.openSelected(); }
  else if (e.key === " ") { e.preventDefault(); reader.scrollBy(innerHeight * 0.8); }
  else if (e.key === "Escape" && app.classList.contains("focus-mode")) toggleFocus();
});

/* --- command palette ------------------------------------------------------ */
function palette() {
  const commands = [
    { t: "Search", s: `${MOD}K`, run: () => { side.setCurrent("search"); list.setMode("search"); } },
    { t: "All banis", s: "", run: () => { side.setCurrent("banis:"); list.setMode("banis", { group: "" }); } },
    { t: "Nitnem", s: "", run: () => { side.setCurrent("banis:nitnem"); list.setMode("banis", { group: "nitnem" }); } },
    { t: "Saved", s: "", run: () => { side.setCurrent("saved"); list.setMode("saved"); } },
    { t: "Appearance", s: "", run: () => openAppearance(document.querySelector(".side-foot .ib")) },
    { t: "Settings", s: `${MOD},`, run: () => openSettings(document.querySelector(".side-foot .ib:last-child")) },
    { t: "Toggle sidebar", s: `${MOD}B`, run: toggleSidebar },
    { t: "Focus mode", s: `${MOD}\\`, run: toggleFocus },
    { t: "Auto-scroll", s: `${MOD}J`, run: () => reader.toggleAuto() },
    { t: "Save what I am reading", s: `${MOD}S`, run: () => reader.toggleSaveWhole() },
    ...["auto", "light", "sepia", "dark", "night"].map((v) => ({
      t: `Theme: ${v[0].toUpperCase()}${v.slice(1)}`, s: "",
      run: () => store.set("theme", v),
    })),
  ];

  const scrim = el("div.palette-scrim");
  const input = el("input.palette-input", {
    placeholder: "Type a command…", "aria-label": "Command palette",
  });
  const listEl = el("div.palette-list");
  const box = el("div.palette", { role: "dialog", "aria-modal": "true" }, [input, listEl]);
  document.body.append(scrim, box);
  requestAnimationFrame(() => { scrim.classList.add("open"); box.classList.add("open"); });
  input.focus();

  let shown = commands, sel = 0;
  draw();

  function draw() {
    listEl.replaceChildren(...shown.map((c, i) =>
      el("button.palette-item", {
        "aria-selected": String(i === sel),
        onclick: () => { close(); c.run(); },
      }, [
        el("div.body", {}, [el("div.t", { text: c.t })]),
        c.s && el("span.kbd", { text: c.s }),
      ].filter(Boolean))));
    listEl.children[sel]?.scrollIntoView({ block: "nearest" });
  }

  input.addEventListener("input", () => {
    const q = input.value.toLowerCase();
    shown = commands.filter((c) => c.t.toLowerCase().includes(q));
    sel = 0; draw();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(sel + 1, shown.length - 1); draw(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(sel - 1, 0); draw(); }
    else if (e.key === "Enter") { e.preventDefault(); const c = shown[sel]; close(); c?.run(); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  });
  scrim.addEventListener("mousedown", close);

  function close() {
    scrim.classList.remove("open"); box.classList.remove("open");
    setTimeout(() => { scrim.remove(); box.remove(); }, 200);
  }
}

/* --- offline -------------------------------------------------------------- */
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  const register = () => navigator.serviceWorker.register("./sw.js").catch(() => {});
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register);
}

/* --- first paint ----------------------------------------------------------- */
list.setMode("banis", { group: "" });
setTimeout(() => {
  const splash = document.getElementById("splash");
  if (!splash) return;
  splash.classList.add("gone");
  setTimeout(() => splash.remove(), 420);
}, 420);
