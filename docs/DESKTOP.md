# The desktop interface

Designed for a pointer, a keyboard and a large screen — not a phone layout
given more room.

Related: [ARCHITECTURE](ARCHITECTURE.md) for the system around it ·
[GURMUKHI](GURMUKHI.md) for what the keyboard is actually typing ·
[DECISIONS](DECISIONS.md) for the bugs behind several of these choices ·
[DEPLOY](DEPLOY.md) for publishing it.

## Three panes

```
┌──────────┬───────────────┬────────────────────────┐
│ Sidebar  │  List         │  Reader                │
│          │               │                        │
│ Search   │  results /    │   ੴ ਸਤਿ ਨਾਮੁ …          │
│ Saved    │  banis /      │                        │
│          │  saved        │   measured column,     │
│ Nitnem   │               │   centred in the pane  │
│ Popular  │  ↑↓ to move   │                        │
│ Vaars    │  ⏎ to open    │                        │
│ Raags    │               │                        │
└──────────┴───────────────┴────────────────────────┘
   248px        372px            flexible
```

The macOS idiom — Mail, Notes, Xcode. Dividers drag to resize and the widths
persist, because on a desktop the shape of the window is a preference like any
other.

**Why categories live in the sidebar.** On the phone, Nitnem and Vaars are
headings inside one scrolling list, because there is nowhere else to put them.
Here the sidebar is always visible and can carry the structure, which leaves
the middle pane free to be nothing but a list.

## Keyboard first

The whole app runs without a mouse. If it needed a pointer for everything it
would just be the phone app in a bigger window.

| Key | Does |
|---|---|
| `⌘K` or `/` | Search |
| `↑` `↓` | Move through the list |
| `⏎` | Open the selection |
| `Space` | Page down in the reader |
| `⌘B` | Show or hide the sidebar |
| `⌘L` | Show or hide the list |
| `F` or `⌘⇧F` | Immersive reading |
| `⌘\` | Focus mode — both left panes away |
| `⌘J` | Start or stop auto-scroll |
| `⌘S` | Save what you are reading |
| `⌘P` | Command palette |
| `⌘,` | Settings |
| `Esc` | Clear the field, or leave focus mode |

**Gurmukhi is typed directly.** On a physical keyboard `jkrvmm` *is* the
[ASCII encoding the index is built from](GURMUKHI.md#two-encodings), so there is no on-screen keyboard in the way
— you type Latin letters and the Gurmukhi appears beneath the field as you go.
The on-screen keyboard is still there behind a button, as a **legend**: each
key shows the Gurmukhi shape with the Latin letter to press in its corner.

Searching starts at **two** letters rather than three; a physical keyboard
gets there faster than a thumb.

## Immersive reading

`F` collapses every pane *and* takes the browser full screen, so nothing of
the window is left. The column gets more air — 20vh above the first line, 55vh
below the last — and the only control is a small cluster at the corner that
surfaces when the mouse moves and fades two seconds after it stops.

The column also widens here. With the panes gone there is a great deal of
screen, and holding the windowed measure wrapped lines that had no need to
wrap: it goes to `min(94vw, max(measure, 58rem))` — 928px instead of 640px on
a 1440px display — never narrower than 58rem, never narrower than the reader's
own setting if they chose a wider one.

Leaving works either way round: `Esc`, the control, or the browser's own
full-screen exit. The `fullscreenchange` event is the single source of truth,
so the app can never be left collapsed with no way back.

## Collapsing panes

Both left panes collapse independently — `⌘B` for the sidebar, `⌘L` for the
list — and the grid animates rather than snapping, because every track is a
length and `grid-template-columns` interpolates. Contents fade as the pane
narrows, so nothing is squashed against the edge on the way out. The state
persists.

## The reading column

A wide window is not a licence for wide lines. The column holds a measured
width and centres in the pane, so widening the window gives margins rather
than a harder read. The width is adjustable — 28 to 72rem — in Appearance.

Every line has a star that appears on hover, and a right-click gives the same
actions. Nothing is behind a gesture, because on a desktop there are none to
discover.

## What carries over from the phone

Same corpus, same search semantics, same preferences model. [Reading position](DECISIONS.md)
is stored as a **line index rather than a pixel offset**, so it survives a
change of type size, font, measure or translation. Themes, fonts, weights, the
three independent text sizes, larivaar and translation toggles all behave
identically.

## What is deliberately different

| Phone | Desktop |
|---|---|
| Bottom tab bar | Sidebar with categories |
| Sheets from the bottom | Popovers anchored to their control |
| Swipe a line left to save | Hover star, or right-click |
| On-screen keyboard is the input | Physical keyboard is the input; on-screen is a legend |
| One screen at a time | List and reader side by side |
| Full-width text | Measured, centred column |

## Traps worth knowing

**`scrollTo({behavior: "auto"})` does not mean instant.** It means "use the CSS
`scroll-behavior`", which is `smooth` here for auto-scroll. Jumps switch smooth
off around the assignment.

**The bani record's id key depends on its source.** The local API returns the
database column `bani_id`; BaniDB's own payload calls it `baniID`. Accept
either, or curated names silently never match and the reader falls back to raw
transliteration — which is exactly what happened.

**`requestAnimationFrame` does not fire in a background tab.** Anything that
must complete runs on a timer.
