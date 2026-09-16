import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildAnnotPdf, str, type AnnotPdfSpec } from './helpers/build-annot-pdf.js';
import { name, type PdfObject } from '../src/types.js';

/** Rule ids reported for this document at `part`. */
const ids = (spec: AnnotPdfSpec, part: 1 | 2): string[] =>
  Document.Open(buildAnnotPdf(spec)).ValidatePdfUa(part).Issues.map((i) => i.rule);

/** A rule must report at part 2 AND be silent at part 1. A single-part
 *  assertion provably cannot tell a rule that correctly went quiet from one
 *  that was never wired up. */
function expectPair(spec: AnnotPdfSpec, rule: string): void {
  expect(ids(spec, 2), `${rule} at part 2`).toContain(rule);
  expect(ids(spec, 1), `${rule} at part 1`).not.toContain(rule);
}

describe('PDF/UA-2 8.9: annotations that must describe themselves', () => {
  it('8.9.2.4.8-1 reports an Ink with no /Contents', () => {
    expectPair({ annots: [{ subtype: 'Ink' }] }, 'InkDescription');
  });

  it('8.9.2.4.8-1 is silent when /Contents is present', () => {
    expect(ids({ annots: [{ subtype: 'Ink', contents: 'a squiggle' }] }, 2))
      .not.toContain('InkDescription');
  });

  it('8.9.2.4.12-1 reports a Screen with no /Contents', () => {
    expectPair({ annots: [{ subtype: 'Screen' }] }, 'ScreenDescription');
  });

  it('8.9.2.4.19-1 reports a 3D with no /Contents', () => {
    expectPair({ annots: [{ subtype: '3D' }] }, 'ThreeDDescription');
  });

  it('8.9.2.4.19-2 reports a RichMedia with no /Contents', () => {
    expectPair({ annots: [{ subtype: 'RichMedia' }] }, 'RichMediaDescription');
  });

  it('8.9.2.4.7-1 accepts a Stamp with EITHER /Name or /Contents', () => {
    expectPair({ annots: [{ subtype: 'Stamp' }] }, 'StampDescription');
    expect(ids({ annots: [{ subtype: 'Stamp', extra: { Name: name('Approved') } }] }, 2))
      .not.toContain('StampDescription');
    expect(ids({ annots: [{ subtype: 'Stamp', contents: 'Approved' }] }, 2))
      .not.toContain('StampDescription');
  });
});

describe('PDF/UA-2 8.9: prohibited subtypes', () => {
  // Pinned from BOTH directions, as the issue's acceptance criterion asks: the
  // subtype reports, and a /Text in the same position does not — so the rule is
  // not simply firing on every annotation.
  for (const [subtype, rule] of [
    ['Sound', 'SoundProhibited'],
    ['Movie', 'MovieProhibited'],
    ['TrapNet', 'TrapNetProhibited'],
  ] as const) {
    it(`reports ${subtype} and nothing else in its place`, () => {
      expectPair({ annots: [{ subtype }] }, rule);
      expect(ids({ annots: [{ subtype: 'Text', contents: 'c' }] }, 2)).not.toContain(rule);
    });
  }
});

describe('PDF/UA-2 8.9.2.4.10-1: file attachment relationship', () => {
  const fs = (extra?: Record<string, PdfObject>): PdfObject =>
    new Map<string, PdfObject>([['Type', name('Filespec')], ...Object.entries(extra ?? {})]);

  it('reports a /FS whose filespec has no /AFRelationship', () => {
    expectPair({
      annots: [{ subtype: 'FileAttachment', contents: 'c', extra: { FS: fs() } }],
    }, 'FileAttachmentRelationship');
  });

  it('is silent when the filespec states one', () => {
    expect(ids({
      annots: [{
        subtype: 'FileAttachment', contents: 'c',
        extra: { FS: fs({ AFRelationship: name('Data') }) },
      }],
    }, 2)).not.toContain('FileAttachmentRelationship');
  });

  it('is silent for a FileAttachment with no /FS at all', () => {
    expect(ids({ annots: [{ subtype: 'FileAttachment', contents: 'c' }] }, 2))
      .not.toContain('FileAttachmentRelationship');
  });
});

describe('PDF/UA-2 8.9.2.2: annotations that must be artifacts', () => {
  it('8.9.2.2-1 reports an Invisible annotation in the tree', () => {
    // /F bit 1 = Invisible (32000-2 Table 167), transcribed from the profile's
    // own `(F & 1) == 0`.
    expectPair({
      annots: [{ subtype: 'Text', contents: 'c', flags: 1, under: ['P'] }],
    }, 'AnnotInvisible');
  });

  it('8.9.2.2-1 is silent when the annotation is NOT in the tree', () => {
    // Every artifact rule carries `structParentType == null` as a pass, so an
    // untagged annotation is exempt. It reads wrong and it is the anchor's.
    expect(ids({ annots: [{ subtype: 'Text', contents: 'c', flags: 1 }] }, 2))
      .not.toContain('AnnotInvisible');
  });

  it('8.9.2.2-1 is silent under an Artifact element', () => {
    expect(ids({
      annots: [{ subtype: 'Text', contents: 'c', flags: 1, under: ['Artifact'] }],
    }, 2)).not.toContain('AnnotInvisible');
  });

  it('isArtifact walks the WHOLE ancestor chain, not the direct parent', () => {
    // Nested TWO deep. A parent-only test reports here, silently, on a document
    // that renders identically — which is why the fixture nests.
    expect(ids({
      annots: [{ subtype: 'Text', contents: 'c', flags: 1, under: ['Artifact', 'Span'] }],
    }, 2)).not.toContain('AnnotInvisible');
  });

  it('8.9.2.2-2 reports NoView without ToggleNoView', () => {
    // bit 6 = NoView (32), bit 9 = ToggleNoView (256).
    expectPair({
      annots: [{ subtype: 'Text', contents: 'c', flags: 32, under: ['P'] }],
    }, 'AnnotNoView');
  });

  it('8.9.2.2-2 is silent when ToggleNoView is also set', () => {
    expect(ids({
      annots: [{ subtype: 'Text', contents: 'c', flags: 32 | 256, under: ['P'] }],
    }, 2)).not.toContain('AnnotNoView');
  });
});

describe('PDF/UA-2 8.9: enclosure', () => {
  it('8.9.2.3-1 reports a markup annotation not enclosed by Annot', () => {
    expectPair({
      annots: [{ subtype: 'Text', contents: 'c', under: ['P'] }],
    }, 'MarkupEnclosure');
  });

  it('8.9.2.3-1 is silent under an Annot element', () => {
    expect(ids({ annots: [{ subtype: 'Text', contents: 'c', under: ['Annot'] }] }, 2))
      .not.toContain('MarkupEnclosure');
  });

  it('8.9.2.3-1 covers Ink, Stamp and FileAttachment, which EXTEND markup', () => {
    // veraPDF's GFPDInkAnnot, GFPDRubberStampAnnot and GFPDFileAttachmentAnnot
    // all extend GFPDMarkupAnnot, so the markup rules reach them — the set is
    // SIXTEEN subtypes, not the thirteen of the dispatch's default branch.
    for (const subtype of ['Ink', 'Stamp', 'FileAttachment']) {
      expect(ids({
        annots: [{
          subtype, contents: 'c', extra: { Name: name('Approved') }, under: ['P'],
        }],
      }, 2), subtype).toContain('MarkupEnclosure');
    }
  });

  it('8.9.2.3-1 does NOT cover Sound or Movie, which ISO calls markup', () => {
    // The divergence to remember: ISO 32000-2 Table 171 counts Sound and Movie
    // as markup annotations and veraPDF's model does not. The profile resolves
    // against the MODEL, so we follow it.
    for (const subtype of ['Sound', 'Movie']) {
      expect(ids({ annots: [{ subtype, contents: 'c', under: ['P'] }] }, 2), subtype)
        .not.toContain('MarkupEnclosure');
    }
  });

  it('8.9.2.4.16-1 reports a Watermark not enclosed by Annot', () => {
    expectPair({
      annots: [{ subtype: 'Watermark', contents: 'c', under: ['P'] }],
    }, 'WatermarkEnclosure');
  });

  it('8.9.2.4.16-1 accepts a Watermark under Annot OR under Artifact', () => {
    for (const under of [['Annot'], ['Artifact']]) {
      expect(ids({ annots: [{ subtype: 'Watermark', contents: 'c', under }] }, 2))
        .not.toContain('WatermarkEnclosure');
    }
  });

  it('8.9.2.4.9-1 reports a Popup that IS in the tree', () => {
    // The INVERSE shape of every other rule here: a Popup must NOT be tagged.
    expectPair({ annots: [{ subtype: 'Popup', under: ['P'] }] }, 'PopupInTree');
    expect(ids({ annots: [{ subtype: 'Popup' }] }, 2)).not.toContain('PopupInTree');
  });

  it('8.9.2.4.14-1 reports a PrinterMark in the tree and not an artifact', () => {
    expectPair({
      annots: [{ subtype: 'PrinterMark', contents: 'c', under: ['P'] }],
    }, 'PrinterMarkArtifact');
    expect(ids({
      annots: [{ subtype: 'PrinterMark', contents: 'c', under: ['Artifact'] }],
    }, 2)).not.toContain('PrinterMarkArtifact');
  });

  it('8.9.2.4.13-1 reports a ZERO-SIZE widget in the tree', () => {
    expectPair({
      annots: [{ subtype: 'Widget', rect: [0, 0, 0, 0], under: ['Form'] }],
    }, 'ZeroSizeWidget');
  });

  it('8.9.2.4.13-1 is silent when EITHER dimension is non-zero', () => {
    // The profile tests `width != 0 || height != 0`, so a zero-HEIGHT widget
    // with width is fine. A fixture with both zero cannot see that.
    const rects: [number, number, number, number][] = [[0, 0, 50, 0], [0, 0, 0, 20]];
    for (const rect of rects) {
      expect(ids({ annots: [{ subtype: 'Widget', rect, under: ['Form'] }] }, 2))
        .not.toContain('ZeroSizeWidget');
    }
  });
});

describe('PDF/UA-2 8.9.4.2-1: Contents and Alt must agree', () => {
  it('reports when both are present and differ', () => {
    expectPair({
      annots: [{ subtype: 'Text', contents: 'one', under: ['Annot'], alt: 'two' }],
    }, 'AnnotAltMismatch');
  });

  it('is silent when they are identical', () => {
    expect(ids({
      annots: [{ subtype: 'Text', contents: 'same', under: ['Annot'], alt: 'same' }],
    }, 2)).not.toContain('AnnotAltMismatch');
  });

  it('is silent when either is absent', () => {
    // The profile tests `Contents == null || Alt == null || Contents == Alt`,
    // so an annotation with only one of the two never reports.
    expect(ids({ annots: [{ subtype: 'Text', contents: 'one', under: ['Annot'] }] }, 2))
      .not.toContain('AnnotAltMismatch');
    expect(ids({ annots: [{ subtype: 'Text', under: ['Annot'], alt: 'two' }] }, 2))
      .not.toContain('AnnotAltMismatch');
  });
});

describe('PDF/UA-2 8.9.2.3-2: /RC must match /Contents', () => {
  const rc = (markup: string): Record<string, PdfObject> => ({ RC: str(markup) });

  it('reports when the reduced rich text differs from /Contents', () => {
    expectPair({
      annots: [{
        subtype: 'Text', contents: 'hello', under: ['Annot'],
        extra: rc('<body><p>goodbye</p></body>'),
      }],
    }, 'MarkupRichText');
  });

  it('is silent when they agree', () => {
    expect(ids({
      annots: [{
        subtype: 'Text', contents: 'hello', under: ['Annot'],
        extra: rc('<body><p>hello</p></body>'),
      }],
    }, 2)).not.toContain('MarkupRichText');
  });

  it('reduces VERBATIM, so two blocks run together', () => {
    // The mode this rule exists for. veraPDF concatenates every text node, so
    // <p>a</p><p>b</p> is 'ab' and matches Contents 'ab'. Our DEFAULT reduction
    // would give 'a\nb' and report here — which is why the mode is not a
    // preference. A single-<p> fixture, which is what Acrobat writes, cannot
    // tell the two apart.
    expect(ids({
      annots: [{
        subtype: 'Text', contents: 'ab', under: ['Annot'],
        extra: rc('<body><p>a</p><p>b</p></body>'),
      }],
    }, 2)).not.toContain('MarkupRichText');
  });

  it('is silent when /RC is absent', () => {
    expect(ids({ annots: [{ subtype: 'Text', contents: 'hello', under: ['Annot'] }] }, 2))
      .not.toContain('MarkupRichText');
  });
});

describe('PDF/UA-2 8.9.3.3-1: tab order', () => {
  it('reports a page with annotations whose /Tabs is absent', () => {
    expectPair({ annots: [{ subtype: 'Text', contents: 'c', under: ['Annot'] }] },
      'TabOrder');
  });

  it('accepts A, W and S', () => {
    for (const tabs of ['A', 'W', 'S']) {
      expect(ids({
        annots: [{ subtype: 'Text', contents: 'c', under: ['Annot'] }], tabs,
      }, 2), tabs).not.toContain('TabOrder');
    }
  });

  it('reports any other value', () => {
    expect(ids({
      annots: [{ subtype: 'Text', contents: 'c', under: ['Annot'] }], tabs: 'R',
    }, 2)).toContain('TabOrder');
  });

  it('is silent for a page with NO annotations', () => {
    expect(ids({ annots: [] }, 2)).not.toContain('TabOrder');
  });

  it('is a WARNING, not an error', () => {
    // The profile tags this one `minor` where every other rule in 8.9 and 8.10
    // is `major`, so a document with only this defect still passes.
    const report = Document.Open(buildAnnotPdf({
      annots: [{ subtype: 'Text', contents: 'c', under: ['Annot'] }],
    })).ValidatePdfUa(2);
    const hit = report.Issues.find((i) => i.rule === 'TabOrder');
    expect(hit?.severity).toBe('warning');
  });
});

describe('PDF/UA-2 8.10: forms', () => {
  /** A widget that IS a field: a merged field/widget carrying /FT. */
  const field = (extra: Record<string, PdfObject> = {}): Record<string, PdfObject> =>
    ({ FT: name('Tx'), ...extra });

  it('8.10.1-1 reports a field widget not enclosed by Form', () => {
    expectPair({
      annots: [{ subtype: 'Widget', extra: field(), contents: 'c', under: ['P'] }],
    }, 'WidgetEnclosure');
  });

  it('8.10.1-1 is silent under a Form element', () => {
    expect(ids({
      annots: [{ subtype: 'Widget', extra: field(), contents: 'c', under: ['Form'] }],
    }, 2)).not.toContain('WidgetEnclosure');
  });

  it('8.10.1-1 EXEMPTS a widget that belongs to no field', () => {
    // isFieldWidget is `is a field OR has a /Parent`. A standalone widget is
    // exempt — and every widget our own form API creates IS a field widget, so
    // without this fixture the exemption is unmeasured.
    expect(ids({ annots: [{ subtype: 'Widget', contents: 'c', under: ['P'] }] }, 2))
      .not.toContain('WidgetEnclosure');
  });

  it('8.10.1-3 reports an /AcroForm /XFA', () => {
    expectPair({ annots: [], xfa: true }, 'XfaPresent');
    expect(ids({ annots: [] }, 2)).not.toContain('XfaPresent');
  });

  it('8.10.2.3-1 reports a field widget with neither Lbl nor /Contents', () => {
    expectPair({
      annots: [{ subtype: 'Widget', extra: field(), under: ['Form'] }],
    }, 'WidgetDescription');
  });

  it('8.10.2.3-1 is silent with /Contents, or with a FILLED Lbl', () => {
    expect(ids({
      annots: [{ subtype: 'Widget', extra: field(), contents: 'c', under: ['Form'] }],
    }, 2)).not.toContain('WidgetDescription');
    expect(ids({
      annots: [{ subtype: 'Widget', extra: field(), under: ['Form'], label: 'filled' }],
    }, 2)).not.toContain('WidgetDescription');
  });

  it('8.10.2.3-1 does NOT accept an EMPTY Lbl', () => {
    // GFPDWidgetAnnot.getcontainsLbl requires `!child.getChildren().isEmpty()`.
    // A label element with nothing in it labels nothing.
    expect(ids({
      annots: [{ subtype: 'Widget', extra: field(), under: ['Form'], label: 'empty' }],
    }, 2)).toContain('WidgetDescription');
  });

  it('8.10.2.3-2 reports a field widget with /AA and no /Contents', () => {
    expectPair({
      annots: [{
        subtype: 'Widget', extra: field({ AA: new Map() }),
        under: ['Form'], label: 'filled',
      }],
    }, 'WidgetActionDescription');
  });

  it('8.10.2.3-2 is satisfied by /Contents, NOT by a label', () => {
    // The two rules differ: -1 accepts an Lbl, -2 demands /Contents outright.
    expect(ids({
      annots: [{
        subtype: 'Widget', extra: field({ AA: new Map() }), contents: 'c', under: ['Form'],
      }],
    }, 2)).not.toContain('WidgetActionDescription');
  });

  it('8.10.1-2 reports a Form element holding two widgets', () => {
    expectPair({
      annots: [
        {
          subtype: 'Widget', extra: field(), contents: 'a',
          under: ['Form'], shareUnder: 'f',
        },
        {
          subtype: 'Widget', extra: field(), contents: 'b',
          under: ['Form'], shareUnder: 'f',
        },
      ],
    }, 'FormWidgetCount');
  });

  it('8.10.1-2 counts WIDGETS, not every /OBJR under the Form', () => {
    // One widget and one Link tagged under the SAME Form. The count is one, so
    // nothing reports — measured: without the /Subtype filter this fixture is
    // two OBJRs and reports, and no other fixture gives a Form a non-widget
    // kid, so the filter is otherwise unmeasured.
    expect(ids({
      annots: [
        {
          subtype: 'Widget', extra: field(), contents: 'a',
          under: ['Form'], shareUnder: 'g',
        },
        { subtype: 'Link', contents: 'b', under: ['Form'], shareUnder: 'g' },
      ],
    }, 2)).not.toContain('FormWidgetCount');
  });

  it('8.10.1-2 is silent for one widget per Form', () => {
    expect(ids({
      annots: [
        { subtype: 'Widget', extra: field(), contents: 'a', under: ['Form'] },
        { subtype: 'Widget', extra: field(), contents: 'b', under: ['Form'] },
      ],
    }, 2)).not.toContain('FormWidgetCount');
  });

  it('8.10.3.3-1 reports /RV without /V', () => {
    expectPair({
      annots: [{
        subtype: 'Widget', extra: field({ RV: str('<body><p>x</p></body>') }),
        contents: 'c', under: ['Form'],
      }],
    }, 'TextFieldRichValue');
  });

  it('8.10.3.3-1 reports /RV that differs from /V', () => {
    expect(ids({
      annots: [{
        subtype: 'Widget',
        extra: field({ RV: str('<body><p>x</p></body>'), V: str('y') }),
        contents: 'c', under: ['Form'],
      }],
    }, 2)).toContain('TextFieldRichValue');
  });

  it('8.10.3.3-1 is silent when /RV and /V agree', () => {
    expect(ids({
      annots: [{
        subtype: 'Widget',
        extra: field({ RV: str('<body><p>x</p></body>'), V: str('x') }),
        contents: 'c', under: ['Form'],
      }],
    }, 2)).not.toContain('TextFieldRichValue');
  });
});
