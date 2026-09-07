/* One shabad or bani, normalised.
 *
 * The reader and the projector show the same thing in very different ways, so
 * the shaping lives here rather than inside either of them. A record is a
 * title, an optional subtitle, and an ordered list of lines - and nothing
 * downstream needs to know whether it came from a bani file or a shabad file.
 */

import { getBani, getShabad } from "./data.js";
import { BANI_INFO } from "./banis-info.js";

/** A raag or mahalla heading rather than a line of the shabad proper. */
export const isHeading = (t = "") => /ਮਹਲਾ|ਮਃ/.test(t) && t.length < 40;

/* The bani record's id key depends on where it came from: the local API
 * returns the database column `bani_id`, while BaniDB's own payload calls it
 * `baniID`. Accept either, or the curated name silently never matches and the
 * reader falls back to the raw transliteration. */
export const baniEnglish = (info) => {
  const id = info.bani_id ?? info.baniID;
  return (BANI_INFO[id] && BANI_INFO[id].name) || info.english || "Bani";
};

export function normaliseBani(d) {
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

export function normaliseShabad(d) {
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

/**
 * The line to name a record by.
 *
 * Not line zero: for a shabad that is the raag-and-mahalla heading, which
 * appears above hundreds of shabads and so identifies none of them. The first
 * line of the shabad proper is what someone recognises it by.
 */
export function identifyingLine(record) {
  const real = (record.lines || []).find(
    (l) => !l.isHeader && !isHeading(l.gurmukhi));
  return real || record.lines?.[0] || null;
}

/** The same thing as text, for a list row or a history entry. */
export const nameLine = (record) => identifyingLine(record)?.gurmukhi || "";

/** Fetch and shape in one step. Both fetches are already cached upstream. */
export async function loadRecord({ type, id }) {
  return type === "bani"
    ? normaliseBani(await getBani(id))
    : normaliseShabad(await getShabad(id));
}
