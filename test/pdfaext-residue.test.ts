import { describe, it, expect } from 'vitest';
import { parseRdfPacket, RDF_NS } from '../src/xmprdf.js';
import { addMissingDescriptions } from '../src/pdfaextfix.js';
import { extensionSchemaIssues, PDFA_SCHEMA_NS, childOf, textOf, extensionContainer } from '../src/pdfaext.js';
import { writeXmpPacket } from '../src/xmp.js';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';

// o6uu.11: residue from the o6uu.6 review.

const enc = (s: string) => new TextEncoder().encode(s);
const ACME = 'http://acme.example/ns/1.0/';
const NS = `xmlns:acme="${ACME}" xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/"`
  + ' xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#"'
  + ' xmlns:pdfaType="http://www.aiim.org/pdfa/ns/type#"';
const text = (inner: string, ns = NS) => `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}">`
  + `<rdf:Description rdf:about="" ${ns}>${inner}</rdf:Description></rdf:RDF></x:xmpmeta>`;
const pkt = (inner: string, ns = NS) => parseRdfPacket(enc(text(inner, ns)));
const prop = (n: string, vt: string, cat = 'external') => '<rdf:li rdf:parseType="Resource">'
  + `<pdfaProperty:name>${n}</pdfaProperty:name><pdfaProperty:valueType>${vt}</pdfaProperty:valueType>`
  + `<pdfaProperty:category>${cat}</pdfaProperty:category><pdfaProperty:description>d</pdfaProperty:description></rdf:li>`;
const vtype = (t: string) => '<rdf:li rdf:parseType="Resource">'
  + `<pdfaType:type>${t}</pdfaType:type><pdfaType:namespaceURI>http://acme.example/t#</pdfaType:namespaceURI>`
  + '<pdfaType:prefix>t</pdfaType:prefix><pdfaType:description>d</pdfaType:description></rdf:li>';
const schema = (props: string, vts = '', propForm = 'Seq') => '<rdf:li rdf:parseType="Resource">'
  + `<pdfaSchema:schema>S</pdfaSchema:schema><pdfaSchema:namespaceURI>${ACME}</pdfaSchema:namespaceURI>`
  + `<pdfaSchema:prefix>acme</pdfaSchema:prefix><pdfaSchema:property><rdf:${propForm}>${props}</rdf:${propForm}></pdfaSchema:property>`
  + (vts ? `<pdfaSchema:valueType><rdf:Seq>${vts}</rdf:Seq></pdfaSchema:valueType>` : '') + '</rdf:li>';
const ext = (schemas: string) => `<pdfaExtension:schemas><rdf:Bag>${schemas}</rdf:Bag></pdfaExtension:schemas>`;
const rules = (issues: { rule: string }[]) => issues.map((i) => i.rule);

describe('an object packet inherits the catalog packet\'s value types at parts 2-3', () => {
  const main = pkt(ext(schema(prop('Code', 'Point'), vtype('Point'))));
  const obj = pkt(`<acme:Code>x</acme:Code>${ext(schema(prop('Code', 'Point')))}`);
  const run = (part: 1 | 2) => rules(extensionSchemaIssues([{ packet: main, main: true }, { packet: obj, main: false }], part));

  it('does not report a type the catalog packet declares for that namespace', () => {
    expect(run(2)).not.toContain('XmpExtensionValueType');
  });
  it('still reports it at part 1, where the catalog packet is not consulted', () => {
    expect(run(1)).toContain('XmpExtensionValueType');
  });
  it('still reports a type declared for a DIFFERENT namespace', () => {
    const other = pkt(ext(schema(prop('Code', 'Point'), vtype('Point')).replace(ACME, 'http://other.example/')));
    expect(rules(extensionSchemaIssues([{ packet: other, main: true }, { packet: obj, main: false }], 2)))
      .toContain('XmpExtensionValueType');
  });
});

describe('a bad category', () => {
  it('is reported as XmpExtensionField, not XmpExtensionValueType', () => {
    const issues = extensionSchemaIssues([{ packet: pkt(`<acme:A>x</acme:A>${ext(schema(prop('A', 'Text', 'weird')))}`), main: true }], 2);
    expect(issues.filter((i) => /category/.test(i.message)).map((i) => i.rule)).toEqual(['XmpExtensionField']);
  });
});

describe('addMissingDescriptions', () => {
  it('turns an existing entry\'s Bag property list into a Seq when it extends it', () => {
    const p = pkt(`<acme:A>x</acme:A><acme:B>y</acme:B>${ext(schema(prop('A', 'Text'), '', 'Bag'))}`);
    const r = addMissingDescriptions(p, 2);
    expect(r.added).toEqual(['acme:B']);
    const back = parseRdfPacket(enc(writeXmpPacket(p)));
    expect(extensionSchemaIssues([{ packet: back, main: true }], 2)).toEqual([]);
  });

  it('keeps a description\'s pdfaSchema:prefix equal to its namespace\'s written prefix', () => {
    // A foreign namespace squatting on a PDF/A prefix is re-bound by pinning.
    const FOREIGN = 'http://foreign.example/';
    const p = pkt('<pdfaType:Batch>B1</pdfaType:Batch>', `xmlns:pdfaType="${FOREIGN}"`);
    expect(addMissingDescriptions(p, 2).added).toEqual(['pdfaType:Batch']);
    const back = parseRdfPacket(enc(writeXmpPacket(p)));
    const c = extensionContainer(back)!;
    const entry = c.value.kind === 'array' ? c.value.items[0].value : undefined;
    const written = textOf(childOf(entry!, PDFA_SCHEMA_NS, 'prefix'));
    expect(back.prefixes.get(FOREIGN)).toBeDefined();
    expect(written).toBe(back.prefixes.get(FOREIGN));
    expect(written).not.toBe('pdfaType');
    expect(extensionSchemaIssues([{ packet: back, main: true }], 2)).toEqual([]);
  });
});

describe('ConvertToPdfX after ConvertToPdfA', () => {
  it('describes pdfxid, so the document stays PDF/A 1-3', () => {
    const d = Document.New();
    d.AddPage(PageFormat.A4);
    d.ConvertToPdfA('2b');
    d.ConvertToPdfX('4');
    expect(rules(d.ValidatePdfA('2b').Issues)).not.toContain('XmpPropertyNotDescribed');
  });

  it('writes no extension schema for a document that does not claim PDF/A', () => {
    const d = Document.New();
    d.AddPage(PageFormat.A4);
    d.ConvertToPdfX('4');
    expect(d.GetXmpValue('http://www.aiim.org/pdfa/ns/extension/', 'schemas')).toBeUndefined();
  });
});
