/** Shared authoring-font shaping resolution and pure measuring drivers.
 *  No PDF object/document work: page blocks, tables and intrinsic sizing must
 *  resolve the same run to the same advances. @internal */
import { EmbeddedFont } from './embeddedfont.js';
import { winAnsiDriver, type FontDriver } from './layout.js';
import { shapeText, validateFeatures, type ShapeOpts } from './shape.js';
import type { AuthoringFont } from './stamp.js';

export interface TextShapeOptions extends ShapeOpts { shape?: boolean }

/** Resolve a run over its block, then the resolved font's shaping default. */
export function shapeOptionsFor(
  font: AuthoringFont, own: TextShapeOptions = {}, block: TextShapeOptions = {},
): ShapeOpts | undefined {
  validateFeatures(block.features);
  validateFeatures(own.features);
  if (!(font instanceof EmbeddedFont) || !(own.shape ?? block.shape ?? font.shape)) return undefined;
  return {
    dir: own.dir ?? block.dir,
    script: own.script ?? block.script,
    language: own.language ?? block.language,
    features: own.features === undefined ? block.features
      : { ...block.features, ...own.features },
  };
}

/** Shaped layout encodes nothing: only positioned emission records glyphs.
 *  `measureOnly` also suppresses recording on the unshaped embedded path. */
export function textDriver(
  font: AuthoringFont, so?: ShapeOpts, measureOnly = false,
): FontDriver {
  if (font instanceof EmbeddedFont && so !== undefined) return {
    contextual: true,
    measure: (t, fs) => font.measureShaped(t, fs, so),
    encode: () => new Uint8Array(0),
    probe: (t) => t.length ? shapeText(t, font.sfnt, so).reduce((n, r) => n + r.glyphs.length, 0) : 0,
  };
  const real = font instanceof EmbeddedFont ? font.driver() : winAnsiDriver(font);
  return measureOnly ? { ...real, encode: () => new Uint8Array(0) } : real;
}
