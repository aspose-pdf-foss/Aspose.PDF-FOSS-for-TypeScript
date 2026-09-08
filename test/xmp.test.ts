import { describe, it, expect } from 'vitest';
import { readXmp, buildXmp, mergeXmp } from '../src/xmp.js';
import { Document } from '../src/document.js';
import { buildXmpPdf } from './helpers/build-xmp-pdf.js';
import { buildBlankPage } from './helpers/build-annot-target.js';

const enc = (s: string) => new TextEncoder().encode(s);

const FULL = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Annual &amp; Report</rdf:li></rdf:Alt></dc:title>
   <dc:creator><rdf:Seq><rdf:li>Jane Doe</rdf:li><rdf:li>John Roe</rdf:li></rdf:Seq></dc:creator>
   <dc:description><rdf:Alt><rdf:li>A &lt;summary&gt;</rdf:li></rdf:Alt></dc:description>
   <dc:subject><rdf:Bag><rdf:li>finance</rdf:li><rdf:li>2024</rdf:li></rdf:Bag></dc:subject>
   <dc:rights><rdf:Alt><rdf:li>(c) Aspose</rdf:li></rdf:Alt></dc:rights>
   <pdf:Keywords>finance, 2024</pdf:Keywords>
   <pdf:Producer>Aspose.PDF</pdf:Producer>
   <xmp:CreatorTool>Aspose Authoring</xmp:CreatorTool>
   <xmp:CreateDate>2024-06-03T12:30:45Z</xmp:CreateDate>
   <xmp:ModifyDate>2024-06-04T08:00:00Z</xmp:ModifyDate>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

describe('readXmp', () => {
  it('parses dc / xmp / pdf properties from a full packet', () => {
    const m = readXmp(enc(FULL));
    expect(m.title).toBe('Annual & Report');
    expect(m.authors).toEqual(['Jane Doe', 'John Roe']);     // ordered Seq
    expect(m.description).toBe('A <summary>');
    expect(m.subjects).toEqual(['finance', '2024']);          // Bag
    expect(m.rights).toBe('(c) Aspose');
    expect(m.keywords).toBe('finance, 2024');
    expect(m.producer).toBe('Aspose.PDF');
    expect(m.creatorTool).toBe('Aspose Authoring');
    expect(m.createDate).toBeInstanceOf(Date);
    expect((m.createDate as Date).toISOString()).toBe('2024-06-03T12:30:45.000Z');
    expect(m.modifyDate).toBeInstanceOf(Date);
    expect(m.raw).toContain('<x:xmpmeta');
  });

  it('parses compact attribute (rdf:Description ... pdf:Producer="...") form', () => {
    const packet = `<x:xmpmeta><rdf:RDF><rdf:Description rdf:about="" ` +
      `pdf:Producer="Compact" xmp:CreateDate="2020-01-02T03:04:05Z"/></rdf:RDF></x:xmpmeta>`;
    const m = readXmp(enc(packet));
    expect(m.producer).toBe('Compact');
    expect(m.createDate).toBeInstanceOf(Date);
  });

  it('keeps an unparseable date as the raw string', () => {
    const packet = `<rdf:Description><xmp:CreateDate>not-a-date</xmp:CreateDate></rdf:Description>`;
    expect(readXmp(enc(packet)).createDate).toBe('not-a-date');
  });

  it('reads malformed XMP leniently (no throw) and preserves raw', () => {
    const packet = `<x:xmpmeta><rdf:RDF><rdf:Description><dc:title><rdf:Alt>`; // truncated
    const m = readXmp(enc(packet));
    expect(m.title).toBeUndefined();
    expect(m.raw).toBe(packet);
  });

  it('decodes a UTF-8 BOM and returns {} of fields for an empty packet', () => {
    const m = readXmp(new Uint8Array([0xef, 0xbb, 0xbf, ...enc('<x:xmpmeta></x:xmpmeta>')]));
    expect(m.title).toBeUndefined();
    expect(m.raw).toBe('<x:xmpmeta></x:xmpmeta>');
  });
});

describe('Document.GetXmp', () => {
  it('parses the /Root /Metadata packet', () => {
    const doc = Document.Open(buildXmpPdf(FULL));
    const xmp = doc.GetXmp();
    expect(xmp.title).toBe('Annual & Report');
    expect(xmp.authors).toEqual(['Jane Doe', 'John Roe']);
    expect(xmp.producer).toBe('Aspose.PDF');
    expect(xmp.createDate).toBeInstanceOf(Date);
    expect(xmp.raw).toContain('<x:xmpmeta');
  });

  it('returns {} when there is no /Metadata stream', () => {
    expect(Document.Open(buildBlankPage()).GetXmp()).toEqual({});
  });
});

describe('buildXmp', () => {
  it('round-trips a full metadata object through readXmp', () => {
    const meta = {
      title: 'T & U', authors: ['A', 'B'], description: 'D', subjects: ['x', 'y'],
      rights: 'R', keywords: 'k1, k2', producer: 'P', creatorTool: 'C',
      createDate: new Date('2024-06-03T12:30:45.000Z'),
      modifyDate: new Date('2024-06-04T08:00:00.000Z'),
    };
    const back = readXmp(new TextEncoder().encode(buildXmp(meta)));
    expect(back.title).toBe('T & U');
    expect(back.authors).toEqual(['A', 'B']);
    expect(back.description).toBe('D');
    expect(back.subjects).toEqual(['x', 'y']);
    expect(back.rights).toBe('R');
    expect(back.keywords).toBe('k1, k2');
    expect(back.producer).toBe('P');
    expect(back.creatorTool).toBe('C');
    expect(back.createDate).toEqual(new Date('2024-06-03T12:30:45.000Z'));
    expect(back.modifyDate).toEqual(new Date('2024-06-04T08:00:00.000Z'));
  });

  it('escapes XML special characters', () => {
    const xml = buildXmp({ title: '<a> & "b"' });
    expect(xml).toContain('&lt;a&gt; &amp; &quot;b&quot;');
    expect(readXmp(new TextEncoder().encode(xml)).title).toBe('<a> & "b"');
  });

  it('omits absent fields', () => {
    const xml = buildXmp({ title: 'only' });
    expect(xml).not.toContain('pdf:Producer');
    expect(xml).not.toContain('dc:creator');
  });
});

describe('mergeXmp', () => {
  it('applies value sets, null deletes, and drops raw', () => {
    const merged = mergeXmp({ title: 'old', producer: 'P', raw: 'RAW' }, { title: 'new', producer: null });
    expect(merged.title).toBe('new');
    expect(merged.producer).toBeUndefined();
    expect(merged.raw).toBeUndefined();
  });
});

describe('Document.SetXmp', () => {
  it('creates a /Metadata packet readable via GetXmp and surviving Save/Open', () => {
    const doc = Document.Open(buildBlankPage());
    doc.SetXmp({ title: 'Hello', authors: ['Jane'], rights: 'Mine' });
    expect(doc.GetXmp().title).toBe('Hello');

    const re = Document.Open(doc.Save());
    expect(re.GetXmp().title).toBe('Hello');
    expect(re.GetXmp().authors).toEqual(['Jane']);
    expect(re.GetXmp().rights).toBe('Mine');
  });

  it('merges over the existing packet (null deletes, others preserved)', () => {
    const doc = Document.Open(buildXmpPdf(FULL));
    doc.SetXmp({ title: 'Changed', producer: null });
    const xmp = doc.GetXmp();
    expect(xmp.title).toBe('Changed');
    expect(xmp.producer).toBeUndefined();
    expect(xmp.authors).toEqual(['Jane Doe', 'John Roe']); // preserved from FULL
  });

  it('mirrors shared fields into /Info, leaving XMP-only fields out', () => {
    const doc = Document.Open(buildBlankPage());
    doc.SetXmp({ title: 'T', authors: ['A', 'B'], description: 'Desc', rights: 'R' });
    const meta = doc.GetMetadata();
    expect(meta.title).toBe('T');
    expect(meta.author).toBe('A, B');     // authors joined
    expect(meta.subject).toBe('Desc');    // dc:description -> /Subject
    expect(meta).not.toHaveProperty('rights'); // dc:rights is XMP-only
  });
});

describe('SetMetadata <-> XMP mirror', () => {
  it('SetMetadata writes overlapping fields into XMP, not custom keys', () => {
    const doc = Document.Open(buildBlankPage());
    doc.SetMetadata({ title: 'Report', author: 'Jane, John', custom: { Dept: 'R&D' } });
    const xmp = doc.GetXmp();
    expect(xmp.title).toBe('Report');
    expect(xmp.authors).toEqual(['Jane', 'John']);  // /Author split into authors
    expect(xmp.raw).not.toContain('Dept');          // custom keys stay /Info-only
  });

  it('does not create an XMP packet when only custom /Info keys change', () => {
    const doc = Document.Open(buildBlankPage());
    doc.SetMetadata({ custom: { Dept: 'R&D' } });
    expect(doc.GetXmp()).toEqual({});
  });
});

describe('ClearMetadata <-> XMP', () => {
  it('also clears the /Root /Metadata XMP packet', () => {
    const doc = Document.Open(buildXmpPdf(FULL));
    expect(doc.GetXmp().title).toBeTruthy(); // packet present before clear

    doc.ClearMetadata();

    expect(doc.GetXmp()).toEqual({});                       // XMP gone, in-memory
    expect(doc.catalog().has('Metadata')).toBe(false);     // catalog entry removed
  });

  it('drops the XMP stream so a cleared doc round-trips with no metadata', () => {
    const doc = Document.Open(buildXmpPdf(FULL));
    doc.ClearMetadata();

    const re = Document.Open(doc.Save());
    expect(re.GetXmp()).toEqual({});
    expect(re.GetMetadata()).toEqual({ custom: {} });
  });

  it('is a no-op on the XMP side when the document has no packet', () => {
    const doc = Document.Open(buildBlankPage());
    expect(() => doc.ClearMetadata()).not.toThrow();
    expect(doc.GetXmp()).toEqual({});
  });
});

describe('xmp pdfaid', () => {
  it('round-trips pdfaid:part and pdfaid:conformance', () => {
    const packet = buildXmp({ title: 'T', pdfaPart: 2, pdfaConformance: 'B' });
    expect(packet).toContain('pdfaid:part');
    const back = readXmp(new TextEncoder().encode(packet));
    expect(back.pdfaPart).toBe(2);
    expect(back.pdfaConformance).toBe('B');
    expect(back.title).toBe('T');
  });

  it('round-trips pdfaid:rev', () => {
    const packet = buildXmp({ pdfaPart: 4, pdfaRev: 2020 });
    expect(packet).toContain('pdfaid:rev="2020"');
    const back = readXmp(enc(packet));
    expect(back.pdfaPart).toBe(4);
    expect(back.pdfaRev).toBe(2020);
  });

  it('emits no pdfaid:rev when it is unset', () => {
    // Parts 1-3 have no rev property at all; a packet rebuilt for one must not
    // grow the attribute, which is what keeps the parts-1-3 fence still.
    expect(buildXmp({ pdfaPart: 2, pdfaConformance: 'B' })).not.toContain('pdfaid:rev');
  });

  it('emits a pdfaid block for a rev with no part or conformance', () => {
    expect(buildXmp({ pdfaRev: 2020 })).toContain('pdfaid:rev="2020"');
  });

  it('reads pdfaid:rev written in element form', () => {
    const xml = '<rdf:Description xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">'
      + '<pdfaid:part>4</pdfaid:part><pdfaid:rev>2020</pdfaid:rev></rdf:Description>';
    expect(readXmp(enc(xml)).pdfaRev).toBe(2020);
  });
});

describe('xmp pdfuaid', () => {
  it('builds and reads back pdfuaid:part', () => {
    const xml = buildXmp({ title: 'Doc', pdfuaPart: 1 });
    expect(xml).toContain('xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/"');
    expect(xml).toContain('pdfuaid:part="1"');
    const back = readXmp(enc(xml));
    expect(back.pdfuaPart).toBe(1);
  });
});

describe('xmp pdfxid', () => {
  it('builds and reads back pdfxid:GTS_PDFXVersion', () => {
    const xml = buildXmp({ title: 'Doc', pdfxVersion: 'PDF/X-4' });
    expect(xml).toContain('xmlns:pdfxid="http://www.npes.org/pdfx/ns/id/"');
    expect(xml).toContain('pdfxid:GTS_PDFXVersion="PDF/X-4"');
    expect(readXmp(enc(xml)).pdfxVersion).toBe('PDF/X-4');
  });

  it('reads the element form as well as the attribute form', () => {
    const packet = '<rdf:Description rdf:about="" xmlns:pdfxid="http://www.npes.org/pdfx/ns/id/">'
      + '<pdfxid:GTS_PDFXVersion>PDF/X-1a:2003</pdfxid:GTS_PDFXVersion></rdf:Description>';
    expect(readXmp(enc(packet)).pdfxVersion).toBe('PDF/X-1a:2003');
  });

  it('round-trips through SetXmp/GetXmp on a real document', () => {
    const doc = Document.Open(buildBlankPage());
    doc.SetXmp({ pdfxVersion: 'PDF/X-4' });
    expect(Document.Open(doc.Save()).GetXmp().pdfxVersion).toBe('PDF/X-4');
  });
});

describe('XMP custom namespaced properties', () => {
  const prop = {
    namespace: 'http://acme.example/ns/1.0/', prefix: 'acme',
    name: 'BatchId', value: 'B-4711',
  };

  it('buildXmp declares the namespace and emits the property', () => {
    const xml = buildXmp({ custom: [prop] });
    expect(xml).toContain('xmlns:acme="http://acme.example/ns/1.0/"');
    expect(xml).toContain('<acme:BatchId>B-4711</acme:BatchId>');
  });

  it('readXmp reads it back', () => {
    const back = readXmp(enc(buildXmp({ title: 'T', custom: [prop] })));
    expect(back.title).toBe('T');
    expect(back.custom).toEqual([prop]);
  });

  it('escapes markup in the value', () => {
    const xml = buildXmp({ custom: [{ ...prop, value: 'a & b <c>' }] });
    expect(xml).toContain('a &amp; b &lt;c&gt;');
    expect(readXmp(enc(xml)).custom![0].value).toBe('a & b <c>');
  });

  it('keeps several properties, including two in the same namespace', () => {
    const props = [
      prop,
      { ...prop, name: 'Operator', value: 'jane' },
      { namespace: 'http://other.example/', prefix: 'oth', name: 'K', value: 'v' },
    ];
    const back = readXmp(enc(buildXmp({ custom: props })));
    expect(back.custom).toEqual(props);
  });

  it('round-trips through a document save and reopen', () => {
    const doc = Document.Open(buildBlankPage());
    doc.SetXmp({ title: 'Report', custom: [prop] });
    const reopened = Document.Open(doc.Save());
    const xmp = reopened.GetXmp()!;
    expect(xmp.title).toBe('Report');
    expect(xmp.custom).toEqual([prop]);
    // The /Info mirror of the standard fields is unaffected.
    expect(reopened.GetMetadata().title).toBe('Report');
  });

  it('a packet with no custom properties is byte-identical to today', () => {
    const withKey = buildXmp({ title: 'T', custom: [] });
    const without = buildXmp({ title: 'T' });
    expect(withKey).toBe(without);
  });

  it('rejects a malformed custom property', () => {
    const bad = (p: unknown) => () => buildXmp({ custom: [p] as never });
    expect(bad({ ...prop, prefix: '' })).toThrow(/custom property/);
    expect(bad({ ...prop, namespace: '' })).toThrow(/custom property/);
    expect(bad({ ...prop, name: 'has space' })).toThrow(/custom property/);
    expect(bad({ ...prop, value: 7 })).toThrow(/custom property/);
    expect(bad({ ...prop, prefix: 'rdf' })).toThrow(/custom property/);
  });
});

describe('xmp identification: an empty attribute is PRESENT, not absent (ugxr)', () => {
  // The general scalar() helper already matched `([^"]*)`, so pdf:Producer=""
  // read back as ''. The five identification fields used `+` instead, so an
  // empty one read back as ABSENT - two answers to one question inside one
  // module, and the reason a written pdfaid:conformance="" was invisible.
  const packet = (attrs: string) =>
    enc(`<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" ${attrs}/>`);

  it('surfaces an empty conformance as the empty string', () => {
    const meta = readXmp(packet('pdfaid:part="4" pdfaid:conformance=""'));
    expect(meta.pdfaConformance).toBe('');
    expect(meta.pdfaPart).toBe(4);
  });

  it('surfaces an empty numeric attribute as NaN, not 0', () => {
    // Number('') is 0, which reads as a document CLAIMING part 0. NaN is the
    // honest answer and is what junk (part="x") already yields today.
    const meta = readXmp(packet('pdfaid:part="" pdfaid:rev=""'));
    expect(meta.pdfaPart).toBeNaN();
    expect(meta.pdfaRev).toBeNaN();
    expect(readXmp(packet('pdfaid:part="x"')).pdfaPart).toBeNaN();  // unchanged
  });

  it('treats a whitespace-only numeric attribute as NaN too', () => {
    expect(readXmp(packet('pdfaid:part="   "')).pdfaPart).toBeNaN();
  });

  it('leaves a genuinely absent attribute undefined', () => {
    const meta = readXmp(packet('pdfaid:part="2"'));
    expect(meta.pdfaPart).toBe(2);
    expect(meta.pdfaConformance).toBeUndefined();
    expect(meta.pdfaRev).toBeUndefined();
  });

  it('reads the empty ELEMENT form as present too', () => {
    const xml = '<rdf:Description xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">'
      + '<pdfaid:conformance></pdfaid:conformance></rdf:Description>';
    expect(readXmp(enc(xml)).pdfaConformance).toBe('');
  });

  it('applies the same rule to pdfuaid:part and pdfxid:GTS_PDFXVersion', () => {
    const ua = enc('<rdf:Description xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/" pdfuaid:part=""/>');
    expect(readXmp(ua).pdfuaPart).toBeNaN();
    const x = enc('<rdf:Description xmlns:pdfxid="http://www.npes.org/pdfx/ns/id/" pdfxid:GTS_PDFXVersion=""/>');
    expect(readXmp(x).pdfxVersion).toBe('');
  });
});
