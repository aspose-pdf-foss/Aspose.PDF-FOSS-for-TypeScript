import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { isArray, isDict, name, type PdfDict, type PdfObject } from '../src/types.js';
import { buildOcgRenderPdf } from './helpers/build-ocg-render-pdf.js';

const str = (t: string): PdfObject => ({ kind: 'string', bytes: new TextEncoder().encode(t) });
const jsAction = (script: string): PdfDict => new Map<string, PdfObject>([
  ['S', name('JavaScript')], ['JS', str(script)],
]);
const aa = (script: string): PdfDict => new Map<string, PdfObject>([['O', jsAction(script)]]);
const latin1 = (b: Uint8Array) => new TextDecoder('latin1').decode(b);

/** A two-page document carrying one of everything Sanitize removes. Every
 *  script carries a distinct marker so a saved-bytes search names the leak. */
function messy(): Document {
  const doc = Document.New();
  doc.AddPage(PageFormat.A4);
  doc.AddPage(PageFormat.A4);
  const [p1, p2] = doc.Pages;
  doc.SetMetadata({ title: 'SECRET-TITLE', author: 'SECRET-AUTHOR' });
  doc.SetJavaScript('init', 'app.alert("DOC-JS")');
  doc.SetOpenAction({ type: 'javascript', script: 'app.alert("OPEN-JS")' });
  doc.catalog().set('AA', new Map<string, PdfObject>([['WC', jsAction('app.alert("CAT-AA")')]]));
  p2.Dict.set('AA', aa('app.alert("PAGE-AA")'));
  doc.AddAttachment('secret.txt', new TextEncoder().encode('EMBEDDED-SECRET'));
  p1.AddFileAttachment({
    rect: [10, 10, 30, 30], name: 'annot.txt', bytes: new TextEncoder().encode('ANNOT-FILE'),
  });
  p1.AddTextNote({ rect: [50, 50, 70, 70], contents: 'NOTE-TEXT' });
  p1.AddLink({ rect: [100, 100, 200, 120], action: { type: 'goto', page: 2 } });
  p1.AddLink({ rect: [100, 130, 200, 150], action: { type: 'uri', uri: 'https://evil.example/' } });
  p1.AddTextField({
    rect: [100, 300, 300, 330], name: 'f1', value: 'FIELD-VALUE',
    actions: { keystroke: { type: 'javascript', script: 'event.rc=true;//FIELD-JS' } },
  });
  doc.SetOutlines([{ Title: 'Chapter', Dest: { page: 2 } }]);
  return doc;
}

/** The /Annots entry (a ref) naming `annot` on page 1. */
function annotRef(doc: Document, annot: PdfDict): PdfObject {
  const arr = doc.resolve(doc.Pages[0].Dict.get('Annots')) as PdfObject[];
  return arr.find((e) => doc.resolve(e) === annot)!;
}

/** The first outline item's dict. */
function firstOutline(doc: Document): PdfDict {
  const root = doc.resolve(doc.catalog().get('Outlines'));
  if (!isDict(root)) throw new Error('no outlines');
  const first = doc.resolve(root.get('First'));
  if (!isDict(first)) throw new Error('no first item');
  return first;
}

describe('Sanitize', () => {
  it('removes everything by default and reports what each toggle removed', () => {
    const doc = messy();
    const report = doc.Sanitize();
    expect(report.metadata).toEqual({ info: true, xmp: 1 });
    expect(report.forms).toEqual({ widgets: 1 });
    // the note and two links; the file-attachment annotation goes under attachments
    expect(report.annotations).toEqual({ removed: 3 });
    expect(report.attachments).toEqual({ embeddedFiles: 1, fileAttachmentAnnotations: 1, collection: false });
    expect(report.actions).toEqual({
      openAction: true, documentJavaScripts: 1, additionalActions: 2,
      actions: 0, convertedToDestinations: 0,
    });
    expect(report.layers).toBeDefined();

    const bytes = latin1(doc.Save());
    for (const leak of ['SECRET-TITLE', 'SECRET-AUTHOR', 'DOC-JS', 'OPEN-JS', 'CAT-AA', 'PAGE-AA',
      'EMBEDDED-SECRET', 'ANNOT-FILE', 'NOTE-TEXT', 'evil.example', 'FIELD-JS']) {
      expect(bytes, leak).not.toContain(leak);
    }
    const re = Document.Open(doc.Save());
    expect(re.Pages[0].Annotations).toEqual([]);
    expect(re.catalog().get('AcroForm')).toBeUndefined();
    expect(re.GetJavaScripts()).toEqual([]);
    expect(re.GetAttachments()).toEqual([]);
  });

  it('every section is undefined when its toggle is off', () => {
    const doc = messy();
    const report = doc.Sanitize({
      metadata: false, actions: false, attachments: false,
      annotations: false, forms: false, layers: false, privateData: false,
    });
    expect(report).toEqual({
      metadata: undefined, actions: undefined, attachments: undefined,
      annotations: undefined, forms: undefined, layers: undefined, privateData: undefined,
    });
    expect(doc.GetJavaScripts()).toHaveLength(1);
    expect(doc.GetAttachments()).toHaveLength(1);
    expect(doc.Pages[0].Annotations).toHaveLength(5);
  });

  it('keeps widgets when forms are kept but annotations are removed', () => {
    const doc = messy();
    const report = doc.Sanitize({ forms: false, actions: false });
    // note + 2 links; the file-attachment annotation goes under attachments
    expect(report.annotations).toEqual({ removed: 3 });
    const subtypes = doc.Pages[0].Annotations.map((a) => a.Subtype);
    expect(subtypes).toEqual(['Widget']);
    expect(doc.Form.Fields.map((f) => f.FullName)).toEqual(['f1']);
  });

  it('turns a GoTo action into a /Dest and drops every other action', () => {
    const doc = messy();
    const report = doc.Sanitize({ annotations: false, forms: false });
    expect(report.actions).toEqual({
      openAction: true, documentJavaScripts: 1, additionalActions: 3,
      actions: 1, convertedToDestinations: 1,
    });
    const links = doc.Pages[0].Annotations.filter((a) => a.Subtype === 'Link');
    expect(links).toHaveLength(2);
    for (const l of links) expect(l.Dict.has('A')).toBe(false);
    expect(links.filter((l) => isArray(doc.resolve(l.Dict.get('Dest'))))).toHaveLength(1);
    // the field keeps its value; its keystroke script is gone
    const field = doc.Form.Get('f1')!;
    expect(field.Value).toBe('FIELD-VALUE');
    expect(field.Dict.has('AA')).toBe(false);
    expect(doc.catalog().has('AA')).toBe(false);
    expect(doc.Pages[1].Dict.has('AA')).toBe(false);
  });

  it('strips an outline item action, keeping a GoTo as a destination', () => {
    const doc = messy();
    const item = firstOutline(doc);
    const dest = item.get('Dest')!;
    item.delete('Dest');
    item.set('A', new Map<string, PdfObject>([['S', name('GoTo')], ['D', dest],
      ['Next', jsAction('app.alert("NEXT-JS")')]]));
    const report = doc.Sanitize();
    expect(report.actions?.convertedToDestinations).toBe(1);
    expect(item.has('A')).toBe(false);
    expect(item.get('Dest')).toBe(dest);
    expect(latin1(doc.Save())).not.toContain('NEXT-JS');
  });

  it('drops a non-GoTo outline action without inventing a destination', () => {
    const doc = messy();
    const item = firstOutline(doc);
    item.delete('Dest');
    item.set('A', jsAction('app.alert("OUTLINE-JS")'));
    const report = doc.Sanitize();
    expect(report.actions?.actions).toBe(1);
    expect(item.has('A')).toBe(false);
    expect(item.has('Dest')).toBe(false);
  });

  // A merged field/widget dict is reached through /Annots; a NON-terminal
  // field node is not, and only the field-tree walk sees its /AA.
  it('removes /AA from a non-terminal field node', () => {
    const doc = messy();
    doc.Pages[0].AddTextField({ rect: [100, 400, 300, 430], name: 'grp.child' });
    const grp = doc.Form.Fields.find((f) => f.FullName === 'grp.child')!;
    const parent = doc.resolve(grp.Dict.get('Parent'));
    if (!isDict(parent)) throw new Error('no parent node');
    parent.set('AA', aa('app.alert("PARENT-AA")'));
    doc.Sanitize({ forms: false });
    expect(parent.has('AA')).toBe(false);
    expect(latin1(doc.Save())).not.toContain('PARENT-AA');
  });

  it('takes a file attachment annotation\'s popup with it', () => {
    const doc = messy();
    const page = doc.Pages[0];
    const fa = page.Annotations.find((a) => a.Subtype === 'FileAttachment')!.Dict;
    const popup = doc.allocObject(new Map<string, PdfObject>([
      ['Type', name('Annot')], ['Subtype', name('Popup')], ['Rect', [0, 0, 1, 1]],
      ['Parent', annotRef(doc, fa)],
    ]));
    fa.set('Popup', popup);
    (doc.resolve(page.Dict.get('Annots')) as PdfObject[]).push(popup);
    // annotations kept: the popup's parent is a file attachment, so only the
    // attachments sweep may take it — and it must
    doc.Sanitize({ annotations: false });
    expect(page.Annotations.map((a) => a.Subtype)).not.toContain('Popup');
    expect(page.Annotations.map((a) => a.Subtype)).not.toContain('FileAttachment');
  });

  it('keeps a popup whose parent is kept', () => {
    const doc = messy();
    const page = doc.Pages[0];
    const fa = page.Annotations.find((a) => a.Subtype === 'FileAttachment')!.Dict;
    const popup = doc.allocObject(new Map<string, PdfObject>([
      ['Type', name('Annot')], ['Subtype', name('Popup')], ['Rect', [0, 0, 1, 1]],
      ['Parent', annotRef(doc, fa)],
    ]));
    fa.set('Popup', popup);
    (doc.resolve(page.Dict.get('Annots')) as PdfObject[]).push(popup);
    doc.Sanitize({ attachments: false, forms: false });
    expect(page.Annotations.map((a) => a.Subtype).sort()).toEqual(['FileAttachment', 'Popup', 'Widget']);
  });

  it('removes object-level XMP as well as the catalog packet', () => {
    const doc = messy();
    const xmp = doc.allocObject({ kind: 'stream', dict: new Map<string, PdfObject>([['Type', name('Metadata')]]),
      raw: new TextEncoder().encode('PAGE-XMP') } as PdfObject);
    doc.Pages[0].Dict.set('Metadata', xmp);
    const report = doc.Sanitize();
    expect(report.metadata).toEqual({ info: true, xmp: 2 });
    expect(doc.Pages[0].Dict.has('Metadata')).toBe(false);
    expect(latin1(doc.Save())).not.toContain('PAGE-XMP');
  });

  it('removes a catalog /AF file the name tree does not list', () => {
    const doc = messy();
    const ef = doc.allocObject({ kind: 'stream', dict: new Map<string, PdfObject>(),
      raw: new TextEncoder().encode('AF-ONLY-FILE') } as PdfObject);
    const fs = doc.allocObject(new Map<string, PdfObject>([
      ['Type', name('Filespec')], ['EF', new Map<string, PdfObject>([['F', ef]])],
    ]));
    const af = doc.resolve(doc.catalog().get('AF'));
    if (isArray(af)) af.push(fs); else doc.catalog().set('AF', [fs]);
    expect(doc.Sanitize().attachments?.embeddedFiles).toBe(2);
    expect(doc.catalog().has('AF')).toBe(false);
    expect(latin1(doc.Save())).not.toContain('AF-ONLY-FILE');
  });

  it('removes a portfolio /Collection with the attachments', () => {
    const doc = messy();
    doc.SetCollection({ fields: [] });
    expect(doc.Sanitize().attachments?.collection).toBe(true);
    expect(doc.catalog().has('Collection')).toBe(false);
  });

  it('flattens layers, deleting hidden content', () => {
    const doc = Document.Open(buildOcgRenderPdf('/OC /OCHid BDC 1 0 0 rg 0 0 50 50 re f EMC\n'));
    const report = doc.Sanitize();
    expect(report.layers?.hiddenSections).toBe(1);
    expect(doc.catalog().has('OCProperties')).toBe(false);
  });

  it('refuses a signed document before changing anything', () => {
    const doc = messy();
    doc.Pages[0].AddSignatureField({ rect: [0, 0, 10, 10], name: 'sig' });
    const before = doc.Save();
    expect(() => doc.Sanitize()).toThrow(UnsupportedFeatureError);
    // FlattenLayers refuses a signed document on its own, so with layers left
    // ON this case cannot see Sanitize's own check — this one can.
    expect(() => doc.Sanitize({ layers: false })).toThrow(UnsupportedFeatureError);
    expect(doc.Save()).toEqual(before);
  });

  it('rejects an unknown or non-boolean option before changing anything', () => {
    const doc = messy();
    const before = doc.Save();
    expect(() => doc.Sanitize({ metaData: false } as never)).toThrow(TypeError);
    expect(() => doc.Sanitize({ forms: 'no' } as never)).toThrow(TypeError);
    expect(() => doc.Sanitize(null as never)).toThrow(TypeError);
    expect(doc.Save()).toEqual(before);
  });

  it('a clean document reports nothing and is not marked modified', () => {
    const doc = Document.Open(Document.New().Save());
    const report = doc.Sanitize();
    expect(report.metadata).toEqual({ info: false, xmp: 0 });
    expect(report.annotations).toEqual({ removed: 0 });
    expect(report.forms).toEqual({ widgets: 0 });
    expect(report.actions).toEqual({
      openAction: false, documentJavaScripts: 0, additionalActions: 0,
      actions: 0, convertedToDestinations: 0,
    });
    expect(report.attachments).toEqual({ embeddedFiles: 0, fileAttachmentAnnotations: 0, collection: false });
    expect(report.privateData).toEqual({ pieceInfo: 0, thumbnails: 0, webCapture: 0, permissions: false, searchIndex: false });
    expect((doc as unknown as { modified: boolean }).modified).toBe(false);
  });
});

const stream = (doc: Document, text: string, dict: Array<[string, PdfObject]> = []): PdfObject =>
  doc.allocObject({ kind: 'stream', dict: new Map<string, PdfObject>(dict),
    raw: new TextEncoder().encode(text) } as PdfObject);
const pieceInfo = (marker: string): PdfDict => new Map<string, PdfObject>([
  ['MyApp', new Map<string, PdfObject>([['Private', str(marker)], ['LastModified', str('D:2026')]])],
]);

describe('Sanitize privateData (74mf.2)', () => {
  /** A document carrying every private/auxiliary key, each with a marker. */
  function privy(): Document {
    const doc = messy();
    const cat = doc.catalog();
    const [p1, p2] = doc.Pages;
    cat.set('PieceInfo', pieceInfo('CAT-PIECE'));
    cat.set('LastModified', str('D:2026'));
    p1.Dict.set('PieceInfo', pieceInfo('PAGE-PIECE'));
    p1.Dict.set('LastModified', str('D:2026'));
    // a form XObject's own page-piece data, reached only through /Resources
    const form = stream(doc, '0 0 m', [['Type', name('XObject')], ['Subtype', name('Form')],
      ['BBox', [0, 0, 1, 1]], ['PieceInfo', pieceInfo('FORM-PIECE')]]);
    p2.Dict.set('Resources', new Map<string, PdfObject>([
      ['XObject', new Map<string, PdfObject>([['Fm0', form]])]]));
    p1.Dict.set('Thumb', stream(doc, 'THUMB-PIXELS', [['Width', 1], ['Height', 1],
      ['ColorSpace', name('DeviceGray')], ['BitsPerComponent', 8]]));
    p2.Dict.set('Thumb', stream(doc, 'THUMB-TWO', [['Width', 1], ['Height', 1],
      ['ColorSpace', name('DeviceGray')], ['BitsPerComponent', 8]]));
    cat.set('SpiderInfo', new Map<string, PdfObject>([['V', 1.0], ['C', str('SPIDER-CMD')]]));
    p1.Dict.set('ID', str('WEB-CAPTURE-ID'));
    cat.set('Perms', new Map<string, PdfObject>([['UR3', new Map<string, PdfObject>([
      ['Type', name('Sig')], ['Filter', name('Adobe.PPKLite')], ['Name', str('USAGE-RIGHTS')]])]]));
    return doc;
  }

  it('removes page-piece data, thumbnails, web capture and permissions', () => {
    const doc = privy();
    const report = doc.Sanitize();
    expect(report.privateData).toEqual({ pieceInfo: 3, thumbnails: 2, webCapture: 2, permissions: true, searchIndex: false });
    const cat = doc.catalog();
    for (const k of ['PieceInfo', 'LastModified', 'SpiderInfo', 'Perms']) expect(cat.has(k), k).toBe(false);
    for (const p of doc.Pages)
      for (const k of ['PieceInfo', 'LastModified', 'Thumb', 'ID']) expect(p.Dict.has(k), k).toBe(false);
    const bytes = latin1(doc.Save());
    for (const leak of ['CAT-PIECE', 'PAGE-PIECE', 'FORM-PIECE', 'THUMB-PIXELS', 'THUMB-TWO',
      'SPIDER-CMD', 'WEB-CAPTURE-ID', 'USAGE-RIGHTS']) {
      expect(bytes, leak).not.toContain(leak);
    }
  });

  it('privateData: false keeps all of it', () => {
    const doc = privy();
    expect(doc.Sanitize({ privateData: false }).privateData).toBeUndefined();
    const cat = doc.catalog();
    for (const k of ['PieceInfo', 'SpiderInfo', 'Perms']) expect(cat.has(k), k).toBe(true);
    expect(doc.Pages[0].Dict.has('Thumb')).toBe(true);
    expect(doc.Pages[0].Dict.has('ID')).toBe(true);
  });

  // /LastModified is the freshness stamp FOR /PieceInfo (14.5); with no
  // page-piece data beside it, it describes nothing a reader could use, but
  // it is not ours to remove either.
  it('leaves /LastModified on a dict that carries no /PieceInfo', () => {
    const doc = messy();
    doc.Pages[0].Dict.set('LastModified', str('D:2026'));
    expect(doc.Sanitize().privateData?.pieceInfo).toBe(0);
    expect(doc.Pages[0].Dict.has('LastModified')).toBe(true);
  });
});

// Acrobat's embedded search index (`74mf.5`). The shape is read off Acrobat
// DC 26.1's Search.api plug-in, whose CEmbedIndex code names, in order,
// PieceInfo, SearchIndex, IsFreshIndex, ModID, PDXFile (a FlateDecode stream
// opening %PDX-3.2), IndexFile and Index1File (.idx data). No Acrobat-indexed
// FILE was available — this install runs in Reader mode and refused IAC — so
// the dictionary below is that inference, not a vendored real one.
describe('Sanitize: Acrobat embedded search index (74mf.5)', () => {
  const indexed = (): Document => {
    const doc = messy();
    const idx = (text: string): PdfObject => doc.allocObject({ kind: 'stream',
      dict: new Map<string, PdfObject>(), raw: new TextEncoder().encode(text) } as PdfObject);
    doc.catalog().set('PieceInfo', new Map<string, PdfObject>([
      ['SearchIndex', new Map<string, PdfObject>([
        ['LastModified', str('D:20261005')],
        ['Private', new Map<string, PdfObject>([
          ['IsFreshIndex', true], ['ModID', str('MODID')],
          ['PDXFile', idx('%PDX-3.2 INDEX-CATALOG')],
          ['IndexFile', idx('INDEX-WORDS-0')], ['Index1File', idx('INDEX-WORDS-1')],
        ])],
      ])],
    ]));
    return doc;
  };

  it('removes the index and reports it', () => {
    const doc = indexed();
    expect(latin1(doc.Save())).toContain('INDEX-WORDS-0');
    const report = doc.Sanitize();
    expect(report.privateData?.searchIndex).toBe(true);
    expect(doc.catalog().has('PieceInfo')).toBe(false);
    const bytes = latin1(doc.Save());
    for (const leak of ['%PDX-3.2', 'INDEX-CATALOG', 'INDEX-WORDS-0', 'INDEX-WORDS-1'])
      expect(bytes, leak).not.toContain(leak);
  });

  it('reports no index where /PieceInfo holds only other applications\' data', () => {
    const doc = messy();
    doc.catalog().set('PieceInfo', new Map<string, PdfObject>([['Illustrator', new Map()]]));
    expect(doc.Sanitize().privateData).toMatchObject({ pieceInfo: 1, searchIndex: false });
  });

  it('privateData: false keeps the index', () => {
    const doc = indexed();
    doc.Sanitize({ privateData: false });
    expect(latin1(doc.Save())).toContain('INDEX-WORDS-0');
  });
});
