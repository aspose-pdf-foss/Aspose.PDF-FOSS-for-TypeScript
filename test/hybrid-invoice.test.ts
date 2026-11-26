import { expect, it } from 'vitest';
import { Document, LoadLimits, PdfParseError, ResourceLimitError } from '../src/index.js';

const fx = 'urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#';
const zf = 'urn:ferd:CrossIndustryDocument:invoice:1p0';
const un = 'urn:un:unece:uncefact:data:standard:';
const en = 'urn:cen.eu:en16931:2017';
const encode = (s: string) => new TextEncoder().encode(s);

function xml(id = en, legacy = false): string {
  const root = legacy ? 'CrossIndustryDocument' : 'CrossIndustryInvoice';
  const context = legacy ? 'SpecifiedExchangedDocumentContext' : 'ExchangedDocumentContext';
  return `\uFEFF<?xml version="1.0"?>\r\n<${root} xmlns="${legacy ? zf : un + 'CrossIndustryInvoice:100'}">
    <${context} xmlns:g="${un}ReusableAggregateBusinessInformationEntity:${legacy ? 12 : 100}">
      <g:GuidelineSpecifiedDocumentContextParameter><g:ID>${id}</g:ID></g:GuidelineSpecifiedDocumentContextParameter>
    </${context}></${root}>\r\n`;
}

function attached(filename: string, body: string, compress = true) {
  const doc = Document.New();
  doc.AddPage();
  doc.AddAttachment(filename, encode(body), { compress });
  return doc;
}

it.each([
  ['factur-x.xml', en, false, 'EN 16931'],
  ['zugferd-invoice.xml', 'urn:zugferd.de:2p0:basicwl', false, 'BASIC WL'],
  ['ZUGFeRD-invoice.xml', zf + ':comfort', true, 'COMFORT'],
] as const)('extracts the original %s bytes and XML profile without XMP', (filename, id, legacy, profile) => {
  const body = xml(id, legacy);
  const doc = attached(filename, body, false);
  const reopened = Document.Open(doc.Save());
  const result = reopened.ReadHybridInvoice()!;
  expect(result).toEqual({ filename, guidelineId: id, profile, xml: encode(body) });
  result.xml.fill(0);
  expect(reopened.GetAttachments()[0].GetBytes()).toEqual(encode(body));
});

it('uses a namespaced XMP filename for a catalog-only invoice and skips unrelated XML', () => {
  const doc = attached('ledger.xml', '<broken');
  doc.Pages[0].AddFileAttachment({ name: 'billing.xml', bytes: encode(xml()), relationship: 'Alternative', rect: [0, 0, 10, 10] });
  doc.SetXmpValue(fx, 'DocumentFileName', 'billing.xml', { prefix: 'billing' });
  doc.SetXmpValue(fx, 'ConformanceLevel', 'EN 16931');
  expect(Document.Open(doc.Save()).ReadHybridInvoice()?.filename).toBe('billing.xml');
});

it('ignores unrelated attachments and unrelated XMP properties with the same local name', () => {
  const doc = attached('report.xml', '<no');
  doc.SetXmpValue('urn:example:other', 'DocumentFileName', 'report.xml', { prefix: 'fx' });
  expect(doc.ReadHybridInvoice()).toBeUndefined();
});

it.each([
  xml().replace('CrossIndustryInvoice:100', 'Other:100'),
  xml().replace('ReusableAggregateBusinessInformationEntity:100', 'Other:100'),
  xml().replace('</g:ID>', '</bad>'),
  xml() + '<extra/>',
  xml().replace('<CrossIndustryInvoice ', '<!DOCTYPE invoice><CrossIndustryInvoice '),
  xml().replace('</CrossIndustryInvoice>', '<Note>A & B</Note></CrossIndustryInvoice>'),
  xml().replace('</CrossIndustryInvoice>', '<other:Note/></CrossIndustryInvoice>'),
  xml().replace('<ExchangedDocumentContext ', '<ExchangedDocumentContext label="a<b" '),
])('rejects malformed or misidentified invoice XML %#', body => {
  expect(() => attached('factur-x.xml', body).ReadHybridInvoice()).toThrow(PdfParseError);
});

it.each([['ConformanceLevel', 'BASIC'], ['DocumentFileName', 'missing.xml'],
  ['DocumentType', 'ORDER'], ['Version', '2.0']])('reports a conflicting XMP %s', (key, value) => {
  const doc = attached('factur-x.xml', xml());
  doc.SetXmpValue(fx, key, value, { prefix: 'billing' });
  expect(() => doc.ReadHybridInvoice()).toThrow(key);
});

it('refuses ambiguous attachments instead of using catalog or name-tree order', () => {
  const doc = attached('factur-x.xml', xml());
  doc.AddAttachment('zugferd-invoice.xml', encode(xml()));
  expect(() => doc.ReadHybridInvoice()).toThrow(/multiple/i);
});

it.each([true, false])('enforces the decoded XML byte limit with compression %s', compress => {
  const doc = attached('factur-x.xml', xml(), compress);
  const reopened = Document.Open(doc.Save(), { limits: LoadLimits.defaults.with({ maxDecodedStreamBytes: 100 }) });
  expect(() => reopened.ReadHybridInvoice()).toThrow(ResourceLimitError);
});

it('bounds a wide XML tree before extracting even a valid guideline', () => {
  const body = xml().replace('</CrossIndustryInvoice>', '<Line/>'.repeat(40) + '</CrossIndustryInvoice>');
  const doc = Document.Open(attached('factur-x.xml', body).Save(), {
    limits: LoadLimits.defaults.with({ maxContainerItems: 32 }),
  });
  expect(() => doc.ReadHybridInvoice()).toThrow(ResourceLimitError);
});

it('packages exact XML bytes on a prepared PDF/A-3b and preserves unrelated metadata and attachments', () => {
  const doc = attached('receipt.txt', 'keep');
  doc.SetXmpValue('urn:example:ledger', 'Account', 'ledger 42', { prefix: 'fx' });
  doc.ConvertToPdfA('3b');
  const bytes = encode(xml());
  const result = doc.BuildHybridInvoice(bytes);
  const output = Document.Open(result.bytes);
  expect(result.validation.Errors).toEqual([]);
  expect(output.ValidatePdfA('3b').Errors).toEqual([]);
  expect(output.ReadHybridInvoice()?.xml).toEqual(bytes);
  expect(output.GetAttachments().map(file => file.Name)).toEqual(['factur-x.xml', 'receipt.txt']);
  const file = output.GetAssociatedFiles().find(file => file.Name === 'factur-x.xml')!;
  expect(file.Dict).toBe(output.GetAttachments()[0].Dict);
  expect([file.Relationship, file.MimeType]).toEqual(['Alternative', 'text/xml']);
  expect(output.GetAttachments()[1].GetBytes()).toEqual(encode('keep'));
  expect(output.GetXmpValue('urn:example:ledger', 'Account')).toEqual(doc.GetXmpValue('urn:example:ledger', 'Account'));
  expect(doc.ReadHybridInvoice()).toBeUndefined();
});

it('replaces a catalog-only invoice shared with an annotation and reports outstanding PDF/A findings', () => {
  const doc = attached('receipt.txt', 'keep');
  doc.Pages[0].AddFileAttachment({ name: 'ZUGFeRD-invoice.xml', bytes: encode(xml(zf + ':basic', true)),
    relationship: 'Alternative', rect: [0, 0, 10, 10] });
  const result = doc.BuildHybridInvoice(encode(xml('urn:factur-x.eu:1p0:minimum')));
  const output = Document.Open(result.bytes);
  expect(result.validation.Passed).toBe(false);
  expect(output.ReadHybridInvoice()?.profile).toBe('MINIMUM');
  const invoice = output.GetAttachments().find(f => f.Name === 'factur-x.xml')!;
  expect(invoice.Relationship).toBe('Data');
  const [annotation] = output.Pages[0].Annotations;
  expect(output.resolve(annotation.Dict.get('FS'))).toBe(invoice.Dict);
  expect(output.GetAssociatedFiles().filter(f => f.Dict === invoice.Dict)).toHaveLength(1);
  expect(doc.ReadHybridInvoice()?.profile).toBe('BASIC');
});

it('switches invoice generations without stale XMP and rejects ambiguous or broken inputs', () => {
  const doc = Document.New();
  doc.AddPage();
  const modern = Document.Open(doc.BuildHybridInvoice(encode(xml())).bytes);
  const legacy = Document.Open(modern.BuildHybridInvoice(encode(xml(zf + ':comfort', true))).bytes);
  expect(legacy.GetAttachments().map(f => f.Name)).toEqual(['ZUGFeRD-invoice.xml']);
  expect(legacy.ReadHybridInvoice()?.profile).toBe('COMFORT');
  expect(legacy.GetXmpValue(fx, 'Version')).toBeUndefined();
  expect(() => modern.BuildHybridInvoice(encode('<broken'))).toThrow(PdfParseError);
  modern.AddAttachment('xrechnung.xml', encode(xml()));
  expect(() => modern.BuildHybridInvoice(encode(xml()))).toThrow(/multiple/i);
});

it('respects PDF/A-3u identification and a caller-specified Source relationship', () => {
  const doc = Document.New();
  doc.AddPage();
  doc.ConvertToPdfA('3u');
  const result = doc.BuildHybridInvoice(encode(xml()), { relationship: 'Source' });
  expect(result.level).toBe('3u');
  expect(result.validation.Errors).toEqual([]);
  expect(Document.Open(result.bytes).GetAssociatedFiles()[0].Relationship).toBe('Source');
});

it('protects unrelated files with a reserved display name or name-tree key and unreadable catalog metadata', () => {
  const doc = attached('factur-x.xml', '<ledger/>');
  expect(() => doc.BuildHybridInvoice(encode(xml()))).toThrow(PdfParseError);
  doc.GetAttachments()[0].Dict.delete('UF');
  doc.GetAttachments()[0].Dict.set('F', { kind: 'string', bytes: encode('ledger.xml') });
  expect(() => doc.BuildHybridInvoice(encode(xml()))).toThrow(/collides/);
  doc.installXmpText('<broken');
  expect(() => doc.BuildHybridInvoice(encode(xml()))).toThrow(/unreadable catalog XMP/);
});
