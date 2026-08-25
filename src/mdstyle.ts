/** The style vocabulary the Markdown mapper renders through: one flat, wholly
 *  optional {@link MarkdownStyle} over a documented defaults table, resolved
 *  once into a {@link ResolvedMarkdownStyle} with every field filled.
 *
 *  Pure: no PDF objects, no layout, no AST. It knows about fonts only as
 *  AuthoringFont values it passes along. */

import { EmbeddedFont } from './embeddedfont.js';
import { validateFont, type AuthoringFont } from './stamp.js';
import type { FlowQuoteBar } from './flowblock.js';

/** The four faces emphasis selects between. `bold`, `italic` and `boldItalic`
 *  each fall back to `regular` when neither given nor derivable. */
export interface MarkdownFontFamily {
  regular: AuthoringFont;
  bold?: AuthoringFont;
  italic?: AuthoringFont;
  boldItalic?: AuthoringFont;
}

/** A single face (whose family is derived when it is Standard-14) or an explicit
 *  family. */
export type MarkdownFontSpec = AuthoringFont | MarkdownFontFamily;

/** A family with all four faces filled. */
export interface ResolvedFamily {
  regular: AuthoringFont;
  bold: AuthoringFont;
  italic: AuthoringFont;
  boldItalic: AuthoringFont;
}

/** The three Standard-14 Latin families, in [regular, bold, italic, boldItalic]
 *  order. These are all twelve authoring faces `validateFont` accepts — Symbol
 *  and ZapfDingbats are not authoring fonts and never reach here. */
const STD_FAMILIES: Record<string, [AuthoringFont, AuthoringFont, AuthoringFont, AuthoringFont]> = {
  Helvetica: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
  Times: ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
  Courier: ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'],
};

/** Which Standard-14 family a face belongs to — matching how textdecor.ts picks
 *  its metrics. Undefined only for an EmbeddedFont, which derives nothing. */
function familyRoot(font: AuthoringFont): string | undefined {
  if (typeof font !== 'string') return undefined;
  if (font.startsWith('Times')) return 'Times';
  if (font.startsWith('Courier')) return 'Courier';
  if (font.startsWith('Helvetica')) return 'Helvetica';
  return undefined;
}

function isFamilyObject(v: MarkdownFontSpec): v is MarkdownFontFamily {
  return typeof v === 'object' && v !== null && !(v instanceof EmbeddedFont);
}

const FAMILY_KEYS = ['regular', 'bold', 'italic', 'boldItalic'];

/** Resolve a font spec to four faces.
 *
 *  A Standard-14 face derives its family by name — including from a non-roman
 *  member, since emphasis is relative to the FAMILY, not to the given face. An
 *  EmbeddedFont derives nothing: there is no synthetic slant or emboldening
 *  here, so an unstated face falls back to `regular` and emphasis shows as no
 *  change rather than as a missing glyph. */
export function resolveFamily(spec: MarkdownFontSpec): ResolvedFamily {
  if (isFamilyObject(spec)) {
    const f = spec;
    if (f.regular === undefined) throw new TypeError('font family must have a regular face');
    for (const [k, v] of Object.entries(f)) {
      if (!FAMILY_KEYS.includes(k)) throw new TypeError(`unknown font family face '${k}'`);
      if (v !== undefined) validateFont(v as AuthoringFont);
    }
    return {
      regular: f.regular,
      bold: f.bold ?? f.regular,
      italic: f.italic ?? f.regular,
      boldItalic: f.boldItalic ?? f.bold ?? f.italic ?? f.regular,
    };
  }
  validateFont(spec);
  const root = familyRoot(spec);
  if (root === undefined)
    return { regular: spec, bold: spec, italic: spec, boldItalic: spec };
  const [, bold, italic, boldItalic] = STD_FAMILIES[root];
  // The given face stays the regular one: `font: 'Helvetica-Bold'` means a bold
  // body, with emphasis still resolving against the Helvetica family.
  return { regular: spec, bold, italic, boldItalic };
}

/** The face the two emphasis flags select. */
export function faceFor(family: ResolvedFamily, bold: boolean, italic: boolean): AuthoringFont {
  if (bold && italic) return family.boldItalic;
  if (bold) return family.bold;
  if (italic) return family.italic;
  return family.regular;
}

/** How Markdown renders. Every field is optional; unset fields take the
 *  documented default, and derived defaults scale off `fontSize` so overriding
 *  the base size alone still yields a coherent document. */
export interface MarkdownStyle {
  /** Body face or family. Default 'Helvetica'. */
  font?: MarkdownFontSpec;
  /** Body size (points). > 0. Default 11. */
  fontSize?: number;
  /** Body colour (RGB 0..1). Default: the renderer's own default (black). */
  color?: [number, number, number];
  /** Baseline-to-baseline distance. Default 1.35 * fontSize. */
  leading?: number;
  /** Paragraph alignment. Default 'left'. */
  align?: 'left' | 'center' | 'right' | 'justify';
  /** Gap between consecutive blocks. >= 0. Default 0.55 * fontSize. */
  paragraphSpacing?: number;
  heading?: {
    /** Heading face or family. Default 'Helvetica-Bold'. */
    font?: MarkdownFontSpec;
    /** Sizes for levels 1..6. Exactly six positive numbers.
     *  Default [24, 18, 14, 12, 10, 8] — Flow's own heading scale. */
    sizes?: number[];
    color?: [number, number, number];
    /** Default 1.2 * fontSize. */ spaceBefore?: number;
    /** Default 0.4 * fontSize. */ spaceAfter?: number;
  };
  code?: {
    /** Default 'Courier'. */ font?: AuthoringFont;
    /** Size of a fenced/indented code BLOCK (points). > 0. Default 0.85 * fontSize. */
    fontSize?: number;
    /** Size of an INLINE code span, as a fraction of the block it sits in.
     *  > 0. Default 0.9 — Courier reads optically larger than Helvetica. */
    sizeRatio?: number;
    color?: [number, number, number];
    /** Fill behind a code block, or `false` for none. Default a light grey. */
    background?: [number, number, number] | false;
    /** Fill behind an inline code span, or `false` for none. Default a light grey. */
    inlineBackground?: [number, number, number] | false;
    /** Inset inside a code block's fill. >= 0. Default 0.4 * fontSize. */
    padding?: number;
    spaceBefore?: number;
    spaceAfter?: number;
  };
  quote?: {
    /** Indent of quoted content. >= 0. Default 1.6 * fontSize. */ indent?: number;
    /** The gutter bar, or `false`. Default a 3pt light-grey bar at the edge. */
    bar?: FlowQuoteBar | false;
    spaceBefore?: number;
    spaceAfter?: number;
  };
  rule?: {
    /** > 0. Default 0.5. */ thickness?: number;
    color?: [number, number, number];
    /** Default 0.8 * fontSize. */ spaceBefore?: number;
    /** Default 0.8 * fontSize. */ spaceAfter?: number;
  };
  list?: {
    /** Per-level body indent. >= 0. Default: Flow's measured-marker auto indent. */
    indent?: number;
    /** Gap between items of a TIGHT list. >= 0. Default 0. */ itemSpacing?: number;
    /** Marker glyph for a bullet list. Default: Flow's vector bullet cycle. */
    bullet?: string;
    spaceBefore?: number;
    spaceAfter?: number;
  };
  link?: {
    /** Default a mid blue. */ color?: [number, number, number];
    /** Default true. */ underline?: boolean;
  };
  table?: {
    /** Cell and frame rule. Default 0.5pt mid grey. */
    border?: { color?: [number, number, number]; thickness?: number };
    /** Fill behind the header row, or `false` for none. Default a light grey. */
    headerBackground?: [number, number, number] | false;
    /** Padding inside every cell. >= 0. Default 4. */
    padding?: number;
    /** Cell text size. > 0. Default the body `fontSize`. */
    fontSize?: number;
    /** Default 0.6 * fontSize. */ spaceBefore?: number;
    /** Default 0.6 * fontSize. */ spaceAfter?: number;
  };
  image?: {
    /** Default 'left'. */ align?: 'left' | 'center' | 'right';
    spaceBefore?: number;
    spaceAfter?: number;
  };
}

/** {@link MarkdownStyle} with every field resolved. @internal */
export interface ResolvedMarkdownStyle {
  family: ResolvedFamily;
  fontSize: number;
  color?: [number, number, number];
  leading: number;
  align: 'left' | 'center' | 'right' | 'justify';
  paragraphSpacing: number;
  heading: {
    family: ResolvedFamily; sizes: number[];
    color?: [number, number, number]; spaceBefore: number; spaceAfter: number;
  };
  code: {
    font: AuthoringFont; fontSize: number; sizeRatio: number;
    color?: [number, number, number];
    background: [number, number, number] | false;
    inlineBackground: [number, number, number] | false;
    padding: number; spaceBefore: number; spaceAfter: number;
  };
  quote: { indent: number; bar: FlowQuoteBar | false; spaceBefore: number; spaceAfter: number };
  rule: {
    thickness: number; color?: [number, number, number];
    spaceBefore: number; spaceAfter: number;
  };
  list: {
    indent?: number; itemSpacing: number; bullet?: string;
    spaceBefore: number; spaceAfter: number;
  };
  link: { color: [number, number, number]; underline: boolean };
  table: {
    border: { color: [number, number, number]; thickness: number };
    headerBackground: [number, number, number] | false;
    padding: number; fontSize: number; spaceBefore: number; spaceAfter: number;
  };
  image: { align: 'left' | 'center' | 'right'; spaceBefore: number; spaceAfter: number };
}

function pos(v: number | undefined, dflt: number, name: string): number {
  const n = v ?? dflt;
  if (!Number.isFinite(n) || n <= 0) throw new TypeError(`${name} must be a positive finite number`);
  return n;
}
function nonNeg(v: number | undefined, dflt: number, name: string): number {
  const n = v ?? dflt;
  if (!Number.isFinite(n) || n < 0)
    throw new TypeError(`${name} must be a non-negative finite number`);
  return n;
}
function color(v: unknown, name: string): [number, number, number] {
  if (!Array.isArray(v) || v.length !== 3
      || !v.every((c) => typeof c === 'number' && Number.isFinite(c) && c >= 0 && c <= 1))
    throw new TypeError(`${name} must be [r, g, b] with each component in 0..1`);
  return v as [number, number, number];
}
function optColor(v: unknown, name: string): [number, number, number] | undefined {
  return v === undefined ? undefined : color(v, name);
}
/** A fill option: a colour, or `false` for none. */
function fill(
  v: [number, number, number] | false | undefined, dflt: [number, number, number], name: string,
): [number, number, number] | false {
  if (v === false) return false;
  return v === undefined ? dflt : color(v, name);
}

const DEFAULT_HEADING_SIZES = [24, 18, 14, 12, 10, 8];
const DEFAULT_CODE_FILL: [number, number, number] = [0.96, 0.96, 0.96];
const DEFAULT_LINK_COLOR: [number, number, number] = [0.1, 0.3, 0.75];
const DEFAULT_TABLE_RULE: [number, number, number] = [0.7, 0.7, 0.7];
const DEFAULT_TABLE_HEADER_FILL: [number, number, number] = [0.93, 0.93, 0.93];

/** Validate and fill a {@link MarkdownStyle}. Validates EVERYTHING before
 *  returning, so a rejected style leaves the document byte-identical. */
export function resolveMarkdownStyle(style: MarkdownStyle = {}): ResolvedMarkdownStyle {
  if (typeof style !== 'object' || style === null)
    throw new TypeError('style must be an object');
  const fontSize = pos(style.fontSize, 11, 'fontSize');
  const align = style.align ?? 'left';
  if (!['left', 'center', 'right', 'justify'].includes(align))
    throw new TypeError('align must be left, center, right, or justify');

  const h = style.heading ?? {};
  const sizes = h.sizes ?? DEFAULT_HEADING_SIZES;
  if (!Array.isArray(sizes) || sizes.length !== 6
      || !sizes.every((n) => Number.isFinite(n) && n > 0))
    throw new TypeError('heading.sizes must be six positive numbers, for levels 1..6');

  const c = style.code ?? {};
  if (c.font !== undefined) validateFont(c.font);
  const q = style.quote ?? {};
  if (q.bar !== undefined && q.bar !== false
      && (typeof q.bar !== 'object' || q.bar === null || Array.isArray(q.bar)))
    throw new TypeError('quote.bar must be an object or false');
  const r = style.rule ?? {};
  const l = style.list ?? {};
  if (l.bullet !== undefined && typeof l.bullet !== 'string')
    throw new TypeError('list.bullet must be a string');
  const k = style.link ?? {};
  const tb = style.table ?? {};
  if (k.underline !== undefined && typeof k.underline !== 'boolean')
    throw new TypeError('link.underline must be a boolean');
  const im = style.image ?? {};
  const imAlign = im.align ?? 'left';
  if (!['left', 'center', 'right'].includes(imAlign))
    throw new TypeError("image.align must be 'left', 'center', or 'right'");

  return {
    family: resolveFamily(style.font ?? 'Helvetica'),
    fontSize,
    color: optColor(style.color, 'color'),
    leading: pos(style.leading, fontSize * 1.35, 'leading'),
    align: align as ResolvedMarkdownStyle['align'],
    paragraphSpacing: nonNeg(style.paragraphSpacing, fontSize * 0.55, 'paragraphSpacing'),
    heading: {
      family: resolveFamily(h.font ?? 'Helvetica-Bold'),
      sizes,
      color: optColor(h.color, 'heading.color'),
      spaceBefore: nonNeg(h.spaceBefore, fontSize * 1.2, 'heading.spaceBefore'),
      spaceAfter: nonNeg(h.spaceAfter, fontSize * 0.4, 'heading.spaceAfter'),
    },
    code: {
      font: c.font ?? 'Courier',
      fontSize: pos(c.fontSize, fontSize * 0.85, 'code.fontSize'),
      sizeRatio: pos(c.sizeRatio, 0.9, 'code.sizeRatio'),
      color: optColor(c.color, 'code.color'),
      background: fill(c.background, DEFAULT_CODE_FILL, 'code.background'),
      inlineBackground: fill(c.inlineBackground, DEFAULT_CODE_FILL, 'code.inlineBackground'),
      padding: nonNeg(c.padding, fontSize * 0.4, 'code.padding'),
      spaceBefore: nonNeg(c.spaceBefore, 0, 'code.spaceBefore'),
      spaceAfter: nonNeg(c.spaceAfter, 0, 'code.spaceAfter'),
    },
    quote: {
      indent: nonNeg(q.indent, fontSize * 1.6, 'quote.indent'),
      bar: q.bar ?? {},
      spaceBefore: nonNeg(q.spaceBefore, 0, 'quote.spaceBefore'),
      spaceAfter: nonNeg(q.spaceAfter, 0, 'quote.spaceAfter'),
    },
    rule: {
      thickness: pos(r.thickness, 0.5, 'rule.thickness'),
      color: optColor(r.color, 'rule.color'),
      spaceBefore: nonNeg(r.spaceBefore, fontSize * 0.8, 'rule.spaceBefore'),
      spaceAfter: nonNeg(r.spaceAfter, fontSize * 0.8, 'rule.spaceAfter'),
    },
    list: {
      indent: l.indent === undefined ? undefined : nonNeg(l.indent, 0, 'list.indent'),
      itemSpacing: nonNeg(l.itemSpacing, 0, 'list.itemSpacing'),
      bullet: l.bullet,
      spaceBefore: nonNeg(l.spaceBefore, 0, 'list.spaceBefore'),
      spaceAfter: nonNeg(l.spaceAfter, 0, 'list.spaceAfter'),
    },
    link: {
      color: k.color === undefined ? DEFAULT_LINK_COLOR : color(k.color, 'link.color'),
      underline: k.underline ?? true,
    },
    table: {
      border: {
        color: tb.border?.color === undefined
          ? DEFAULT_TABLE_RULE : color(tb.border.color, 'table.border.color'),
        thickness: pos(tb.border?.thickness, 0.5, 'table.border.thickness'),
      },
      headerBackground: fill(tb.headerBackground, DEFAULT_TABLE_HEADER_FILL,
        'table.headerBackground'),
      padding: nonNeg(tb.padding, 4, 'table.padding'),
      fontSize: pos(tb.fontSize, fontSize, 'table.fontSize'),
      spaceBefore: nonNeg(tb.spaceBefore, 0.6 * fontSize, 'table.spaceBefore'),
      spaceAfter: nonNeg(tb.spaceAfter, 0.6 * fontSize, 'table.spaceAfter'),
    },
    image: {
      align: imAlign as 'left' | 'center' | 'right',
      spaceBefore: nonNeg(im.spaceBefore, 0, 'image.spaceBefore'),
      spaceAfter: nonNeg(im.spaceAfter, 0, 'image.spaceAfter'),
    },
  };
}
