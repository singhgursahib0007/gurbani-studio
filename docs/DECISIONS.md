# Decisions and defects

The non-obvious calls, and the bugs that were found by measuring rather than
by looking. Recorded because in every case the wrong version *looked* fine.

## Corpus

### `/banis` numbers verses in a different id space from `/angs`

The worst bug in the project, and it was invisible.

BaniDB's bani endpoint returns a `verseId` for every line. So does the ang
endpoint. They are **not the same numbering**: bani verse 12 is the ੴ line,
while ang verse 12 is something else entirely. Merging them on id attached the
wrong translation to roughly 25,000 lines — text that read perfectly, just
against the wrong verse.

Caught by spot-checking a rendered shabad against the upstream API: verse 354
showed the translation for a different line.

Measured across the whole corpus: **25,688 of 25,697 bani lines disagreed**
with the ang corpus; the 9 that agreed did so by coincidence.

Bani lines therefore keep their own text and translations, and the upstream id
is stored under the deliberately unambiguous name `banidb_bani_verse_id`.
`harness verify` asserts the two spaces stay apart.

### Derived columns are derived once, from settled text

Search columns were originally merged field by field along with everything
else. But an empty derived value is a *real answer* — a line of pure
punctuation genuinely has no first letters — and merging let one record's
index be filled in from a different record's text.

They are now computed in one pass at the end of `build()`, from each verse's
final text.

### Upstream quirks are kept, not cleaned

Two blank lines in Dasam Bani, one line with a stray space mid-word, one that
tokenises differently in the Unicode and ASCII columns. All kept as published
and reported by `verify`. Silently fixing a source makes it stop matching the
source, and the next person to compare would find a discrepancy with no
explanation.

## Search

### `LIKE` is case-insensitive; in Gurmukhi ASCII, case is the letter

`j` is ਜ and `J` is ਝ. SQLite's `LIKE` folds them together, so the API returned
81 matches for `jkr` where the truth is 78 — the extra three began ਝਕਰ.

Now `GLOB`, which compares byte for byte, matching BaniDB's own `LIKE BINARY`.

### The index is one string, not 142,000 rows

Splitting the index file into parsed rows would allocate well over a million
small strings and tens of megabytes — on a phone. It is held as a single blob
scanned with `indexOf`, which is native and allocation-free, plus an offset
table; only the handful of rows about to be drawn are sliced out.

### Matching is always "anywhere"

Offering "from the start" as a choice mostly made people choose wrong: someone
searching by remembered letters rarely knows whether the phrase begins the
line. Anywhere is a superset, so nothing is lost by not asking.

## Interface

### Panes must be height-constrained, or nothing inside them scrolls

`min-height: 100dvh` lets the frame grow to its content, so the *document*
scrolls and any handler watching a pane's scroll never fires. The shell uses a
fixed `100dvh` grid with `overflow: hidden`, and every scrolling child carries
`min-height: 0` so a flex item will actually shrink far enough to scroll.

### A popover that closed when the app reflowed

Close-on-scroll had a second, worse failure. Dragging the text-size slider
changes a CSS variable, the document reflows, the reader's scroll container
fires a scroll event — and the panel closed mid-drag, so the size could not be
adjusted at all. Close-on-scroll is gone entirely: a full-screen scrim sits
under the panel, so the page cannot be scrolled by hand while one is open, and
the only scrolling it ever caught was the app's own.

### A popover that closed on its own scroll

The panel closed on any scroll event, registered in the capture phase so it
would notice the page moving out from under its anchor. But capture sees
scrolls from *every* element, including the panel itself — so scrolling the
settings panel closed it, and a panel taller than the screen could not be read
at all. It now ignores scrolls originating inside itself.

The placement was wrong too: it was positioned first and capped at a fixed
74vh, which could leave the top of a long panel above the viewport with no way
to scroll back. It now measures the space above and below its anchor, picks
the larger, and caps its height to that.

### An absolutely positioned child needs a positioned parent

The reading-progress bar is `position: absolute` inside the reader pane, but
the pane had no `position`, so it resolved against the viewport and stretched
the full width of the window — across both sidebars, reporting on a pane it
was not in.

### The bani id key depends on where the record came from

The local API returns the database column `bani_id`; BaniDB's own payload calls
the same thing `baniID`. Reading only `baniID` meant the curated English names
silently never matched, and the reader fell back to raw transliteration —
"japujee saahib" in the title bar while the list beside it said "Japji Sahib".
Both are accepted now.

### `requestAnimationFrame` does not fire in a background tab

The splash was gated on rAF and sat there until its ceiling expired whenever
the tab was not frontmost — exactly what happens when someone opens a shared
link in a new tab. Anything that must complete now runs on a timer. The jump
to a searched line had the same fault.

### `scrollTo({behavior: "auto"})` is not instant

`auto` means "use the CSS `scroll-behavior`", which is `smooth` here. The
reader slid slowly through an entire shabad to reach the searched line, and in
a background tab never arrived. Smooth is switched off around the jump.

### A saved shabad is kept against its searched line

It was kept against its first line, which for most shabads is the
raag-and-mehla heading — the same words across hundreds of shabads, useless as
a label. Now it records the line the reader actually came for.

### Gold is tuned per theme

The bright gold that reads as luxurious on navy measures **3.8:1 on white** —
under the 4.5:1 small text needs, and the tab label is 10px. Light and sepia
get a deeper antique gold at 4.6:1 and 5.2:1; dark and night keep the bright
one at 11.5:1 and 12.1:1.

## Method

Two habits did most of the work.

**Measure instead of assuming.** The Unicode-to-ASCII letter table was derived
by aligning both columns across 136,231 lines rather than written from
knowledge — and every entry held for 100% of occurrences. The font was chosen
by rendering the same line in four candidates and looking. The gold was chosen
by computing contrast ratios.

**Verify by a second, independent route.** The first-letter index is derived a
second time, from the other encoding, by different code; the two must agree on
all 142,403 lines. That check is what would catch a subtle regression in
either path, and neither path validates itself.
