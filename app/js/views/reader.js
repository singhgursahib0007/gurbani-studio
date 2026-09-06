/* The reading pane.
 *
 * One surface, two sources (a bani or a shabad), normalised to the same shape
 * so the rendering has no idea which it is showing.
 *
 * Desktop differences from the phone: the column holds a measured width rather
 * than filling the pane, every line has a star that appears on hover, and a
 * right-click gives the same actions without one. Nothing is hidden behind a
 * gesture, because on a desktop there are none to discover.
 */

import { el, clear, iconBtn, toast, contextMenu } from "../ui.js";
import { Icons } from "../icons.js";
import { store } from "../store.js";
import { getBani, getShabad, toLarivaar } from "../data.js";
import { BANI_INFO } from "../banis-info.js";

const isHeading = (t = "") => /ਮਹਲਾ|ਮਃ/.test(t) && t.length < 40;

/* The bani record's id key depends on where it came from: the local API
 * returns the database column `bani_id`, while BaniDB's own payload calls it
 * `baniID`. Accept either, or the curated name silently never matches and the
 * reader falls back to the raw transliteration. */
const baniEnglish = (info) => {
  const id = info.bani_id ?? info.baniID;
  return (BANI_INFO[id] && BANI_INFO[id].name) || info.english || "Bani";
};

export function readerPane({ onSaveChanged, onToggleList, onImmersive }) {
  const root = el("div.pane.reader-pane");

  const where = el("div.reader-where", { text: "" });
  const saveBtn = iconBtn("bookmark", "Save this shabad", () => toggleSaveWhole());
  const autoBtn = iconBtn("play", "Auto-scroll", () => toggleAuto());
  const listBtn = iconBtn("list", "Show or hide the list", () => onToggleList?.());
  const immBtn = iconBtn("arrowsOut", "Immersive reading  ·  F", () => onImmersive?.());
  const bar = el("div.reader-bar", {}, [
    listBtn,
    where,
    el("div.spacer"),
    autoBtn,
    saveBtn,
    immBtn,
  ]);

  const progress = el("div.reader-progress");
  const scroller = el("div.reader-scroll");
  const doc = el("div.reader-doc");
  scroller.append(doc);

  /* Immersive furniture: a title that names what you are reading and a small
     control cluster, both of which appear on movement and fade when the
     pointer settles. */
  const immTitle = el("div.immersive-title", { text: "" });
  const immControls = el("div.immersive-controls");
  root.append(bar, progress, immTitle, scroller, immControls);

  let type = null, id = null, focusLine = null;
  let record = null, revealed = false, restored = false;
  let speedPill = null, auto = false, rafId = null, carry = 0, lastT = 0;
  let saveTimer = null;

  showIdle();

  /* ------------------------------------------------------------- open --- */
  async function open(next) {
    stopAuto();
    ({ type, id } = next);
    focusLine = next.focusLine ?? null;
    revealed = false; restored = false;

    clear(doc);
    doc.append(el("div.empty", {}, [
      el("div", { html: Icons.book }), el("h3", { text: "Opening…" }),
    ]));

    record = type === "bani"
      ? normaliseBani(await getBani(id))
      : normaliseShabad(await getShabad(id));

    where.textContent = record.title;
    immTitle.textContent = record.title;
    store.set("lastRead", { type, id, title: record.title, at: Date.now() });
    render();
    updateSaveBtn();
    setTimeout(() => { reveal(); restore(); }, 60);
  }

  function showIdle() {
    clear(doc);
    doc.append(el("div.empty", { style: { minHeight: "60vh" } }, [
      el("div", { html: Icons.book }),
      el("h3", { text: "Nothing open" }),
      el("p", { text: "Choose a bani, or search for a line." }),
    ]));
  }

  /* ---------------------------------------------------------- render --- */
  function render() {
    if (!record) return;
    const p = store.all;
    clear(doc);

    doc.append(el("header.doc-head", {}, [
      record.gurTitle
        ? el("div.gur", { text: record.gurTitle })
        : el("h1", { text: record.title }),
      record.subtitle && el("div.sub", { text: record.subtitle }),
    ].filter(Boolean)));

    record.lines.forEach((line, index) => {
      line.index = index;
      const box = el("div.line" + (line.isHeader ? ".is-header" : ""), {
        dataset: { key: line.key != null ? String(line.key) : "", i: String(index) },
      });
      const add = (...n) => box.append(...n.filter(Boolean));

      add(el("div.gur", {
        text: p.larivaar ? toLarivaar(line.gurmukhi) : line.gurmukhi,
      }));
      if (p.transliteration && line.translit) add(el("div.tl", { text: line.translit }));
      if (p.translationEn && line.en)
        add(el("div.tr", { text: line.en }),
            p.showAttribution && el("div.who", { text: "English" }));
      if (p.translationEnAlt && line.enAlt)
        add(el("div.tr", { text: line.enAlt }),
            p.showAttribution && el("div.who", { text: "Manmohan Singh" }));
      if (p.translationPa && line.pa)
        add(el("div.tr.pa", { text: line.pa }),
            p.showAttribution && el("div.who", { text: "Prof. Sahib Singh" }));

      if (box.childElementCount === 1) box.classList.add("is-bare");
      if (focusLine != null && line.key === focusLine) box.classList.add("is-focus");

      if (line.key == null) { doc.append(box); return; }

      const saved = store.isSaved(lineKey(line));
      if (saved) box.classList.add("is-saved");

      const star = el("button", {
        class: `line-star ${saved ? "on" : ""}`,
        html: saved ? Icons.starFill : Icons.star,
        "aria-label": saved ? "Remove this line from Saved" : "Save this line",
        title: saved ? "Remove from Saved" : "Save line",
        onclick: (e) => { e.stopPropagation(); toggleLine(line, box, star); },
      });

      const row = el("div.line-row", {
        oncontextmenu: (e) => {
          e.preventDefault();
          contextMenu(e.clientX, e.clientY, [
            { label: store.isSaved(lineKey(line)) ? "Remove from Saved" : "Save line",
              icon: "starFill", onSelect: () => toggleLine(line, box, star) },
            { label: "Copy line", icon: "copy", onSelect: () => copyLine(line) },
          ]);
        },
      }, [star, box]);
      doc.append(row);
    });
  }

  store.subscribe((_s, keys) => {
    if (!record) return;
    if (keys === "*" || ["larivaar", "transliteration", "translationEn",
      "translationEnAlt", "translationPa", "showAttribution"].some((k) => keys.includes(k))) {
      const y = scroller.scrollTop;
      render();
      scroller.scrollTop = y;
    }
  });

  /* ---------------------------------------------------- saving lines --- */
  const lineKey = (line) =>
    type === "bani" ? `baniline:${id}:${line.key}` : `line:${line.key}`;

  function lineEntry(line) {
    const base = {
      id: lineKey(line), type: "line",
      gurmukhi: line.gurmukhi, translit: line.translit || null, en: line.en || null,
    };
    return type === "bani"
      ? { ...base, baniId: id, seq: line.key, where: record?.title || "" }
      : { ...base, refId: line.key, shabadId: id,
          where: [record?.title, record?.subtitle].filter(Boolean).join(" · ") };
  }

  function toggleLine(line, box, star) {
    const now = store.toggleSaved(lineEntry(line));
    box.classList.toggle("is-saved", now);
    star.classList.toggle("on", now);
    star.innerHTML = now ? Icons.starFill : Icons.star;
    onSaveChanged?.();
    toast(now ? "Line saved" : "Line removed", {
      action: "Undo",
      onAction: () => {
        const back = store.toggleSaved(lineEntry(line));
        box.classList.toggle("is-saved", back);
        star.classList.toggle("on", back);
        star.innerHTML = back ? Icons.starFill : Icons.star;
        onSaveChanged?.();
      },
    });
  }

  async function copyLine(line) {
    const parts = [line.gurmukhi, line.translit, line.en].filter(Boolean);
    try { await navigator.clipboard.writeText(parts.join("\n")); toast("Copied"); }
    catch { toast("Could not copy"); }
  }

  function toggleSaveWhole() {
    if (!record) return;
    const ref =
      (focusLine != null && record.lines.find((l) => l.key === focusLine)) ||
      record.lines.find((l) => !l.isHeader && !isHeading(l.gurmukhi)) ||
      record.lines[0];
    const now = store.toggleSaved({
      id: `${type}:${id}`, type, refId: id, verseId: ref?.key ?? null,
      title: record.gurTitle || record.title,
      subtitle: record.subtitle || null,
      gurmukhi: ref?.gurmukhi || "",
    });
    updateSaveBtn();
    onSaveChanged?.();
    toast(now ? (type === "bani" ? "Bani saved" : "Shabad saved") : "Removed from Saved");
  }

  function updateSaveBtn() {
    const on = type != null && store.isSaved(`${type}:${id}`);
    saveBtn.innerHTML = on ? Icons.bookmarkFill : Icons.bookmark;
    saveBtn.classList.toggle("on", on);
  }

  /* ------------------------------------------------- position & focus --- */
  function reveal() {
    if (revealed || focusLine == null) return;
    const t = doc.querySelector(`.line[data-key="${focusLine}"]`);
    if (!t) return;
    revealed = true;
    jumpTo((t.closest(".line-row") || t).offsetTop - scroller.clientHeight * 0.3);
  }

  function restore() {
    if (restored || focusLine != null) return;
    const saved = store.getProgress(`${type}:${id}`);
    restored = true;
    if (!saved || !saved.line) { scroller.scrollTop = 0; return; }
    const box = doc.querySelector(`.line[data-i="${saved.line}"]`);
    if (box) jumpTo((box.closest(".line-row") || box).offsetTop - 12);
  }

  /* The scroller is set to smooth for auto-scroll, and scrollTo({behavior:
     "auto"}) means "use the CSS value", not "instantly". So smooth is
     switched off around a jump - which also works on Safari versions
     predating behavior: "instant". */
  function jumpTo(top) {
    scroller.classList.add("no-smooth");
    scroller.scrollTop = Math.max(0, top);
    void scroller.scrollTop;
    scroller.classList.remove("no-smooth");
  }

  scroller.addEventListener("scroll", () => {
    const max = scroller.scrollHeight - scroller.clientHeight;
    progress.style.width = max > 0 ? `${(scroller.scrollTop / max) * 100}%` : "0";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!record) return;
      store.setProgress(`${type}:${id}`, topLine());
    }, 450);
  }, { passive: true });

  function topLine() {
    const y = scroller.scrollTop + 8;
    for (const box of doc.querySelectorAll(".line[data-i]")) {
      const e = box.closest(".line-row") || box;
      if (e.offsetTop + e.offsetHeight > y) return Number(box.dataset.i);
    }
    return 0;
  }

  /* -------------------------------------------------------- autoscroll --- */
  function toggleAuto() { auto ? stopAuto() : startAuto(); }

  function startAuto() {
    if (!record) return;
    auto = true;
    autoBtn.innerHTML = Icons.pause;
    autoBtn.classList.add("on");
    scroller.classList.add("no-smooth");
    showSpeed();
    lastT = performance.now(); carry = 0;
    const step = (t) => {
      if (!auto) return;
      const dt = Math.min(64, t - lastT); lastT = t;
      const px = 3.75 + 1.15 * store.get("autoScrollSpeed");
      carry += (px * dt) / 1000;
      const whole = Math.floor(carry);
      if (whole >= 1) {
        carry -= whole;
        const before = scroller.scrollTop;
        scroller.scrollTop = before + whole;
        if (scroller.scrollTop === before) { stopAuto(); return; }
      }
      rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
  }

  function stopAuto() {
    auto = false;
    cancelAnimationFrame(rafId);
    autoBtn.innerHTML = Icons.play;
    autoBtn.classList.remove("on");
    scroller.classList.remove("no-smooth");
    speedPill?.remove(); speedPill = null;
  }

  function showSpeed() {
    if (speedPill) return;
    speedPill = el("div.speed", {}, [
      el("span", { html: Icons.scroll, style: { display: "flex" } }),
      el("input.slider", {
        type: "range", min: 5, max: 100, step: 1,
        value: store.get("autoScrollSpeed"), "aria-label": "Auto-scroll speed",
        oninput: (e) => store.set("autoScrollSpeed", Number(e.target.value)),
      }),
    ]);
    root.append(speedPill);
  }

  return {
    root, open, showIdle,
    controls: immControls,
    setImmersiveTitle: (t) => { immTitle.textContent = t; },
    title: () => record?.title || "",
    isOpen: () => record != null,
    toggleAuto, toggleSaveWhole,
    scrollBy: (dy) => { scroller.scrollTop += dy; },
    refreshStars: () => { if (record) { const y = scroller.scrollTop; render(); scroller.scrollTop = y; updateSaveBtn(); } },
  };
}

/* ------------------------------------------------------------ shaping --- */
function normaliseBani(d) {
  const info = d.bani || {};
  return {
    title: baniEnglish(info),
    gurTitle: info.unicode || null,
    subtitle: baniEnglish(info) || null,
    lines: (d.verses || []).map((v, i) => ({
      key: v.seq != null ? v.seq : i,
      gurmukhi: v.gurmukhi, translit: v.translit_en,
      en: v.translation_en, enAlt: null, pa: v.translation_pu,
      isHeader: !!v.is_header,
    })),
  };
}

function normaliseShabad(d) {
  const s = d.shabad || {};
  return {
    title: s.page_no ? `Ang ${s.page_no}` : "Shabad",
    gurTitle: null,
    subtitle: [s.writer, s.raag].filter(Boolean).join(" · ") || null,
    lines: (d.verses || []).map((v) => {
      const t = v.translation || {};
      return {
        key: v.verse_id, gurmukhi: v.gurmukhi, translit: v.translit_en,
        en: t.en?.bdb || t.en?.ssk || null, enAlt: t.en?.ms || null,
        pa: t.pu?.ss || null, isHeader: false,
      };
    }),
  };
}
