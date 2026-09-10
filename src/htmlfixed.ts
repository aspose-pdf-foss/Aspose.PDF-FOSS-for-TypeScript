import type { Document } from './document.js';
import type { Page } from './page.js';
import { Matrix, mul, translate } from './text.js';
import { glyphDisplacement, glyphOrigin } from './font.js';
import { PdfDict, PdfStream } from './types.js';
import { Rgb } from './colorspace.js';
import { interpret, baseMatrix, RenderSink, Path, StrokeStyle, TextRunInfo, OffscreenUse } from './pagerender.js';
import { SvgSink, fmt } from './svgrender.js';
import { renderPageBackdropToPng } from './raster.js';
import { pageFormControls, formEnvelope } from './htmlforms.js';
import { escapeHtml, HtmlOptions } from './html.js';
import { FontRegistry, resolveFont } from './htmlfont.js';
import { EmbeddedFontRegistry } from './htmlfontembed.js';
import { BlendMode } from './blend.js';

/** RenderSink that paints non-text ops onto an internal SvgSink backdrop and
 *  diverts each glyph run to an absolutely positioned <span>. One interpret()
 *  pass yields both layers, so text is never drawn twice. */
class HtmlSink implements RenderSink {
  private svg: SvgSink;
  private spans: string[] = [];
  constructor(doc: Document, private fonts: FontRegistry, private embed?: EmbeddedFontRegistry) {
    this.svg = new SvgSink(doc);
  }

  save(): void { this.svg.save(); }
  restore(): void { this.svg.restore(); }
  addClip(path: Path, ctm: Matrix, evenOdd: boolean): void { this.svg.addClip(path, ctm, evenOdd); }
  fill(path: Path, ctm: Matrix, color: Rgb, evenOdd: boolean): void { this.svg.fill(path, ctm, color, evenOdd); }
  stroke(path: Path, ctm: Matrix, color: Rgb, style: StrokeStyle): void { this.svg.stroke(path, ctm, color, style); }
  image(stream: PdfStream, ctm: Matrix, fillColor: Rgb): void { this.svg.image(stream, ctm, fillColor); }
  // The union and the third parameter both arrive from RenderSink; this was
  // left at the narrow `PdfDict` from 4gtd.4 until 4gtd.3, since TypeScript
  // enforces neither on an implementor.
  shading(shading: PdfDict | PdfStream, ctm: Matrix, pattern: boolean): void {
    this.svg.shading(shading, ctm, pattern);
  }
  setAlpha(fill: number, stroke: number): void { this.svg.setAlpha(fill, stroke); }
  setBlend(mode: BlendMode): void { this.svg.setBlend(mode); }
  beginOffscreen(
    region?: { x0: number; y0: number; x1: number; y1: number },
    opts?: { backdrop?: boolean; knockout?: boolean },
  ): void { this.svg.beginOffscreen(region, opts); }
  endOffscreen(use: OffscreenUse): void { this.svg.endOffscreen(use); }
  beginKnockoutElement(): void { this.svg.beginKnockoutElement(); }
  endKnockoutElement(): void { this.svg.endKnockoutElement(); }
  clearSoftMask(): void { this.svg.clearSoftMask(); }
  clipToStroke(path: Path, ctm: Matrix, style: StrokeStyle): void { this.svg.clipToStroke(path, ctm, style); }
  clipToGlyphs(infos: readonly TextRunInfo[]): boolean { return this.svg.clipToGlyphs(infos); }

  /**
   * **Text rendering mode degrades here, deliberately.** A non-painting mode (3
   * and 7) never arrives — `showText` gates it above every sink, which is what
   * makes an OCR layer invisible in this backend too — but a STROKING mode (1
   * and 5) paints filled, where raster.ts and svgrender.ts stroke for real.
   * CSS has no portable glyph stroke: `-webkit-text-stroke` is unprefixed
   * nowhere and would need the run's colour class re-keyed on the stroke paint.
   * Visible ink beats a vanished run, the rule `paintGlyphRun` already states
   * for a sink that cannot build a glyph clip. Recorded in README's limitations.
   */
  glyphRun(info: TextRunInfo): void {
    if (info.bytes.length === 0) return;
    // L: text space -> device space (ctm already folds in baseMatrix).
    const L = mul(mul(translate(0, info.rise), info.tm), info.ctm);
    // Embed mode diverts embeddable runs to their @font-face class + per-glyph
    // rendering string; a non-embeddable font returns null and falls back to map.
    // Embedding still renders glyphs with no /ToUnicode (via PUA), so the empty
    // check is on the resolved content, not the decoded text.
    const emb = this.embed?.run(info);
    let cls: string, ascent: number, content: string;
    if (emb) {
      cls = emb.cls; content = emb.chars.join('');
      ascent = resolveFont(info.fontFamily, info.bold, info.italic).ascent;
    } else {
      const r = this.fonts.get(info.fontFamily, info.bold, info.italic, info.color);
      cls = r.cls; ascent = r.ascent; content = info.decoded.text;
    }
    if (content.length === 0) return;

    // A vertical run cannot be one span: CSS would lay its glyphs across the
    // page, which is what made a vertical Japanese page export as a stack of
    // short horizontal blobs. Each glyph is placed itself, from the same
    // glyphOrigin/glyphDisplacement rules svgrender.ts and raster.ts use — a
    // third copy of the vertical arithmetic is how the backends come to
    // disagree about one page.
    if (info.font.wmode === 1) {
      this.verticalRun(info, L, cls, ascent, emb?.chars);
      return;
    }
    const [a, b, c, d, e, f] = L;
    const size = info.fontSize;
    // Fast path: axis-aligned, upright, uniform scale — plain left/top/font-size.
    const upright = Math.abs(b) < 1e-6 && Math.abs(c) < 1e-6 && a > 0 && d < 0
      && Math.abs(Math.abs(a) - Math.abs(d)) < 1e-6;
    let style: string;
    if (upright) {
      const dev = size * Math.abs(d);
      style = `left:${fmt(e)}px;top:${fmt(f - ascent * dev)}px;font-size:${fmt(dev)}px`;
    } else {
      // General path: same PDF-y-up -> CSS-y-down flip SvgSink uses (-c,-d);
      // the inner translateY applies the baseline->top shift in local space so
      // it rotates with the text.
      const m = `matrix(${[a, b, -c, -d, 0, 0].map(fmt).join(',')}) translateY(${fmt(-ascent * size)}px)`;
      style = `left:${fmt(e)}px;top:${fmt(f)}px;font-size:${fmt(size)}px;transform:${m}`;
    }
    this.spans.push(`<span class="${cls}" style="${style}">${escapeHtml(content)}</span>`);
  }

  /** One positioned span per glyph, for a `/WMode 1` run.
   *
   *  `chars` is the embedder's per-glyph rendering characters when embedding,
   *  and undefined in map mode. The two modes differ on ONE point, deliberately:
   *  map mode skips a glyph with no `text`, because there is nothing to show,
   *  while embed mode does not — its character is a codepoint assigned per gid,
   *  which is exactly how embedding renders a glyph that carries no
   *  `/ToUnicode`.
   *
   *  Note the offsets arrive in TEXT space and a span is positioned in device
   *  px, so each origin goes through `L`. `svgrender.ts` needs no such step: its
   *  `<tspan>` offsets are local to an element that already carries the
   *  transform. */
  private verticalRun(
    info: TextRunInfo, L: Matrix, cls: string, ascent: number, chars?: string[],
  ): void {
    const [a, b, c, d, e, f] = L;
    const size = info.fontSize;
    const upright = Math.abs(b) < 1e-6 && Math.abs(c) < 1e-6 && a > 0 && d < 0
      && Math.abs(Math.abs(a) - Math.abs(d)) < 1e-6;
    const dev = size * Math.abs(d);
    let penX = 0, penY = 0, i = 0;
    for (const g of info.font.decodeGlyphs(info.bytes)) {
      const text = chars ? chars[i] : g.text;
      if (text) {
        const [ox, oy] = glyphOrigin(g, penX, penY, size, info.hscale);
        // Text space -> device space, the same map the run-level e/f came from.
        const gx = a * ox + c * oy + e;
        const gy = b * ox + d * oy + f;
        const style = upright
          ? `left:${fmt(gx)}px;top:${fmt(gy - ascent * dev)}px;font-size:${fmt(dev)}px`
          : `left:${fmt(gx)}px;top:${fmt(gy)}px;font-size:${fmt(size)}px;transform:`
            + `matrix(${[a, b, -c, -d, 0, 0].map(fmt).join(',')}) `
            + `translateY(${fmt(-ascent * size)}px)`;
        this.spans.push(`<span class="${cls}" style="${style}">${escapeHtml(text)}</span>`);
      }
      const [dx, dy] = glyphDisplacement(g, size, info.charSp, info.wordSp, info.hscale);
      penX += dx; penY += dy;
      i++;
    }
  }

  /** The vector backdrop alone. A raster mode drops this and keeps the spans. */
  svgLayer(width: number, height: number): string {
    return this.svg.finish(width, height);
  }

  /** The positioned spans alone — emitted in every mode, since the text layer
   *  is what makes a fixed-mode page selectable whatever is behind it. */
  spanLayer(): string {
    return this.spans.join('');
  }
}

/** Build the fixed-mode body — one `<div class="pg">` per page — plus the
 *  document-wide font-class CSS. Never throws per page: a page that fails
 *  mid-walk contributes whatever was emitted, matching renderPageToSvg. */
export function fixedBody(
  doc: Document, pages: Page[], opts: HtmlOptions,
): { body: string; css: string } {
  const box = opts.box ?? 'crop';
  const fonts = new FontRegistry();
  const embed = opts.fonts && opts.fonts !== 'map'
    ? new EmbeddedFontRegistry(doc, opts.fonts === 'embed-all')
    : undefined;
  const divs: string[] = [];
  // Tab order runs across the DOCUMENT, so the counter is shared by every page:
  // per-page indices would restart and interleave a multi-page form's order.
  let tabIndex = 0;
  const nextTabIndex = () => ++tabIndex;
  let anySubmit = false;
  for (const page of pages) {
    const { matrix, width, height } = baseMatrix(page, box);
    const sink = new HtmlSink(doc, fonts, embed);
    // Before the interpret pass, which needs the suppression set it produces.
    const fc = opts.forms
      ? pageFormControls(doc, page, doc.Form, nextTabIndex)
      : undefined;
    if (fc?.submits) anySubmit = true;
    try {
      interpret(doc, page, matrix, sink,
        { annotations: opts.annotations, hideWidgets: fc?.converted });
    } catch {
      // Degrade: whatever was emitted before the failure still renders.
    }
    const kind = opts.backdrop ?? 'vector';
    let backdrop = '';
    if (kind !== 'vector') {
      // No `background`: renderPageToPng already defaults it to 'white', which
      // is what both modes want — .pg paints #fff behind the image, so an RGBA
      // PNG would carry an alpha channel for an invisible difference.
      const img = { scale: opts.backdropScale ?? 2, box, annotations: opts.annotations };
      try {
        // Both kinds through one entry, so the suppression set reaches a
        // rendered page too — which is what lets forms work with 'page'.
        const png = renderPageBackdropToPng(doc, page, img,
          { skipGlyphs: kind === 'raster', hideWidgets: fc?.converted });
        backdrop = `<img src="data:image/png;base64,${Buffer.from(png).toString('base64')}">`;
      } catch {
        // **Invariant:** a page that will not rasterize falls back to 'vector',
        // both raster modes, one rule. docxexport.ts degrades by dropping the
        // backdrop and keeping the text, which is right there and wrong here:
        // in 'page' mode the text is transparent, so dropping the backdrop
        // leaves a BLANK page. Falling back restores the backdrop and the
        // visible text together — and costs nothing, because the vector
        // backdrop comes from the interpret pass that has already run.
      }
    }
    // Keyed on `backdrop`, not on `kind`: a degraded 'page' must not carry the
    // transparent-text class, or the fallback produces the blank page it exists
    // to prevent.
    const sel = backdrop && kind === 'page' ? ' sel' : '';
    divs.push(`<div class="pg${sel}" style="width:${fmt(width)}px;height:${fmt(height)}px">`
      + (backdrop || sink.svgLayer(width, height)) + sink.spanLayer()
      // Controls last, so they stack above the backdrop and the text and can
      // actually be clicked.
      + (fc?.html ?? '') + `</div>`);
  }
  let body = divs.join('\n');
  if (opts.forms && anySubmit) {
    const env = formEnvelope(doc, doc.Form);
    if (env)
      body = `<form action="${escapeHtml(env.action)}" method="${env.method}">\n`
        + `${body}\n</form>`;
  }
  return { body, css: fonts.css() + (embed?.css() ?? '') };
}
