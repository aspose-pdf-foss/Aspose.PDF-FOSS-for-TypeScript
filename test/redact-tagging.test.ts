import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildMultiStreamPage } from './helpers/build-edit-pdf.js';
import { name, type PdfObject } from '../src/types.js';

const REGION: [number, number, number, number] = [40, 80, 260, 140];

/** A tagged document: AutoTag builds the tree and tags the existing content.
 *
 *  /Lang is set because the overlay adds a text-bearing element, and
 *  EffectiveLang falls back to doc.Lang. Without it the NaturalLanguage rule
 *  fires once per text-bearing element, so the overlay's /P would add a second
 *  instance of a failure the fixture already had — noise that would obscure the
 *  one rule this suite is actually about. */
function taggedDoc(): Document {
  const doc = Document.Open(buildMultiStreamPage([
    'BT /F1 10 Tf 50 100 Td (PageSecret) Tj ET',
  ]));
  doc.Lang = 'en-US';
  doc.AutoTag();
  return doc;
}

/** An untagged document with the same content. */
function plainDoc(): Document {
  return Document.Open(buildMultiStreamPage([
    'BT /F1 10 Tf 50 100 Td (PageSecret) Tj ET',
  ]));
}

const content = (doc: Document) =>
  new TextDecoder('latin1').decode(doc.Pages[0].Contents);

describe('redaction marker box tagging', () => {
  it('wraps the marker box as an artifact in a tagged document', () => {
    // UntaggedContent covers path fills, so an unartifacted box would fire it —
    // but the rule reports only that *something* on the page is unmarked, so
    // assert on the stream to pin the wrapping to the box itself.
    // (untagged-vector.test.ts holds the validator half for this same box.)
    const doc = taggedDoc();
    doc.Pages[0].Redact([REGION]);
    expect(content(doc)).toContain('/Artifact BMC');
  });

  it('leaves an untagged document exactly as it was', () => {
    const doc = plainDoc();
    doc.Pages[0].Redact([REGION]);
    const body = content(doc);
    expect(body).not.toContain('BMC');
    expect(body).not.toContain('BDC');
  });

  it('artifacts the fill on the ApplyRedactions path too', () => {
    const doc = taggedDoc();
    doc.Pages[0].AddRedact({ rect: REGION, fill: [0, 0, 1] });
    doc.Pages[0].ApplyRedactions();
    const body = content(doc);
    expect(body).toContain('/Artifact BMC');
    expect(body).toContain('0 0 1 rg'); // still the mark's own /IC colour
  });
});

/** Rule ids reported by ValidatePdfUa, in order. */
const rules = (doc: Document) => doc.ValidatePdfUa().Issues.map((i) => i.rule);

describe('redaction overlay text tagging', () => {
  it('no longer reports UntaggedContent, and reports nothing else new', () => {
    const before = rules(taggedDoc());
    expect(before).not.toContain('UntaggedContent'); // baseline sanity

    const doc = taggedDoc();
    doc.Pages[0].AddRedact({ rect: REGION, overlayText: 'REDACTED' });
    doc.Pages[0].ApplyRedactions();

    // Assert the whole set: silencing unrelated rules would be a regression
    // wearing a fix's clothes.
    expect(rules(doc)).toEqual(before);
  });

  it('puts the overlay text in the structure tree under /Document', () => {
    const doc = taggedDoc();
    doc.Pages[0].AddRedact({ rect: REGION, overlayText: 'REDACTED' });
    doc.Pages[0].ApplyRedactions();

    const root = doc.GetStructTree()!;
    const docElem = root.Children[0];
    // A /P was added under /Document, not beside it.
    expect(docElem.Children.some((c) => c.Type === 'P')).toBe(true);
    // And the text is genuinely reachable through the tree. GetText lives on
    // StructTreeRoot, not StructElement — do not call it on an element.
    expect(root.GetText()).toContain('REDACTED');
  });

  it('emits a /P marked-content sequence around the overlay text', () => {
    const doc = taggedDoc();
    doc.Pages[0].AddRedact({ rect: REGION, overlayText: 'REDACTED' });
    doc.Pages[0].ApplyRedactions();
    expect(content(doc)).toMatch(/\/P <<\/MCID \d+>> BDC/);
  });

  it('emits nothing marked in an untagged document', () => {
    const doc = plainDoc();
    doc.Pages[0].AddRedact({ rect: REGION, overlayText: 'REDACTED' });
    doc.Pages[0].ApplyRedactions();
    const body = content(doc);
    expect(body).toContain('(REDACTED) Tj'); // still drawn
    expect(body).not.toContain('BDC');
    expect(body).not.toContain('BMC');
  });

  it('tags an /RO overlay form as /P too', () => {
    // /RO takes precedence over /IC + /OverlayText, so it plays the overlay's
    // role and gets the overlay's treatment.
    const doc = taggedDoc();
    const mark = doc.Pages[0].AddRedact({ rect: REGION });
    const form = doc.allocObject({
      kind: 'stream',
      dict: new Map<string, PdfObject>([
        ['Type', name('XObject')], ['Subtype', name('Form')],
        ['BBox', [0, 0, 160, 20]],
      ]),
      raw: new TextEncoder().encode('0 1 0 rg 0 0 160 20 re f'),
    });
    mark.Dict.set('RO', form);

    doc.Pages[0].ApplyRedactions();
    const body = content(doc);
    expect(body).toMatch(/\/P <<\/MCID \d+>> BDC/);
    expect(body).toContain(' Do');
    expect(rules(doc)).not.toContain('UntaggedContent');
  });
});
