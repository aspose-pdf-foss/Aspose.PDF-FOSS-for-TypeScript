import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import { isDict, name, PdfDict, PdfObject } from '../src/types.js';
import { encodeAction, parseAction, parseStandaloneAction, type PdfAction } from '../src/actions.js';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { enc } from '../src/serialize.js';
import { encodePdfText } from '../src/metadata.js';

const blank = () => Document.Open(buildBlankPage());
const nameOf = (o: unknown) => (o as { name: string }).name;
const str = (o: unknown) => new TextDecoder('latin1').decode((o as { bytes: Uint8Array }).bytes);
/** Wrap an action dict in a throwaway annotation, which is what parseAction reads. */
const annotWith = (a: PdfDict): PdfDict => new Map<string, PdfObject>([['A', a]]);

describe('encodeAction', () => {
  it('encodes a URI action', () => {
    const d = encodeAction(blank(), { type: 'uri', uri: 'https://example.com' });
    expect(nameOf(d.get('S'))).toBe('URI');
    expect(str(d.get('URI'))).toBe('https://example.com');
  });

  it('encodes a GoTo action with a destination array', () => {
    const doc = blank();
    const d = encodeAction(doc, { type: 'goto', page: 1 });
    expect(nameOf(d.get('S'))).toBe('GoTo');
    expect(Array.isArray(d.get('D'))).toBe(true);
  });

  it('encodes SubmitForm with a URL filespec and no flags by default', () => {
    const d = encodeAction(blank(), { type: 'submit', url: 'https://example.com/post' });
    expect(nameOf(d.get('S'))).toBe('SubmitForm');
    const fs = d.get('F') as PdfDict;
    expect(isDict(fs)).toBe(true);
    expect(nameOf(fs.get('FS'))).toBe('URL');
    expect(str(fs.get('F'))).toBe('https://example.com/post');
    expect(d.has('Flags')).toBe(false);
    expect(d.has('Fields')).toBe(false);
  });

  it('maps each submit format to its specification flag bit', () => {
    const doc = blank();
    const flagsFor = (format: 'fdf' | 'html' | 'xfdf' | 'pdf') =>
      encodeAction(doc, { type: 'submit', url: 'u', format }).get('Flags');
    expect(flagsFor('fdf')).toBeUndefined();   // no bit set
    expect(flagsFor('html')).toBe(4);          // bit 3, ExportFormat
    expect(flagsFor('xfdf')).toBe(32);         // bit 6, XFDF
    expect(flagsFor('pdf')).toBe(256);         // bit 9, SubmitPDF
  });

  it('sets IncludeExclude and writes the field-name list', () => {
    const d = encodeAction(blank(), {
      type: 'submit', url: 'u', fields: ['a', 'b'], exclude: true,
    });
    expect(d.get('Flags')).toBe(1);            // bit 1
    expect((d.get('Fields') as unknown[]).map(str)).toEqual(['a', 'b']);
  });

  it('encodes ResetForm', () => {
    const bare = encodeAction(blank(), { type: 'reset' });
    expect(nameOf(bare.get('S'))).toBe('ResetForm');
    expect(bare.has('Flags')).toBe(false);
    const scoped = encodeAction(blank(), { type: 'reset', fields: ['a'], exclude: true });
    expect(scoped.get('Flags')).toBe(1);
    expect((scoped.get('Fields') as unknown[]).map(str)).toEqual(['a']);
  });

  it('encodes JavaScript', () => {
    const d = encodeAction(blank(), { type: 'javascript', script: 'app.alert(1)' });
    expect(nameOf(d.get('S'))).toBe('JavaScript');
    expect(str(d.get('JS'))).toBe('app.alert(1)');
  });

  it('rejects malformed actions', () => {
    const doc = blank();
    expect(() => encodeAction(doc, { type: 'uri', uri: '' })).toThrow(TypeError);
    expect(() => encodeAction(doc, { type: 'submit', url: '' })).toThrow(TypeError);
    expect(() => encodeAction(doc, { type: 'javascript', script: '' })).toThrow(TypeError);
    expect(() => encodeAction(doc, { type: 'goto', page: 9 })).toThrow(RangeError);
    expect(() => encodeAction(doc, { type: 'goto', page: 0 })).toThrow(RangeError);
    expect(() => encodeAction(doc, {
      type: 'submit', url: 'u', fields: [1] as never,
    })).toThrow(TypeError);
    expect(() => encodeAction(doc, { type: 'nope' } as never)).toThrow(TypeError);
  });
});

describe('parseAction', () => {
  const roundTrip = (doc: Document, a: PdfAction) =>
    parseAction(doc, annotWith(encodeAction(doc, a)));

  it('round-trips every action type', () => {
    const doc = blank();
    expect(roundTrip(doc, { type: 'uri', uri: 'https://x' }))
      .toEqual({ type: 'uri', uri: 'https://x' });
    expect(roundTrip(doc, { type: 'javascript', script: 's' }))
      .toEqual({ type: 'javascript', script: 's' });
    expect(roundTrip(doc, { type: 'reset' })).toEqual({ type: 'reset' });
    expect(roundTrip(doc, { type: 'reset', fields: ['a'], exclude: true }))
      .toEqual({ type: 'reset', fields: ['a'], exclude: true });
    expect(roundTrip(doc, { type: 'submit', url: 'u', format: 'xfdf' }))
      .toEqual({ type: 'submit', url: 'u', format: 'xfdf' });
    expect(roundTrip(doc, { type: 'submit', url: 'u', fields: ['a'], exclude: true }))
      .toEqual({ type: 'submit', url: 'u', fields: ['a'], exclude: true, format: 'fdf' });
  });

  it('reports fdf when no format bit is set', () => {
    const doc = blank();
    expect(roundTrip(doc, { type: 'submit', url: 'u' }))
      .toEqual({ type: 'submit', url: 'u', format: 'fdf' });
  });

  it('accepts a bare string /F, which some producers write', () => {
    const doc = blank();
    const a: PdfDict = new Map<string, PdfObject>([
      ['S', { kind: 'name', name: 'SubmitForm' } as PdfObject],
      ['F', { kind: 'string', bytes: new TextEncoder().encode('https://bare') }],
    ]);
    expect(parseAction(doc, annotWith(a))).toEqual({
      type: 'submit', url: 'https://bare', format: 'fdf',
    });
  });

  it('returns undefined with no /A, a non-dict /A, or an unmodelled /S', () => {
    const doc = blank();
    expect(parseAction(doc, new Map())).toBeUndefined();
    const named: PdfDict = new Map<string, PdfObject>([
      ['S', { kind: 'name', name: 'Named' } as PdfObject],
    ]);
    expect(parseAction(doc, annotWith(named))).toBeUndefined();
  });
});

describe('LinkAnnotation over the shared action model', () => {
  it('still round-trips a URI link', () => {
    const doc = Document.Open(buildClassicPdf(1));
    const link = doc.Pages[0].AddLink({
      rect: [10, 10, 100, 30], action: { type: 'uri', uri: 'https://example.com' },
    });
    expect(link.Action).toEqual({ type: 'uri', uri: 'https://example.com' });
  });

  it('still round-trips a GoTo link', () => {
    const doc = Document.Open(buildClassicPdf(2));
    const link = doc.Pages[0].AddLink({
      rect: [10, 10, 100, 30], action: { type: 'goto', page: 2 },
    });
    expect(link.Action?.type).toBe('goto');
    expect((link.Action as { page: number }).page).toBe(2);
  });

  it('now parses a submit action that previously read back as undefined', () => {
    const doc = Document.Open(buildClassicPdf(1));
    const link = doc.Pages[0].AddLink({
      rect: [10, 10, 100, 30],
      action: { type: 'submit', url: 'https://example.com/post', format: 'html' },
    });
    expect(link.Action).toEqual({
      type: 'submit', url: 'https://example.com/post', format: 'html',
    });
  });

  it('keeps rejecting a malformed link action', () => {
    const doc = Document.Open(buildClassicPdf(1));
    expect(() => doc.Pages[0].AddLink({
      rect: [10, 10, 100, 30], action: { type: 'goto', page: 99 },
    })).toThrow(RangeError);
    expect(() => doc.Pages[0].AddLink({
      rect: [10, 10, 100, 30], action: { type: 'bogus' } as never,
    })).toThrow(TypeError);
  });
});

describe('JavaScript action /JS as a stream', () => {
  it('reads a stream /JS, not just a string', () => {
    // 32000-1 table 217: /JS is a text string OR a text stream, and a large
    // script is commonly the stream form. Before this, isString was the only
    // branch, so the WHOLE action read back as undefined — not merely its
    // script.
    const doc = Document.New();
    const js = doc.allocObject({
      kind: 'stream', dict: new Map(), raw: enc('app.alert("hi");'),
    });
    const action = new Map<string, PdfObject>([['S', name('JavaScript')], ['JS', js]]);
    expect(parseStandaloneAction(doc, action))
      .toEqual({ type: 'javascript', script: 'app.alert("hi");' });
  });

  it('still reads a string /JS', () => {
    const doc = Document.New();
    const action = new Map<string, PdfObject>([
      ['S', name('JavaScript')],
      ['JS', { kind: 'string', bytes: encodePdfText('x = 1;') }],
    ]);
    expect(parseStandaloneAction(doc, action))
      .toEqual({ type: 'javascript', script: 'x = 1;' });
  });

  it('returns undefined for a /JS that is neither', () => {
    const doc = Document.New();
    const action = new Map<string, PdfObject>([['S', name('JavaScript')], ['JS', 42]]);
    expect(parseStandaloneAction(doc, action)).toBeUndefined();
  });
});
