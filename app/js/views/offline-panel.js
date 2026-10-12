/* The offline control, as one component used in two places: Settings, and
 * the projector's Look tab. Both show the same controller (js/offline.js),
 * so a download started in one is the download shown in the other.
 *
 * It re-renders itself from the controller's state and lets go of its
 * subscription once it is no longer in the document - popovers and the Look
 * tab both rebuild their contents freely, and a panel that kept listening
 * after it was thrown away would leak one listener per opening.
 */

import { el } from "../ui.js";
import { Icons } from "../icons.js";
import { offline, mb } from "../offline.js";

const pct = (s) => (s.total ? Math.floor((s.done / s.total) * 100) : 0);
const when = (t) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });

export function offlinePanel() {
  const root = el("div.ol");
  let armed = false, armTimer = null;

  const unsubscribe = offline.subscribe((s) => {
    if (root.isConnected === false && root.dataset.mounted) { unsubscribe?.(); return; }
    render(s);
  });
  // The first render happens before the element is attached; mark it so the
  // "no longer in the document" check above only applies after that.
  requestAnimationFrame(() => { root.dataset.mounted = "1"; });
  offline.refresh();

  function render(s) {
    const m = s.manifest;
    const total = s.total || m?.bytes || 0;
    const download = m ? mb(m.gz) : "about 25 MB";
    const onDevice = total ? mb(total) : "about 115 MB";
    let icon = "cloudDown", title = "", sub = "", note = "", bar = false;
    const actions = [];

    switch (s.phase) {
      case "unsupported":
        icon = "wifiSlash";
        title = "Offline is not available here";
        sub = "It needs the published app over HTTPS, such as gurbani-studio.vercel.app.";
        break;
      case "checking":
        title = "Checking…";
        break;
      case "none":
        if (!s.online && !m) {
          icon = "wifiSlash";
          title = "Not available offline yet";
          sub = "Connect to the internet once to download everything.";
          break;
        }
        title = "Make available offline";
        sub = "Every shabad, bani and the search index, so reading, search and " +
              `projector mode work with no connection. ${download} to download, ` +
              `${onDevice} on this device.`;
        actions.push(btn("Download", () => offline.start(), "primary"));
        break;
      case "downloading":
        title = `Downloading… ${pct(s)}%`;
        sub = `${mb(s.done)} of ${mb(total)}`;
        note = "Keep Gurbani Studio open until it finishes. It can be paused and resumed.";
        bar = true;
        actions.push(btn("Pause", () => offline.stop()));
        break;
      case "verifying":
        title = "Checking everything arrived…";
        bar = true;
        break;
      case "partial":
        title = `Paused at ${pct(s)}%`;
        sub = "What has arrived is kept, and already works offline.";
        bar = true;
        actions.push(btn("Resume", () => offline.start(), "primary"),
                     confirmBtn("Discard", "Tap again to discard"));
        break;
      case "ready":
        icon = "cloudCheck";
        title = "Ready offline";
        sub = `${mb(s.ready?.bytes || total)} on this device · downloaded ${when(s.ready?.at || Date.now())}`;
        note = s.persisted === true
          ? "Protected from automatic clearing."
          : s.persisted === false
            ? "The browser may clear this if the disk runs low. Installing the app " +
              "(Add to Dock, or Install in Chrome) keeps it safe."
            : "";
        actions.push(confirmBtn("Remove", "Tap again to remove"));
        break;
      case "update":
        icon = "cloudCheck";
        title = "Ready offline · update available";
        sub = s.done > 0
          ? `The texts have changed. Update paused at ${pct(s)}%; your current copy keeps working.`
          : `The texts have changed. Your current copy keeps working until the new one (${download}) is complete.`;
        bar = s.done > 0;
        actions.push(btn(s.done > 0 ? "Resume update" : "Update", () => offline.start(), "primary"),
                     confirmBtn("Remove", "Tap again to remove"));
        break;
      case "error":
        icon = "wifiSlash";
        title = "Download stopped";
        sub = s.error || "";
        bar = s.done > 0;
        actions.push(btn("Try again", () => offline.start(), "primary"));
        if (s.done > 0) actions.push(confirmBtn("Discard", "Tap again to discard"));
        break;
      default: break;
    }

    root.dataset.phase = s.phase;
    root.replaceChildren(...[
      el("div.ol-head", {}, [
        el("span.ol-icon", { html: Icons[icon] || "" }),
        el("div.ol-text", {}, [
          el("div.ol-title", { text: title }),
          sub && el("div.ol-sub", { text: sub }),
        ].filter(Boolean)),
      ]),
      bar && el("div.ol-bar", { role: "progressbar", "aria-valuenow": String(pct(s)),
                                "aria-valuemin": "0", "aria-valuemax": "100" },
        [el("div.ol-fill", { style: { width: `${s.phase === "verifying" ? 100 : pct(s)}%` } })]),
      actions.length && el("div.ol-actions", {}, actions),
      note && el("div.ol-note", { text: note }),
    // replaceChildren, like append, turns `false` and `0` into text nodes -
    // a literal "false" appeared above the Download button until this filter.
    ].filter(Boolean));
  }

  function btn(label, onclick, kind = "") {
    return el(`button.ol-btn${kind ? "." + kind : ""}`, {
      text: label,
      onclick: (e) => { e.stopPropagation(); onclick(); },
    });
  }

  /* Destructive, so two taps - the same idiom as "Erase all saved data". */
  function confirmBtn(label, armedLabel) {
    const b = btn(label, () => {
      if (!armed) {
        armed = true;
        b.textContent = armedLabel; b.classList.add("danger");
        clearTimeout(armTimer);
        armTimer = setTimeout(() => { armed = false; render(offline.state); }, 4000);
        return;
      }
      armed = false; clearTimeout(armTimer);
      offline.remove();
    });
    return b;
  }

  return root;
}

/* The small status in the sidebar foot: progress while downloading, a mark
 * when the copy is ready, and a clear "Offline" when the network is gone -
 * which is when someone most needs to know whether they are covered. */
export function offlineChip(onOpen) {
  const chip = el("button.ol-chip", { onclick: (e) => onOpen?.(e.currentTarget) });
  offline.subscribe((s) => {
    let icon = null, text = "", tone = "", tip = "";
    if (s.phase === "downloading" || s.phase === "verifying") {
      icon = "cloudDown"; text = `${pct(s)}%`; tip = "Downloading for offline use";
    } else if (!s.online) {
      icon = "wifiSlash"; text = "Offline";
      tone = s.phase === "ready" || s.phase === "update" ? "ok" : "warn";
      tip = tone === "ok" ? "No connection — everything is on this device"
                          : "No connection — only what you have opened before will load";
    } else if (s.phase === "ready" || s.phase === "update") {
      icon = "cloudCheck"; tone = "ok"; tip = "Available offline";
    } else if (s.phase === "partial" || s.phase === "error") {
      icon = "cloudDown"; text = "Paused"; tip = "Offline download paused";
    }
    chip.hidden = !icon;
    chip.className = `ol-chip ${tone}`;
    chip.title = tip; chip.setAttribute("aria-label", tip);
    chip.replaceChildren(
      ...(icon ? [el("span", { html: Icons[icon] })] : []),
      ...(text ? [el("span", { text })] : []),
    );
  });
  return chip;
}
