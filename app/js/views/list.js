/* The middle pane: search results, the bani catalogue, or saved items.
 *
 * One component with three modes, because they are the same object - a
 * scrollable, keyboard-navigable list whose selection drives the reader. Arrow
 * keys move, Return opens, and the selected row is always scrolled into view,
 * so the whole app can be driven without the mouse.
 */

import { el, clear, iconBtn, popover, popItem, emptyState, toast, MOD } from "../ui.js";
import { Icons } from "../icons.js";
import { store } from "../store.js";
import { getMeta, search as runSearch, loadIndex, indexReady, getShabad } from "../data.js";
import { KB_ROWS, A2U, LETTER_NAMES, toGurmukhi, toAscii } from "../gurmukhi.js";
import { BANI_INFO, GROUPS, baniName, baniGroup } from "../banis-info.js";

const MIN_LETTERS = 2;   // a desktop keyboard types faster; start sooner
const SORTS = [
  { id: "category", label: "By category", sub: "Nitnem first, then the rest" },
  { id: "english",  label: "A – Z",       sub: "By English name" },
  { id: "gurmukhi", label: "ਅ – ੜ",      sub: "By Gurmukhi name" },
];

export function listPane({ onOpen, onToggleSidebar }) {
  const root = el("div.pane.list-pane");

  let mode = "banis";           // banis | search | saved
  let banis = [];
  let items = [];               // what is currently listed
  let selected = -1;
  let query = "";
  let token = 0;

  /* --- head -------------------------------------------------------------- */
  const title = el("div.list-title", { text: "Banis" });
  const meta = el("div.list-meta", { text: "" });

  const input = el("input", {
    type: "search", spellcheck: "false", autocomplete: "off",
    placeholder: "Search banis",
    "aria-label": "Search",
    oninput: () => { query = input.value; refresh(); },
    onkeydown: onFieldKey,
  });
  const echo = el("div.echo");
  const sortBtn = iconBtn("sliders", "Arrange", (e) => openSort(e.currentTarget));
  const kbBtn = iconBtn("keyboard", "Gurmukhi keyboard reference", () => {
    store.toggle("keyboardRef"); renderKeyboard();
  });

  const field = el("div.field", {}, [
    el("span.field-icon", { html: Icons.search }),
    input,
    el("span.kbd", { text: `${MOD}K` }),
  ]);

  const sideBtn = iconBtn("sidebar", `Show or hide the sidebar  ${MOD}B`,
                          () => onToggleSidebar?.());

  const head = el("div.list-head", {}, [
    el("div", { style: { display: "flex", alignItems: "center", gap: "6px" } },
       [sideBtn, title, el("div", { style: { flex: "1" } }), sortBtn, kbBtn]),
    field, echo, meta,
  ]);

  const scroll = el("div.scroll", { role: "listbox", tabindex: "-1" });
  const kbref = el("div.kbref");
  root.append(head, scroll, kbref);

  (async () => {
    banis = (await getMeta()).banis || [];
    refresh();
  })();

  store.subscribe((_s, keys) => {
    if (keys === "*" || keys.includes("saved") || keys.includes("favourites")) {
      if (mode === "saved" || mode === "banis") refresh();
    }
  });

  renderKeyboard();

  /* --- modes -------------------------------------------------------------- */
  function setMode(next, { group } = {}) {
    mode = next;
    root.dataset.group = group || "";
    query = ""; input.value = "";
    selected = -1;
    title.textContent = next === "search" ? "Search"
      : next === "saved" ? "Saved"
      : group ? (GROUPS.find((g) => g.id === group)?.label || "Banis") : "Banis";
    input.placeholder = next === "search"
      ? "Type the first letter of each word"
      : next === "saved" ? "Search saved" : "Search banis";
    sortBtn.hidden = next !== "banis";
    kbBtn.hidden = next !== "search";
    renderKeyboard();
    refresh();
    focusField();
  }

  const focusField = () => { input.focus(); input.select(); };

  /* --- the on-screen keyboard, a legend rather than an input -------------- */
  function renderKeyboard() {
    clear(kbref);
    if (mode !== "search" || !store.get("keyboardRef")) { kbref.hidden = true; return; }
    kbref.hidden = false;
    const grid = el("div.kbref-grid");
    KB_ROWS.flat().forEach((ch) => {
      grid.append(el("button.key", {
        title: `${LETTER_NAMES[ch] || ch} — press “${ch}”`,
        onclick: () => { input.value += ch; query = input.value; refresh(); focusField(); },
      }, [
        el("span.g", { text: A2U[ch] || ch }),
        el("span.a", { text: ch }),
      ]));
    });
    kbref.append(grid);
  }

  /* --- refresh ------------------------------------------------------------ */
  async function refresh() {
    const mine = ++token;

    if (mode === "search") {
      const letters = toAscii(query);
      echo.replaceChildren(
        letters ? el("span.gur", { text: toGurmukhi(letters) }) : el("span"),
        el("span", { text: letters ? `typed as ${letters}` : "letters appear here" }),
      );
      if (letters.length < MIN_LETTERS) {
        items = []; selected = -1;
        meta.textContent = "";
        clear(scroll);
        scroll.append(intro());
        return;
      }
      if (!indexReady()) {
        clear(scroll);
        const bar = el("div", { style: { width: "60%", height: "3px",
          background: "var(--fill-strong)", borderRadius: "99px", overflow: "hidden" } });
        const fill = el("div", { style: { height: "100%", width: "0%",
          background: "var(--accent)" } });
        bar.append(fill);
        scroll.append(el("div.empty", {}, [
          el("div", { html: Icons.book }),
          el("h3", { text: "Preparing search" }),
          el("p", { text: "Once, then it is instant and works offline." }),
          bar,
        ]));
        await loadIndex((f) => { fill.style.width = `${Math.round(f * 100)}%`; });
        if (mine !== token) return;
      }
      const res = await runSearch(letters, { mode: "anywhere", limit: 200 });
      if (mine !== token) return;
      items = res.rows;
      meta.textContent = res.total
        ? `${res.capped ? "2000+" : res.total} result${res.total === 1 ? "" : "s"}` +
          (res.total > res.rows.length ? ` · first ${res.rows.length}` : "")
        : "No matches";
      drawResults();
      return;
    }

    if (mode === "saved") {
      const q = query.trim().toLowerCase();
      items = store.get("saved").filter((s) =>
        !q || (s.gurmukhi || "").includes(query) ||
        (s.title || "").toLowerCase().includes(q) ||
        (s.where || "").toLowerCase().includes(q));
      meta.textContent = items.length
        ? `${items.length} item${items.length === 1 ? "" : "s"}` : "";
      drawSaved();
      return;
    }

    /* banis */
    const q = query.trim().toLowerCase();
    const group = root.dataset.group;
    let list = banis.filter((b) =>
      (!group || baniGroup(b) === group) &&
      (!q || baniName(b).toLowerCase().includes(q) || (b.unicode || "").includes(query)));

    const sort = store.get("baniSort");
    if (sort === "english") list = [...list].sort((a, b) => baniName(a).localeCompare(baniName(b), "en"));
    else if (sort === "gurmukhi") list = [...list].sort((a, b) => (a.unicode || "").localeCompare(b.unicode || "", "pa"));

    items = list;
    meta.textContent = `${list.length} ${list.length === 1 ? "bani" : "banis"}`;
    drawBanis();
  }

  /* --- drawing ------------------------------------------------------------ */
  function drawBanis() {
    clear(scroll);
    if (!items.length) {
      scroll.append(emptyState("search", "No bani by that name",
        "Try part of the name, like “sukhmani”."));
      return;
    }
    items.forEach((b, i) => {
      const fav = store.isFavourite(b.bani_id);
      scroll.append(el("button.row", {
        role: "option", "aria-selected": String(i === selected),
        dataset: { i: String(i) },
        onclick: () => select(i, true),
      }, [
        el("button", {
          class: `row-star ${fav ? "on" : ""}`,
          html: fav ? Icons.starFill : Icons.star,
          "aria-label": fav ? "Unstar" : "Star",
          onclick: (e) => { e.stopPropagation(); store.toggleFavourite(b.bani_id); },
        }),
        el("div.row-gur.gur", { text: b.unicode || "" }),
        el("div.row-sub", { text: baniName(b) }),
      ]));
    });
  }

  function drawResults() {
    clear(scroll);
    if (!items.length) {
      scroll.append(emptyState("search", "Nothing found",
        "Try fewer letters, or check their order."));
      return;
    }
    items.forEach((r, i) => {
      scroll.append(el("button.row", {
        role: "option", "aria-selected": String(i === selected),
        dataset: { i: String(i), shabad: String(r.shabad_id), verse: String(r.verse_id) },
        onclick: () => select(i, true),
      }, [
        el("div.row-gur.gur", { text: r.gurmukhi }),
        el("div.row-sub.tl", { text: "" }),
        el("div.row-meta", {}, [
          el("span", { text: r.page_no ? `Ang ${r.page_no}` : "" }),
          r.writer && el("span", { text: r.writer }),
        ].filter(Boolean)),
      ]));
    });
    enrich();
  }

  /* Results show Gurmukhi at once from the in-memory index; the romanisation
     arrives from the shabad file as each row scrolls into view. */
  function enrich() {
    const io = new IntersectionObserver((entries) => {
      entries.forEach(async (e) => {
        if (!e.isIntersecting) return;
        const node = e.target; io.unobserve(node);
        if (node.dataset.filled) return;
        node.dataset.filled = "1";
        try {
          const d = await getShabad(+node.dataset.shabad);
          const v = (d.verses || []).find((x) => x.verse_id === +node.dataset.verse);
          if (v?.translit_en) node.querySelector(".tl").textContent = v.translit_en;
        } catch { /* a missing file must not break the list */ }
      });
    }, { root: scroll, rootMargin: "300px" });
    scroll.querySelectorAll(".row[data-shabad]").forEach((n) => io.observe(n));
  }

  function drawSaved() {
    clear(scroll);
    if (!items.length) {
      scroll.append(emptyState("bookmark", "Nothing saved yet",
        "Star a line while reading, or save a whole shabad."));
      return;
    }
    items.forEach((it, i) => {
      scroll.append(el("button.row", {
        role: "option", "aria-selected": String(i === selected),
        dataset: { i: String(i) },
        onclick: () => select(i, true),
        oncontextmenu: (e) => { e.preventDefault(); remove(it); },
      }, [
        el("div.row-gur.gur", { text: it.gurmukhi || it.title || "" }),
        el("div.row-meta", {}, [
          el("span", { html: it.type === "line" ? Icons.starFill : Icons.bookFill,
                       style: { display: "flex", width: "13px" } }),
          el("span", { text: it.where || it.subtitle || it.title || "" }),
        ]),
      ]));
    });
  }

  function remove(it) {
    store.toggleSaved(it);
    toast("Removed", { action: "Undo", onAction: () => store.toggleSaved(it) });
  }

  function intro() {
    return el("div.empty", {}, [
      el("div", { html: Icons.keyboard }),
      el("h3", { text: "Type the first letter of each word" }),
      el("p", { text: "On this keyboard the letters are Latin: j k r for ਜ ਕ ਰ. " +
                      "Two letters is enough to start." }),
      el("div", { style: { display: "flex", gap: "6px", alignItems: "center",
                           marginTop: "8px" } }, [
        el("span.kbd", { text: "j" }), el("span.kbd", { text: "m" }),
        el("span.kbd", { text: "T" }), el("span.kbd", { text: "A" }),
        el("span.kbd", { text: "q" }),
        el("span", { text: "→", style: { color: "var(--label-3)" } }),
        el("span.gur", { text: "ਜਮਠਅਤ",
                         style: { color: "var(--gold)", fontSize: "1.1rem" } }),
      ]),
    ]);
  }

  /* --- selection and keys -------------------------------------------------- */
  function select(i, open = false) {
    if (!items.length) return;
    selected = Math.max(0, Math.min(i, items.length - 1));
    [...scroll.children].forEach((n, k) =>
      n.setAttribute?.("aria-selected", String(k === selected)));
    scroll.children[selected]?.scrollIntoView({ block: "nearest" });
    if (open) openSelected();
  }

  function openSelected() {
    const it = items[selected];
    if (!it) return;
    if (mode === "banis") onOpen({ type: "bani", id: it.bani_id });
    else if (mode === "search")
      onOpen({ type: "shabad", id: it.shabad_id, focusLine: it.verse_id });
    else if (it.type === "line")
      onOpen(it.baniId != null
        ? { type: "bani", id: it.baniId, focusLine: it.seq }
        : { type: "shabad", id: it.shabadId, focusLine: it.refId });
    else onOpen({ type: it.type, id: it.refId, focusLine: it.verseId ?? null });
  }

  function onFieldKey(e) {
    if (e.key === "ArrowDown") { e.preventDefault(); select(selected + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); select(selected - 1); }
    else if (e.key === "Enter") { e.preventDefault(); if (selected < 0) select(0); openSelected(); }
    else if (e.key === "Escape") {
      if (input.value) { input.value = ""; query = ""; refresh(); }
      else input.blur();
    }
  }

  function openSort(anchor) {
    popover(anchor, (pop, { close }) => {
      pop.append(el("div.pop-title", { text: "Arrange" }));
      SORTS.forEach((s) => pop.append(popItem(s.label, {
        sub: s.sub, ticked: store.get("baniSort") === s.id,
        onSelect: () => { store.set("baniSort", s.id); close(); refresh(); },
      })));
    });
  }

  return {
    root, setMode, focusField,
    moveSelection: (d) => select(selected + d),
    openSelected,
    refresh,
  };
}
