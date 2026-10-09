// src/xfafont.ts
/**
 * Which face measures an XFA run (`164g.7`), in three tiers: embedded in the
 * document, registered font folders, then a CLOSED table of metric-compatible
 * substitutes. The first tier offering a face of exactly the requested family
 * and style that covers every character of the run wins.
 *
 * **Invariant:** an embedded program is identified by its OWN `name` table
 * (`fontnames.ts`), never by `/BaseFont` spelling, so `Arial,Bold` and
 * `ABCDEF+Arial-BoldMT` agree. A bare CFF or Type 1 program has no `name` table
 * and is no candidate.
 *
 * **Invariant:** the substitute table is CLOSED and its faces are the bundled
 * Liberation fonts, which equal Arial and Times New Roman on advances AND on
 * hhea, typo and win line metrics (measured against OPM 1644's embedded faces).
 * Helvetica, Times and Courier are deliberately absent: their vendors' vertical
 * metrics differ from Liberation's, and line height comes from them (p. 61).
 *
 * **Invariant:** nothing is written to the document; `registeredFaceSfnt`
 * parses a file, it never calls `AddFont`.
 */
import type { Document } from './document.js';
import { isDict, isName, isStream } from './types.js';
import { decodeStream } from './filters.js';
import { parseSfnt, type SfntFont } from './sfnt.js';
import { readFontNames, type FontNames } from './fontnames.js';
import { deriveStyle, familyMatches } from './fontmatch.js';
import { getStd14Sfnt } from './std14fonts.js';
import type { StdFont } from './metrics.js';
import { rethrowLimit } from './errors.js';
import type { FaceRecord } from './fontsource.js';
import type { RunStyle } from './xfarich.js';
import type { FaceLookup, FaceMetrics } from './xfatext.js';

/** [regular, bold, italic, bold italic], by exact family name (lower-cased). */
export const XFA_SUBSTITUTES: Readonly<Record<string, readonly [StdFont, StdFont, StdFont, StdFont]>> = {
  arial: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
  'times new roman': ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
  'courier new': ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'],
};

/** CSS generic families: never a face (cssfont.ts's rule). */
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui']);

interface Face { names?: FontNames; metrics: FaceMetrics }

function unicodeCmap(s: SfntFont): Map<number, number> | undefined {
  return s.cmapSubtable(3, 10) ?? s.cmapSubtable(3, 1) ?? s.cmapSubtable(0, 4) ?? s.cmapSubtable(0, 3);
}

function metricsOf(s: SfntFont): FaceMetrics | undefined {
  const cmap = unicodeCmap(s);
  const hhea = s.table('hhea', false);
  if (!cmap || !hhea || hhea.length < 8) return undefined;
  const v = new DataView(hhea.buffer, hhea.byteOffset, hhea.byteLength);
  return {
    unitsPerEm: s.unitsPerEm,
    ascent: v.getInt16(4),
    descent: -v.getInt16(6),
    advance: (cp) => {
      const gid = cmap.get(cp);
      return gid === undefined || gid === 0 || gid >= s.numGlyphs ? undefined : s.advanceWidth(gid);
    },
  };
}

function face(s: SfntFont | undefined): Face | undefined {
  if (!s) return undefined;
  const m = metricsOf(s);
  if (!m) return undefined;
  const names = readFontNames(s.raw);
  return { ...(names ? { names } : {}), metrics: m };
}

const styled = (names: FontNames, want: string, bold: boolean, italic: boolean): boolean => {
  if (!familyMatches(names, want)) return false;
  const st = deriveStyle(names);
  return (st.weight >= 600) === bold && st.italic === italic;
};

const covers = (m: FaceMetrics, text: string): number | undefined => {
  for (const ch of text) {
    if (ch === '\n') continue;
    const cp = ch.codePointAt(0)!;
    if (m.advance(cp) === undefined) return cp;
  }
  return undefined;
};

export function faceLookup(doc: Document): FaceLookup {
  let embedded: Face[] | undefined;
  const embeddedFaces = (): Face[] => {
    if (embedded) return embedded;
    embedded = [];
    for (const [, o] of doc.objectEntries()) {
      if (!isDict(o)) continue;
      const t = o.get('Type');
      if (!isName(t) || t.name !== 'FontDescriptor') continue;
      for (const key of ['FontFile2', 'FontFile3']) {
        const s = doc.resolve(o.get(key));
        if (!isStream(s)) continue;
        if (key === 'FontFile3') {
          const sub = s.dict.get('Subtype');
          if (!isName(sub) || sub.name !== 'OpenType') continue;
        }
        try {
          const f = face(parseSfnt(decodeStream(s), 0, doc.loadLimits));
          if (f?.names) embedded.push(f);
        } catch (caught) { rethrowLimit(caught); }
      }
    }
    return embedded;
  };
  // A registered face is parsed on first use: `f` undefined until then, null
  // when it would not parse.
  type Registered = { rec: FaceRecord; f?: Face | null };
  let registered: Registered[] | undefined;
  const registeredFaces = (): Registered[] =>
    (registered ??= doc.registeredFontFaces().map((rec): Registered => ({ rec })));

  return (style: RunStyle, text: string) => {
    const tried: string[] = [];
    for (const raw of style.family) {
      const want = raw.trim().toLowerCase();
      if (want === '' || GENERIC.has(want)) continue;
      tried.push(raw.trim());
      let uncovered: number | undefined;
      const accept = (f: Face): FaceMetrics | undefined => {
        const miss = covers(f.metrics, text);
        if (miss === undefined) return f.metrics;
        uncovered ??= miss;
        return undefined;
      };
      for (const f of embeddedFaces())
        if (styled(f.names!, want, style.bold, style.italic)) { const m = accept(f); if (m) return m; }
      for (const r of registeredFaces()) {
        if (!styled(r.rec.names, want, style.bold, style.italic)) continue;
        if (r.f === undefined) r.f = face(doc.registeredFaceSfnt(r.rec)) ?? null;
        if (r.f) { const m = accept(r.f); if (m) return m; }
      }
      // hasOwn FIRST: the name comes from the document, and 'constructor'
      // must not find Object.prototype's (predefcmap.ts's trap).
      const sub = Object.hasOwn(XFA_SUBSTITUTES, want) ? XFA_SUBSTITUTES[want] : undefined;
      if (sub) {
        const f = face(getStd14Sfnt(sub[(style.bold ? 1 : 0) + (style.italic ? 2 : 0)]));
        if (f) { const m = accept(f); if (m) return m; }
      }
      if (uncovered !== undefined)
        return { reason: `no face of "${raw.trim()}" covers U+${uncovered.toString(16).toUpperCase().padStart(4, '0')}` };
    }
    const st = `${style.bold ? 'bold' : 'normal'} ${style.italic ? 'italic' : 'normal'}`;
    return { reason: tried.length === 0
      ? `its font family "${style.family.join(', ')}" names no face`
      : `no face named "${tried.join('", "')}" (${st}) is embedded, registered, or a known substitute` };
  };
}
