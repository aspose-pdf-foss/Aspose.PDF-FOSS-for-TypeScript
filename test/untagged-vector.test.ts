import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { visitContent } from '../src/text.js';
import { buildMultiStreamPage } from './helpers/build-edit-pdf.js';
import { name, type PdfObject } from '../src/types.js';
import { appendContent, ensureOwnResources, ensureOwnSubdict } from '../src/pagecontent.js';

/** A tagged page with text to hang a structure tree off. */
function taggedDoc(): Document {
  const doc = Document.Open(buildMultiStreamPage([
    'BT /F1 10 Tf 50 700 Td (Hello) Tj ET',
  ]));
  doc.Lang = 'en-US';
  doc.AutoTag();
  return doc;
}

/** Marking counts over every path paint on page 1. */
function paths(doc: Document) {
  let untagged = 0, tagged = 0, artifact = 0;
  visitContent(doc, doc.Pages[0], {
    path: (e) => {
      if (e.artifact) artifact++;
      else if (e.mcid !== undefined) tagged++;
      else untagged++;
    },
  });
  return { untagged, tagged, artifact };
}

const fires = (doc: Document) =>
  doc.ValidatePdfUa().Issues.some((i) => i.rule === 'UntaggedContent');

describe('PathEvent carries its marked-content state', () => {
  it('reports a bare fill as untagged', () => {
    const doc = taggedDoc();
    doc.Pages[0].Graphics().setFillColor([1, 0, 0]).rect(10, 10, 50, 50).fill().apply();
    expect(paths(doc)).toEqual({ untagged: 1, tagged: 0, artifact: 0 });
  });

  it('reports a fill inside BeginArtifact as an artifact', () => {
    const doc = taggedDoc();
    const g = doc.Pages[0].Graphics();
    g.BeginArtifact();
    g.setFillColor([1, 0, 0]).rect(10, 10, 50, 50).fill();
    g.EndMarkedContent();
    g.apply();
    expect(paths(doc)).toEqual({ untagged: 0, tagged: 0, artifact: 1 });
  });

  it('reports a fill inside a BDC sequence as tagged, carrying its MCID', () => {
    const doc = taggedDoc();
    const root = doc.GetStructTree()!;
    const elem = root.Children[0].Append('Figure', { alt: 'a red square' });
    const g = doc.Pages[0].Graphics();
    g.BeginMarkedContent(elem.Type, elem.NextMcid(doc.Pages[0]));
    g.setFillColor([1, 0, 0]).rect(10, 10, 50, 50).fill();
    g.EndMarkedContent();
    g.apply();
    expect(paths(doc)).toEqual({ untagged: 0, tagged: 1, artifact: 0 });
  });
});

describe('UntaggedContent covers vector content', () => {
  it('fires for a bare fill on an otherwise clean tagged page', () => {
    const clean = taggedDoc();
    expect(fires(clean)).toBe(false); // baseline

    const doc = taggedDoc();
    doc.Pages[0].Graphics().setFillColor([1, 0, 0]).rect(10, 10, 50, 50).fill().apply();
    expect(fires(doc)).toBe(true);
  });

  it('stays silent when the same fill is an artifact', () => {
    const doc = taggedDoc();
    const g = doc.Pages[0].Graphics();
    g.BeginArtifact();
    g.setFillColor([1, 0, 0]).rect(10, 10, 50, 50).fill();
    g.EndMarkedContent();
    g.apply();
    expect(fires(doc)).toBe(false);
  });

  it('still reads the redaction marker box as an artifact', () => {
    // Regression guard on nmjf: the one producer already doing this correctly.
    const doc = taggedDoc();
    doc.Pages[0].Redact([[40, 690, 200, 720]]);
    expect(paths(doc).artifact).toBe(1);
    expect(fires(doc)).toBe(false);
  });
});

describe('marked-content state propagates into Form XObjects', () => {
  // A marked-content sequence must open and close within one stream, but a form
  // drawn inside one is still part of it. Without propagation, everything inside
  // a correctly tagged form reads as untagged — which is how a /Redact mark's
  // tagged /RO overlay still tripped UntaggedContent.
  function docWithForm(wrap: 'none' | 'artifact' | 'tagged') {
    const doc = taggedDoc();
    const page = doc.Pages[0];
    const form = doc.allocObject({
      kind: 'stream' as const,
      dict: new Map<string, PdfObject>([
        ['Type', name('XObject')], ['Subtype', name('Form')],
        ['BBox', [0, 0, 60, 60]],
      ]),
      raw: new TextEncoder().encode('1 0 0 rg 0 0 60 60 re f'),
    });
    const xo = ensureOwnSubdict(doc, ensureOwnResources(doc, page), 'XObject');
    xo.set('Fm9', form);

    let body = 'q 1 0 0 1 100 100 cm /Fm9 Do Q\n';
    if (wrap === 'artifact') body = `/Artifact BMC\n${body}EMC\n`;
    if (wrap === 'tagged') {
      const elem = doc.GetStructTree()!.Children[0].Append('Figure', { alt: 'square' });
      body = `/${elem.Type} <</MCID ${elem.NextMcid(page)}>> BDC\n${body}EMC\n`;
    }
    appendContent(doc, page, new TextEncoder().encode(body));
    return doc;
  }

  it('reads a form drawn bare as untagged', () => {
    expect(paths(docWithForm('none'))).toEqual({ untagged: 1, tagged: 0, artifact: 0 });
  });

  it('inherits an /Artifact scope across the Do', () => {
    expect(paths(docWithForm('artifact'))).toEqual({ untagged: 0, tagged: 0, artifact: 1 });
    expect(fires(docWithForm('artifact'))).toBe(false);
  });

  it('inherits an MCID scope across the Do', () => {
    expect(paths(docWithForm('tagged'))).toEqual({ untagged: 0, tagged: 1, artifact: 0 });
    expect(fires(docWithForm('tagged'))).toBe(false);
  });
});
