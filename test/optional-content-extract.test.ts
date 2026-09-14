// Optional content and EXTRACTION (q1g2.3). q1g2.1 taught the renderer to skip
// a hidden layer and q1g2.2 taught it to read an /OC on an XObject and an
// annotation; every READ API went on reporting both, so `GetText` returned
// words the same library's own `ToImage` did not draw.
//
// Two walkers, not one: `text.ts`'s `visitContent` feeds text, images and the
// table detector, while `paths.ts` is its own focused walker behind `GetPaths`.
// A fixture that passes for `GetText` proves nothing about the second, so the
// path cases are written against it directly.
//
// The other half of this file is the DELIBERATE ASYMMETRY: the walker's default
// is to see everything, so redaction, inline-image removal and `MarkContent`
// keep acting on what the file CONTAINS. Those cases are the ones that would
// turn a silent content-disclosure bug into a red build.
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { visitContent } from '../src/text.js';
import { buildOcgRenderPdf } from './helpers/build-ocg-render-pdf.js';
import { unzip } from './helpers/unzip.js';

/** Text on the visible layer, then text inside the hidden layer's section. */
const TEXT = `BT /F1 12 Tf 20 150 Td (shownword) Tj ET
/OC /OCHid BDC
BT /F1 12 Tf 20 100 Td (hiddenword) Tj ET
EMC
`;

const open = (content: string, opts = {}) =>
  Document.Open(buildOcgRenderPdf(content, opts));

const page0 = (content: string, opts = {}) => open(content, opts).Pages[0];

describe('optional content: text extraction', () => {
  it('omits text on a switched-off layer from GetText', () => {
    const p = page0(TEXT);
    expect(p.GetText()).toContain('shownword');
    expect(p.GetText()).not.toContain('hiddenword');
  });

  it('reports it again under includeHidden', () => {
    const p = page0(TEXT);
    const all = p.GetText({ includeHidden: true });
    expect(all).toContain('shownword');
    expect(all).toContain('hiddenword');
  });

  it('omits it from GetTextFragments and GetStructuredText', () => {
    const p = page0(TEXT);
    const shown = p.GetTextFragments().map((f) => f.text).join('|');
    expect(shown).toContain('shownword');
    expect(shown).not.toContain('hiddenword');

    const blocks = p.GetStructuredText().map((b) => b.text).join('|');
    expect(blocks).toContain('shownword');
    expect(blocks).not.toContain('hiddenword');

    // ...and reports both with the opt-out, so the absence above is the rule
    // rather than a fixture that never drew the second word.
    expect(p.GetTextFragments({ includeHidden: true }).map((f) => f.text).join('|'))
      .toContain('hiddenword');
    expect(p.GetStructuredText({ includeHidden: true }).map((b) => b.text).join('|'))
      .toContain('hiddenword');
  });

  it('leaves text on a layer the configuration switches ON', () => {
    // The same content with the Hidden layer's ref moved out of /OFF: nothing
    // is suppressed, which is what shows the rule reads the CONFIGURATION and
    // does not simply drop every /OC section it meets.
    const p = page0(TEXT, { off: [] });
    expect(p.GetText()).toContain('hiddenword');
  });

  it('keeps the pen advancing across a hidden run', () => {
    // A show operator occupies its width whether or not anybody sees it. Skip
    // the call outright — which is what the RENDERER does — and the visible
    // word after it starts where the hidden one began, so its quad is WRONG
    // rather than merely absent.
    const content = `BT /F1 12 Tf 20 150 Td
/OC /OCHid BDC (hiddenword) Tj EMC
(tail) Tj ET
`;
    const doc = open(content);
    // Glyph events rather than fragments: `fragmentsFromGlyphs` MERGES the two
    // adjacent same-font runs, so under includeHidden they are one fragment
    // starting at 20 and a fragment-level comparison measures nothing. 't'
    // occurs only in `tail`.
    const tx = (skipHidden: boolean): number => {
      let x = NaN;
      visitContent(doc, doc.Pages[0], {
        glyph: (e) => { if (e.text === 't' && Number.isNaN(x)) x = e.quad[0]; },
      }, { skipHidden });
      return x;
    };
    // Where the hidden glyphs really put the pen, read with them reported...
    const expected = tx(false);
    expect(expected).toBeGreaterThan(60);       // well past the 20 it started at
    // ...and the same answer with them suppressed.
    expect(tx(true)).toBeCloseTo(expected, 6);
  });
});

describe('optional content: nesting and operand shapes', () => {
  it('keeps a visible section nested inside a hidden one hidden', () => {
    const content = `/OC /OCHid BDC
BT /F1 12 Tf 20 150 Td (outerword) Tj ET
/OC /OCVis BDC
BT /F1 12 Tf 20 120 Td (innerword) Tj ET
EMC
BT /F1 12 Tf 20 90 Td (betweenword) Tj ET
EMC
BT /F1 12 Tf 20 60 Td (afterword) Tj ET
`;
    const t = page0(content).GetText();
    expect(t).not.toContain('outerword');
    expect(t).not.toContain('innerword');
    // Between the two EMCs is still INSIDE the hidden section: an inner EMC
    // that popped the outer one would let this through.
    expect(t).not.toContain('betweenword');
    // Past the outer EMC the page is visible again, which is what shows the
    // nesting pops rather than latching hidden forever.
    expect(t).toContain('afterword');
  });

  it('leaves an /OC operand that is an inline dictionary VISIBLE', () => {
    // Hiding content on a shape we did not resolve through /Properties is the
    // one error that loses ink, so an unresolvable operand paints.
    const content = `/OC << /Type /OCMD >> BDC
BT /F1 12 Tf 20 100 Td (inlineword) Tj ET
EMC
`;
    expect(page0(content).GetText()).toContain('inlineword');
  });

  it('ignores a non-/OC tag carrying the hidden layer as its property', () => {
    const content = `/Span /OCHid BDC
BT /F1 12 Tf 20 100 Td (spanword) Tj ET
EMC
`;
    expect(page0(content).GetText()).toContain('spanword');
  });
});

describe('optional content: paths', () => {
  // GetPaths goes through paths.ts's OWN walker, so none of the text cases
  // above covers any of this.
  const PATHS = `0 0 1 rg 10 150 40 40 re f
/OC /OCHid BDC 1 0 0 rg 10 60 40 40 re f EMC
`;

  it('omits a path painted inside a hidden section', () => {
    const p = page0(PATHS);
    expect(p.GetPaths()).toHaveLength(1);
    expect(p.GetPaths({ includeHidden: true })).toHaveLength(2);
  });

  it('does not carry a hidden path\'s geometry into the next visible one', () => {
    // The hidden paint must still RESET the accumulated subpaths, or the next
    // visible path inherits them and reports a box covering both.
    const content = `/OC /OCHid BDC 1 0 0 rg 0 0 10 10 re f EMC
0 0 1 rg 100 100 40 40 re f
`;
    const paths = page0(content).GetPaths();
    expect(paths).toHaveLength(1);
    expect(paths[0].subpaths).toHaveLength(1);
    expect(paths[0].bbox[0]).toBeCloseTo(100, 6);
  });

  it('omits a table whose ruling lines are on a hidden layer', () => {
    // GetTables reads rules through paths and cell text through glyphs, so it
    // is the one API that needs BOTH walkers to agree.
    const grid = (x: number, y: number) => `
${x} ${y} 120 0.6 re f
${x} ${y + 40} 120 0.6 re f
${x} ${y + 80} 120 0.6 re f
${x} ${y} 0.6 80 re f
${x + 60} ${y} 0.6 80 re f
${x + 120} ${y} 0.6 80 re f
BT /F1 8 Tf ${x + 5} ${y + 55} Td (aa) Tj ET
BT /F1 8 Tf ${x + 65} ${y + 55} Td (bb) Tj ET
BT /F1 8 Tf ${x + 5} ${y + 15} Td (cc) Tj ET
BT /F1 8 Tf ${x + 65} ${y + 15} Td (dd) Tj ET
`;
    const content = `/OC /OCHid BDC${grid(20, 60)}EMC\n`;
    const p = page0(content);
    expect(p.GetTables()).toHaveLength(0);
    expect(p.GetTables({ includeHidden: true })).toHaveLength(1);
  });
});

describe('optional content: XObjects and inline images', () => {
  it('omits an image XObject carrying a hidden /OC', () => {
    // The half this library itself WRITES, through AddImage({ layer }).
    const content = 'q 50 0 0 50 20 20 cm /Im0 Do Q\n';
    const doc = open(content, { imageOc: '7 0 R' });
    const seen = (skipHidden: boolean) => {
      const out: string[] = [];
      visitContent(doc, doc.Pages[0], { image: () => out.push('img') }, { skipHidden });
      return out;
    };
    expect(seen(true)).toHaveLength(0);
    expect(seen(false)).toHaveLength(1);
  });

  it('omits a form XObject carrying a hidden /OC, and its ink with it', () => {
    const content = 'q 1 0 0 1 20 20 cm /Fm0 Do Q\n';
    const doc = open(content, { formOc: '7 0 R' });
    expect(doc.Pages[0].GetPaths()).toHaveLength(0);
    expect(doc.Pages[0].GetPaths({ includeHidden: true })).toHaveLength(1);
  });

  it('omits a form XObject invoked inside a hidden section', () => {
    const content = '/OC /OCHid BDC q 1 0 0 1 20 20 cm /Fm0 Do Q EMC\n';
    expect(page0(content).GetPaths()).toHaveLength(0);
    expect(page0(content).GetPaths({ includeHidden: true })).toHaveLength(1);
  });

  it('omits an inline image drawn inside a hidden section', () => {
    const content = `/OC /OCHid BDC
q 50 0 0 50 20 20 cm BI /W 1 /H 1 /CS /RGB /BPC 8 /F /AHx ID FF00FF> EI Q
EMC
`;
    const doc = open(content);
    const seen = (skipHidden: boolean) => {
      const out: string[] = [];
      visitContent(doc, doc.Pages[0], { image: () => out.push('img') }, { skipHidden });
      return out;
    };
    expect(seen(true)).toHaveLength(0);
    expect(seen(false)).toHaveLength(1);
  });
});

describe('optional content: a document that declares none', () => {
  it('is not MODIFIED by an extraction that asked to skip hidden content', () => {
    // `OptionalContent.Default` CREATES /OCProperties and calls markModified(),
    // and `choosePath()` takes the incremental append only for an UNMODIFIED
    // base — so reaching for it here would turn a Sign() after a GetText() into
    // a full rewrite of bytes an earlier signature covered.
    // A save alone CANNOT see this — a full rewrite of an untouched model
    // reproduces the same bytes — so the catalog is asserted directly, which is
    // the form `optional-content-render.test.ts` already records for the
    // renderer's half of the same rule.
    const doc = open(TEXT, { noOcProperties: true });
    expect(doc.Pages[0].GetText()).toContain('hiddenword');   // nothing to hide
    doc.Pages[0].GetPaths();
    doc.Pages[0].GetTables();
    expect(doc.catalog().has('OCProperties')).toBe(false);
  });
});

describe('optional content: what still sees everything', () => {
  // The walker's default is to report all content, so these consumers are safe
  // BY CONSTRUCTION rather than by anybody having remembered them. Each case
  // here is a content-removal guarantee, which is why they are asserted rather
  // than left to the default's reasoning.

  it('RedactText removes an occurrence on a hidden layer', () => {
    const doc = open(TEXT);
    const n = doc.Pages[0].RedactText('hiddenword');
    expect(n).toBe(1);
    const out = Buffer.from(doc.Save()).toString('latin1');
    expect(out).not.toContain('hiddenword');
  });

  it('MarkRedactText marks an occurrence on a hidden layer', () => {
    const doc = open(TEXT);
    expect(doc.Pages[0].MarkRedactText('hiddenword')).toBe(1);
  });

  it('ReplaceText rewrites an occurrence on a hidden layer', () => {
    const doc = open(TEXT);
    expect(doc.Pages[0].ReplaceText('hiddenword', 'zzzzzzzzzz')).toBe(1);
  });

  it('but Search does NOT find it — the divergence is deliberate', () => {
    // `Search` answers "what does this page show"; the edit entries answer
    // "what does this file contain". Asserted from both sides on ONE fixture,
    // so neither can quietly adopt the other's rule.
    const p = page0(TEXT);
    expect(p.Search('hiddenword')).toHaveLength(0);
    expect(p.Search('hiddenword', { includeHidden: true })).toHaveLength(1);
    expect(p.Search('shownword')).toHaveLength(1);
  });

  it('page.InlineImages still enumerates one inside a hidden section', () => {
    const content = `/OC /OCHid BDC
q 50 0 0 50 20 20 cm BI /W 1 /H 1 /CS /RGB /BPC 8 /F /AHx ID FF00FF> EI Q
EMC
`;
    // Removal machinery: an inline image a configuration hides is still in the
    // bytes, and `Remove` is what takes it out.
    expect(page0(content).InlineImages).toHaveLength(1);
  });

  it('page.Artifacts still reports a scope inside a hidden section', () => {
    const content = `/OC /OCHid BDC
/Artifact BMC 0 0 1 rg 10 10 40 40 re f EMC
EMC
`;
    expect(page0(content).Artifacts).toHaveLength(1);
  });
});

describe('optional content: the exports inherit it', () => {
  it('omits hidden text from ToHtml and ToMarkdown on an untagged page', () => {
    const doc = open(TEXT);
    const html = doc.ToHtml();
    expect(html).toContain('shownword');
    expect(html).not.toContain('hiddenword');

    const md = doc.ToMarkdown();
    expect(md).toContain('shownword');
    expect(md).not.toContain('hiddenword');
  });

  it('omits it from ToDocx in BOTH modes', () => {
    // Flow mode reads docmodel.ts; textbox mode has its OWN content walk, so a
    // fixture asserting only one of them leaves the other unmeasured. The
    // package is deflated, so the document part has to be inflated to be read
    // at all — searching the raw archive bytes would pass with the text present.
    const doc = open(TEXT);
    for (const mode of ['flow', 'textbox'] as const) {
      const part = unzip(doc.ToDocx({ mode }))
        .find((e) => e.path === 'word/document.xml');
      expect(part, mode).toBeDefined();
      const xml = Buffer.from(part!.bytes).toString('utf8');
      expect(xml, mode).toContain('shownword');
      expect(xml, mode).not.toContain('hiddenword');
    }
  });

  it('omits hidden text from a TAGGED export, through StructElement.Nodes', () => {
    // The tagged path reads text through struct.ts's mcidIndex, NOT through
    // extractStructured — so the untagged cases above cover none of it.
    const content = `/P << /MCID 0 >> BDC
BT /F1 12 Tf 20 150 Td (shownword) Tj ET
EMC
/OC /OCHid BDC
/P << /MCID 1 >> BDC
BT /F1 12 Tf 20 100 Td (hiddenword) Tj ET
EMC
EMC
`;
    const doc = open(content, { mcids: [0, 1] });
    expect(doc.GetStructTree()).not.toBeNull();

    const html = doc.ToHtml();
    expect(html).toContain('shownword');
    expect(html).not.toContain('hiddenword');

    const md = doc.ToMarkdown();
    expect(md).toContain('shownword');
    expect(md).not.toContain('hiddenword');
  });
});

describe('optional content: the rules a first sweep left uncovered', () => {
  it('keeps a BMC inside a hidden section from popping it', () => {
    // Every tag must push, not just /OC. A `BMC` that pushed nothing would let
    // its own `EMC` pop the HIDDEN section's entry, un-hiding everything after
    // it — and no single-level fixture can see that.
    const content = `/OC /OCHid BDC
/Artifact BMC 0 0 1 rg 10 10 20 20 re f EMC
BT /F1 12 Tf 20 100 Td (afterbmc) Tj ET
EMC
`;
    expect(page0(content).GetText()).not.toContain('afterbmc');
  });

  it('omits an image XObject drawn inside a hidden section', () => {
    // text.ts's `Do` gate, which the FORM case above cannot reach: that one
    // asserts through GetPaths, and GetPaths is paths.ts's own walker.
    const content = '/OC /OCHid BDC q 50 0 0 50 20 20 cm /Im0 Do Q EMC\n';
    const doc = open(content);
    const seen = (skipHidden: boolean) => {
      const out: string[] = [];
      visitContent(doc, doc.Pages[0], { image: () => out.push('img') }, { skipHidden });
      return out;
    };
    expect(seen(true)).toHaveLength(0);
    expect(seen(false)).toHaveLength(1);
  });

  it('drops a tagged /Figure\'s image when the draw is hidden', () => {
    // docmodel.ts's per-MCID image walk. The untagged path cannot cover it:
    // there the image comes from page.Images (a /Resources read that reports it
    // either way) and the content walk supplies only its drawn SIZE.
    const content = `/OC /OCHid BDC
/Figure << /MCID 0 >> BDC
q 50 0 0 50 20 20 cm /Im0 Do Q
EMC
EMC
`;
    const doc = open(content, { mcids: [0], structTypes: ['Figure'] });
    // The figure is still ANNOUNCED — its /Alt is the accessible content, and
    // dropping the element would lose that — but the picture a viewer never
    // shows carries no `src`, so nothing is embedded.
    expect(doc.ToHtml()).toContain('<img alt="alt text"');
    expect(doc.ToHtml()).not.toContain('src=');

    // Same document with the layer switched ON: the picture IS embedded, which
    // is what shows the absence above is the rule and not a broken fixture.
    const shown = Document.Open(
      buildOcgRenderPdf(content, { mcids: [0], structTypes: ['Figure'], off: [] }));
    expect(shown.ToHtml()).toContain('src="data:image/');
  });
});
