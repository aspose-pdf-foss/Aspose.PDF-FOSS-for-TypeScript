import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import {
  Annotation, createAnnotation, TextAnnotation, StampAnnotation, MarkupAnnotation, LinkAnnotation,
  SquareCircleAnnotation, LineAnnotation, FreeTextAnnotation, PopupAnnotation,
  PolyAnnotation, InkAnnotation, CaretAnnotation,
} from '../src/annotation.js';
import {
  buildAnnotTarget, buildBlankPage, buildStampReadTarget, buildMarkupReadTarget, buildLinkReadTarget,
  buildShapeReadTarget, buildFreeTextReadTarget, buildPopupReadTarget, buildPathReadTarget,
} from './helpers/build-annot-target.js';
import { isStream, isName, name, PdfDict, PdfStream } from '../src/types.js';
import { inflateStream } from '../src/flate.js';
import { parseContentStream } from '../src/content.js';
import { collectImages } from '../src/image.js';
import { buildJpeg, buildPngRgba } from './helpers/build-embed-images.js';

describe('Annotation read model', () => {
  it('exposes typed annotations from Page.Annotations', () => {
    const doc = Document.Open(buildAnnotTarget());
    const annots = doc.Pages[0].Annotations;
    expect(annots).toHaveLength(2);
    expect(annots[0]).toBeInstanceOf(Annotation);

    const text = annots[0];
    expect(text.Subtype).toBe('Text');
    expect(text.Rect).toEqual([10, 20, 30, 40]);
    expect(text.Contents).toBe('hello');
    expect(text.Color).toEqual([1, 0, 0]);
    expect(text.Flags).toBe(4);
    expect(text.Print).toBe(true);
    expect(text.Hidden).toBe(false);

    expect(annots[1].Subtype).toBe('Link');
    expect(annots[1].Color).toBeUndefined();
    expect(annots[1].Dict).toBeInstanceOf(Map); // raw escape hatch present
  });
});

describe('Annotation setters', () => {
  it('round-trips mutations onto the live dict', () => {
    const doc = Document.Open(buildAnnotTarget());
    const a = doc.Pages[0].Annotations[0];

    a.Rect = [1, 2, 3, 4];
    expect(a.Rect).toEqual([1, 2, 3, 4]);

    a.Color = [0, 0.5, 1];
    expect(a.Color).toEqual([0, 0.5, 1]);
    a.Color = undefined;
    expect(a.Color).toBeUndefined();

    a.Contents = 'edited';
    expect(a.Contents).toBe('edited');

    a.Name = 'note-1';
    expect(a.Name).toBe('note-1');

    const when = new Date(Date.UTC(2026, 5, 18, 12, 0, 0));
    a.ModDate = when;
    expect(a.ModDate).toEqual(when);

    a.Print = false;
    expect(a.Print).toBe(false);
    a.Hidden = true;
    expect(a.Hidden).toBe(true);

    a.Opacity = 0.25;
    expect(a.Opacity).toBe(0.25);
  });

  it('rejects invalid input with TypeError', () => {
    const doc = Document.Open(buildAnnotTarget());
    const a = doc.Pages[0].Annotations[0];
    expect(() => { a.Rect = [1, 2, 3] as any; }).toThrow(TypeError);
    expect(() => { a.Color = [2, 0, 0]; }).toThrow(TypeError);
    expect(() => { a.Opacity = 5; }).toThrow(TypeError);
  });
});

describe('Annotation lifecycle', () => {
  it('createAnnotation attaches a well-formed dict to the page /Annots', () => {
    const doc = Document.Open(buildAnnotTarget());
    const page = doc.Pages[0];
    const before = page.Annotations.length;

    const dict = createAnnotation(doc, page, {
      subtype: 'Square',
      rect: [5, 5, 95, 45],
      color: [0, 0, 1],
      contents: 'made',
    });

    expect(page.Annotations.length).toBe(before + 1);
    const made = page.Annotations[page.Annotations.length - 1];
    expect(made.Dict).toBe(dict);
    expect(made.Subtype).toBe('Square');
    expect(made.Rect).toEqual([5, 5, 95, 45]);
    expect(made.Color).toEqual([0, 0, 1]);
    expect(made.Contents).toBe('made');
    expect(made.Print).toBe(true);              // default /F = 4
    expect(made.ModDate).toBeInstanceOf(Date);  // /M set to now
  });

  it('createAnnotation creates /Annots when the page has none', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    expect(page.Annotations).toHaveLength(0);
    createAnnotation(doc, page, { subtype: 'Square', rect: [0, 0, 10, 10] });
    expect(page.Annotations).toHaveLength(1);
  });

  it('createAnnotation validates rect before allocating', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    expect(() => createAnnotation(doc, page, { subtype: 'Square', rect: [0, 0, 10] as any }))
      .toThrow(TypeError);
    expect(page.Annotations).toHaveLength(0); // no stranded object
  });

  it('RemoveAnnotation removes exactly the target', () => {
    const doc = Document.Open(buildAnnotTarget());
    const page = doc.Pages[0];
    const link = page.Annotations.find((a) => a.Subtype === 'Link')!;
    page.RemoveAnnotation(link);
    expect(page.Annotations.map((a) => a.Subtype)).toEqual(['Text']);
  });
});

describe('Annotation persistence', () => {
  it('round-trips a created annotation through Save/Open', () => {
    const doc = Document.Open(buildBlankPage());
    createAnnotation(doc, doc.Pages[0], {
      subtype: 'Square',
      rect: [5, 5, 95, 45],
      color: [0, 0, 1],
      contents: 'persisted',
    });

    const reopened = Document.Open(doc.Save());
    const annots = reopened.Pages[0].Annotations;
    expect(annots).toHaveLength(1);
    expect(annots[0].Subtype).toBe('Square');
    expect(annots[0].Rect).toEqual([5, 5, 95, 45]);
    expect(annots[0].Color).toEqual([0, 0, 1]);
    expect(annots[0].Contents).toBe('persisted');
  });

  it('round-trips a removal through Save/Open', () => {
    const doc = Document.Open(buildAnnotTarget());
    const link = doc.Pages[0].Annotations.find((a) => a.Subtype === 'Link')!;
    doc.Pages[0].RemoveAnnotation(link);

    const reopened = Document.Open(doc.Save());
    expect(reopened.Pages[0].Annotations.map((a) => a.Subtype)).toEqual(['Text']);
  });
});

describe('TextAnnotation', () => {
  it('wraps /Text annotations and exposes icon/open/author accessors', () => {
    const doc = Document.Open(buildAnnotTarget());
    const a = doc.Pages[0].Annotations[0];
    expect(a).toBeInstanceOf(TextAnnotation);

    const note = a as TextAnnotation;
    expect(note.Subtype).toBe('Text');
    expect(note.Icon).toBeUndefined();  // fixture has no /Name
    expect(note.Open).toBe(false);      // fixture has no /Open
    expect(note.Author).toBeUndefined();

    note.Icon = 'Comment';
    expect(note.Icon).toBe('Comment');
    note.Open = true;
    expect(note.Open).toBe(true);
    note.Author = 'Reviewer';
    expect(note.Author).toBe('Reviewer');

    note.Icon = undefined;
    expect(note.Icon).toBeUndefined();
  });

  it('rejects invalid icon/open/author types', () => {
    const doc = Document.Open(buildAnnotTarget());
    const note = doc.Pages[0].Annotations[0] as TextAnnotation;
    expect(() => { (note as any).Icon = 5; }).toThrow(TypeError);
    expect(() => { (note as any).Open = 'yes'; }).toThrow(TypeError);
    expect(() => { (note as any).Author = 7; }).toThrow(TypeError);
  });

  it('still returns a base Annotation for non-Text subtypes', () => {
    const doc = Document.Open(buildAnnotTarget());
    const link = doc.Pages[0].Annotations[1];
    expect(link).toBeInstanceOf(Annotation);
    expect(link).not.toBeInstanceOf(TextAnnotation);
  });
});

describe('Page.AddTextNote', () => {
  it('creates a /Text annotation with defaults and provided fields', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];

    const note = page.AddTextNote({
      rect: [10, 20, 30, 40],
      contents: 'please review',
      icon: 'Comment',
      open: true,
      color: [1, 1, 0],
      author: 'QA',
    });

    expect(note).toBeInstanceOf(TextAnnotation);
    expect(note.Subtype).toBe('Text');
    expect(note.Rect).toEqual([10, 20, 30, 40]);
    expect(note.Contents).toBe('please review');
    expect(note.Icon).toBe('Comment');
    expect(note.Open).toBe(true);
    expect(note.Color).toEqual([1, 1, 0]);
    expect(note.Author).toBe('QA');
    expect(note.Print).toBe(true);            // default /F = 4
    expect(page.Annotations).toHaveLength(1);
  });

  it('defaults icon to Note and open to false', () => {
    const doc = Document.Open(buildBlankPage());
    const note = doc.Pages[0].AddTextNote({ rect: [0, 0, 10, 10] });
    expect(note.Icon).toBe('Note');
    expect(note.Open).toBe(false);
    expect(note.Author).toBeUndefined();
  });

  it('validates rect via the shared create path', () => {
    const doc = Document.Open(buildBlankPage());
    expect(() => doc.Pages[0].AddTextNote({ rect: [0, 0, 10] as any })).toThrow(TypeError);
    expect(doc.Pages[0].Annotations).toHaveLength(0);
  });

  it('round-trips through Save/Open as a TextAnnotation', () => {
    const doc = Document.Open(buildBlankPage());
    doc.Pages[0].AddTextNote({ rect: [5, 5, 25, 25], contents: 'hi', icon: 'Help', author: 'Me' });

    const reopened = Document.Open(doc.Save());
    const annots = reopened.Pages[0].Annotations;
    expect(annots).toHaveLength(1);
    expect(annots[0]).toBeInstanceOf(TextAnnotation);
    const note = annots[0] as TextAnnotation;
    expect(note.Icon).toBe('Help');
    expect(note.Contents).toBe('hi');
    expect(note.Author).toBe('Me');
  });
});

describe('StampAnnotation', () => {
  it('wraps /Stamp annotations and exposes StampName', () => {
    const doc = Document.Open(buildStampReadTarget());
    const a = doc.Pages[0].Annotations[0];
    expect(a).toBeInstanceOf(StampAnnotation);

    const stamp = a as StampAnnotation;
    expect(stamp.Subtype).toBe('Stamp');
    expect(stamp.StampName).toBe('Approved');

    stamp.StampName = 'Confidential';
    expect(stamp.StampName).toBe('Confidential');
    stamp.StampName = undefined;
    expect(stamp.StampName).toBeUndefined();
  });

  it('rejects an invalid StampName type', () => {
    const doc = Document.Open(buildStampReadTarget());
    const stamp = doc.Pages[0].Annotations[0] as StampAnnotation;
    expect(() => { (stamp as any).StampName = 5; }).toThrow(TypeError);
  });
});

describe('Page.AddStamp (label)', () => {
  /** The /AP /N stream of an annotation, asserted to exist. */
  function apN(doc: Document, stamp: StampAnnotation) {
    const ap = doc.resolve(stamp.Dict.get('AP')) as Map<string, any>;
    const n = doc.resolve(ap.get('N'));
    expect(isStream(n)).toBe(true);
    return n as any;
  }

  it('creates a standard-name stamp with a framed-label appearance', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];

    const stamp = page.AddStamp({ rect: [10, 20, 110, 60], name: 'Approved' });

    expect(stamp).toBeInstanceOf(StampAnnotation);
    expect(stamp.Subtype).toBe('Stamp');
    expect(stamp.StampName).toBe('Approved');
    expect(stamp.Print).toBe(true);              // default /F = 4
    expect(page.Annotations).toHaveLength(1);

    const ops = parseContentStream(apN(doc, stamp).raw).map((o) => o.operator);
    expect(ops).toContain('S');                  // stroked border
    expect(ops).toContain('Tj');                 // label text
  });

  it('creates a custom-text stamp (no /Name) with an appearance', () => {
    const doc = Document.Open(buildBlankPage());
    const stamp = doc.Pages[0].AddStamp({ rect: [0, 0, 100, 40], text: 'DRAFT', color: [0, 0, 1] });
    expect(stamp.StampName).toBeUndefined();
    expect(stamp.Color).toEqual([0, 0, 1]);      // /C set from color
    const ops = parseContentStream(apN(doc, stamp).raw).map((o) => o.operator);
    expect(ops).toContain('Tj');
  });

  it('rejects ambiguous or empty stamp specs without mutating the page', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    expect(() => page.AddStamp({ rect: [0, 0, 10, 10] })).toThrow(TypeError);
    expect(() => page.AddStamp({ rect: [0, 0, 10, 10], name: 'A', text: 'B' })).toThrow(TypeError);
    expect(page.Annotations).toHaveLength(0);
  });

  it('round-trips a standard-name stamp through Save/Open', () => {
    const doc = Document.Open(buildBlankPage());
    doc.Pages[0].AddStamp({ rect: [5, 5, 105, 45], name: 'Confidential' });

    const reopened = Document.Open(doc.Save());
    const annots = reopened.Pages[0].Annotations;
    expect(annots).toHaveLength(1);
    expect(annots[0]).toBeInstanceOf(StampAnnotation);
    expect((annots[0] as StampAnnotation).StampName).toBe('Confidential');
  });
});

describe('Page.AddStamp (image)', () => {
  it('embeds an image XObject in the stamp appearance, reachable by the extractor', () => {
    const doc = Document.Open(buildBlankPage());
    const stamp = doc.Pages[0].AddStamp({ rect: [0, 0, 64, 48], image: buildJpeg(8, 6, 3) });

    expect(stamp).toBeInstanceOf(StampAnnotation);
    expect(stamp.StampName).toBeUndefined();

    const ap = doc.resolve(stamp.Dict.get('AP')) as Map<string, any>;
    const n = doc.resolve(ap.get('N')) as any;
    expect(isStream(n)).toBe(true);

    const ops = parseContentStream(n.raw).map((o) => o.operator);
    expect(ops).toContain('Do');

    // The image XObject lives in the appearance form's own /Resources.
    const res = doc.resolve(n.dict.get('Resources')) as Map<string, any>;
    const imgs = collectImages(doc, res);
    expect(imgs).toHaveLength(1);
    expect(imgs[0].Width).toBe(8);
    expect(imgs[0].Height).toBe(6);
  });

  it('does not attach an annotation when the image bytes are unrecognized', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    expect(() => page.AddStamp({ rect: [0, 0, 64, 48], image: new Uint8Array([1, 2, 3]) }))
      .toThrow();                         // UnsupportedFeatureError from buildImageXObject
    expect(page.Annotations).toHaveLength(0);
  });

  it('round-trips an image stamp through Save/Open', () => {
    const doc = Document.Open(buildBlankPage());
    doc.Pages[0].AddStamp({ rect: [0, 0, 64, 48], image: buildPngRgba() });

    const reopened = Document.Open(doc.Save());
    const annots = reopened.Pages[0].Annotations;
    expect(annots).toHaveLength(1);
    expect(annots[0]).toBeInstanceOf(StampAnnotation);
  });
});

describe('MarkupAnnotation', () => {
  it('wraps the four markup subtypes and exposes MarkupType + QuadPoints', () => {
    const doc = Document.Open(buildMarkupReadTarget());
    const a = doc.Pages[0].Annotations[0];
    expect(a).toBeInstanceOf(MarkupAnnotation);

    const m = a as MarkupAnnotation;
    expect(m.Subtype).toBe('Highlight');
    expect(m.MarkupType).toBe('highlight');
    expect(m.QuadPoints).toEqual([10, 40, 60, 40, 10, 30, 60, 30]);

    m.QuadPoints = [0, 8, 4, 8, 0, 0, 4, 0];
    expect(m.QuadPoints).toEqual([0, 8, 4, 8, 0, 0, 4, 0]);
  });

  it('rejects /QuadPoints whose length is not a positive multiple of 8', () => {
    const doc = Document.Open(buildMarkupReadTarget());
    const m = doc.Pages[0].Annotations[0] as MarkupAnnotation;
    expect(() => { m.QuadPoints = [1, 2, 3, 4]; }).toThrow(TypeError);
    expect(() => { m.QuadPoints = []; }).toThrow(TypeError);
  });
});

describe('Page.AddHighlight', () => {
  function apN(doc: Document, m: MarkupAnnotation) {
    const ap = doc.resolve(m.Dict.get('AP')) as Map<string, any>;
    const n = doc.resolve(ap.get('N'));
    expect(isStream(n)).toBe(true);
    return n as any;
  }

  it('creates a /Highlight with /Rect = quad bbox, /QuadPoints, and a fill appearance', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];

    const m = page.AddHighlight({ quads: [10, 40, 60, 40, 10, 30, 60, 30] });

    expect(m).toBeInstanceOf(MarkupAnnotation);
    expect(m.Subtype).toBe('Highlight');
    expect(m.MarkupType).toBe('highlight');
    expect(m.Rect).toEqual([10, 30, 60, 40]);          // bbox of the quad
    expect(m.QuadPoints).toEqual([10, 40, 60, 40, 10, 30, 60, 30]);
    expect(m.Color).toEqual([1, 1, 0]);                // default yellow
    expect(m.Print).toBe(true);
    expect(page.Annotations).toHaveLength(1);

    const n = apN(doc, m);
    expect(n.dict.get('BBox')).toEqual([0, 0, 50, 10]); // w=50, h=10
    const ops = parseContentStream(n.raw).map((o) => o.operator);
    expect(ops).toContain('f');                         // filled quad
  });

  it('defaults to a readable translucent /CA when opacity is omitted', () => {
    const doc = Document.Open(buildBlankPage());
    const m = doc.Pages[0].AddHighlight({ quads: [10, 40, 60, 40, 10, 30, 60, 30] });

    expect(m.Opacity).toBe(0.4);                          // translucent so text shows through
    const ap = doc.resolve(m.Dict.get('AP')) as Map<string, any>;
    const n = doc.resolve(ap.get('N')) as any;
    const res = doc.resolve(n.dict.get('Resources')) as Map<string, any>;
    expect(res.has('ExtGState')).toBe(true);
    expect(new TextDecoder().decode(n.raw)).toContain('gs');
  });

  it('keeps an explicit opacity override (including fully opaque)', () => {
    const doc = Document.Open(buildBlankPage());
    const m = doc.Pages[0].AddHighlight({ quads: [10, 40, 60, 40, 10, 30, 60, 30], opacity: 1 });

    expect(m.Opacity).toBe(1);
    const ap = doc.resolve(m.Dict.get('AP')) as Map<string, any>;
    const n = doc.resolve(ap.get('N')) as any;
    const res = doc.resolve(n.dict.get('Resources')) as Map<string, any>;
    expect(res.has('ExtGState')).toBe(false);             // no soft-mask state when fully opaque
  });

  it('honors a custom color and sets /CA + an ExtGState when opacity < 1', () => {
    const doc = Document.Open(buildBlankPage());
    const m = doc.Pages[0].AddHighlight({
      quads: [0, 10, 20, 10, 0, 0, 20, 0], color: [0, 1, 0], opacity: 0.4, contents: 'note',
    });
    expect(m.Color).toEqual([0, 1, 0]);
    expect(m.Opacity).toBe(0.4);
    expect(m.Contents).toBe('note');

    const ap = doc.resolve(m.Dict.get('AP')) as Map<string, any>;
    const n = doc.resolve(ap.get('N')) as any;
    const res = doc.resolve(n.dict.get('Resources')) as Map<string, any>;
    expect(res.has('ExtGState')).toBe(true);
    expect(new TextDecoder().decode(n.raw)).toContain('gs');
  });

  it('rejects quads whose length is not a positive multiple of 8', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    expect(() => page.AddHighlight({ quads: [1, 2, 3, 4] })).toThrow(TypeError);
    expect(page.Annotations).toHaveLength(0);
  });

  it('round-trips a highlight through Save/Open', () => {
    const doc = Document.Open(buildBlankPage());
    doc.Pages[0].AddHighlight({ quads: [10, 40, 60, 40, 10, 30, 60, 30] });

    const reopened = Document.Open(doc.Save());
    const annots = reopened.Pages[0].Annotations;
    expect(annots).toHaveLength(1);
    expect(annots[0]).toBeInstanceOf(MarkupAnnotation);
    expect((annots[0] as MarkupAnnotation).QuadPoints).toEqual([10, 40, 60, 40, 10, 30, 60, 30]);
  });
});

describe('Page.AddUnderline / AddStrikeOut / AddSquiggly', () => {
  function apOps(doc: Document, m: MarkupAnnotation): string[] {
    const ap = doc.resolve(m.Dict.get('AP')) as Map<string, any>;
    const n = doc.resolve(ap.get('N')) as any;
    expect(isStream(n)).toBe(true);
    return parseContentStream(n.raw).map((o) => o.operator);
  }

  const quads = [10, 40, 60, 40, 10, 30, 60, 30];

  it('AddUnderline creates an /Underline with a stroked-line appearance (black default)', () => {
    const doc = Document.Open(buildBlankPage());
    const m = doc.Pages[0].AddUnderline({ quads });
    expect(m.Subtype).toBe('Underline');
    expect(m.MarkupType).toBe('underline');
    expect(m.Color).toEqual([0, 0, 0]);                // default black
    const ops = apOps(doc, m);
    expect(ops).toContain('S');                        // stroke
    expect(ops).not.toContain('f');                    // not a fill
  });

  it('AddStrikeOut creates a /StrikeOut with a stroked-line appearance', () => {
    const doc = Document.Open(buildBlankPage());
    const m = doc.Pages[0].AddStrikeOut({ quads });
    expect(m.Subtype).toBe('StrikeOut');
    expect(m.MarkupType).toBe('strikeout');
    expect(apOps(doc, m)).toContain('S');
  });

  it('AddSquiggly creates a /Squiggly with a multi-segment stroked path', () => {
    const doc = Document.Open(buildBlankPage());
    const m = doc.Pages[0].AddSquiggly({ quads });
    expect(m.Subtype).toBe('Squiggly');
    expect(m.MarkupType).toBe('squiggly');
    const ap = doc.resolve(m.Dict.get('AP')) as Map<string, any>;
    const n = doc.resolve(ap.get('N')) as any;
    const lineCount = parseContentStream(n.raw).filter((o) => o.operator === 'l').length;
    expect(lineCount).toBeGreaterThan(1);              // zig-zag has multiple segments
  });

  it('leaves underline/strikeout/squiggly fully opaque by default', () => {
    const doc = Document.Open(buildBlankPage());
    for (const m of [
      doc.Pages[0].AddUnderline({ quads }),
      doc.Pages[0].AddStrikeOut({ quads }),
      doc.Pages[0].AddSquiggly({ quads }),
    ]) {
      expect(m.Opacity).toBeUndefined();                 // no /CA written
      const ap = doc.resolve(m.Dict.get('AP')) as Map<string, any>;
      const n = doc.resolve(ap.get('N')) as any;
      const res = doc.resolve(n.dict.get('Resources')) as Map<string, any>;
      expect(res.has('ExtGState')).toBe(false);
    }
  });

  it('round-trips an underline through Save/Open', () => {
    const doc = Document.Open(buildBlankPage());
    doc.Pages[0].AddUnderline({ quads, color: [1, 0, 0] });
    const reopened = Document.Open(doc.Save());
    const m = reopened.Pages[0].Annotations[0] as MarkupAnnotation;
    expect(m).toBeInstanceOf(MarkupAnnotation);
    expect(m.MarkupType).toBe('underline');
    expect(m.Color).toEqual([1, 0, 0]);
  });
});

describe('LinkAnnotation', () => {
  it('wraps /Link and parses a URI action (no GoTo dest)', () => {
    const doc = Document.Open(buildLinkReadTarget());
    const a = doc.Pages[0].Annotations[0];
    expect(a).toBeInstanceOf(LinkAnnotation);

    const link = a as LinkAnnotation;
    expect(link.Subtype).toBe('Link');
    expect(link.Action).toEqual({ type: 'uri', uri: 'https://example.com' });
    expect(link.Dest).toBeUndefined();
  });

  it('parses a GoTo action and the resolved destination', () => {
    const doc = Document.Open(buildLinkReadTarget());
    const link = doc.Pages[0].Annotations[1] as LinkAnnotation;
    expect(link.Action).toEqual({ type: 'goto', page: 2, view: { type: 'Fit' } });
    expect(link.Dest).toEqual({ page: 2, view: { type: 'Fit' } });
  });
});

describe('Page.AddLink', () => {
  it('creates a URI link with an invisible default border', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];

    const link = page.AddLink({ rect: [10, 10, 100, 30], action: { type: 'uri', uri: 'https://aspose.com' } });

    expect(link).toBeInstanceOf(LinkAnnotation);
    expect(link.Subtype).toBe('Link');
    expect(link.Rect).toEqual([10, 10, 100, 30]);
    expect(link.Action).toEqual({ type: 'uri', uri: 'https://aspose.com' });
    expect(link.Dict.get('Border')).toEqual([0, 0, 0]);   // invisible
    expect(page.Annotations).toHaveLength(1);
  });

  it('creates a GoTo link with a page+view and a visible border', () => {
    const doc = Document.Open(buildBlankPage());             // single indirect page, no annots
    const page = doc.Pages[0];
    const link = page.AddLink({
      rect: [0, 0, 50, 20],
      action: { type: 'goto', page: 1, view: { type: 'XYZ', left: 0, top: 100, zoom: null } },
      border: 2,
    });
    expect(link.Action).toEqual({ type: 'goto', page: 1, view: { type: 'XYZ', left: 0, top: 100, zoom: null } });
    expect(link.Dict.get('Border')).toEqual([0, 0, 2]);
    const a = doc.resolve(link.Dict.get('A')) as Map<string, any>;
    const s = doc.resolve(a.get('S'));
    expect(isName(s) && s.name).toBe('GoTo');
  });

  it('validates the action and rejects an out-of-range GoTo page without mutating the page', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    expect(() => page.AddLink({ rect: [0, 0, 10, 10], action: { type: 'goto', page: 99 } })).toThrow(RangeError);
    expect(() => page.AddLink({ rect: [0, 0, 10, 10], action: { type: 'uri', uri: '' } })).toThrow(TypeError);
    expect(() => page.AddLink({ rect: [0, 0, 10, 10], action: { type: 'x' } as any })).toThrow(TypeError);
    expect(page.Annotations).toHaveLength(0);
  });

  it('round-trips a GoTo link through Save/Open', () => {
    const doc = Document.Open(buildBlankPage());
    doc.Pages[0].AddLink({ rect: [5, 5, 55, 25], action: { type: 'goto', page: 1 } });

    const reopened = Document.Open(doc.Save());
    const link = reopened.Pages[0].Annotations.find((x) => x.Subtype === 'Link') as LinkAnnotation;
    expect(link).toBeInstanceOf(LinkAnnotation);
    expect(link.Action).toEqual({ type: 'goto', page: 1, view: { type: 'Fit' } });
    expect(link.Dest).toEqual({ page: 1, view: { type: 'Fit' } });
  });
});

describe('Annotation.Layer (/OC membership)', () => {
  it('gets and sets an annotation layer via /OC', () => {
    const doc = Document.Open(buildBlankPage());
    const layer = doc.OptionalContent.AddLayer('Review');
    const page = doc.Pages[0];
    const annot = page.AddStamp({ rect: [10, 10, 60, 40], name: 'Approved' });

    expect(annot.Layer).toBeUndefined();
    annot.Layer = layer;
    expect(annot.Dict.get('OC')).toBeTruthy();
    expect(annot.Layer?.Ref.num).toBe(layer.Ref.num);

    annot.Layer = undefined;
    expect(annot.Dict.get('OC')).toBeUndefined();
    expect(annot.Layer).toBeUndefined();
  });
});

describe('SquareCircleAnnotation read model', () => {
  it('wraps /Square and /Circle with shape/interior/border accessors', () => {
    const doc = Document.Open(buildShapeReadTarget());
    const annots = doc.Pages[0].Annotations;
    const square = annots.find((a) => a.Subtype === 'Square') as SquareCircleAnnotation;
    const circle = annots.find((a) => a.Subtype === 'Circle') as SquareCircleAnnotation;

    expect(square).toBeInstanceOf(SquareCircleAnnotation);
    expect(circle).toBeInstanceOf(SquareCircleAnnotation);
    expect(square.ShapeType).toBe('square');
    expect(circle.ShapeType).toBe('circle');
    expect(square.InteriorColor).toEqual([1, 1, 0]);
    expect(circle.InteriorColor).toBeUndefined(); // fixture circle has no /IC
    expect(square.BorderWidth).toBe(2);
    expect(circle.BorderWidth).toBe(1);           // default when /BS absent
  });

  it('round-trips interior color and border width, rejecting bad input', () => {
    const doc = Document.Open(buildShapeReadTarget());
    const square = doc.Pages[0].Annotations.find((a) => a.Subtype === 'Square') as SquareCircleAnnotation;

    square.InteriorColor = [0, 0.5, 1];
    expect(square.InteriorColor).toEqual([0, 0.5, 1]);
    square.InteriorColor = undefined;
    expect(square.InteriorColor).toBeUndefined();

    square.BorderWidth = 3;
    expect(square.BorderWidth).toBe(3);

    expect(() => { square.InteriorColor = [2, 0, 0]; }).toThrow(TypeError);
    expect(() => { square.BorderWidth = -1; }).toThrow(TypeError);
  });
});

describe('LineAnnotation read model', () => {
  it('wraps /Line with endpoint/border/ending accessors', () => {
    const doc = Document.Open(buildShapeReadTarget());
    const line = doc.Pages[0].Annotations.find((a) => a.Subtype === 'Line') as LineAnnotation;

    expect(line).toBeInstanceOf(LineAnnotation);
    expect(line.Line).toEqual([20, 110, 180, 130]);
    expect(line.BorderWidth).toBe(1);                 // no /BS → default
    expect(line.LineEndings).toEqual(['None', 'OpenArrow']);
  });

  it('round-trips line/endings and rejects bad input', () => {
    const doc = Document.Open(buildShapeReadTarget());
    const line = doc.Pages[0].Annotations.find((a) => a.Subtype === 'Line') as LineAnnotation;

    line.Line = [0, 0, 100, 100];
    expect(line.Line).toEqual([0, 0, 100, 100]);

    line.LineEndings = ['OpenArrow', 'ClosedArrow'];
    expect(line.LineEndings).toEqual(['OpenArrow', 'ClosedArrow']);
    line.LineEndings = undefined;
    expect(line.LineEndings).toBeUndefined();

    expect(() => { line.Line = [1, 2, 3] as any; }).toThrow(TypeError);
    expect(() => { line.LineEndings = ['Bogus', 'None'] as any; }).toThrow(TypeError);
  });
});

describe('Page.AddSquare / AddCircle', () => {
  function apOps(doc: Document, annot: Annotation): string[] {
    const ap = doc.resolve(annot.Dict.get('AP')) as Map<string, any>;
    const n = doc.resolve(ap.get('N'));
    expect(isStream(n)).toBe(true);
    return parseContentStream((n as any).raw).map((o) => o.operator);
  }

  it('AddSquare creates a filled+stroked /Square with an appearance', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const sq = page.AddSquare({ rect: [10, 10, 90, 60], color: [0, 0, 1], fill: [1, 1, 0], width: 2 });

    expect(sq).toBeInstanceOf(SquareCircleAnnotation);
    expect(sq.Subtype).toBe('Square');
    expect(sq.InteriorColor).toEqual([1, 1, 0]);
    expect(sq.BorderWidth).toBe(2);
    expect(sq.Print).toBe(true);
    expect(page.Annotations).toHaveLength(1);

    const ops = apOps(doc, sq);
    expect(ops).toContain('re');
    expect(ops).toContain('B');   // fill + stroke
  });

  it('AddCircle without fill strokes an ellipse (Bézier curves)', () => {
    const doc = Document.Open(buildBlankPage());
    const c = doc.Pages[0].AddCircle({ rect: [10, 10, 90, 60], color: [1, 0, 0] });

    expect(c.ShapeType).toBe('circle');
    expect(c.InteriorColor).toBeUndefined();
    const ops = apOps(doc, c);
    expect(ops.filter((o) => o === 'c').length).toBe(4); // 4 quarter-arcs
    expect(ops).toContain('S');                          // stroke only
  });

  it('applies opacity via a /GS0 ExtGState and validates before attaching', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const sq = page.AddSquare({ rect: [0, 0, 40, 40], opacity: 0.5 });
    const ap = doc.resolve(sq.Dict.get('AP')) as Map<string, any>;
    const n = doc.resolve(ap.get('N'));
    expect(new TextDecoder().decode((n as any).raw)).toContain('gs');
    expect(sq.Opacity).toBe(0.5);

    expect(() => page.AddSquare({ rect: [0, 0, 10, 10], color: [2, 0, 0] })).toThrow(TypeError);
    expect(() => page.AddSquare({ rect: [0, 0, 10, 10], opacity: 5 })).toThrow(TypeError);
    expect(page.Annotations).toHaveLength(1); // no stranded objects from the throwing calls
  });
});

describe('Page.AddLine', () => {
  function apOps(doc: Document, annot: Annotation): string[] {
    const ap = doc.resolve(annot.Dict.get('AP')) as Map<string, any>;
    const n = doc.resolve(ap.get('N'));
    expect(isStream(n)).toBe(true);
    return parseContentStream((n as any).raw).map((o) => o.operator);
  }

  it('AddLine sets /L, derives /Rect from endpoints, and strokes the segment', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const line = page.AddLine({ line: [20, 30, 120, 30], color: [1, 0, 0], width: 2 });

    expect(line).toBeInstanceOf(LineAnnotation);
    expect(line.Subtype).toBe('Line');
    expect(line.Line).toEqual([20, 30, 120, 30]);
    expect(line.BorderWidth).toBe(2);
    // /Rect encloses both endpoints (with margin), so it is wider/taller than /L.
    const [x1, y1, x2, y2] = line.Rect!;
    expect(x1).toBeLessThan(20);
    expect(x2).toBeGreaterThan(120);
    expect(y1).toBeLessThan(30);
    expect(y2).toBeGreaterThan(30);

    const ops = apOps(doc, line);
    expect(ops).toContain('m');
    expect(ops).toContain('l');
    expect(ops).toContain('S');
  });

  it('renders a closed arrowhead as a filled triangle at the end', () => {
    const doc = Document.Open(buildBlankPage());
    const line = doc.Pages[0].AddLine({ line: [0, 0, 100, 0], endEnding: 'ClosedArrow' });
    expect(line.LineEndings).toEqual(['None', 'ClosedArrow']);
    const ops = apOps(doc, line);
    expect(ops).toContain('f'); // filled arrowhead triangle
  });

  it('validates inputs before attaching', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    expect(() => page.AddLine({ line: [0, 0, 1] as any })).toThrow(TypeError);
    expect(() => page.AddLine({ line: [0, 0, 1, 1], endEnding: 'Bogus' as any })).toThrow(TypeError);
    expect(page.Annotations).toHaveLength(0); // nothing stranded
  });
});

describe('FreeText read model + setters', () => {
  it('reads FreeText entries as typed accessors', () => {
    const doc = Document.Open(buildFreeTextReadTarget());
    const ft = doc.Pages[0].Annotations[0] as FreeTextAnnotation;
    expect(ft).toBeInstanceOf(FreeTextAnnotation);
    expect(ft.Subtype).toBe('FreeText');
    expect(ft.Contents).toBe('note');
    expect(ft.Alignment).toBe('center');
    expect(ft.FontSize).toBe(14);
    expect(ft.TextColor).toEqual([1, 0, 0]);
    expect(ft.BorderWidth).toBe(2);
    expect(ft.InteriorColor).toEqual([0.9, 0.9, 0.9]);
    expect(ft.Intent).toBe('FreeTextCallout');
    expect(ft.CalloutLine).toEqual([30, 30, 60, 60, 100, 80]);
    expect(ft.CalloutEnding).toBe('OpenArrow');
  });

  it('round-trips setters and preserves the other /DA parts', () => {
    const doc = Document.Open(buildFreeTextReadTarget());
    const ft = doc.Pages[0].Annotations[0] as FreeTextAnnotation;
    ft.Alignment = 'right';
    expect(ft.Alignment).toBe('right');
    ft.FontSize = 20;
    expect(ft.FontSize).toBe(20);
    expect(ft.TextColor).toEqual([1, 0, 0]); // unchanged by FontSize set
    ft.TextColor = [0, 0, 1];
    expect(ft.TextColor).toEqual([0, 0, 1]);
    expect(ft.FontSize).toBe(20);            // unchanged by TextColor set
    ft.InteriorColor = undefined;
    expect(ft.InteriorColor).toBeUndefined();
    ft.CalloutEnding = undefined;
    expect(ft.CalloutEnding).toBeUndefined();
    expect(() => { ft.TextColor = [2, 0, 0]; }).toThrow(TypeError);
    expect(() => { ft.CalloutLine = [1, 2, 3]; }).toThrow(TypeError);
    expect(() => { ft.CalloutEnding = 'Nope' as any; }).toThrow(TypeError);
  });
});

describe('Popup read model', () => {
  it('reads /Open and resolves a typed /Parent handle', () => {
    const doc = Document.Open(buildPopupReadTarget());
    const popup = doc.Pages[0].Annotations[1] as PopupAnnotation;
    expect(popup).toBeInstanceOf(PopupAnnotation);
    expect(popup.Subtype).toBe('Popup');
    expect(popup.Open).toBe(true);
    expect(popup.Parent).toBeInstanceOf(TextAnnotation);
    expect(popup.Parent!.Subtype).toBe('Text');
  });
});

describe('Page.AddFreeText (no callout)', () => {
  function apOps(doc: Document, annot: Annotation): string[] {
    const ap = doc.resolve(annot.Dict.get('AP')) as Map<string, any>;
    const n = doc.resolve(ap.get('N'));
    expect(isStream(n)).toBe(true);
    return parseContentStream((n as any).raw).map((o) => o.operator);
  }

  it('creates a /FreeText box with /DA, /Q, /IC and a text appearance', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const ft = page.AddFreeText({
      rect: [20, 20, 180, 90], contents: 'hello world from a wrapped note',
      fontSize: 12, textColor: [0, 0, 1], align: 'center', fill: [0.9, 0.9, 0.9], width: 1,
    });
    expect(ft).toBeInstanceOf(FreeTextAnnotation);
    expect(ft.Subtype).toBe('FreeText');
    expect(ft.Alignment).toBe('center');
    expect(ft.FontSize).toBe(12);
    expect(ft.TextColor).toEqual([0, 0, 1]);
    expect(ft.InteriorColor).toEqual([0.9, 0.9, 0.9]);
    expect(page.Annotations).toHaveLength(1);

    const ops = apOps(doc, ft);
    expect(ops).toContain('Tj'); // text drawn
    expect(ops).toContain('re'); // border/fill rect
  });

  it('applies opacity via /GS0 and validates before attaching', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const ft = page.AddFreeText({ rect: [0, 0, 100, 40], contents: 'x', opacity: 0.5 });
    const ap = doc.resolve(ft.Dict.get('AP')) as Map<string, any>;
    expect(new TextDecoder().decode((doc.resolve(ap.get('N')) as any).raw)).toContain('gs');

    expect(() => page.AddFreeText({ rect: [0, 0, 10, 10], contents: '' })).toThrow(TypeError);
    expect(() => page.AddFreeText({ rect: [0, 0, 10, 10], contents: 'x', textColor: [2, 0, 0] })).toThrow(TypeError);
    expect(page.Annotations).toHaveLength(1); // nothing stranded
  });
});

describe('Page.AddFreeText (callout)', () => {
  function apStr(doc: Document, annot: Annotation): string {
    const ap = doc.resolve(annot.Dict.get('AP')) as Map<string, any>;
    return new TextDecoder().decode((doc.resolve(ap.get('N')) as any).raw);
  }

  it('adds /CL, /LE, /IT and enlarges /Rect to enclose the leader', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const ft = page.AddFreeText({
      rect: [120, 120, 260, 180], contents: 'see here',
      callout: [20, 20, 80, 90, 120, 150],
    }) as FreeTextAnnotation;

    expect(ft.CalloutLine).toEqual([20, 20, 80, 90, 120, 150]);
    expect(ft.CalloutEnding).toBe('OpenArrow'); // default when callout set
    expect(ft.Intent).toBe('FreeTextCallout');
    // /Rect grew to include the callout tip at (20,20).
    const [x0, y0] = ft.Rect!;
    expect(x0).toBeLessThan(20);
    expect(y0).toBeLessThan(20);
    // /RD records the padding from /Rect to the text box.
    const rd = doc.resolve(ft.Dict.get('RD')) as number[];
    expect(rd).toHaveLength(4);

    const body = apStr(doc, ft);
    expect(body).toContain('Tj'); // text still drawn
    expect(body).toContain(' l '); // leader stroke segments
  });

  it('honors an explicit calloutEnding and rejects a bad /CL length', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const ft = page.AddFreeText({
      rect: [100, 100, 200, 150], contents: 'x', callout: [10, 10, 100, 120], calloutEnding: 'ClosedArrow',
    }) as FreeTextAnnotation;
    expect(ft.CalloutEnding).toBe('ClosedArrow');
    expect(() => page.AddFreeText({ rect: [0, 0, 50, 50], contents: 'x', callout: [1, 2, 3] })).toThrow(TypeError);
    expect(page.Annotations).toHaveLength(1); // bad call stranded nothing
  });
});

describe('Page.AddPopup', () => {
  it('links a popup to its parent both ways', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const sq = page.AddSquare({ rect: [10, 10, 90, 60] });
    const popup = page.AddPopup({ parent: sq, rect: [100, 10, 300, 110], open: true });

    expect(popup).toBeInstanceOf(PopupAnnotation);
    expect(popup.Subtype).toBe('Popup');
    expect(popup.Open).toBe(true);
    expect(popup.Dict.has('AP')).toBe(false); // no appearance
    // parent /Popup → popup, popup /Parent → parent (same dict identity)
    expect(doc.resolve(sq.Dict.get('Popup'))).toBe(popup.Dict);
    expect(popup.Parent!.Dict).toBe(sq.Dict);
    expect(page.Annotations).toHaveLength(2);
  });

  it('derives a default rect and rejects a bad rect before attaching', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const sq = page.AddSquare({ rect: [10, 10, 90, 60] });
    const popup = page.AddPopup({ parent: sq });
    expect(popup.Rect).toHaveLength(4);
    expect(() => page.AddPopup({ parent: sq, rect: [1, 2, 3] as any })).toThrow(TypeError);
    expect(page.Annotations).toHaveLength(2); // parent + first popup only
  });
});

describe('auto-popup option', () => {
  it('AddSquare with popup attaches a linked popup in one call', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const sq = page.AddSquare({ rect: [10, 10, 90, 60], popup: { open: true } });
    expect(page.Annotations).toHaveLength(2);
    const popup = page.Annotations.find((a) => a.Subtype === 'Popup') as PopupAnnotation;
    expect(popup).toBeInstanceOf(PopupAnnotation);
    expect(popup.Open).toBe(true);
    expect(popup.Parent!.Dict).toBe(sq.Dict);
    expect(doc.resolve(sq.Dict.get('Popup'))).toBe(popup.Dict);
  });

  it('AddHighlight and AddFreeText also accept popup', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    page.AddHighlight({ quads: [10, 40, 60, 40, 10, 30, 60, 30], popup: {} });
    page.AddFreeText({ rect: [80, 80, 180, 140], contents: 'x', popup: { rect: [190, 80, 380, 180] } });
    expect(page.Annotations.filter((a) => a.Subtype === 'Popup')).toHaveLength(2);
  });
});

describe('PolyAnnotation read model', () => {
  it('wraps /Polygon and /PolyLine with vertices/interior/border/ending accessors', () => {
    const doc = Document.Open(buildPathReadTarget());
    const annots = doc.Pages[0].Annotations;
    const poly = annots.find((a) => a.Subtype === 'Polygon') as PolyAnnotation;
    const line = annots.find((a) => a.Subtype === 'PolyLine') as PolyAnnotation;

    expect(poly).toBeInstanceOf(PolyAnnotation);
    expect(line).toBeInstanceOf(PolyAnnotation);
    expect(poly.PolyType).toBe('polygon');
    expect(line.PolyType).toBe('polyline');
    expect(poly.Vertices).toEqual([10, 10, 90, 10, 50, 60]);
    expect(poly.InteriorColor).toEqual([1, 1, 0]);
    expect(poly.BorderWidth).toBe(2);
    expect(line.InteriorColor).toBeUndefined();
    expect(line.BorderWidth).toBe(1); // no /BS → default
    expect(line.LineEndings).toEqual(['None', 'OpenArrow']);
    expect(poly.LineEndings).toBeUndefined();
  });

  it('round-trips vertices/interior/endings and rejects bad input', () => {
    const doc = Document.Open(buildPathReadTarget());
    const poly = doc.Pages[0].Annotations.find((a) => a.Subtype === 'Polygon') as PolyAnnotation;

    poly.Vertices = [0, 0, 100, 0, 100, 100, 0, 100];
    expect(poly.Vertices).toEqual([0, 0, 100, 0, 100, 100, 0, 100]);
    poly.InteriorColor = [0, 0.5, 1];
    expect(poly.InteriorColor).toEqual([0, 0.5, 1]);
    poly.InteriorColor = undefined;
    expect(poly.InteriorColor).toBeUndefined();
    poly.LineEndings = ['OpenArrow', 'Circle'];
    expect(poly.LineEndings).toEqual(['OpenArrow', 'Circle']);

    expect(() => { poly.Vertices = [0, 0, 100]; }).toThrow(TypeError);      // odd length
    expect(() => { poly.Vertices = [0, 0]; }).toThrow(TypeError);           // < 4 numbers
    expect(() => { poly.InteriorColor = [2, 0, 0]; }).toThrow(TypeError);
    expect(() => { poly.LineEndings = ['Bogus', 'None'] as any; }).toThrow(TypeError);
  });
});

describe('InkAnnotation read model', () => {
  it('wraps /Ink with per-stroke InkList and border accessors', () => {
    const doc = Document.Open(buildPathReadTarget());
    const ink = doc.Pages[0].Annotations.find((a) => a.Subtype === 'Ink') as InkAnnotation;

    expect(ink).toBeInstanceOf(InkAnnotation);
    expect(ink.InkList).toEqual([[10, 10, 40, 40], [50, 50, 80, 20]]);
    expect(ink.BorderWidth).toBe(1);
  });

  it('round-trips InkList and rejects bad input', () => {
    const doc = Document.Open(buildPathReadTarget());
    const ink = doc.Pages[0].Annotations.find((a) => a.Subtype === 'Ink') as InkAnnotation;

    ink.InkList = [[0, 0, 10, 10, 20, 0]];
    expect(ink.InkList).toEqual([[0, 0, 10, 10, 20, 0]]);
    ink.BorderWidth = 3;
    expect(ink.BorderWidth).toBe(3);

    expect(() => { ink.InkList = []; }).toThrow(TypeError);            // empty
    expect(() => { ink.InkList = [[0, 0, 10]]; }).toThrow(TypeError);  // odd stroke
  });
});

describe('Page.AddPolygon / AddPolyline', () => {
  function apOps(doc: Document, annot: Annotation): string[] {
    const ap = doc.resolve(annot.Dict.get('AP')) as Map<string, any>;
    const n = doc.resolve(ap.get('N'));
    expect(isStream(n)).toBe(true);
    return parseContentStream((n as any).raw).map((o) => o.operator);
  }

  it('AddPolygon creates a closed filled+stroked /Polygon with an appearance', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const poly = page.AddPolygon({
      vertices: [20, 20, 120, 20, 70, 100], color: [0, 0, 1], fill: [1, 1, 0], width: 2,
    });

    expect(poly).toBeInstanceOf(PolyAnnotation);
    expect(poly.Subtype).toBe('Polygon');
    expect(poly.PolyType).toBe('polygon');
    expect(poly.Vertices).toEqual([20, 20, 120, 20, 70, 100]);
    expect(poly.InteriorColor).toEqual([1, 1, 0]);
    expect(poly.BorderWidth).toBe(2);
    expect(poly.Print).toBe(true);
    // /Rect encloses all vertices.
    const [x1, y1, x2, y2] = poly.Rect!;
    expect(x1).toBeLessThanOrEqual(20); expect(x2).toBeGreaterThanOrEqual(120);
    expect(y1).toBeLessThanOrEqual(20); expect(y2).toBeGreaterThanOrEqual(100);

    const ops = apOps(doc, poly);
    expect(ops).toContain('m');
    expect(ops).toContain('l');
    expect(ops).toContain('h');   // closed
    expect(ops).toContain('B');   // fill + stroke
    expect(ops).not.toContain('re');
  });

  it('AddPolyline strokes an open path with an end arrowhead', () => {
    const doc = Document.Open(buildBlankPage());
    const line = doc.Pages[0].AddPolyline({
      vertices: [10, 10, 60, 40, 110, 10], endEnding: 'OpenArrow',
    });

    expect(line.PolyType).toBe('polyline');
    expect(line.Subtype).toBe('PolyLine');
    expect(line.LineEndings).toEqual(['None', 'OpenArrow']);
    const ops = apOps(doc, line);
    expect(ops).toContain('m');
    expect(ops).toContain('l');
    expect(ops).toContain('S');   // stroke (path + arrowhead barbs)
    expect(ops).not.toContain('h'); // open
  });

  it('applies opacity via /GS0 and validates before attaching', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const poly = page.AddPolygon({ vertices: [0, 0, 40, 0, 40, 40], opacity: 0.5 });
    const ap = doc.resolve(poly.Dict.get('AP')) as Map<string, any>;
    const n = doc.resolve(ap.get('N'));
    expect(new TextDecoder().decode((n as any).raw)).toContain('gs');
    expect(poly.Opacity).toBe(0.5);

    expect(() => page.AddPolygon({ vertices: [0, 0, 10] })).toThrow(TypeError);       // odd
    expect(() => page.AddPolygon({ vertices: [0, 0, 10, 10], color: [2, 0, 0] })).toThrow(TypeError);
    expect(() => page.AddPolyline({ vertices: [0, 0, 10, 10], endEnding: 'Bogus' as any })).toThrow(TypeError);
    expect(page.Annotations).toHaveLength(1); // nothing stranded
  });
});

describe('Page.AddInk', () => {
  function apOps(doc: Document, annot: Annotation): string[] {
    const ap = doc.resolve(annot.Dict.get('AP')) as Map<string, any>;
    const n = doc.resolve(ap.get('N'));
    expect(isStream(n)).toBe(true);
    return parseContentStream((n as any).raw).map((o) => o.operator);
  }

  it('AddInk strokes each freehand path and encloses all points in /Rect', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const ink = page.AddInk({
      paths: [[20, 20, 60, 80, 100, 20], [120, 40, 160, 60]], color: [1, 0, 0], width: 2,
    });

    expect(ink).toBeInstanceOf(InkAnnotation);
    expect(ink.Subtype).toBe('Ink');
    expect(ink.InkList).toEqual([[20, 20, 60, 80, 100, 20], [120, 40, 160, 60]]);
    expect(ink.BorderWidth).toBe(2);
    expect(ink.Print).toBe(true);
    const [x1, y1, x2, y2] = ink.Rect!;
    expect(x1).toBeLessThanOrEqual(20); expect(x2).toBeGreaterThanOrEqual(160);
    expect(y1).toBeLessThanOrEqual(20); expect(y2).toBeGreaterThanOrEqual(80);

    const ops = apOps(doc, ink);
    expect(ops.filter((o) => o === 'm').length).toBe(2); // one move per stroke
    expect(ops.filter((o) => o === 'S').length).toBe(2); // one stroke per path
    expect(ops).toContain('l');
  });

  it('applies opacity via /GS0 and validates before attaching', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const ink = page.AddInk({ paths: [[0, 0, 40, 40]], opacity: 0.3 });
    const ap = doc.resolve(ink.Dict.get('AP')) as Map<string, any>;
    const n = doc.resolve(ap.get('N'));
    expect(new TextDecoder().decode((n as any).raw)).toContain('gs');
    expect(ink.Opacity).toBe(0.3);

    expect(() => page.AddInk({ paths: [] })).toThrow(TypeError);          // no strokes
    expect(() => page.AddInk({ paths: [[0, 0, 10]] })).toThrow(TypeError); // odd stroke
    expect(() => page.AddInk({ paths: [[0, 0, 10, 10]], color: [0, 0, 2] })).toThrow(TypeError);
    expect(page.Annotations).toHaveLength(1); // nothing stranded
  });
});

describe('page.AddCaret', () => {
  const apBody = (doc: Document, a: { Dict: PdfDict }) => {
    const n = doc.resolve((doc.resolve(a.Dict.get('AP')) as PdfDict).get('N'));
    return new TextDecoder('latin1').decode(inflateStream(n as PdfStream));
  };

  it('writes the /Caret keys and returns a live handle', () => {
    const doc = Document.Open(buildBlankPage());
    const c = doc.Pages[0].AddCaret({
      rect: [72, 700, 92, 720], color: [0, 0, 1], contents: 'insert here', author: 'ed',
    });

    expect(c).toBeInstanceOf(CaretAnnotation);
    expect(c.Subtype).toBe('Caret');
    expect(c.Rect).toEqual([72, 700, 92, 720]);
    expect(c.Color).toEqual([0, 0, 1]);
    expect(c.Contents).toBe('insert here');
    expect(c.Author).toBe('ed');
    expect(c.Symbol).toBe('none');
    expect(isName(c.Dict.get('Sy')) && (c.Dict.get('Sy') as { name: string }).name).toBe('None');
  });

  it('round-trips through Save/Open as a CaretAnnotation', () => {
    const doc = Document.Open(buildBlankPage());
    doc.Pages[0].AddCaret({ rect: [72, 700, 92, 720], symbol: 'paragraph' });

    const back = Document.Open(doc.Save()).Pages[0].Annotations[0];
    expect(back).toBeInstanceOf(CaretAnnotation);
    expect((back as CaretAnnotation).Symbol).toBe('paragraph');
  });

  it('draws the paragraph sign only when asked, naming the registered font', () => {
    const doc = Document.Open(buildBlankPage());
    const plain = doc.Pages[0].AddCaret({ rect: [72, 700, 92, 720] });
    const sym = doc.Pages[0].AddCaret({ rect: [72, 660, 92, 680], symbol: 'paragraph' });

    expect(apBody(doc, plain)).not.toContain('Tj');
    const body = apBody(doc, sym);
    expect(body).toContain('Tj');
    // The operator must name the key fontResources actually registered — see cu3b.
    expect(body).toContain('/F0 ');
    const ap = doc.resolve((doc.resolve(sym.Dict.get('AP')) as PdfDict).get('N')) as PdfStream;
    const res = doc.resolve(ap.dict.get('Resources')) as PdfDict;
    const fonts = doc.resolve(res.get('Font')) as PdfDict;
    expect([...fonts.keys()]).toContain('F0');
  });

  it('reads an unrecognised /Sy as none rather than throwing', () => {
    const doc = Document.Open(buildBlankPage());
    const c = doc.Pages[0].AddCaret({ rect: [72, 700, 92, 720] });
    c.Dict.set('Sy', name('Wat'));
    expect(c.Symbol).toBe('none');
  });

  it('sets Symbol through the accessor', () => {
    const doc = Document.Open(buildBlankPage());
    const c = doc.Pages[0].AddCaret({ rect: [72, 700, 92, 720] });
    c.Symbol = 'paragraph';
    expect((c.Dict.get('Sy') as { name: string }).name).toBe('P');
    c.Symbol = 'none';
    expect((c.Dict.get('Sy') as { name: string }).name).toBe('None');
  });

  it('creates the annotation without an /AP for a degenerate rect', () => {
    const doc = Document.Open(buildBlankPage());
    const c = doc.Pages[0].AddCaret({ rect: [72, 700, 72, 700] });
    expect(c.Subtype).toBe('Caret');
    expect(c.Dict.has('AP')).toBe(false);
  });

  it('rejects bad input before adding anything', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    expect(() => page.AddCaret({ rect: [1, 2, 3] as never })).toThrow(TypeError);
    expect(() => page.AddCaret({ rect: [0, 0, 10, 10], color: [2, 0, 0] })).toThrow(TypeError);
    expect(() => page.AddCaret({ rect: [0, 0, 10, 10], symbol: 'star' as never })).toThrow(TypeError);
    expect(() => page.AddCaret({ rect: [0, 0, 10, 10], opacity: 5 })).toThrow(TypeError);
    expect(page.Annotations).toHaveLength(0);
  });
});
