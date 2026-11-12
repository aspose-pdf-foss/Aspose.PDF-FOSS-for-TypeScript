import { SfntFont } from './sfnt.js';
import { FontDriver } from './layout.js';
import { shapeText, measureShaped, type ShapedRun, type ShapeOpts } from './shape.js';
import { verticalGlyph } from './otlayout.js';
import { UnsupportedFeatureError } from './errors.js';

/**
 * An opaque handle to a font program registered with {@link Document.AddFont}.
 * Pass it as the `font` option to `Page.AddText` / `Page.AddTextBlock` to author
 * arbitrary-Unicode text. One handle is subset and embedded once per document at
 * `Save`, accumulating the glyphs used across every draw.
 */
export class EmbeddedFont {
  /** @internal parsed font program. */
  readonly sfnt: SfntFont;
  /** @internal original GIDs (= CIDs) drawn with this font, across all pages. */
  readonly usedGids = new Set<number>();
  /** @internal object number of the Type0 font dict, reserved on first draw and
   *  filled by the document's finalize pass at Save (undefined until then). */
  objNum: number | undefined;
  /** @internal object number of a VERTICAL Type0 font dict over the same
   *  descendant (`/Identity-V`), reserved when text is written vertically in
   *  this font (`ReplaceFont` of a vertical font, g0ky.8); undefined until then. */
  verticalObjNum: number | undefined;
  /** @internal default shaping flag, from {@link Document.AddFont}({ shape }). */
  shape = false;
  /** @internal Character code → source text, for /ToUnicode. Codes normally
   *  equal GIDs; conflicting source strings get distinct codes for one CID. */
  readonly toUnicode = new Map<number, string>();
  /** @internal Drawn character code → original GID (= CID). */
  readonly codeToGid = new Map<number, number>();
  private readonly sourceCodes = new Map<number, Map<string, number>>();
  private nextCode = 0xffff;

  /** Give each (outline, source text) pair a stable character code. The font's
   *  Encoding CMap can map multiple codes to one CID without duplicating the
   *  outline or changing /W, for both TrueType and CFF fonts. */
  private codeFor(gid: number, source: string): number {
    let sources = this.sourceCodes.get(gid);
    const existing = sources?.get(source);
    if (existing !== undefined) return existing;
    let code = gid;
    if (this.codeToGid.has(code)) {
      while (this.nextCode >= 0 && this.codeToGid.has(this.nextCode)) this.nextCode--;
      if (this.nextCode < 0) throw new UnsupportedFeatureError('embedded font exhausted its 2-byte character codes');
      code = this.nextCode--;
    }
    if (!sources) { sources = new Map(); this.sourceCodes.set(gid, sources); }
    sources.set(source, code);
    this.codeToGid.set(code, gid);
    this.toUnicode.set(code, source);
    return code;
  }

  /** @internal Construct via {@link Document.AddFont}. */
  constructor(sfnt: SfntFont) {
    this.sfnt = sfnt;
  }

  /** @internal Width of `text` in points at `fontSize`; chars absent from the
   *  font's cmap are dropped (no recording). */
  measure(text: string, fontSize: number): number {
    const scale = fontSize / (this.sfnt.unitsPerEm || 1000);
    let w = 0;
    for (const ch of text) {
      const gid = this.sfnt.cmapLookup(ch.codePointAt(0)!);
      if (gid !== undefined) w += this.sfnt.advanceWidth(gid) * scale;
    }
    return w;
  }

  /** @internal Encode `text` to 2-byte codes selecting original GID CIDs,
   *  recording glyphs for subsetting. Uncmapped chars are dropped. */
  encode(text: string): Uint8Array {
    const out: number[] = [];
    for (const ch of text) {
      const gid = this.sfnt.cmapLookup(ch.codePointAt(0)!);
      if (gid !== undefined) {
        const code = this.codeFor(gid, ch);
        out.push((code >> 8) & 0xff, code & 0xff);
        this.usedGids.add(gid);
      }
    }
    return Uint8Array.from(out);
  }

  /** @internal `gid` -> the glyph drawn for it in vertical writing, memoized. */
  private readonly vglyphs = new Map<number, number>();
  private vglyph(gid: number): number {
    let v = this.vglyphs.get(gid);
    if (v === undefined) { v = verticalGlyph(this.sfnt, gid); this.vglyphs.set(gid, v); }
    return v;
  }

  /** @internal {@link encode} for the VERTICAL twin (g0ky.10): each glyph is
   *  the face's vertical form (`vrt2`, else `vert`), so a rotated `ー` or `「`
   *  is drawn rather than the horizontal one. A substituted glyph usually has
   *  no cmap entry, so its text is recorded for `/ToUnicode`. */
  encodeVertical(text: string): Uint8Array {
    const out: number[] = [];
    for (const ch of text) {
      const base = this.sfnt.cmapLookup(ch.codePointAt(0)!);
      if (base === undefined) continue;
      const gid = this.vglyph(base);
      const code = this.codeFor(gid, ch);
      out.push((code >> 8) & 0xff, code & 0xff);
      this.usedGids.add(gid);
    }
    return Uint8Array.from(out);
  }

  /** @internal `gid`'s `/W2` entry -- `[w1y, vx, vy]` in 1/1000 em -- from
   *  the face's `vmtx`: advance height down, half the advance width across,
   *  and the vertical origin at `yMax + topSideBearing` (OpenType). Undefined
   *  without `vhea`/`vmtx`, where the twin's `/DW2` default answers. */
  verticalMetricsOf(gid: number): [number, number, number] | undefined {
    const m = this.sfnt.verticalMetrics(gid);
    if (!m) return undefined;
    const em = (v: number): number => Math.round((v * 1000) / (this.sfnt.unitsPerEm || 1000));
    return [-em(m.advance), em(this.sfnt.advanceWidth(gid) / 2), em((this.sfnt.glyphYMax(gid) ?? 0) + m.tsb)];
  }

  /** @internal How far `text` advances in the vertical twin, in em -- negative,
   *  downward -- by the same rounding `/W2` is written with. */
  verticalAdvance(text: string): number {
    let a = 0;
    for (const ch of text) {
      const base = this.sfnt.cmapLookup(ch.codePointAt(0)!);
      if (base === undefined) continue;
      a += (this.verticalMetricsOf(this.vglyph(base))?.[0] ?? -1000) / 1000;
    }
    return a;
  }

  /** @internal Count of cmappable chars in `text`, without recording glyphs. */
  probe(text: string): number {
    let n = 0;
    for (const ch of text) if (this.sfnt.cmapLookup(ch.codePointAt(0)!) !== undefined) n++;
    return n;
  }

  /** @internal A {@link FontDriver} view for the layout/stamping engine. */
  driver(): FontDriver {
    return {
      measure: (t, fs) => this.measure(t, fs),
      encode: (t) => this.encode(t),
      probe: (t) => this.probe(t),
    };
  }

  /** @internal Shape `text` into visual runs, recording used gids and, for each
   *  final gid, the source code points of its cluster (for /ToUnicode). */
  shapeRuns(text: string, opts?: ShapeOpts): ShapedRun[] {
    const codes = [...text];
    const runs = shapeText(text, this.sfnt, opts);
    // A gid's source substring spans [cluster, nextUsedCluster) over the whole
    // text; clusters are global logical code indices, so the last one extends to
    // codes.length (restores a trailing ligature's full source, e.g. fi → "fi").
    const clusters = new Set<number>();
    for (const r of runs) for (const g of r.glyphs) clusters.add(g.cluster);
    const sorted = [...clusters].sort((a, b) => a - b);
    const nextOf = new Map<number, number>();
    for (let i = 0; i < sorted.length; i++) nextOf.set(sorted[i], i + 1 < sorted.length ? sorted[i + 1] : codes.length);
    for (const r of runs) {
      for (const g of r.glyphs) {
        this.usedGids.add(g.gid);
        const next = nextOf.get(g.cluster) ?? g.cluster + 1;
        const code = this.codeFor(g.gid, codes.slice(g.cluster, Math.max(next, g.cluster + 1)).join(''));
        if (code !== g.gid) g.code = code;
      }
    }
    return runs;
  }

  /** @internal Shaped width of `text` in points at `fontSize`. */
  measureShaped(text: string, fontSize: number, opts?: ShapeOpts): number {
    const scale = fontSize / (this.sfnt.unitsPerEm || 1000);
    return measureShaped(shapeText(text, this.sfnt, opts)) * scale;
  }
}
