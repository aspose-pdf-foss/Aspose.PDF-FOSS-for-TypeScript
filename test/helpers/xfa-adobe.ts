// test/helpers/xfa-adobe.ts
import { readFileSync } from 'node:fs';

/** One fragment as Adobe Reader's xfa.layout reports it: page (1-based) and
 *  x, y, w, h in points, x/y relative to the parent's content box. */
export type AdobeFrag = [page: number, x: number, y: number, w: number, h: number];
export interface AdobeProbe {
  pages: number;
  expect: 'match' | 'refused';
  /** The issue id a refused probe's reason cites. */
  reason?: string;
  /** The dotted path of the subform whose fields a refused probe refuses;
   *  `form1.pos` (164g.11's probes) when absent. */
  refusedUnder?: string;
  /** [left, top] content insets of a subform, by dotted path. */
  insets?: Record<string, [number, number]>;
  subforms: Record<string, AdobeFrag[]>;
  fields: Record<string, AdobeFrag[]>;
  /** Draws, by dotted path (164g.12): t37-t39 hold only draws, which have no
   *  widget, so they are compared through our layout rather than the PDF. */
  draws?: Record<string, AdobeFrag[]>;
  /** t66, t67 (164g.14): every frag's x/y is relative to the content-area
   *  origin (0.5in, 0.5in) of an imaginary single content area, ancestors
   *  included -- content area B starts 360pt down. Needed because Reader's
   *  pageSpan reports one fragment per PAGE, so a subform split across two
   *  content areas of one page reports only its first. */
  absolute?: true;
  /** When present, only these dotted paths are compared (t65: Adobe splits a
   *  field directly under the content area, which we do not). */
  only?: string[];
  /** A node Adobe places outside the subform it is named under (164g.15, t83:
   *  a positioned split's leader sits in the content area's flow, above the
   *  continuation, while its SOM name is `P.L`): its layout parent's path. */
  layoutParent?: Record<string, string>;
}
export interface AdobeGoldens { reader: string; probes: Record<string, AdobeProbe> }

const DIR = new URL('../fixtures/xfa-adobe/', import.meta.url);
/** t3-t26: a positioned subform split (164g.11); t27-t39: an lr-tb or table
 *  split (164g.12); t40-t54: a field split between its lines (164g.13);
 *  t55-t72: adhesion and keep intact="pageArea" (164g.14); t73-t90: overflow
 *  and break leaders and trailers (164g.15); t92-t95: a breakAfter inside a
 *  split chain (164g.16); t96-t100, t103, t104: a split positioned subform's
 *  margins (164g.20); t105-t110: one inside a split tb chain (164g.21). t91 (164g.23) is not a geometry golden -- its line
 *  heights are 164g.32's -- and `test/xfa-linesep.test.ts` reads it alone; nor
 *  are t101 and t102, visual probes on small pages read from the capture.
 *  t111-t117 (164g.32): how tall a line of text is -- faces, sizes, line
 *  counts, mixed sizes, lineHeight and paragraph spacing. t111 and t113 hold
 *  Myriad Pro rows -- not available here, so a draw in it refuses its flow --
 *  and are recorded as evidence that the face does not matter; t118 and t119
 *  are the same probes without them, and are what is compared. t114,
 *  reserve-less top captions, is recorded for 164g.36. t120: rich paragraph
 *  margins, summed. t121 (164g.36): reserve-less captions and over-wide words;
 *  its captioned fields are compared by test/xfa-caption.test.ts, since the
 *  harness compares a field's widget, which excludes the caption. */
export const ADOBE_PROBES: readonly string[] = Array.from({ length: 119 }, (_, i) => `t${String(i + 3)}`)
  .filter((t) => !['t91', 't101', 't102', 't111', 't113', 't114'].includes(t));
/** Probes with a golden that is recorded but not compared (164g.32): t111 and
 *  t113 for their Myriad Pro rows, t114 for 164g.36's captions. */
export const ADOBE_RECORDED: readonly string[] = ['t111', 't113', 't114'];
export const loadAdobeProbe = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`${name}.pdf`, DIR)));
export const adobeGoldens = (): AdobeGoldens =>
  JSON.parse(readFileSync(new URL('adobe.json', DIR), 'utf8')) as AdobeGoldens;

/** A qualified-pagination probe (164g.9) as Reader laid it out. */
export interface QualifiedProbe {
  /** 'match': we must reproduce `areas` and `fields`; 'refused': we must refuse
   *  every field in `fields` (each mapped to 0), citing `reason`. */
  expect: 'match' | 'refused';
  reason?: string;
  /** Page area NAME per page, page 1 first, exactly as Adobe reported. */
  areas: string[];
  /** Our SOM field name to Adobe's 1-based page. */
  fields: Record<string, number>;
  /** Fields Reader laid out nowhere -- content past every occur max (n1). */
  discarded?: string[];
  /** What Adobe showed, in words, when it is not a plain sequence. */
  note?: string;
}
export interface QualifiedGoldens {
  reader: string;
  /** The rules XFA 3.3 leaves open, as the probes settled them. */
  decisions: {
    /** q3: under simplex an oddOrEven="even" page area never matches. */
    simplexEvenArea: 'never' | 'matches';
    /** q12, q15: a pageEven break outside duplex -- Reader lays nothing out. */
    pageEvenOutsideDuplex: 'fatal' | 'newPage';
    /** q9, q4: a duplex document is NOT ended on a blank back page. */
    duplexTrailingBack: boolean;
    /** q10: no page area matches page 1 -- Reader lays nothing out. */
    noMatch: 'nothing' | 'other';
    /** q11: under orderedOccurrence every page is odd. */
    orderedParity: 'alwaysOdd' | 'physical';
  };
  probes: Record<string, QualifiedProbe>;
}
/** q1-q15: one qualified page set (164g.9); n1-n10: nested and sibling page
 *  sets (164g.22). */
export const QUALIFIED_PROBES: readonly string[] = [
  ...Array.from({ length: 15 }, (_, i) => `q${String(i + 1)}`),
  ...Array.from({ length: 10 }, (_, i) => `n${String(i + 1)}`),
];
export const qualifiedGoldens = (): QualifiedGoldens =>
  JSON.parse(readFileSync(new URL('adobe-qualified.json', DIR), 'utf8')) as QualifiedGoldens;
