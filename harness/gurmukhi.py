"""Gurmukhi script utilities: the letter layer the whole search rests on.

SikhiToTheMax's signature search is *first-letter search*: you type the first
letter of each word of a line and it finds the line. BaniDB implements this
with a precomputed `FirstLetterStr` column matched by `LIKE 'q%'` (start) or
`LIKE '%q%'` (anywhere), where the letters are in the legacy ASCII Gurmukhi
font encoding (AnmolLipi / GurbaniAkhar).

The public API does not expose that column, so we recompute it. We derive it
from the **Unicode** text rather than the ASCII text, because ASCII Gurmukhi
stores the sihari vowel *before* its consonant (`isr` = ਸਿਰ), so `word[0]` is
the wrong letter there, whereas Unicode is in logical order and `word[0]` is
always the base letter. We then map each Unicode letter back to its ASCII
character so the result is byte-compatible with BaniDB's own column and with
anything typed on an STTM-style keyboard.
"""
from __future__ import annotations

import unicodedata

# The exact set of first-letter characters BaniDB accepts, copied from
# api/controllers/omni.js (GURMUKHI_CHARS). Order is the traditional
# Gurmukhi alphabet order and drives the on-screen keyboard.
GURMUKHI_CHARS = "aAeshkKgG|cCjJ\\tTfFxqQdDnpPbBmXrlvS^Zz&LV"

# ASCII (legacy font) -> Unicode Gurmukhi, for exactly those 41 letters.
#
# The six nukta letters are written as explicit escapes on purpose. Gurmukhi
# nukta characters are Unicode *composition exclusions*, so NFC leaves them
# DEcomposed (ਸ਼ = U+0A38 U+0A3C). We canonicalise the other way - to the
# single precomposed codepoint - so that one letter is always one character
# and first-letter logic can work character by character.
ASCII_TO_UNICODE: dict[str, str] = {
    "a": "\u0A73", "A": "\u0A05", "e": "\u0A72",
    "s": "\u0A38", "h": "\u0A39",
    "k": "\u0A15", "K": "\u0A16", "g": "\u0A17", "G": "\u0A18", "|": "\u0A19",
    "c": "\u0A1A", "C": "\u0A1B", "j": "\u0A1C", "J": "\u0A1D", "\\": "\u0A1E",
    "t": "\u0A1F", "T": "\u0A20", "f": "\u0A21", "F": "\u0A22", "x": "\u0A23",
    "q": "\u0A24", "Q": "\u0A25", "d": "\u0A26", "D": "\u0A27", "n": "\u0A28",
    "p": "\u0A2A", "P": "\u0A2B", "b": "\u0A2C", "B": "\u0A2D", "m": "\u0A2E",
    "X": "\u0A2F", "r": "\u0A30", "l": "\u0A32", "v": "\u0A35",
    "S": "\u0A36", "^": "\u0A59", "Z": "\u0A5A", "z": "\u0A5B", "&": "\u0A5E",
    "L": "\u0A33", "V": "\u0A5C",
}
UNICODE_TO_ASCII: dict[str, str] = {v: k for k, v in ASCII_TO_UNICODE.items()}

# Unicode encodes the independent vowels as single precomposed codepoints
# (ਆ, ਇ, ਉ ...), but the ASCII font writes them as a carrier letter plus a
# vowel sign, so their *first letter* is the carrier: ਉ is written "au", and
# its first letter is ੳ. ਓ is the exception - the font has a precomposed "E".
#
# This table is not guesswork: it was derived by aligning the Unicode and
# ASCII columns of all 136,231 lines of the corpus word by word, and every
# entry below held for 100% of occurrences. Regenerate it with
# `python3 -m harness verify`, which re-checks the alignment.
VOWEL_TO_ASCII: dict[str, str] = {
    "\u0A06": "A",   # ਆ -> ਅ      (18,416 occurrences)
    "\u0A07": "e",   # ਇ -> ੲ       (9,205)
    "\u0A08": "e",   # ਈ -> ੲ         (448)
    "\u0A09": "a",   # ਉ -> ੳ       (9,352)
    "\u0A0A": "a",   # ਊ -> ੳ       (1,408)
    "\u0A0F": "e",   # ਏ -> ੲ       (4,245)
    "\u0A10": "A",   # ਐ -> ਅ       (1,615)
    "\u0A13": "E",   # ਓ -> "E"     (1,591)  precomposed in the font
    "\u0A14": "A",   # ਔ -> ਅ         (377)
}

# The full letter -> ASCII lookup the first-letter index is built from.
FIRST_LETTER_ASCII: dict[str, str] = {**UNICODE_TO_ASCII, **VOWEL_TO_ASCII}

# Characters that may legitimately appear in a first-letter query. This is the
# keyboard alphabet plus "E", which BaniDB indexes but its keyboard omits.
SEARCHABLE_CHARS = GURMUKHI_CHARS + "E"

# Rendering a first-letter string back to Gurmukhi for display.
ASCII_TO_DISPLAY: dict[str, str] = {**ASCII_TO_UNICODE, "E": "\u0A13"}

assert set(ASCII_TO_UNICODE) == set(GURMUKHI_CHARS), "letter map out of sync"
assert all(len(v) == 1 for v in ASCII_TO_UNICODE.values()), "letters must be single codepoints"

# Romanised name for each letter, for keyboard tooltips.
LETTER_NAMES: dict[str, str] = {
    "\u0A73": "oora", "\u0A05": "aira", "\u0A72": "eeri",
    "\u0A38": "sassa", "\u0A39": "haaha",
    "\u0A15": "kakka", "\u0A16": "khakha", "\u0A17": "gagga",
    "\u0A18": "ghagha", "\u0A19": "nganga",
    "\u0A1A": "chacha", "\u0A1B": "chhachha", "\u0A1C": "jajja",
    "\u0A1D": "jhajha", "\u0A1E": "nyanya",
    "\u0A1F": "tainka", "\u0A20": "thattha", "\u0A21": "dadda",
    "\u0A22": "dhadha", "\u0A23": "nahnha",
    "\u0A24": "tatta", "\u0A25": "thatha", "\u0A26": "dadda",
    "\u0A27": "dhadha", "\u0A28": "nanna",
    "\u0A2A": "pappa", "\u0A2B": "phapha", "\u0A2C": "babba",
    "\u0A2D": "bhabha", "\u0A2E": "mamma",
    "\u0A2F": "yayya", "\u0A30": "rara", "\u0A32": "lalla",
    "\u0A35": "vava", "\u0A5C": "rrarra",
    "\u0A36": "shashha", "\u0A59": "khhakhha", "\u0A5A": "ghhaghha",
    "\u0A5B": "zazza", "\u0A5E": "faffa", "\u0A33": "llalla",
    "\u0A13": "ora",          # ਓ - indexed as "E", absent from STTM's keyboard
}

# On-screen keyboard rows.
#
# The first four rows are SikhiToTheMax's own first-letter keyboard layout
# (sttm-web EnhancedGurmukhiKeyboard `withoutMatra`), reproduced key for key.
# The last row holds letters BaniDB indexes but that layout leaves out -
# notably "E" (ਓ), without which no ਓ-initial line can be reached.
KEYBOARD_ROWS: list[list[str]] = [
    list("aAeshkKgG|"),
    list("cCjJ\\tTfFx"),
    list("qQdDnpPbBm"),
    list("Xrlv V^".replace(" ", "")),
    list("SZz&LE"),
]

# --- Unicode character classes ---------------------------------------------
NUKTA = "\u0A3C"

# base + nukta -> single precomposed letter. Applied after NFC so that a line
# written either way folds to the same canonical form.
_NUKTA_COMPOSE = {
    "\u0A38" + NUKTA: "\u0A36",   # sa  -> sha
    "\u0A16" + NUKTA: "\u0A59",   # kha -> khha
    "\u0A17" + NUKTA: "\u0A5A",   # ga  -> ghha
    "\u0A1C" + NUKTA: "\u0A5B",   # ja  -> za
    "\u0A2B" + NUKTA: "\u0A5E",   # pha -> fa
    "\u0A32" + NUKTA: "\u0A33",   # la  -> lla
    "\u0A21" + NUKTA: "\u0A5C",   # dda -> rra
}

# Base letters (consonants and vowel carriers) that can begin a word.
_BASE_LETTERS = frozenset(
    "\u0A05\u0A06\u0A07\u0A08\u0A09\u0A0A\u0A0F\u0A10\u0A13\u0A14"  # independent vowels
    "\u0A15\u0A16\u0A17\u0A18\u0A19"                                # ka-varga
    "\u0A1A\u0A1B\u0A1C\u0A1D\u0A1E"                                # cha-varga
    "\u0A1F\u0A20\u0A21\u0A22\u0A23"                                # tta-varga
    "\u0A24\u0A25\u0A26\u0A27\u0A28"                                # ta-varga
    "\u0A2A\u0A2B\u0A2C\u0A2D\u0A2E"                                # pa-varga
    "\u0A2F\u0A30\u0A32\u0A35\u0A38\u0A39"                          # ya ra la va sa ha
    "\u0A33\u0A36\u0A59\u0A5A\u0A5B\u0A5C\u0A5E"                    # nukta letters + rra
    "\u0A72\u0A73"                                                  # eeri, oora
)

# Combining marks: vowel signs, nasalisation, subjoined forms, nukta, virama.
_MARKS = frozenset(
    "\u0A3E\u0A3F\u0A40\u0A41\u0A42\u0A47\u0A48\u0A4B\u0A4C"      # vowel signs
    "\u0A4D\u0A51\u0A75"                                          # virama, udaat, yakash
    "\u0A01\u0A02\u0A03\u0A70\u0A71"                              # bindi, tippi, addak
    "\u0A3C"                                                     # nukta
)

EK_ONKAR = "\u0A74"
VIRAMA = "\u0A4D"

# Vowel signs and combining marks in the legacy ASCII font encoding, i.e. the
# ASCII counterpart of _MARKS. "^" is deliberately absent - it is the letter
# ਖ਼, not a mark.
ASCII_MARKS = frozenset("wiIuUyYoOMN`~RH")


def normalize(text: str) -> str:
    """NFC-normalise and fold decomposed nukta pairs to precomposed letters."""
    if not text:
        return ""
    text = unicodedata.normalize("NFC", text)
    for pair, single in _NUKTA_COMPOSE.items():
        if pair in text:
            text = text.replace(pair, single)
    return text


def first_letter_of_word(word: str) -> str | None:
    """The base Gurmukhi letter a word starts with, or None if it has none.

    Punctuation (``॥``), digits, and ``ੴ`` yield None, matching BaniDB, whose
    first-letter alphabet contains only the 41 letters in GURMUKHI_CHARS.
    """
    skip_next = False
    for ch in word:
        if skip_next:
            # The letter after a virama is a *subjoined* consonant (੍ਰ, ੍ਹ),
            # not the word's base letter. The ASCII font encodes each of these
            # as one character (R, H), so skipping the pair keeps the two
            # derivations in step.
            skip_next = False
            continue
        if ch == VIRAMA:
            skip_next = True
            continue
        if ch in _BASE_LETTERS:
            return ch
        if ch in _MARKS or ch == EK_ONKAR:
            continue
        # Anything else (danda, digits, latin) means this token has no letter.
        return None
    return None


def first_letters_unicode(line: str) -> str:
    """First letter of each word, as Unicode Gurmukhi. ``ਹਰਿ ਜਸੁ`` -> ``ਹਜ``."""
    out = []
    for word in normalize(line).split():
        letter = first_letter_of_word(word)
        if letter:
            out.append(letter)
    return "".join(out)


def first_letters_ascii(line: str) -> str:
    """First letters in the legacy ASCII encoding BaniDB's column uses."""
    return "".join(
        FIRST_LETTER_ASCII.get(ch, "") for ch in first_letters_unicode(line)
    )


def first_letters_from_ascii(line: str) -> str:
    """First letters derived from the *legacy ASCII* text instead of Unicode.

    This exists as an independent second opinion. `first_letters_ascii` works
    from the Unicode column; this works from the ASCII column the source also
    publishes. The two are computed by completely different routes, so when
    they agree on every line, the index is almost certainly right - which is
    what `harness verify` asserts.

    Leading vowel signs are skipped, mirroring the Unicode side's skipping of
    combining marks: ASCII Gurmukhi puts the sihari before its consonant
    ("isr" = ਸਿਰ), and a handful of upstream lines carry a stray space that
    leaves a word starting with a detached matra. Tokens with no letter at
    all - "<>" for ੴ, "]" for ॥, digits - contribute nothing, exactly as on
    the Unicode side.
    """
    out = []
    for word in line.split():
        for ch in word:
            if ch in ASCII_MARKS:
                continue            # a vowel sign is never the letter
            if ch in SEARCHABLE_CHARS:
                out.append(ch)
            break                   # first real character decides the word
    return "".join(out)


def ascii_query_to_unicode(query: str) -> str:
    """Render an ASCII first-letter query as Unicode, for display."""
    return "".join(ASCII_TO_DISPLAY.get(ch, ch) for ch in query)


def unicode_query_to_ascii(query: str) -> str:
    """Accept a query typed in Unicode Gurmukhi and fold it to ASCII."""
    return "".join(
        FIRST_LETTER_ASCII.get(ch, ch) for ch in normalize(query) if not ch.isspace()
    )


def main_letters(line: str) -> str:
    """The line with all vowel signs and diacritics stripped.

    This is BaniDB's `MainLetters` column, backing the "main letters" search
    mode: ``ਸਤਿਗੁਰੁ`` -> ``ਸਤਗਰ``.
    """
    text = normalize(line)
    return "".join(
        ch for ch in text if ch in _BASE_LETTERS or ch.isspace()
    )


def is_ascii_query(query: str) -> bool:
    """True if every character is a legal ASCII first-letter character."""
    q = query.strip()
    return bool(q) and all(ch in SEARCHABLE_CHARS for ch in q)
