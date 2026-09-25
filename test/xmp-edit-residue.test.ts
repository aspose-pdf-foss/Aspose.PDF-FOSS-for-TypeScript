import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { LoadLimits } from '../src/loadlimits.js';
import { ResourceLimitError } from '../src/errors.js';
import { name, type PdfDict, type PdfObject } from '../src/types.js';
import { RDF_NS } from '../src/xmprdf.js';
import { encodePdfText } from '../src/metadata.js';

// Residue from the o6uu.3 review (o6uu.7).

const ACME = 'http://acme.example/ns/1.0/';
const OTHER = 'http://other.example/ns/';
const packet = (attrs: string, body: string) => `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}">`
  + `<rdf:Description rdf:about=""${attrs}>${body}</rdf:Description></rdf:RDF></x:xmpmeta>`;
const withXmp = (text: string): Document => {
  const d = Document.New();
  d.AddPage(PageFormat.A4);
  const dict: PdfDict = new Map<string, PdfObject>([['Type', name('Metadata')], ['Subtype', name('XML')]]);
  d.catalog().set('Metadata', d.allocObject({ kind: 'stream', dict, raw: new TextEncoder().encode(text) }));
  return d;
};
/** A packet nested `depth` structs deep — past the default maxNestingDepth. */
const deep = (depth: number) => packet(` xmlns:acme="${ACME}"`,
  '<acme:a rdf:parseType="Resource">'.repeat(depth) + '<acme:v>x</acme:v>' + '</acme:a>'.repeat(depth));

describe('XMP writes honour the document\'s own limits (item 2)', () => {
  it('lets a document opened with looser limits edit a deep packet', () => {
    const src = withXmp(deep(300)).Save();
    const d = Document.Open(src, { limits: LoadLimits.defaults.with({ maxNestingDepth: 2000 }) });
    expect(() => d.SetMetadata({ title: 'T' })).not.toThrow();
    expect(d.GetXmp().title).toBe('T');
  });
});

describe('SetMetadata is all-or-nothing (item 5)', () => {
  it('leaves /Info untouched when the XMP half hits a limit', () => {
    const d = withXmp(deep(300));
    // Seeded directly: SetMetadata itself refuses on this packet, which is the point.
    d.ensureInfo().set('Subject', { kind: 'string', bytes: encodePdfText('before') });
    expect(() => d.SetMetadata({ title: 'after', subject: 'after' })).toThrow(ResourceLimitError);
    const m = d.GetMetadata();
    expect(m.title).toBeUndefined();
    expect(m.subject).toBe('before');
  });
});

describe('a custom property keeps the prefix the caller asked for (item 3)', () => {
  it('wins the prefix from a surviving foreign namespace that held it', () => {
    // The packet binds `acme` to OTHER; the caller asks for `acme` on ACME.
    // The foreign property must SURVIVE the rewrite to keep holding the prefix,
    // so it is a Bag — a literal would be in `custom` and replaced with it.
    const d = withXmp(packet(` xmlns:acme="${OTHER}"`, '<acme:Old><rdf:Bag><rdf:li>o</rdf:li></rdf:Bag></acme:Old>'));
    d.SetXmp({ custom: [{ namespace: ACME, prefix: 'acme', name: 'Batch', value: 'B1' }] });
    const mine = d.GetXmp().custom?.find((c) => c.namespace === ACME);
    expect(mine).toEqual({ namespace: ACME, prefix: 'acme', name: 'Batch', value: 'B1' });
  });
});

describe('attribute-form custom literals are custom from the start (item 4)', () => {
  it('reports a property written as an rdf:Description attribute', () => {
    const d = withXmp(packet(` xmlns:acme="${ACME}" acme:Batch="B1"`, ''));
    expect(d.GetXmp().custom).toEqual([{ namespace: ACME, prefix: 'acme', name: 'Batch', value: 'B1' }]);
  });

  it('reports the same custom set before and after the first rewrite', () => {
    const d = withXmp(packet(` xmlns:acme="${ACME}" acme:Batch="B1"`, '<acme:Lot>L</acme:Lot>'));
    const before = d.GetXmp().custom;
    d.SetXmp({ title: 'T' });
    const after = d.GetXmp().custom;
    const sort = (l: typeof before) => [...(l ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    expect(sort(after)).toEqual(sort(before));
    expect(before).toHaveLength(2);
  });

  it('does not report rdf, xml or namespace-declaration attributes', () => {
    const d = withXmp(packet(` xmlns:acme="${ACME}" xml:lang="en"`, ''));
    expect(d.GetXmp().custom ?? []).toEqual([]);   // readXmp omits an empty custom list
  });
});
