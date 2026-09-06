/* Settings, as popovers anchored to the control that opened them.
 *
 * Split in two on purpose: what the page looks like is a different question
 * from what the app does, and a reader adjusting type size should not have to
 * scroll past reset buttons to reach it.
 */

import { el, popover, popItem, switchRow, sliderRow, segmented, toast, MOD } from "../ui.js";
import { Icons } from "../icons.js";
import { store, DEFAULTS, FONTS, WEIGHTS, THEMES } from "../store.js";

const pct = (v) => `${Math.round(v * 100)}%`;

/** Theme, Gurmukhi face, weight, sizes, alignment, measure. */
export function openAppearance(anchor) {
  popover(anchor, (pop) => {
    pop.append(el("div.pop-title", { text: "Theme" }));
    const sw = el("div.swatches");
    THEMES.forEach((t) => {
      const b = el("button.swatch", {
        text: "Aa", "aria-label": t.label, title: t.label,
        "aria-pressed": String(store.get("theme") === t.value),
        style: { background: t.bg, color: t.fg },
        onclick: () => {
          [...sw.children].forEach((c) => c.setAttribute("aria-pressed", "false"));
          b.setAttribute("aria-pressed", "true");
          store.set("theme", t.value);
        },
      });
      sw.append(b);
    });
    pop.append(sw, el("div.pop-sep"));

    pop.append(el("div.pop-title", { text: "Gurmukhi" }));
    FONTS.forEach((f) => pop.append(el("button.pop-item", {
      onclick: () => { store.set("gurFont", f.value); refreshTicks(); },
    }, [
      el("div", { style: { flex: "1", minWidth: "0" } }, [
        el("div.gur", { text: "ਸਤਿ ਨਾਮੁ",
          style: { fontFamily: `"${f.value}"`, fontSize: "1.15rem", lineHeight: "1.5" } }),
        el("div.sub", { text: `${f.label} · ${f.note}` }),
      ]),
      el("span.tick", { html: store.get("gurFont") === f.value ? Icons.check : "",
                        dataset: { font: f.value } }),
    ])));

    function refreshTicks() {
      pop.querySelectorAll(".tick[data-font]").forEach((t) => {
        t.innerHTML = t.dataset.font === store.get("gurFont") ? Icons.check : "";
      });
    }

    pop.append(el("div.pop-field", {}, [
      el("div.lab", {}, [el("span", { text: "Weight" })]),
      segmented(WEIGHTS, store.get("gurWeight"),
        (v) => store.set("gurWeight", v), { label: "Gurmukhi weight" }),
    ]));

    pop.append(el("div.pop-sep"), el("div.pop-title", { text: "Size" }));
    pop.append(
      sliderRow({ label: "Gurbani", min: 0.8, max: 2, step: 0.05,
        value: store.get("textScale"), format: pct,
        onInput: (v) => store.set("textScale", v) }),
      sliderRow({ label: "Transliteration", min: 0.7, max: 1.6, step: 0.05,
        value: store.get("translitScale"), format: pct,
        onInput: (v) => store.set("translitScale", v) }),
      sliderRow({ label: "Translation", min: 0.7, max: 1.6, step: 0.05,
        value: store.get("translationScale"), format: pct,
        onInput: (v) => store.set("translationScale", v) }),
      // The measure is the desktop-only control: a wide window should give
      // margins, not a harder read.
      sliderRow({ label: "Column width", min: 28, max: 72, step: 1,
        value: store.get("measure"), format: (v) => `${v}rem`,
        onInput: (v) => store.set("measure", v) }),
    );

    pop.append(el("div.pop-field", {}, [
      el("div.lab", {}, [el("span", { text: "Alignment" })]),
      segmented([{ value: "center", label: "Centred" }, { value: "start", label: "Natural" }],
        store.get("align"), (v) => store.set("align", v), { label: "Alignment" }),
    ]));
  });
}

/** What shows under each line, gestures, and the resets. */
export function openSettings(anchor) {
  popover(anchor, (pop, { close }) => {
    pop.append(el("div.pop-title", { text: "Show with each line" }));
    pop.append(
      switchRow("Transliteration", store.get("transliteration"),
        (v) => store.set("transliteration", v), { sub: "Roman spelling" }),
      switchRow("English", store.get("translationEn"),
        (v) => store.set("translationEn", v)),
      switchRow("English · Manmohan Singh", store.get("translationEnAlt"),
        (v) => store.set("translationEnAlt", v), { sub: "A second English voice" }),
      switchRow("Punjabi · Prof. Sahib Singh", store.get("translationPa"),
        (v) => store.set("translationPa", v)),
      switchRow("Name the translator", store.get("showAttribution"),
        (v) => store.set("showAttribution", v)),
      switchRow("Larivaar", store.get("larivaar"),
        (v) => store.set("larivaar", v), { sub: "Words joined, as in the original" }),
    );

    pop.append(el("div.pop-sep"), el("div.pop-title", { text: "Keyboard" }));
    [
      [`${MOD}K`, "Search"],
      ["↑ ↓ ⏎", "Move through results, open"],
      [`${MOD}B`, "Show or hide the sidebar"],
      [`${MOD}\\`, "Focus mode"],
      [`${MOD}J`, "Start or stop auto-scroll"],
      [`${MOD}S`, "Save what you are reading"],
      [`${MOD}P`, "Command palette"],
    ].forEach(([k, what]) => pop.append(el("button.pop-item", {}, [
      el("div", { style: { flex: "1" } }, [el("div", { text: what })]),
      el("span.kbd", { text: k }),
    ])));

    pop.append(el("div.pop-sep"), el("div.pop-title", { text: "Reset" }));
    pop.append(popItem("Reset appearance", {
      sub: "Theme, fonts and sizes. Keeps your banis and saved lines.",
      icon: "reset",
      onSelect: () => { store.resetAppearance(); close(); toast("Appearance reset"); },
    }));

    /* Two taps rather than a browser dialog: the first turns the row into the
       warning, the second does it. Destructive and irreversible, so it should
       not be one stray click away - but a native confirm() is an ugly way to
       say so. */
    const wipe = el("button.pop-item", {});
    let armed = false;
    const paint = () => {
      wipe.replaceChildren(
        el("span", { html: armed ? Icons.xmark : Icons.reset,
                     style: { display: "flex", color: armed ? "#D9483B" : "" } }),
        el("div", { style: { flex: "1", minWidth: "0" } }, [
          el("div", { text: armed ? "Tap again to erase everything" : "Erase all saved data",
                      style: { color: armed ? "#D9483B" : "", fontWeight: armed ? "600" : "" } }),
          el("div.sub", {
            text: armed
              ? "This cannot be undone"
              : "Preferences, starred banis, saved lines, reading positions",
          }),
        ]),
      );
    };
    paint();
    wipe.onclick = () => {
      if (!armed) {
        armed = true; paint();
        setTimeout(() => { if (armed) { armed = false; paint(); } }, 4000);
        return;
      }
      store.resetEverything();
      // resetEverything writes the defaults back; clear the key outright so
      // nothing of the old state survives in storage either.
      try { localStorage.removeItem("gurbani.studio.v1"); } catch { /* blocked */ }
      close();
      toast("Everything erased");
    };
    pop.append(wipe);

    pop.append(el("div.pop-sep"));
    pop.append(el("div", {
      style: { padding: "8px 10px", fontSize: "var(--t-tiny)",
               color: "var(--label-3)", lineHeight: "1.5" },
      html: "Built by Gursahib Singh<br>" +
            '<a href="mailto:gursahib99888@gmail.com">gursahib99888@gmail.com</a><br>' +
            "Texts by the Khalis Foundation and the translators named above.",
    }));
  });
}

export { DEFAULTS };
