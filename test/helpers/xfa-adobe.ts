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
  /** [left, top] content insets of a subform, by dotted path. */
  insets?: Record<string, [number, number]>;
  subforms: Record<string, AdobeFrag[]>;
  fields: Record<string, AdobeFrag[]>;
}
export interface AdobeGoldens { reader: string; probes: Record<string, AdobeProbe> }

const DIR = new URL('../fixtures/xfa-adobe/', import.meta.url);
export const ADOBE_PROBES: readonly string[] = Array.from({ length: 24 }, (_, i) => `t${String(i + 3)}`);
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
export const QUALIFIED_PROBES: readonly string[] = Array.from({ length: 15 }, (_, i) => `q${String(i + 1)}`);
export const qualifiedGoldens = (): QualifiedGoldens =>
  JSON.parse(readFileSync(new URL('adobe-qualified.json', DIR), 'utf8')) as QualifiedGoldens;
