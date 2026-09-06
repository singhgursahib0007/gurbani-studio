/* DOM helpers and the shared desktop controls.
 *
 * Desktop wants different furniture from a phone: popovers anchored to the
 * control that opened them rather than sheets from the bottom, a context menu,
 * and a command palette. No framework - these are plain functions returning
 * elements.
 */

import { Icons } from "./icons.js";

/** el("div.card", {onclick}, [children | "text"]) */
export function el(spec, props = {}, children = []) {
  const [tag, ...classes] = String(spec).split(".");
  const node = document.createElement(tag || "div");
  if (classes.length) node.className = classes.join(" ");

  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") node.className += (node.className ? " " : "") + v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "text") node.textContent = v;
    else if (k === "style") Object.assign(node.style, v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on") && typeof v === "function")
      node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const clear = (n) => { while (n.firstChild) n.firstChild.remove(); };

export const iconBtn = (name, label, onclick, cls = "ib") =>
  el(`button.${cls}`, { html: Icons[name] || "", "aria-label": label,
                        title: label, onclick });

/** ⌘ on a Mac, Ctrl elsewhere — shown in shortcut hints. */
export const MOD = /Mac|iPhone|iPad/.test(navigator.platform || "") ? "⌘" : "Ctrl";

/* ------------------------------------------------------------- toast ---- */
let toastEl = null, toastTimer = null;

export function toast(message, { action, onAction, ms = 3000 } = {}) {
  clearTimeout(toastTimer);
  toastEl?.remove();
  toastEl = el("div.toast", { role: "status" }, [
    el("span", { text: message }),
    action && el("button", { text: action, onclick: () => { onAction?.(); hide(); } }),
  ].filter(Boolean));
  document.body.append(toastEl);
  requestAnimationFrame(() => toastEl?.classList.add("in"));
  setTimeout(() => toastEl?.classList.add("in"), 40);
  toastTimer = setTimeout(hide, ms);

  function hide() {
    const t = toastEl; if (!t) return;
    toastEl = null; t.classList.remove("in");
    setTimeout(() => t.remove(), 260);
  }
}

/* ----------------------------------------------------------- popover ---- */
/**
 * A panel anchored under the control that opened it, kept inside the window.
 * Closes on outside click, on Escape, and on scroll - anchored things that
 * float away from their anchor look broken.
 */
export function popover(anchor, build, { align = "end" } = {}) {
  const scrim = el("div.pop-scrim");
  const pop = el("div.pop", { role: "dialog" });
  build(pop, { close });
  document.body.append(scrim, pop);

  /* Place it in whichever gap is bigger, and cap its height to that gap so
     the panel always fits on screen and scrolls inside itself. Placing first
     and hoping the content fits leaves the top of a long panel above the
     viewport, where it cannot be scrolled back to. */
  const r = anchor.getBoundingClientRect();
  const gap = 8;
  const below = innerHeight - r.bottom - gap * 2;
  const above = r.top - gap * 2;
  const placeBelow = below >= 260 || below >= above;
  const room = Math.max(180, placeBelow ? below : above);

  pop.style.maxHeight = `${room}px`;
  const w = pop.offsetWidth;
  const h = Math.min(pop.offsetHeight, room);

  let left = align === "end" ? r.right - w : r.left;
  left = Math.max(gap, Math.min(left, innerWidth - w - gap));
  const top = placeBelow
    ? Math.min(r.bottom + 6, innerHeight - h - gap)
    : Math.max(gap, r.top - h - 6);

  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  requestAnimationFrame(() => pop.classList.add("open"));

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    pop.classList.remove("open");
    setTimeout(() => { pop.remove(); scrim.remove(); }, 140);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", onScroll, true);
  }
  function onKey(e) { if (e.key === "Escape") { e.stopPropagation(); close(); } }

  /* Close when the page scrolls out from under the anchor - but NOT when the
     panel scrolls itself. The listener is in the capture phase so it sees
     scrolls from any element, including this one, and closing on those made
     a tall panel impossible to scroll at all. */
  function onScroll(e) { if (!pop.contains(e.target)) close(); }

  scrim.addEventListener("mousedown", close);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", onScroll, true);
  return { close, pop };
}

/* ------------------------------------------------------ context menu ---- */
export function contextMenu(x, y, items) {
  const scrim = el("div.pop-scrim");
  const menu = el("div.menu", { role: "menu" });
  items.filter(Boolean).forEach((it) => {
    menu.append(el("button", {
      role: "menuitem",
      onclick: () => { close(); it.onSelect(); },
    }, [
      it.icon && el("span", { html: Icons[it.icon], style: { display: "flex" } }),
      el("span", { text: it.label }),
    ].filter(Boolean)));
  });
  document.body.append(scrim, menu);
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = `${Math.min(x, innerWidth - w - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - h - 8)}px`;

  function close() {
    menu.remove(); scrim.remove();
    document.removeEventListener("keydown", onKey, true);
  }
  function onKey(e) { if (e.key === "Escape") close(); }
  scrim.addEventListener("mousedown", close);
  document.addEventListener("keydown", onKey, true);
  return { close };
}

/* -------------------------------------------------------- form bits ---- */
export function switchRow(label, checked, onchange, { sub } = {}) {
  const sw = el("button.switch", {
    role: "switch", "aria-checked": String(!!checked), "aria-label": label,
  });
  const row = el("button.pop-item", {}, [
    el("div", { style: { flex: "1", minWidth: "0" } }, [
      el("div", { text: label }),
      sub && el("div.sub", { text: sub }),
    ].filter(Boolean)),
    sw,
  ]);
  const flip = () => {
    const next = sw.getAttribute("aria-checked") !== "true";
    sw.setAttribute("aria-checked", String(next));
    onchange(next);
  };
  sw.addEventListener("click", (e) => { e.stopPropagation(); flip(); });
  row.addEventListener("click", flip);
  return row;
}

export function sliderRow({ label, min, max, step, value, onInput, format }) {
  const out = el("span", { text: format ? format(value) : String(value) });
  return el("div.pop-field", {}, [
    el("div.lab", {}, [el("span", { text: label }), out]),
    el("input.slider", {
      type: "range", min, max, step, value, "aria-label": label,
      oninput: (e) => {
        const v = Number(e.target.value);
        out.textContent = format ? format(v) : String(v);
        onInput(v);
      },
    }),
  ]);
}

export function segmented(options, value, onchange, { label } = {}) {
  const wrap = el("div.segmented", { role: "group", "aria-label": label || "" });
  options.forEach((opt) => {
    const b = el("button", {
      "aria-pressed": String(opt.value === value),
      onclick: () => {
        [...wrap.children].forEach((c) => c.setAttribute("aria-pressed", "false"));
        b.setAttribute("aria-pressed", "true");
        onchange(opt.value);
      },
    });
    if (opt.icon) { b.innerHTML = Icons[opt.icon]; b.setAttribute("aria-label", opt.label); }
    else b.textContent = opt.label;
    wrap.append(b);
  });
  return wrap;
}

export function popItem(label, { sub, icon, ticked, onSelect } = {}) {
  return el("button.pop-item", { onclick: onSelect }, [
    icon && el("span", { html: Icons[icon], style: { display: "flex" } }),
    el("div", { style: { flex: "1", minWidth: "0" } }, [
      el("div", { text: label }),
      sub && el("div.sub", { text: sub }),
    ].filter(Boolean)),
    ticked && el("span.tick", { html: Icons.check }),
  ].filter(Boolean));
}

export function emptyState(iconName, title, body) {
  return el("div.empty", {}, [
    el("div", { html: Icons[iconName] || "" }),
    el("h3", { text: title }),
    body && el("p", { text: body }),
  ].filter(Boolean));
}
