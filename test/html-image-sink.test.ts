import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildDocModel } from '../src/docmodel.js';
import { semanticBody, type HtmlImageSink } from '../src/htmlsemantic.js';
import { buildTextAndImagePage } from './helpers/build-edit-pdf.js';

/** A caption and a 1x1 image scaled to 100pt, for the /Figure path. */
const FIGURE_PAGE =
  'BT /F1 10 Tf 50 250 Td (caption) Tj ET q 100 0 0 100 50 50 cm /Im0 Do Q';

const withImage = () => Document.Open(buildTextAndImagePage(FIGURE_PAGE));

describe('semanticBody image sink', () => {
  it('routes every figure image through the sink', () => {
    const doc = withImage();
    let calls = 0;
    const sink: HtmlImageSink = {
      href: () => { calls++; return 'images/image1.png'; },
    };
    const body = semanticBody(doc, buildDocModel(doc, doc.Pages), sink);
    expect(calls).toBeGreaterThan(0);
    expect(body).toContain('src="images/image1.png"');
    expect(body).not.toContain('data:');
  });

  it('falls back to a data: URI with no sink', () => {
    // The companion that proves the sink is what changed the href, rather than
    // the fixture simply having no image in it.
    const doc = withImage();
    const body = semanticBody(doc, buildDocModel(doc, doc.Pages));
    expect(body).toContain('src="data:');
  });

  it("drops an image the sink refuses, keeping figureHtml's own rule", () => {
    // An unencodable image must not reach the output. That rule belongs to
    // figureHtml, and a sink returning undefined must not get to re-decide it.
    const doc = withImage();
    const sink: HtmlImageSink = { href: () => undefined };
    const body = semanticBody(doc, buildDocModel(doc, doc.Pages), sink);
    expect(body).not.toContain('<img src=');
  });
});
