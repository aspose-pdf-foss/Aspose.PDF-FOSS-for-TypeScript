import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildFormButtonsPdf } from './helpers/build-form-buttons-pdf.js';
import { buildFormPdf } from './helpers/build-form-pdf.js';
import { interpret, baseMatrix } from '../src/pagerender.js';
import { SvgSink } from '../src/svgrender.js';
import type { PdfDict } from '../src/types.js';
import { decodePng } from './helpers/decode-png.js';

/** The SVG a page renders to, with `hide` suppressed. */
function svgWith(doc: Document, hide?: ReadonlySet<PdfDict>): string {
  const page = doc.Pages[0];
  const { matrix, width, height } = baseMatrix(page, 'crop');
  const sink = new SvgSink(doc);
  interpret(doc, page, matrix, sink, { hideWidgets: hide });
  return sink.finish(width, height);
}

describe('InterpretOptions.hideWidgets', () => {
  // The buttons fixture, not the shared form one: its widgets have a REAL
  // appearance (a blue fill) where the shared fixture's /AP streams are empty,
  // and an empty appearance draws nothing whether it is suppressed or not — so
  // that fixture cannot tell the two apart.
  const doc = () => Document.Open(buildFormButtonsPdf());

  it('draws every widget when nothing is hidden', () => {
    // Three buttons, each a blue fill.
    expect((svgWith(doc()).match(/#0000ff/g) ?? []).length).toBe(3);
  });

  it("drops a hidden widget's appearance", () => {
    // The whole double-draw defence: a converted widget must contribute no ink,
    // or its painted value sits behind the control showing the same text.
    const d = doc();
    const widget = d.Form.Fields.find((f) => f.Name === 'submit')!.Widgets[0];
    expect((svgWith(d, new Set([widget])).match(/#0000ff/g) ?? []).length).toBe(2);
  });

  it('hides only the widgets it is given', () => {
    // Per widget, not per page: a field that failed to convert keeps its ink.
    const d = doc();
    const all = d.Form.Fields.flatMap((f) => f.Widgets);
    expect((svgWith(d, new Set(all)).match(/#0000ff/g) ?? []).length).toBe(0);
  });
});

describe('ToHtml({ forms: true })', () => {
  const withForms = (extra = {}) =>
    Document.Open(buildFormPdf()).ToHtml({ mode: 'fixed', forms: true, ...extra });

  it('emits the controls', () => {
    expect(withForms()).toContain('type="text"');
  });

  it("does not also paint the field's value", () => {
    // The text field's value is Bob; it must appear once, in the control, and
    // never as a <span> from the widget's own appearance.
    //
    // **Measured, and recorded rather than hidden: this assertion is NOT
    // load-bearing.** `buildFormPdf`'s text field carries no /AP at all, so
    // nothing paints "Bob" whether the widget is suppressed or not — neutering
    // drawAnnots' skip leaves this case green. The rule it describes is real,
    // and what actually pins it is the pair of pixel probes below plus the
    // hideWidgets counts above, all three of which go red under that mutation.
    // Do not read this one's green as coverage.
    const html = withForms();
    expect(html).toContain('value="Bob"');
    expect(html).not.toMatch(/<span[^>]*>[^<]*Bob/);
  });

  it('emits no controls without the option', () => {
    expect(Document.Open(buildFormPdf()).ToHtml({ mode: 'fixed' }))
      .not.toContain('type="text"');
  });

  it('refuses semantic mode rather than ignoring the option', () => {
    expect(() => Document.Open(buildFormPdf()).ToHtml({ mode: 'semantic', forms: true }))
      .toThrow(/forms/);
  });

  it('works with a raster backdrop', () => {
    expect(withForms({ backdrop: 'raster' })).toContain('type="text"');
  });

  it('wraps the pages in a form only when a submit button was converted', () => {
    // The plain-fields fixture has no submit, so no envelope.
    expect(withForms()).not.toContain('<form');
    const withSubmit = Document.Open(buildFormButtonsPdf())
      .ToHtml({ mode: 'fixed', forms: true });
    expect(withSubmit).toContain('<form action="https://example.com/post" method="post">');
  });
});

describe("forms with backdrop: 'page'", () => {
  it('emits the control and keeps the widget ink out of the raster', () => {
    // Go refuses this combination outright, because its faithful raster has the
    // widget baked in. Ours does not: the same suppression set reaches the
    // rasterizer, so the widget appears once — as the control.
    //
    // The pixel probe is the only assertion that can see into a baked backdrop;
    // asserting the control exists would pass with the appearance still painted.
    // The buttons fixture's widgets paint a blue fill, so blue pixels inside a
    // converted widget's own /Rect are exactly the defect.
    const doc = Document.Open(buildFormButtonsPdf());
    const html = doc.ToHtml({ mode: 'fixed', forms: true, backdrop: 'page', backdropScale: 1 });
    expect(html).toContain('type="submit"');

    const b64 = /<img src="data:image\/png;base64,([^"]+)"/.exec(html)![1];
    const img = decodePng(new Uint8Array(Buffer.from(b64, 'base64')));
    const rect = (doc.resolve(doc.Form.Fields.find((f) => f.Name === 'submit')!.Widgets[0]
      .get('Rect')) as number[]).map(Number);
    const crop = doc.Pages[0].CropBox;
    const top = Math.max(crop[1], crop[3]);
    let blue = 0;
    for (let y = Math.round(top - rect[3]); y < Math.round(top - rect[1]); y++)
      for (let x = Math.round(rect[0]); x < Math.round(rect[2]); x++) {
        if (y < 0 || y >= img.height || x < 0 || x >= img.width) continue;
        const [r, g, b] = img.at(x, y);
        if (b > 200 && r < 100 && g < 100) blue++;
      }
    expect(blue).toBe(0);
  });

  it('a NON-converted widget keeps its ink in that same raster', () => {
    // The companion that stops the above passing because the raster is blank:
    // `plain` has no submit/reset action, so it is never claimed and must still
    // be painted. Same fixture, same probe, opposite expectation.
    const doc = Document.Open(buildFormButtonsPdf());
    const html = doc.ToHtml({ mode: 'fixed', forms: true, backdrop: 'page', backdropScale: 1 });
    const b64 = /<img src="data:image\/png;base64,([^"]+)"/.exec(html)![1];
    const img = decodePng(new Uint8Array(Buffer.from(b64, 'base64')));
    const rect = (doc.resolve(doc.Form.Fields.find((f) => f.Name === 'plain')!.Widgets[0]
      .get('Rect')) as number[]).map(Number);
    const crop = doc.Pages[0].CropBox;
    const top = Math.max(crop[1], crop[3]);
    let blue = 0;
    for (let y = Math.round(top - rect[3]); y < Math.round(top - rect[1]); y++)
      for (let x = Math.round(rect[0]); x < Math.round(rect[2]); x++) {
        if (y < 0 || y >= img.height || x < 0 || x >= img.width) continue;
        const [r, g, b] = img.at(x, y);
        if (b > 200 && r < 100 && g < 100) blue++;
      }
    expect(blue).toBeGreaterThan(0);
  });
});
