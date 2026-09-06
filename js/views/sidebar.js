/* The sidebar: where you are in the app.
 *
 * Search, the bani catalogue broken out by category, and Saved. Categories are
 * top-level here rather than headings inside a list, because on a desktop the
 * sidebar is always visible and can carry the structure — which leaves the
 * middle pane free to be just a list.
 */

import { el, clear, iconBtn, MOD } from "../ui.js";
import { Icons } from "../icons.js";
import { store } from "../store.js";
import { getMeta } from "../data.js";
import { GROUPS, baniGroup } from "../banis-info.js";

export function sidebar({ onSelect, onSettings, onAppearance }) {
  const root = el("div.pane.sidebar");
  const scroll = el("div.scroll");
  let counts = {}, current = "banis:";

  const bar = el("div.titlebar", {}, [
    el("span", { html: Icons.bookFill,
                 style: { display: "flex", color: "var(--gold)", width: "17px" } }),
    el("div.titlebar-title", { text: "Gurbani Studio" }),
  ]);

  const foot = el("div.side-foot", {}, [
    iconBtn("palette", "Appearance", (e) => onAppearance(e.currentTarget)),
    iconBtn("gear", `Settings  ${MOD},`, (e) => onSettings(e.currentTarget)),
  ]);

  root.append(bar, scroll, foot);

  (async () => {
    const meta = await getMeta();
    const banis = meta.banis || [];
    counts = { "banis:": banis.length };
    GROUPS.forEach((g) => {
      counts[`banis:${g.id}`] = banis.filter((b) => baniGroup(b) === g.id).length;
    });
    render();
  })();

  store.subscribe((_s, k) => {
    if (k === "*" || k.includes("saved")) render();
  });

  function item(key, label, icon, count) {
    return el("button.side-item", {
      "aria-current": String(key === current),
      onclick: () => { setCurrent(key); onSelect(key); },
    }, [
      el("span.side-icon", { html: Icons[icon] || "" }),
      el("span.side-label", { text: label }),
      count != null && el("span.side-count", { text: String(count) }),
    ].filter(Boolean));
  }

  function render() {
    clear(scroll);
    scroll.append(
      el("div.side-section", { text: "Find" }),
      item("search", "Search", "search"),
      item("saved", "Saved", "bookmark", store.get("saved").length || null),
      el("div.side-section", { text: "Banis" }),
      item("banis:", "All banis", "book", counts["banis:"]),
      ...GROUPS.map((g) => item(`banis:${g.id}`, g.label, "list", counts[`banis:${g.id}`])),
    );
  }

  function setCurrent(key) {
    current = key;
    [...scroll.querySelectorAll(".side-item")].forEach((n) => n.setAttribute("aria-current", "false"));
    render();
  }

  return { root, setCurrent };
}
