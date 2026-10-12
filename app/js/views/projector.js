/* Projector mode — one line, the whole screen, driven from the keyboard.
 *
 * The premise is that this screen IS the screen the sangat is looking at.
 * There is no second operator window, so everything the operator needs has to
 * live on the same display without spoiling it: hence a glass sidebar that
 * slides away to the right, and a stage that gives its whole width to one
 * line of Gurbani.
 *
 * Three decisions worth knowing about before changing anything here:
 *
 *   Type is fitted once per shabad, not per line. Fitting each line
 *   separately would fill the screen better but the text would jump a size on
 *   every advance, which looks broken from the back of a hall. So the size is
 *   the largest at which the longest line of THIS shabad still fits, and it
 *   then holds for the whole shabad.
 *
 *   Leaving full screen does not leave projector mode. Immersive reading ties
 *   the two together, but a presenter may well have the window on a second
 *   display and no interest in the browser's own full screen. Escape, and the
 *   exit button, are the ways out.
 *
 *   Advance is bound to arrows, space, page up/down and Enter, because a
 *   presentation clicker sends one of those and you do not get to choose
 *   which.
 */

import { el, clear, iconBtn } from "../ui.js";
import { Icons } from "../icons.js";
import { store, PROJ_PRESETS, WEIGHTS, FONTS, isDarkColour } from "../store.js";
import { loadRecord, nameLine } from "../record.js";
import { toLarivaar, search as runSearch, loadIndex, indexReady, getMeta } from "../data.js";
import { baniName } from "../banis-info.js";
import { KB_ROWS, A2U, LETTER_NAMES, toGurmukhi, toAscii } from "../gurmukhi.js";
import { offlinePanel } from "./offline-panel.js";

const MIN_LETTERS = 2;
const TABS = [
  { id: "lines",  label: "Lines",  icon: "list",    key: "1" },
  { id: "banis",  label: "Banis",  icon: "book",    key: "2" },
  { id: "search", label: "Search", icon: "search",  key: "3" },
  { id: "recent", label: "Recent", icon: "clock",   key: "4" },
  { id: "look",   label: "Look",   icon: "palette", key: "5" },
];

export function projectorView({ onExit } = {}) {
  /* tabindex -1: not in the Tab order, but able to hold focus. The slideshow
     needs somewhere to put the keyboard that is not a text field. */
  const root = el("div.proj", { hidden: true, "aria-hidden": "true", tabindex: "-1" });

  /* --- stage ------------------------------------------------------------- */
  const slideGur = el("div.pj-gur.gur");
  const slideTl = el("div.pj-tl");
  const slideEn = el("div.pj-en");
  const slidePa = el("div.pj-pa.gur");
  const slide = el("div.pj-slide", {}, [slideGur, slideTl, slideEn, slidePa]);
  const stageInner = el("div.pj-stage-inner", {}, [slide]);
  const caption = el("div.pj-caption");
  const stage = el("div.pj-stage", {}, [stageInner, caption]);

  /* What the screen shows when it is blanked. An empty screen mid-diwan reads
     as a fault; the Name does not. */
  const blankWord = el("div.pj-blank", { "aria-hidden": "true" },
                       [el("div.pj-blank-word.gur", { text: "ਵਾਹਿਗੁਰੂ" })]);

  /* An off-screen twin of the slide, used to measure candidate type sizes
     without the real one flickering through them. */
  const mGur = el("div.pj-gur.gur");
  const mTl = el("div.pj-tl");
  const mEn = el("div.pj-en");
  const mPa = el("div.pj-pa.gur");
  const measure = el("div.pj-slide.pj-measure", { "aria-hidden": "true" },
                     [mGur, mTl, mEn, mPa]);
  stageInner.append(measure);

  /* --- sidebar ------------------------------------------------------------ */
  const tabStrip = el("div.pj-tabs", { role: "tablist" });
  const panes = {};
  const body = el("div.pj-body");
  const grip = el("div.pj-grip", { role: "separator", "aria-label": "Resize panel" });

  const noticeEl = el("div.pj-notice", { role: "status", hidden: true });
  const side = el("aside.pj-side", { "aria-label": "Projector controls" }, [
    grip,
    el("div.pj-side-head", {}, [tabStrip]),
    noticeEl,
    body,
  ]);
  let noticeTimer = null;
  function notice(text) {
    noticeEl.textContent = text;
    noticeEl.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { noticeEl.hidden = true; }, 6000);
  }

  /* One control for the panel, in one place.
   *
   * There used to be two: a » in the panel's header to hide it, and a tab on
   * the screen edge to bring it back - different buttons, different places,
   * and it read as two things fighting over one job. Now there is a single
   * pull-tab at mid-height that rides on the panel's left edge and travels
   * with it, so the way out is exactly where the way back in will be. */
  const sideToggle = iconBtn("caretsRight", "Hide the panel  ·  S",
                         () => setSide(root.classList.contains("side-closed")),
                         "pj-pull");

  /* --- the bar that is only there when the pointer moves ------------------ */
  const bar = el("div.pj-bar", {}, [
    iconBtn("arrowUp", "Previous line  ·  ←", () => step(-1), "pj-ib"),
    iconBtn("arrowDown", "Next line  ·  →", () => step(1), "pj-ib"),
    iconBtn("circleHalf", "Blank the screen  ·  B", () => toggleBlank(), "pj-ib"),
    iconBtn("xmark", "Leave projector  ·  Esc", () => exit(), "pj-ib"),
  ]);

  root.append(stage, blankWord, side, sideToggle, bar);

  /* --- state -------------------------------------------------------------- */
  let on = false;
  let record = null, what = null;
  let at = 0;                     // index of the line on screen
  let blank = false;
  let fitPx = 64;
  let resizeTimer = null;

  /* ====================================================================== */
  /*  entering and leaving                                                   */
  /* ====================================================================== */

  async function enter(target) {
    if (on) return;
    on = true;
    root.hidden = false;
    root.setAttribute("aria-hidden", "false");
    document.documentElement.classList.add("projecting");
    paintColours();
    setSide(store.get("projSideOpen"), { silent: true });
    setTab(store.get("projTab") || "lines", { silent: true });
    wake();

    /* Deliberately not awaited. Full screen is a nicety that the browser may
       refuse, defer to a user gesture, or - inside an embedded view - never
       settle at all. Awaiting it once left the stage blank forever while the
       promise hung. Getting the words up is the job; the window chrome can
       catch up on its own. */
    document.documentElement.requestFullscreen?.().catch(() => {});

    if (target) await open(target);
    else if (!record) drawIdle();
    else { layout(); showLine(at); }
  }

  function exit() {
    if (!on) return;
    on = false;
    root.hidden = true;
    root.setAttribute("aria-hidden", "true");
    document.documentElement.classList.remove("projecting");
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    onExit?.(what);
  }

  /* ====================================================================== */
  /*  what is on the stage                                                   */
  /* ====================================================================== */

  async function open(target) {
    const next = { type: target.type, id: target.id };
    let loaded;
    try {
      loaded = await loadRecord(next);
    } catch {
      // Keep what is on the screen. The hall sees the stage, so the failure
      // is told to the operator in the panel, not projected over the Gurbani.
      notice(navigator.onLine
        ? "Could not open that — the connection may have dropped."
        : "Not available offline. Download everything from Look → Offline next time you are connected.");
      if (!record) drawIdle();
      return;
    }
    what = next;
    record = loaded;

    store.pushHistory({
      type: what.type, id: what.id, title: record.title,
      subtitle: record.subtitle || null,
      gurmukhi: record.gurTitle || nameLine(record),
    });

    const i = target.focusLine != null
      ? Math.max(0, record.lines.findIndex((l) => l.key === target.focusLine))
      : 0;
    at = i;
    layout();
    showLine(at);
    drawLines();
    drawRecent();
  }

  function drawIdle() {
    slideGur.textContent = "";
    slideTl.textContent = "";
    slideEn.textContent = "Search for a line, or pick one from Recent.";
    slidePa.textContent = "";
    caption.textContent = "";
  }

  function showLine(i) {
    if (!record || !record.lines.length) return;
    at = Math.max(0, Math.min(i, record.lines.length - 1));
    const p = store.all;
    const line = record.lines[at];

    slideGur.textContent = p.projLarivaar ? toLarivaar(line.gurmukhi) : line.gurmukhi;
    setLine(slideTl, p.projTranslit && line.translit);
    setLine(slideEn, p.projEn && line.en);
    setLine(slidePa, p.projPa && line.pa);

    caption.hidden = !p.projCaption;
    caption.textContent = [
      record.title,
      `${at + 1} of ${record.lines.length}`,
    ].filter(Boolean).join("   ·   ");

    markCurrentLine();
    if (blank) toggleBlank();      // advancing un-blanks; that is what B is for
  }

  const setLine = (node, text) => {
    node.textContent = text || "";
    node.hidden = !text;
  };

  /**
   * Give the keyboard back to the slideshow.
   *
   * Picking something from the panel is the moment the operator's attention
   * moves back to the screen - so that is the moment →, Space and the
   * clicker must work again. Without this, focus stayed in the search field
   * after a pick, and every arrow moved a text caret nobody could see.
   */
  function handBack() {
    const a = document.activeElement;
    if (a && a !== root && root.contains(a)) a.blur?.();
    if (on) root.focus({ preventScroll: true });
  }

  function step(d) {
    if (!record) return;
    const next = at + d;
    if (next < 0 || next >= record.lines.length) return;
    showLine(next);
  }

  function toggleBlank() {
    blank = !blank;
    root.classList.toggle("blank", blank);
  }

  /* ====================================================================== */
  /*  fitting the type                                                       */
  /* ====================================================================== */

  /**
   * The largest size at which every line of this shabad still fits the stage.
   *
   * Measuring all of them would be wasteful, so the three heaviest lines are
   * measured and the smallest of the three answers wins. Weight is the length
   * of everything that will actually be drawn, which is what drives height.
   */
  function layout() {
    if (!record || !record.lines.length) return;
    const p = store.all;

    /* Measure against the CONTENT box, not the padding box. An absolutely
       positioned child resolves left/right against the padding box, so a
       measuring twin left to size itself came out wider than the real slide
       will ever be - and every line it approved then overflowed. */
    const cs = getComputedStyle(stageInner);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const availW = stageInner.clientWidth - padX;
    const avail = (stageInner.clientHeight - padY) * 0.98 * (p.projScale || 1);
    if (avail <= 0 || availW <= 0) return;
    measure.style.width = `${availW}px`;

    const weigh = (l) =>
      (l.gurmukhi || "").length * 2.2 +
      (p.projTranslit ? (l.translit || "").length : 0) * 0.8 +
      (p.projEn ? (l.en || "").length : 0) * 0.8 +
      (p.projPa ? (l.pa || "").length : 0) * 1.0;

    const worst = [...record.lines].sort((a, b) => weigh(b) - weigh(a)).slice(0, 3);

    let best = 220;
    for (const line of worst) {
      mGur.textContent = p.projLarivaar ? toLarivaar(line.gurmukhi) : line.gurmukhi;
      setLine(mTl, p.projTranslit && line.translit);
      setLine(mEn, p.projEn && line.en);
      setLine(mPa, p.projPa && line.pa);

      let lo = 14, hi = 220;
      for (let i = 0; i < 11; i++) {
        const mid = (lo + hi) / 2;
        measure.style.setProperty("--pg", `${mid}px`);
        if (measure.scrollHeight <= avail) lo = mid; else hi = mid;
      }
      best = Math.min(best, lo);
    }

    fitPx = Math.max(14, best);
    slide.style.setProperty("--pg", `${fitPx}px`);
  }

  /* ====================================================================== */
  /*  the sidebar                                                            */
  /* ====================================================================== */

  function setSide(open, { silent } = {}) {
    // Out of the panel BEFORE it becomes inert. Browsers disagree about what
    // happens to focus inside a subtree that turns inert - Chrome moves it to
    // the body, Safari can leave it where it was - and "where it was" is a
    // hidden search field that then eats every arrow key. Do not leave it to
    // the browser.
    if (!open) handBack();
    root.classList.toggle("side-closed", !open);
    sideToggle.innerHTML = open ? Icons.caretsRight : Icons.caretsLeft;
    sideToggle.setAttribute("aria-label", open ? "Hide the panel  ·  S" : "Show the panel  ·  S");
    sideToggle.title = sideToggle.getAttribute("aria-label");
    /* Moved off screen by a transform, the panel is still in the layout and
       still focusable. `inert` is what actually takes it out of reach, so
       nothing inside it can pull itself back into view. */
    side.inert = !open;
    if (!silent) { store.set("projSideOpen", !!open); wake(); }
    // The stage narrows, so the fitted size is no longer the right one. Wait
    // for the slide transition to finish before measuring against it.
    setTimeout(layout, 260);
  }

  function setTab(id, { silent } = {}) {
    store.set("projTab", id);
    /* Asking for a tab means asking to see it. Without this, `3` for Search
       left the panel closed and then focused a field inside it, and the
       browser scrolled the panel into view to reveal the focus - so it looked
       open while the state, the button and the handle all still said closed. */
    if (!silent && root.classList.contains("side-closed")) setSide(true);
    [...tabStrip.children].forEach((b) =>
      b.setAttribute("aria-selected", String(b.dataset.tab === id)));
    Object.entries(panes).forEach(([k, node]) => { node.hidden = k !== id; });
    if (id === "search" && !silent) setTimeout(() => qInput.focus(), 30);
    if (id === "recent") drawRecent();
    if (id === "banis") drawBanis();
    if (id === "lines") markCurrentLine();
  }

  TABS.forEach((t) => tabStrip.append(el("button.pj-tab", {
    role: "tab", dataset: { tab: t.id }, "aria-selected": "false",
    title: `${t.label}  ·  ${t.key}`,
    onclick: () => setTab(t.id),
  }, [
    el("span.pj-tab-icon", { html: Icons[t.icon] || "" }),
    el("span", { text: t.label }),
  ])));

  /* --- Lines -------------------------------------------------------------- */
  const linesList = el("div.pj-list");
  panes.lines = el("div.pj-pane", {}, [linesList]);

  function drawLines() {
    clear(linesList);
    if (!record) {
      linesList.append(el("div.pj-empty", { text: "Nothing open yet." }));
      return;
    }
    record.lines.forEach((line, i) => {
      linesList.append(el("button.pj-line", {
        dataset: { i: String(i) },
        "aria-current": "false",
        onclick: () => { showLine(i); handBack(); },
      }, [
        el("span.pj-line-n", { text: String(i + 1) }),
        el("span.pj-line-gur.gur", { text: line.gurmukhi }),
      ]));
    });
    markCurrentLine();
  }

  function markCurrentLine() {
    const rows = linesList.children;
    for (const r of rows) r.setAttribute("aria-current", String(+r.dataset.i === at));
    rows[at]?.scrollIntoView({ block: "nearest" });
  }

  /* --- Banis ---------------------------------------------------------------
   * The catalogue, so a bani can be put on the screen without leaving
   * projector mode. Opening one goes through the same open() as everything
   * else, so it lands in Recent too.
   */
  const baniFilter = el("input", {
    type: "search", spellcheck: "false", autocomplete: "off",
    placeholder: "Filter banis", "aria-label": "Filter banis",
    oninput: () => drawBanis(),
    onkeydown: (e) => {
      if (e.key === "Escape" && baniFilter.value) {
        e.preventDefault(); e.stopPropagation();
        baniFilter.value = ""; drawBanis();
      } else if (e.key !== "Escape") e.stopPropagation();
    },
  });
  const baniList = el("div.pj-list");
  panes.banis = el("div.pj-pane", {}, [
    el("div.pj-field", {}, [
      el("span.pj-field-icon", { html: Icons.search }), baniFilter,
    ]),
    baniList,
  ]);

  let allBanis = null;
  async function drawBanis() {
    if (!allBanis) {
      baniList.replaceChildren(el("div.pj-empty", { text: "Loading…" }));
      allBanis = (await getMeta()).banis || [];
    }
    const q = baniFilter.value.trim().toLowerCase();
    const shown = allBanis.filter((b) =>
      !q || baniName(b).toLowerCase().includes(q) ||
      (b.unicode || "").includes(baniFilter.value.trim()));

    clear(baniList);
    if (!shown.length) {
      baniList.append(el("div.pj-empty", { text: "No bani by that name." }));
      return;
    }
    shown.forEach((b) => {
      baniList.append(el("button.pj-recent", {
        onclick: () => { open({ type: "bani", id: b.bani_id }); handBack(); },
      }, [
        el("div.pj-recent-gur.gur", { text: b.unicode || "" }),
        el("div.pj-recent-meta", { text: baniName(b) }),
      ]));
    });
  }

  /* --- Search ------------------------------------------------------------- */
  const qInput = el("input", {
    type: "search", spellcheck: "false", autocomplete: "off",
    placeholder: "First letter of each word",
    "aria-label": "Search Gurbani",
    class: "pj-gur-input",
    oninput: () => { normaliseField(); runQuery(); },
    onkeydown: onQueryKey,
  });
  const qMeta = el("div.pj-meta");
  const qResults = el("div.pj-list");
  const qKeys = el("div.pj-keys");
  const kbToggle = iconBtn("keyboard", "Show or hide the keyboard",
                           () => { store.toggle("projKeyboard"); drawKeys(); }, "pj-ib");

  panes.search = el("div.pj-pane.pj-pane-search", {}, [
    el("div.pj-field", {}, [
      el("span.pj-field-icon", { html: Icons.search }),
      qInput,
      kbToggle,
    ]),
    qMeta, qResults, qKeys,
  ]);

  /* The field shows Gurmukhi, whatever was typed.
   *
   * On a physical keyboard the operator types Latin - j k r - because that is
   * the encoding the index is built on. But the sangat can see this panel, and
   * "jkr" means nothing to them. So every keystroke is folded to the index
   * form and the field is redrawn in Gurmukhi: type j, see ਜ. One letter is
   * one codepoint (the nukta letters are precomposed), so Backspace removes
   * exactly one letter. */
  function normaliseField() {
    const shown = toGurmukhi(toAscii(qInput.value));
    if (qInput.value !== shown) {
      qInput.value = shown;
      qInput.setSelectionRange?.(shown.length, shown.length);
    }
  }

  let qToken = 0;
  async function runQuery() {
    const mine = ++qToken;
    const letters = toAscii(qInput.value);

    if (letters.length < MIN_LETTERS) {
      qMeta.textContent = "";
      clear(qResults);
      qResults.append(el("div.pj-empty", {
        text: "Two letters is enough to start.",
      }));
      return;
    }

    if (!indexReady()) {
      qMeta.textContent = "Preparing search…";
      clear(qResults);
      const fill = el("div.pj-progress-fill");
      qResults.append(el("div.pj-progress", {}, [fill]));
      try {
        await loadIndex((f) => { fill.style.width = `${Math.round(f * 100)}%`; });
      } catch {
        if (mine !== qToken) return;
        qMeta.textContent = "";
        clear(qResults);
        qResults.append(el("div.pj-empty", {
          text: "Search needs its index, which is not on this device yet. " +
                "Download everything from Look → Offline next time you are connected.",
        }));
        return;
      }
      if (mine !== qToken) return;
    }

    const res = await runSearch(letters, { mode: "anywhere", limit: 80 });
    if (mine !== qToken) return;

    qMeta.textContent = res.total
      ? `${res.capped ? "2000+" : res.total} result${res.total === 1 ? "" : "s"}`
      : "No matches";

    clear(qResults);
    if (!res.rows.length) {
      qResults.append(el("div.pj-empty", { text: "Try fewer letters, or check their order." }));
      return;
    }
    res.rows.forEach((r, i) => {
      qResults.append(el("button.pj-result", {
        dataset: { i: String(i) },
        "aria-selected": String(i === 0),
        onclick: () => {
          open({ type: "shabad", id: r.shabad_id, focusLine: r.verse_id });
          handBack();
        },
      }, [
        el("div.pj-result-gur.gur", { text: r.gurmukhi }),
        el("div.pj-result-meta", { text: r.page_no ? `Ang ${r.page_no}` : "" }),
      ]));
    });
  }

  function onQueryKey(e) {
    // Page up/down do nothing in a one-line field, and they are what a
    // presentation clicker sends. Let them through to the slideshow.
    if (e.key === "PageDown" || e.key === "PageUp") return;
    const rows = [...qResults.querySelectorAll(".pj-result")];
    const cur = rows.findIndex((n) => n.getAttribute("aria-selected") === "true");
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); e.stopPropagation();
      if (!rows.length) return;
      const next = Math.max(0, Math.min(rows.length - 1,
        (cur < 0 ? 0 : cur) + (e.key === "ArrowDown" ? 1 : -1)));
      rows.forEach((n, i) => n.setAttribute("aria-selected", String(i === next)));
      rows[next].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault(); e.stopPropagation();
      (rows[cur < 0 ? 0 : cur])?.click();
    } else if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      if (qInput.value) { qInput.value = ""; runQuery(); } else qInput.blur();
    } else {
      // Everything else typed in the field belongs to the field, not to the
      // slideshow: space must be able to be a space.
      e.stopPropagation();
    }
  }

  function drawKeys() {
    clear(qKeys);
    const showing = store.get("projKeyboard");
    kbToggle.classList.toggle("on", showing);
    qKeys.hidden = !showing;
    if (!showing) return;
    const grid = el("div.pj-keys-grid");
    KB_ROWS.flat().forEach((ch) => {
      grid.append(el("button.pj-key", {
        title: `${LETTER_NAMES[ch] || ch} — the “${ch}” key`,
        onclick: () => { qInput.value += A2U[ch] || ch; normaliseField(); runQuery(); qInput.focus(); },
      }, [
        el("span.pj-key-g.gur", { text: A2U[ch] || ch }),
        el("span.pj-key-a", { text: ch }),
      ]));
    });
    const back = el("button.pj-key.pj-key-wide", {
      title: "Delete the last letter",
      onclick: () => {
        qInput.value = qInput.value.slice(0, -1); runQuery(); qInput.focus();
      },
    }, [el("span.pj-key-a", { text: "⌫" })]);
    const clr = el("button.pj-key.pj-key-wide", {
      title: "Clear",
      onclick: () => { qInput.value = ""; runQuery(); qInput.focus(); },
    }, [el("span.pj-key-a", { text: "clear" })]);
    qKeys.append(grid, el("div.pj-keys-row", {}, [back, clr]));
  }

  /* --- Recent ------------------------------------------------------------- */
  const recentList = el("div.pj-list");
  panes.recent = el("div.pj-pane", {}, [
    el("div.pj-note", { text: "Everything opened in the last 24 hours." }),
    recentList,
  ]);

  function drawRecent() {
    clear(recentList);
    const items = store.recentHistory();
    if (!items.length) {
      recentList.append(el("div.pj-empty", {
        text: "Nothing yet. What you open appears here.",
      }));
      return;
    }
    items.forEach((h) => {
      recentList.append(el("button.pj-recent", {
        onclick: () => {
          open({ type: h.type, id: h.id, focusLine: h.focusLine ?? null });
          handBack();
        },
      }, [
        el("div.pj-recent-gur.gur", { text: h.gurmukhi || h.title || "" }),
        el("div.pj-recent-meta", {
          text: [h.title, ago(h.at)].filter(Boolean).join("   ·   "),
        }),
      ]));
    });
  }

  function ago(t) {
    const m = Math.round((Date.now() - (t || 0)) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h === 1 ? "an hour ago" : `${h} hours ago`;
  }

  /* --- Look ---------------------------------------------------------------- */
  panes.look = el("div.pj-pane.pj-pane-look");
  buildLook();

  function buildLook() {
    const pane = panes.look;
    clear(pane);

    pane.append(el("div.pj-group-title", { text: "Colour" }));
    const sw = el("div.pj-swatches");
    PROJ_PRESETS.forEach((pr) => {
      sw.append(el("button.pj-swatch", {
        title: pr.label, "aria-label": pr.label,
        "aria-pressed": String(store.get("projPreset") === pr.id),
        style: { background: pr.bg, color: pr.ink },
        text: "ੴ",
        onclick: () => {
          store.update({ projPreset: pr.id, projBg: pr.bg, projInk: pr.ink });
          paintColours(); buildLook();
        },
      }));
    });
    pane.append(sw);

    pane.append(el("div.pj-colours", {}, [
      colourField("Background", "projBg"),
      colourField("Text", "projInk"),
    ]));

    /* The face. Each tile is set in the face it names, so the choice is made
       by looking, not by reading names. Sant Lipi stays the default. */
    pane.append(el("div.pj-group-title", { text: "Gurmukhi font" }));
    const fonts = el("div.pj-fonts");
    FONTS.forEach((ft) => {
      fonts.append(el("button.pj-font", {
        "aria-pressed": String((store.get("projFont") || "Sant Lipi") === ft.value),
        title: `${ft.label} · ${ft.note}`,
        onclick: () => {
          store.set("projFont", ft.value);
          paintColours(); buildLook();
          refitWhenLoaded(ft.value);
        },
      }, [
        el("span.pj-font-sample", { text: "ਸਤਿ ਨਾਮੁ",
                                     style: { fontFamily: `"${ft.value}"` } }),
        el("span.pj-font-name", { text: ft.label }),
      ]));
    });
    pane.append(fonts);
    pane.append(seg("Weight", WEIGHTS.map((w) => ({ value: w.value, label: w.label })),
      store.get("projWeight"),
      (v) => { store.set("projWeight", v); paintColours(); layout(); showLine(at); }));

    /* Sizes, one per kind of text.
       Gurbani is a share of the screen - 100% is as large as this shabad
       allows. The rest are relative to it, so each can be taken up or down on
       its own; making one larger shrinks the Gurbani just enough that
       everything still fits, because nothing on a projector may fall off the
       bottom. */
    pane.append(el("div.pj-group-title", { text: "Size" }));
    pane.append(range({
      label: "Gurbani", min: 40, max: 100, step: 1,
      value: Math.round((store.get("projScale") || 1) * 100),
      format: (v) => (v === 100 ? "Fill" : `${v}%`),
      onInput: (v) => { store.set("projScale", v / 100); layout(); },
    }));
    [
      ["Transliteration", "projTlScale"],
      ["English", "projEnScale"],
      ["Punjabi", "projPaScale"],
    ].forEach(([label, key]) => pane.append(range({
      label, min: 50, max: 200, step: 5,
      value: Math.round((store.get(key) || 1) * 100),
      format: (v) => `${v}%`,
      onInput: (v) => { store.set(key, v / 100); paintColours(); layout(); },
    })));
    pane.append(el("button.pj-reset", {
      text: "Reset sizes",
      onclick: () => {
        store.update({ projScale: 1, projTlScale: 1, projEnScale: 1, projPaScale: 1 });
        paintColours(); layout(); buildLook();
      },
    }));

    pane.append(el("div.pj-group-title", { text: "Layout" }));
    pane.append(seg("Alignment", [
      { value: "center", label: "Centred" },
      { value: "start", label: "Natural" },
    ], store.get("projAlign"), (v) => { store.set("projAlign", v); paintColours(); }));

    pane.append(el("div.pj-group-title", { text: "Show with each line" }));
    pane.append(
      toggle("Transliteration", "projTranslit"),
      toggle("English translation", "projEn"),
      toggle("Punjabi translation", "projPa"),
      toggle("Larivaar", "projLarivaar"),
      toggle("Caption at the foot", "projCaption"),
    );

    // The hall is where offline matters most, so the control lives here too,
    // not only in Settings behind the projector.
    pane.append(el("div.pj-group-title", { text: "Offline" }), offlinePanel());

    pane.append(el("div.pj-group-title", { text: "Keys" }));
    [
      ["→  ␣  ⇟", "Next line"],
      ["←  ⇞", "Previous line"],
      ["B", "Blank the screen — ਵਾਹਿਗੁਰੂ"],
      ["S", "Show or hide this panel"],
      ["1 – 5", "Lines · Banis · Search · Recent · Look"],
      ["/", "Jump to search"],
      ["+  −", "Text size"],
      ["Esc", "Leave projector"],
    ].forEach(([k, w]) => pane.append(el("div.pj-keyrow", {}, [
      el("span", { text: w }),
      el("span.pj-kbd", { text: k }),
    ])));
  }

  function colourField(label, key) {
    const input = el("input.pj-colour", {
      type: "color", value: store.get(key), "aria-label": label,
      oninput: (e) => {
        store.update({ [key]: e.target.value, projPreset: "custom" });
        paintColours();
      },
    });
    return el("label.pj-colour-row", {}, [el("span", { text: label }), input]);
  }

  function toggle(label, key) {
    const b = el("button.pj-toggle", {
      role: "switch", "aria-checked": String(!!store.get(key)),
      onclick: () => {
        const next = !store.get(key);
        store.set(key, next);
        b.setAttribute("aria-checked", String(next));
        layout(); showLine(at);
      },
    }, [el("span", { text: label }), el("span.pj-switch")]);
    return b;
  }

  function range({ label, min, max, step, value, format, onInput }) {
    const out = el("span.pj-range-v", { text: format ? format(value) : String(value) });
    return el("div.pj-range", {}, [
      el("div.pj-range-lab", {}, [el("span", { text: label }), out]),
      el("input.pj-slider", {
        type: "range", min, max, step, value, "aria-label": label,
        oninput: (e) => {
          const v = Number(e.target.value);
          out.textContent = format ? format(v) : String(v);
          onInput(v);
        },
      }),
    ]);
  }

  function seg(label, options, value, onchange) {
    const wrap = el("div.pj-seg", { role: "group", "aria-label": label });
    options.forEach((o) => {
      const b = el("button", {
        text: o.label, "aria-pressed": String(o.value === value),
        onclick: () => {
          [...wrap.children].forEach((c) => c.setAttribute("aria-pressed", "false"));
          b.setAttribute("aria-pressed", "true");
          onchange(o.value);
        },
      });
      wrap.append(b);
    });
    return el("div.pj-range", {}, [
      el("div.pj-range-lab", {}, [el("span", { text: label })]), wrap,
    ]);
  }

  /* ====================================================================== */
  /*  colours                                                                */
  /* ====================================================================== */

  function paintColours() {
    const bg = store.get("projBg") || "#000";
    const ink = store.get("projInk") || "#fff";
    root.style.setProperty("--proj-bg", bg);
    root.style.setProperty("--proj-ink", ink);
    root.style.setProperty("--proj-align",
      store.get("projAlign") === "start" ? "start" : "center");
    /* On the stage only, not on .proj as a whole. A heavier face carries
       further through a lamp than a larger light one - but the control means
       "the Gurbani being projected", so the panel's own lists stay regular
       and the reader behind is untouched either way. */
    const w = String(store.get("projWeight") || 400);
    const f = `"${store.get("projFont") || "Sant Lipi"}"`;
    for (const node of [stage, blankWord]) {
      node.style.setProperty("--gur-weight", w);
      node.style.setProperty("--gur-font", f);
    }
    root.style.setProperty("--pj-tl", String(store.get("projTlScale") || 1));
    root.style.setProperty("--pj-en", String(store.get("projEnScale") || 1));
    root.style.setProperty("--pj-pa", String(store.get("projPaScale") || 1));
    // Glass, hairlines and hover states have to flip with the background, or
    // the panel is invisible on Paper and blinding on Black.
    root.dataset.lum = isDarkColour(bg) ? "dark" : "light";
  }

  /* ====================================================================== */
  /*  keyboard                                                               */
  /* ====================================================================== */

  function handleKey(e) {
    if (!on) return false;
    /* "Typing" means a text field the operator can actually see. A slider or
       colour well with focus is not typing - the arrows belong to the slides
       - and nothing inside a closed panel is typing, whatever the browser
       thinks has focus. */
    const t = e.target;
    const textual = t.tagName === "TEXTAREA" ||
      (t.tagName === "INPUT" && /^(search|text|)$/.test(t.type || ""));
    const typing = textual && !root.classList.contains("side-closed");
    const mod = e.metaKey || e.ctrlKey;

    if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault(); setTab("search"); qInput.focus(); qInput.select(); return true;
    }
    if (e.key === "Escape") { e.preventDefault(); exit(); return true; }
    if (typing && e.key !== "PageDown" && e.key !== "PageUp") return true;

    switch (e.key) {
      case "ArrowRight": case "ArrowDown": case "PageDown": case " ":
      case "Enter":
        e.preventDefault(); step(1); return true;
      case "ArrowLeft": case "ArrowUp": case "PageUp": case "Backspace":
        e.preventDefault(); step(-1); return true;
      case "Home": e.preventDefault(); showLine(0); return true;
      case "End":
        e.preventDefault(); showLine((record?.lines.length || 1) - 1); return true;
      case "+": case "=":
        e.preventDefault(); nudgeScale(+0.05); return true;
      case "-": case "_":
        e.preventDefault(); nudgeScale(-0.05); return true;
      default: break;
    }

    const k = e.key.toLowerCase();
    if (k === "b") { e.preventDefault(); toggleBlank(); return true; }
    if (k === "s") { e.preventDefault(); setSide(root.classList.contains("side-closed")); return true; }
    if (k === "l") { e.preventDefault(); store.toggle("projLarivaar"); layout(); showLine(at); buildLook(); return true; }
    if (k === "/") { e.preventDefault(); setTab("search"); qInput.focus(); return true; }
    if (k === "f") {
      e.preventDefault();
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      else document.documentElement.requestFullscreen?.().catch(() => {});
      return true;
    }
    const tab = TABS.find((t) => t.key === e.key);
    if (tab) { e.preventDefault(); setTab(tab.id); return true; }
    return true;   // projector mode swallows the rest rather than leaking keys
  }

  /* A face downloads the first time it is used, and measuring before it
     arrives fits the fallback font instead - then the real one lands larger
     and overflows. So fit now, and again once the browser has it. */
  function refitWhenLoaded(family) {
    layout(); showLine(at);
    document.fonts?.load?.(`400 48px "${family}"`, "ਸਤਿ")
      .then(() => { layout(); showLine(at); })
      .catch(() => {});
  }

  function nudgeScale(d) {
    // Rounded, or repeated nudges drift into 0.9500000000000001.
    const v = Math.round(
      Math.max(0.4, Math.min(1, (store.get("projScale") || 1) + d)) * 100) / 100;
    store.set("projScale", v);
    layout();
    buildLook();
  }

  /* ====================================================================== */
  /*  chrome that fades                                                      */
  /* ====================================================================== */

  let wakeTimer = null;
  function wake() {
    if (!on) return;
    root.classList.add("live");
    clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => root.classList.remove("live"), 2400);
  }
  root.addEventListener("mousemove", wake);

  // Clicking the projected line is the universal "give me the keyboard back".
  stage.addEventListener("mousedown", () => handBack());
  blankWord.addEventListener("mousedown", () => handBack());

  /* --- resizing the panel -------------------------------------------------- */
  grip.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = store.get("projSideWidth") || 400;
    const move = (ev) => {
      const w = Math.round(Math.min(680, Math.max(320, startW - (ev.clientX - startX))));
      root.style.setProperty("--proj-side-w", `${w}px`);
      grip.dataset.w = String(w);
    };
    const up = () => {
      if (grip.dataset.w) store.set("projSideWidth", Number(grip.dataset.w));
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      layout();
    };
    document.body.style.cursor = "col-resize";
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });

  window.addEventListener("resize", () => {
    if (!on) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => layout(), 120);
  });

  /* --- first paint of the panel -------------------------------------------- */
  body.append(panes.lines, panes.banis, panes.search, panes.recent, panes.look);
  root.style.setProperty("--proj-side-w", `${store.get("projSideWidth") || 400}px`);
  paintColours();
  drawKeys();
  runQuery();
  drawLines();
  drawRecent();
  drawBanis();

  return {
    root,
    enter, exit, open,
    isOn: () => on,
    handleKey,
    showing: () => what,
  };
}
