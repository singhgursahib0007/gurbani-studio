# The script layer

Everything about search rests on one question: given a line of Gurbani, which
letters would someone type to find it? Getting that wrong is not a rounding
error — it silently returns different lines.

Related: [DATASET](DATASET.md) for the columns this produces ·
[HARNESS](HARNESS.md) for where in the pipeline it runs ·
[DESKTOP](DESKTOP.md) for how the keyboard exposes it ·
[DECISIONS](DECISIONS.md) for the case-sensitivity bug.

Implemented twice on purpose: `harness/gurmukhi.py` builds the index,
`app/js/gurmukhi.js` interprets what the keyboard types. The two agree by
construction, and `harness verify` proves it.

## Two encodings

Gurbani is published in two forms, and both matter.

**Unicode Gurmukhi** — `ਸਿਰ` — logical order. The base letter comes first and
its vowel signs follow, so `word[0]` is always the letter.

**The legacy ASCII font encoding** (AnmolLipi / GurbaniAkhar) — `isr` — visual
order. Characters appear in the order they are *drawn*, so the sihari, which
is drawn to the left of its consonant, is stored **before** it. `word[0]` is
the vowel sign, not the letter.

BaniDB stores both, and its search is defined over the ASCII form. So the
index has to be in ASCII, but must not be *derived* from ASCII.

## First-letter search

The signature feature: type the first letter of each word and the line is
found. ਜਿਨ ਕੈ ਰਾਮੁ ਵਸੈ ਮਨ ਮਾਹਿ is `jkrvmm`.

BaniDB keeps a `FirstLetterStr` column and matches it with `LIKE`. The public
API never returns that column, so the harness recomputes it — **from the
Unicode text, then mapped to ASCII**. Deriving it from the ASCII text directly
would take the sihari in `isr` as the first letter of ਸਿਰ.

Three details settled it, and each was measured rather than assumed.

### Independent vowels fold to their carrier

Unicode has single codepoints for ਆ ਇ ਈ ਉ ਊ ਏ ਐ ਓ ਔ. The ASCII font writes
them as a carrier letter plus a vowel sign, so the *first letter* is the
carrier — ਉ is written `au`, and its first letter is ੳ.

| Unicode | ASCII | Carrier |
|---|---|---|
| ਆ ਐ ਔ | `A` | ਅ |
| ਇ ਈ ਏ | `e` | ੲ |
| ਉ ਊ | `a` | ੳ |
| ਓ | `E` | precomposed in the font |

This table is not guesswork. It was derived by aligning the Unicode and ASCII
columns of all 136,231 lines word by word: **every entry held for 100% of
occurrences.**

### Subjoined consonants are one character, not two

ੜ੍ਹ and ਪ੍ਰ carry a subjoined consonant: a virama plus a letter in Unicode,
but a *single* character in the ASCII font (`R`, `H`). So a virama and the
letter after it are skipped together. Without this, ਪ੍ਰਸਾਦਿ would index as `r`
rather than `p`.

### `E` exists, and SikhiToTheMax cannot type it

BaniDB indexes ਓ-initial lines under `E`, but STTM's own keyboard has no `E`
key — so those lines cannot be reached by first-letter search there. Our
keyboard adds the key.

## Case is the letter

The single most consequential detail, and it was a real bug here.

In the ASCII encoding, **case distinguishes letters**:

| | | | |
|---|---|---|---|
| `j` = ਜ | `J` = ਝ | `k` = ਕ | `K` = ਖ |
| `t` = ਟ | `T` = ਠ | `d` = ਦ | `D` = ਧ |

SQLite's `LIKE` is case-insensitive for ASCII. The local API used `LIKE`, so
searching `jkr` also returned lines beginning ਝਕਰ — different letters
entirely. Switching to `GLOB`, which compares byte for byte, brought it in
line with the static index and with BaniDB, which uses `LIKE BINARY` for the
same reason. The count went from a wrong 81 to a correct 78.

**If you touch the search SQL: never use `LIKE` on a Gurmukhi column.**

## How the index is checked

[`harness verify`](HARNESS.md#commands) proves it three independent ways:

1. **Reproducible** — recomputing from the stored Gurmukhi reproduces the
   stored column.
2. **Two derivations** — the index is derived a *second* time from the ASCII
   column by a completely different code path, and the two must agree on every
   line. They agree on 142,403 of 142,403.
3. **Against BaniDB itself** (`--online`) — the same queries run locally and
   against the live API; every verse the API returns must also be found here.

## The keyboard

`KB_ROWS` reproduces SikhiToTheMax's own first-letter layout key for key, so
anyone who has used STTM finds the keys where they expect them, plus a fifth
row for the letters that layout omits — including `E`.

Queries may be typed in either encoding. `toAscii()` folds Unicode Gurmukhi,
independent vowels and ASCII characters to the single indexed form.

## Fonts

Gurmukhi is set in **Sant Lipi**, a Unicode face built for Gurbani by the
Shabad OS project, chosen after rendering the same line in four candidates. It
draws ੴ as one flowing Ik Onkar where the system faces and Noto show a digit
and a detached hook, and it places aunkar, dulainkar and tippi without
crowding them at reading sizes. It is variable, so weight is real rather than
synthesised, and it is 28 KB.

Mukta Mahee, Noto Sans Gurmukhi and Anek Gurmukhi are offered as alternatives.
Each is its own `@font-face` family, so a browser downloads only the one in
use — picking a font costs 12–33 KB, picking none costs nothing.

## Two traps worth knowing

**Nukta letters are Unicode composition exclusions.** `NFC` leaves ਸ਼ as
`ਸ` + `਼` — two codepoints. Per-character lookups silently miss them. The
harness canonicalises the other way, to the single precomposed codepoint, so
one letter is always one character.

**Never split a word between a consonant and its matra.** The vowel sign is
orphaned and the browser renders it on a dotted circle of its own. When the
search screen highlights the first letter of each word, it highlights the
whole *cluster* — the letter together with its marks.
