// What Sanitize removed must be absent from the SAVED BYTES, not only from the
// live model (`74mf.4`). The live model is the wrong witness: a removed key can
// survive in a stream nobody re-encoded, in an earlier revision the file still
// carries, or in an object `Save` kept reachable by a route the sweep did not
// clear — and none of that is visible through `doc.catalog()`.
//
// The search is only worth something if it can FIND a leak, and a raw byte
// search cannot see inside a compressed stream: an embedded file is deflated,
// so `bytes.includes('EMBEDDED-SECRET')` is false whether or not the file
// leaked. `leaksIn` therefore searches four renderings of the file, and every
// case pairs its absence check with a POSITIVE CONTROL — the same search over
// the unsanitized document must find every marker, so a search that cannot see
// a marker fails loudly instead of passing quietly.
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { decodeStream } from '../src/filters.js';
import { serializeObject } from '../src/serialize.js';
import { appendContent, ensureOwnResources, ensureOwnSubdict } from '../src/pagecontent.js';
import { isDict, isStream, name, type PdfDict, type PdfObject } from '../src/types.js';

const enc = (t: string) => new TextEncoder().encode(t);
const str = (t: string): PdfObject => ({ kind: 'string', bytes: enc(t) });
const latin1 = (b: Uint8Array) => new TextDecoder('latin1').decode(b);
const js = (marker: string): PdfDict => new Map<string, PdfObject>([
  ['S', name('JavaScript')], ['JS', str(`app.alert("${marker}")`)],
]);
const utf16be = (t: string) => [...t].map((c) => `\0${c}`).join('');
const hex = (t: string) => [...enc(t)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Every marker found anywhere in `bytes`: in the raw file (as written, as a
 *  hex string in either case, and as UTF-16BE text), in every object
 *  re-serialized after parsing, and in every stream's DECODED payload. */
function leaksIn(bytes: Uint8Array, markers: readonly string[]): string[] {
  const haystacks = [latin1(bytes)];
  const doc = Document.Open(bytes);
  for (const [, obj] of doc.objectEntries()) {
    if (isStream(obj)) {
      haystacks.push(latin1(serializeObject(obj.dict)));
      try { haystacks.push(latin1(decodeStream(obj))); } catch { /* undecodable: raw already searched */ }
    } else {
      haystacks.push(latin1(serializeObject(obj)));
    }
  }
  const all = haystacks.join('\n');
  const lower = all.toLowerCase();
  return markers.filter((m) => all.includes(m) || all.includes(utf16be(m)) || lower.includes(hex(m)));
}

/** Markers planted by {@link loaded}, by the category that must remove them. */
const MARKERS = {
  metadata: ['INFO-TITLE', 'INFO-AUTHOR', 'XMP-ONLY', 'PAGE-XMP'],
  actions: ['DOC-JS', 'OPEN-JS', 'CATALOG-AA', 'PAGE-AA', 'FIELD-KEYSTROKE', 'OUTLINE-JS',
    'evil.example'],
  attachments: ['TREE-FILE-BYTES', 'ANNOT-FILE-BYTES'],
  annotations: ['NOTE-CONTENTS', 'NOTE-AUTHOR'],
  layers: ['HIDDEN-LAYER-TEXT'],
  privateData: ['PIECE-INFO', 'THUMB-PIXELS', 'SPIDER-CMD', 'WEB-CAPTURE-ID', 'USAGE-RIGHTS'],
} as const;
const DEFAULT_MARKERS = Object.values(MARKERS).flat();

/** A document carrying a marker in every place a default Sanitize clears. */
function loaded(): Document {
  const doc = Document.New();
  doc.AddPage(PageFormat.A4);
  doc.AddPage(PageFormat.A4);
  const [p1, p2] = doc.Pages;
  const cat = doc.catalog();

  doc.SetMetadata({ title: 'INFO-TITLE', author: 'INFO-AUTHOR' });
  doc.SetXmp({ custom: [{ prefix: 'leak', namespace: 'http://example.com/leak/', name: 'Note', value: 'XMP-ONLY' }] });
  p2.Dict.set('Metadata', doc.allocObject({ kind: 'stream',
    dict: new Map<string, PdfObject>([['Type', name('Metadata')], ['Subtype', name('XML')]]),
    raw: enc('<x>PAGE-XMP</x>') }));

  doc.SetJavaScript('init', 'app.alert("DOC-JS")');
  doc.SetOpenAction({ type: 'javascript', script: 'app.alert("OPEN-JS")' });
  cat.set('AA', new Map<string, PdfObject>([['WC', js('CATALOG-AA')]]));
  p2.Dict.set('AA', new Map<string, PdfObject>([['O', js('PAGE-AA')]]));
  p1.AddTextField({ rect: [100, 300, 300, 330], name: 'f1',
    actions: { keystroke: { type: 'javascript', script: '//FIELD-KEYSTROKE' } } });
  p1.AddLink({ rect: [100, 130, 200, 150], action: { type: 'uri', uri: 'https://evil.example/' } });
  doc.SetOutlines([{ Title: 'Chapter', Dest: { page: 2 } }]);
  const outline = doc.resolve(doc.resolve(cat.get('Outlines')) instanceof Map
    ? (doc.resolve(cat.get('Outlines')) as PdfDict).get('First') : undefined) as PdfDict;
  outline.set('A', js('OUTLINE-JS'));

  doc.AddAttachment('tree.txt', enc('TREE-FILE-BYTES'));
  p1.AddFileAttachment({ rect: [10, 10, 30, 30], name: 'annot.txt', bytes: enc('ANNOT-FILE-BYTES') });

  const note = p1.AddTextNote({ rect: [50, 50, 70, 70], contents: 'NOTE-CONTENTS' });
  note.Dict.set('T', str('NOTE-AUTHOR'));

  // Ink in a layer the default configuration hides: page content, not a key.
  const hidden = doc.OptionalContent.AddLayer('Hidden', { visible: false });
  const res = ensureOwnResources(doc, p1);
  ensureOwnSubdict(doc, res, 'Properties').set('HidOC', hidden.Ref);
  ensureOwnSubdict(doc, res, 'Font').set('HidF', doc.allocObject(new Map<string, PdfObject>([
    ['Type', name('Font')], ['Subtype', name('Type1')], ['BaseFont', name('Helvetica')],
  ])));
  appendContent(doc, p1, enc('/OC /HidOC BDC BT /HidF 12 Tf 72 500 Td (HIDDEN-LAYER-TEXT) Tj ET EMC\n'));

  cat.set('PieceInfo', new Map<string, PdfObject>([['App', new Map<string, PdfObject>([
    ['Private', str('PIECE-INFO')], ['LastModified', str('D:2026')]])]]));
  p1.Dict.set('Thumb', doc.allocObject({ kind: 'stream', dict: new Map<string, PdfObject>([
    ['Width', 1], ['Height', 1], ['ColorSpace', name('DeviceGray')], ['BitsPerComponent', 8]]),
    raw: enc('THUMB-PIXELS') }));
  cat.set('SpiderInfo', new Map<string, PdfObject>([['V', 1], ['C', str('SPIDER-CMD')]]));
  p2.Dict.set('ID', str('WEB-CAPTURE-ID'));
  cat.set('Perms', new Map<string, PdfObject>([['UR3', new Map<string, PdfObject>([
    ['Type', name('Sig')], ['Name', str('USAGE-RIGHTS')]])]]));
  return doc;
}

/** `loaded()` saved, reopened, with a second revision appended on top — so the
 *  file carries a history whose FIRST revision names `OLD-REVISION-TITLE`. */
function withHistory(): Uint8Array {
  const doc = loaded();
  doc.SetMetadata({ subject: 'OLD-REVISION-SUBJECT' });
  const reopened = Document.Open(doc.Save());
  reopened.SetMetadata({ subject: 'current subject' });
  return reopened.Save({ incremental: true });
}

describe('Sanitize: removed data is absent from the saved bytes (74mf.4)', () => {
  it('the search sees every marker in an unsanitized file, compressed or not', () => {
    const doc = loaded();
    expect(leaksIn(doc.Save(), DEFAULT_MARKERS)).toEqual(DEFAULT_MARKERS);
    expect(leaksIn(doc.Save({ compressed: true }), DEFAULT_MARKERS)).toEqual(DEFAULT_MARKERS);
  });

  // The control that makes the attachment half mean anything: the payload is
  // deflated, so only the decoded-stream rendering of the file can find it.
  it('finds a deflated payload only through the decoded stream', () => {
    const bytes = loaded().Save();
    expect(latin1(bytes)).not.toContain('TREE-FILE-BYTES');
    expect(leaksIn(bytes, ['TREE-FILE-BYTES'])).toEqual(['TREE-FILE-BYTES']);
  });

  for (const compressed of [false, true]) {
    it(`a default Sanitize leaves none of them (compressed: ${compressed})`, () => {
      const doc = loaded();
      doc.Sanitize();
      expect(leaksIn(doc.Save({ compressed }), DEFAULT_MARKERS)).toEqual([]);
    });
  }

  // Each category is checked on its own against ITS markers, with every other
  // category kept, so one category's removal cannot cover for another's.
  for (const [category, markers] of Object.entries(MARKERS)) {
    it(`${category} alone removes its own markers`, () => {
      const keep = Object.fromEntries(Object.keys(MARKERS).map((k) => [k, k === category]));
      // the hidden layer's annotation-free ink and the form's field are the
      // only things two categories could both reach; forms stays off
      const doc = loaded();
      doc.Sanitize({ ...keep, forms: false });
      expect(leaksIn(doc.Save(), markers)).toEqual([]);
    });
  }

  it('an earlier revision of the file is not carried into the saved bytes', () => {
    const history = withHistory();
    expect(leaksIn(history, ['OLD-REVISION-SUBJECT'])).toEqual(['OLD-REVISION-SUBJECT']);
    const doc = Document.Open(history);
    doc.Sanitize();
    expect(leaksIn(doc.Save(), ['OLD-REVISION-SUBJECT', ...DEFAULT_MARKERS])).toEqual([]);
  });

  // An incremental save APPENDS to the bytes the document was opened from, and
  // those bytes still hold everything Sanitize removed.
  it('refuses an incremental save after Sanitize', () => {
    const opened = () => Document.Open(loaded().Save());
    const control = opened();
    control.SetMetadata({ subject: 'x' });
    expect(() => control.Save({ incremental: true })).not.toThrow();
    const doc = opened();
    doc.Sanitize();
    expect(() => doc.Save({ incremental: true })).toThrow(UnsupportedFeatureError);
    expect(leaksIn(doc.Save(), DEFAULT_MARKERS)).toEqual([]);
  });

  it('pagesToImages also removes hidden page text, fonts and structure', () => {
    const doc = loaded();
    const p1 = doc.Pages[0];
    p1.AddText('WHITE-ON-WHITE', 72, 600, { fontSize: 20, color: [1, 1, 1] });
    doc.AddMarkdown('Tagged paragraph TAGGED-BODY.', { tagged: true });
    const root = doc.resolve(doc.catalog().get('StructTreeRoot'));
    if (!isDict(root)) throw new Error('no structure tree');
    root.set('Alt', str('STRUCT-ALT'));
    const extra = ['WHITE-ON-WHITE', 'TAGGED-BODY', 'STRUCT-ALT'];
    expect(leaksIn(doc.Save(), extra)).toEqual(extra);
    doc.Sanitize({ pagesToImages: true });
    expect(leaksIn(doc.Save(), [...DEFAULT_MARKERS, ...extra])).toEqual([]);
  });
});
