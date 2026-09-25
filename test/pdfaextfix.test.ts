import { describe, it, expect } from 'vitest';
import { parseRdfPacket, RDF_NS } from '../src/xmprdf.js';
import { addMissingDescriptions } from '../src/pdfaextfix.js';
import { extensionSchemaIssues, PDFA_EXTENSION_NS } from '../src/pdfaext.js';
import { writeXmpPacket } from '../src/xmp.js';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';

const enc = (s: string) => new TextEncoder().encode(s);
const text = (inner: string, ns = '') => `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}">`
  + '<rdf:Description rdf:about="" xmlns:acme="http://acme.example/ns/1.0/"'
  + ` xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/" xmlns:pdfxid="http://www.npes.org/pdfx/ns/id/"${ns}>`
  + `${inner}</rdf:Description></rdf:RDF></x:xmpmeta>`;
const pkt = (inner: string, ns = '') => parseRdfPacket(enc(text(inner, ns)));
/** Write, re-read, and validate — what the converter's re-validation sees. */
const after = (inner: string, part: 1 | 2 = 2, ns = '') => {
  const p = pkt(inner, ns);
  const r = addMissingDescriptions(p, part);
  const back = parseRdfPacket(enc(writeXmpPacket(p)));
  return { r, back, issues: extensionSchemaIssues([{ packet: back, main: true }], part) };
};

describe('addMissingDescriptions', () => {
  it('describes a simple value in an unknown namespace as external Text', () => {
    const { r, back, issues } = after('<acme:Batch>B1</acme:Batch>');
    expect(r).toEqual({ added: ['acme:Batch'], left: [] });
    expect(issues).toEqual([]);
    expect(writeXmpPacket(back)).toContain('<pdfaProperty:valueType>Text</pdfaProperty:valueType>');
    expect(writeXmpPacket(back)).toContain('<pdfaProperty:category>external</pdfaProperty:category>');
  });

  it('describes pdfuaid and pdfxid with their real types, category internal', () => {
    const { r, back, issues } = after('<pdfuaid:part>1</pdfuaid:part><pdfxid:GTS_PDFXVersion>PDF/X-4</pdfxid:GTS_PDFXVersion>');
    expect(r.added.sort()).toEqual(['pdfuaid:part', 'pdfxid:GTS_PDFXVersion']);
    expect(issues).toEqual([]);
    const s = writeXmpPacket(back);
    expect(s).toContain('<pdfaSchema:prefix>pdfuaid</pdfaSchema:prefix>');
    expect(s).toMatch(/<pdfaProperty:name>part<\/pdfaProperty:name>\s*<pdfaProperty:valueType>Integer</);
    expect(s).toContain('<pdfaProperty:category>internal</pdfaProperty:category>');
  });

  it('leaves an array, a struct and a URI in an unknown namespace reported', () => {
    const inner = '<acme:List><rdf:Bag><rdf:li>a</rdf:li></rdf:Bag></acme:List>'
      + '<acme:S rdf:parseType="Resource"><acme:x>1</acme:x></acme:S><acme:U rdf:resource="http://x"/>';
    const { r, issues } = after(inner);
    expect(r.added).toEqual([]);
    expect(r.left.sort()).toEqual(['acme:List', 'acme:S', 'acme:U']);
    expect(issues.filter((i) => i.rule === 'XmpPropertyNotDescribed')).toHaveLength(3);
  });

  it('extends an existing entry for the namespace rather than adding a second', () => {
    const existing = '<pdfaExtension:schemas><rdf:Bag><rdf:li rdf:parseType="Resource">'
      + '<pdfaSchema:schema>Acme</pdfaSchema:schema><pdfaSchema:namespaceURI>http://acme.example/ns/1.0/</pdfaSchema:namespaceURI>'
      + '<pdfaSchema:prefix>acme</pdfaSchema:prefix><pdfaSchema:property><rdf:Seq><rdf:li rdf:parseType="Resource">'
      + '<pdfaProperty:name>Other</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType>'
      + '<pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>d</pdfaProperty:description>'
      + '</rdf:li></rdf:Seq></pdfaSchema:property></rdf:li></rdf:Bag></pdfaExtension:schemas>';
    const ns = ' xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#"'
      + ' xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#"';
    const { back, issues } = after(`<acme:Batch>B1</acme:Batch><acme:Other>o</acme:Other>${existing}`, 2, ns);
    expect(issues).toEqual([]);
    const c = back.properties.find((p) => p.ns === PDFA_EXTENSION_NS)!;
    expect(c.value.kind === 'array' && c.value.items.length).toBe(1);
  });

  it('writes the required prefixes even when the source bound the namespaces to others', () => {
    // A pre-existing description under the prefix `ps` fails the prefix test
    // until rewritten; the rewrite pins pdfaSchema and repairs it for free.
    const existing = '<ext:schemas><rdf:Bag><rdf:li rdf:parseType="Resource">'
      + '<ps:schema>Acme</ps:schema><ps:namespaceURI>http://acme.example/ns/1.0/</ps:namespaceURI>'
      + '<ps:prefix>acme</ps:prefix><ps:property><rdf:Seq><rdf:li rdf:parseType="Resource">'
      + '<pp:name>Other</pp:name><pp:valueType>Text</pp:valueType><pp:category>external</pp:category>'
      + '<pp:description>d</pp:description></rdf:li></rdf:Seq></ps:property></rdf:li></rdf:Bag></ext:schemas>';
    const ns = ' xmlns:ext="http://www.aiim.org/pdfa/ns/extension/" xmlns:ps="http://www.aiim.org/pdfa/ns/schema#"'
      + ' xmlns:pp="http://www.aiim.org/pdfa/ns/property#"';
    const before = extensionSchemaIssues([{ packet: pkt(`<acme:Other>o</acme:Other>${existing}`, ns), main: true }], 2);
    expect(before.length).toBeGreaterThan(0);
    const { issues } = after(`<acme:Batch>B1</acme:Batch><acme:Other>o</acme:Other>${existing}`, 2, ns);
    expect(issues).toEqual([]);
  });

  it('adds nothing when the container is not a Bag', () => {
    const seq = '<pdfaExtension:schemas><rdf:Seq/></pdfaExtension:schemas>';
    const ns = ' xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/"';
    const p = pkt(`<acme:Batch>B1</acme:Batch>${seq}`, ns);
    expect(addMissingDescriptions(p, 2)).toEqual({ added: [], left: ['acme:Batch'] });
  });

  it('does nothing to a packet that needs nothing', () => {
    const p = pkt('');
    expect(addMissingDescriptions(p, 2)).toEqual({ added: [], left: [] });
    expect(p.properties).toEqual([]);
  });
});

describe('ConvertToPdfA extensionSchemaPass', () => {
  const custom = { namespace: 'http://acme.example/ns/1.0/', prefix: 'acme', name: 'Batch', value: 'B1' };
  const doc1 = () => { const d = Document.New(); d.AddPage(PageFormat.A4); d.SetXmp({ custom: [custom] }); return d; };
  const schemasOf = (d: Document) => d.GetXmpValue(PDFA_EXTENSION_NS, 'schemas')?.asArray()?.length ?? 0;

  it('describes the custom property at parts 1-3 and reports it in applied', () => {
    for (const level of ['1b', '2b', '3b'] as const) {
      const d = doc1();
      const report = d.ConvertToPdfA(level);
      expect(schemasOf(d)).toBe(1);
      expect(report.applied.map((a) => a.rule)).toContain('XmpPropertyNotDescribed');
    }
  });

  it('does nothing at part 4, or under preserve', () => {
    const d4 = doc1();
    d4.ConvertToPdfA('4');
    expect(schemasOf(d4)).toBe(0);
    const dp = doc1();
    dp.ConvertToPdfA('2b', { preserve: ['extensionSchemas'] });
    expect(schemasOf(dp)).toBe(0);
  });
});
