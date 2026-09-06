/* The Gurmukhi letter layer for the browser.
 *
 * Mirrors harness/gurmukhi.py: the search index is a string of first letters
 * in the legacy ASCII font encoding, and the on-screen keyboard types those
 * letters while showing their Gurmukhi shapes. */

/* Keyboard layout, keyed by the ASCII character each letter indexes as.
 * Rows follow SikhiToTheMax's own first-letter keyboard, so anyone who has
 * used STTM finds the keys exactly where they expect them. */
export const KB_ROWS = [
  ["a", "A", "e", "s", "h", "k", "K", "g", "G", "|"],
  ["c", "C", "j", "J", "\\", "t", "T", "f", "F", "x"],
  ["q", "Q", "d", "D", "n", "p", "P", "b", "B", "m"],
  ["X", "r", "l", "v", "V", "S", "^", "Z", "z", "E"],
];

export const A2U = {
  a: "ੳ", A: "ਅ", e: "ੲ", s: "ਸ", h: "ਹ",
  k: "ਕ", K: "ਖ", g: "ਗ", G: "ਘ", "|": "ਙ",
  c: "ਚ", C: "ਛ", j: "ਜ", J: "ਝ", "\\": "ਞ",
  t: "ਟ", T: "ਠ", f: "ਡ", F: "ਢ", x: "ਣ",
  q: "ਤ", Q: "ਥ", d: "ਦ", D: "ਧ", n: "ਨ",
  p: "ਪ", P: "ਫ", b: "ਬ", B: "ਭ", m: "ਮ",
  X: "ਯ", r: "ਰ", l: "ਲ", v: "ਵ", V: "ੜ",
  S: "ਸ਼", "^": "ਖ਼", Z: "ਗ਼", z: "ਜ਼", "&": "ਫ਼",
  L: "ਲ਼", E: "ਓ",
};

export const U2A = Object.fromEntries(
  Object.entries(A2U).map(([ascii, uni]) => [uni, ascii]),
);

/* The independent vowels are single codepoints in Unicode but a carrier plus
 * a matra in the ASCII font, so they fold to their carrier - except ਓ, which
 * the font has precomposed as "E". Derived from the corpus, not guessed. */
const VOWEL_TO_ASCII = {
  "ਆ": "A", "ਇ": "e", "ਈ": "e", "ਉ": "a", "ਊ": "a",
  "ਏ": "e", "ਐ": "A", "ਓ": "E", "ਔ": "A",
};

const FOLD = { ...U2A, ...VOWEL_TO_ASCII };
const VALID = new Set(Object.keys(A2U));

/** Render an ASCII first-letter string as Gurmukhi, for display. */
export const toGurmukhi = (ascii) =>
  [...(ascii || "")].map((ch) => A2U[ch] || ch).join("");

/** Accept a query typed either way and fold it to the indexed ASCII form. */
export function toAscii(query) {
  let out = "";
  for (const ch of (query || "").trim()) {
    if (FOLD[ch]) out += FOLD[ch];
    else if (VALID.has(ch)) out += ch;
  }
  return out;
}

/** Romanised name of each letter, for the keyboard's accessible label. */
export const LETTER_NAMES = {
  a: "oora", A: "aira", e: "eeri", s: "sassa", h: "haaha", k: "kakka",
  K: "khakha", g: "gagga", G: "ghagha", "|": "nganga", c: "chacha",
  C: "chhachha", j: "jajja", J: "jhajha", "\\": "nyanya", t: "tainka",
  T: "thattha", f: "dadda", F: "dhadha", x: "nahnha", q: "tatta",
  Q: "thatha", d: "dadda", D: "dhadha", n: "nanna", p: "pappa",
  P: "phapha", b: "babba", B: "bhabha", m: "mamma", X: "yayya",
  r: "rara", l: "lalla", v: "vava", V: "rrarra", S: "shashha",
  "^": "khhakhha", Z: "ghhaghha", z: "zazza", "&": "faffa", L: "llalla",
  E: "ora",
};
