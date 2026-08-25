import { SfntFont } from './sfnt.js';
import { FontDriver } from './layout.js';
import { shapeText, measureShaped, type ShapedRun, type ShapeOpts } from './shape.js';

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
  /** @internal default shaping flag, from {@link Document.AddFont}({ shape }). */
  shape = false;
  /** @internal gid → source text, for /ToUnicode of shaped/ligated/RTL glyphs. */
  readonly toUnicode = new Map<number, string>();

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

  /** @internal Encode `text` to 2-byte Identity-H glyph codes (CID = original
   *  GID), recording each used GID for subsetting. Uncmapped chars are dropped. */
  encode(text: string): Uint8Array {
    const out: number[] = [];
    for (const ch of text) {
      const gid = this.sfnt.cmapLookup(ch.codePointAt(0)!);
      if (gid !== undefined) {
        out.push((gid >> 8) & 0xff, gid & 0xff);
        this.usedGids.add(gid);
      }
    }
    return Uint8Array.from(out);
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
        if (!this.toUnicode.has(g.gid)) {
          const next = nextOf.get(g.cluster) ?? g.cluster + 1;
          this.toUnicode.set(g.gid, codes.slice(g.cluster, Math.max(next, g.cluster + 1)).join(''));
        }
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
