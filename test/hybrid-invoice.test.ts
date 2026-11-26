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
