import { beforeAll, describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { Lexer } from '../src/lexer.js';
import { ObjectParser, signatureDictionarySources } from '../src/object-parser.js';
import { pdfString } from '../src/signature.js';
import { isDict } from '../src/types.js';
import { readXref, revisionFooterEnd } from '../src/xref.js';
import { buildClassicPdf, buildXrefStreamPdf } from './helpers/build-pdf.js';
import { buildSigner } from './helpers/build-signer.js';

describe('signature structure', () => {
  let signed: Buffer;

  beforeAll(async () => {
    const doc = Document.Open(buildClassicPdf(1));
    await doc.Sign(buildSigner({ type: 'ec' }), { fieldName: 'Approval' });
    signed = Buffer.from(doc.Save());
  });

  it('accepts the library’s signature with both Contents delimiters signed', async () => {
    const [report] = await Document.Open(signed).VerifySignatures();
    expect(report).toMatchObject({ integrity: 'valid', signature: 'valid', structureFindings: [] });
  });

  it('reports unsigned trailing data while retaining the digest and CMS verdicts', async () => {
    const bytes = Buffer.concat([signed, Buffer.from('\n\tNotes')]);
    const [report] = await Document.Open(bytes).VerifySignatures();
    expect(report).toMatchObject({ integrity: 'valid', signature: 'valid', modifications: [] });
    expect(report.structureFindings).toEqual([{ kind: 'appended-data', offset: signed.length + 2 }]);
  });

  it('accepts trailing PDF whitespace', async () => {
    const bytes = Buffer.concat([signed, Buffer.from('\0\t\n\f\r ')]);
    const [report] = await Document.Open(bytes).VerifySignatures();
    expect(report.structureFindings).toEqual([]);
  });

  it('recognizes an ordinary incremental update after signing', async () => {
    const doc = Document.Open(signed);
    doc.SetMetadata({ title: 'Reviewed' });
    const [report] = await Document.Open(doc.Save({ incremental: true })).VerifySignatures();
    expect(report.structureFindings).toEqual([]);
    expect(report.modifications.length).toBeGreaterThan(0);
  });

  it('reports a malformed ByteRange without trying to open its claimed prefix', async () => {
    const bytes = Buffer.from(signed);
    const rangeStart = bytes.indexOf('/ByteRange [0') + '/ByteRange ['.length;
    bytes[rangeStart] = 0x31;
    const [report] = await Document.Open(bytes).VerifySignatures();
    expect(report).toMatchObject({ integrity: 'tampered', signature: 'valid' });
    expect(report.structureFindings).toContainEqual({ kind: 'invalid-byte-range' });
  });

  it('reports a signature dictionary with ByteRange and a missing Contents entry', async () => {
    const bytes = Buffer.from(signed);
    bytes.write('/DocNotes', bytes.indexOf('/Contents <'));
    const [report] = await Document.Open(bytes).VerifySignatures();
    expect(report).toMatchObject({ name: 'Approval', signature: 'invalid' });
    expect(report.structureFindings).toEqual([{ kind: 'signature-dictionary-unavailable' }]);
  });

  it('finds a gap that does not match the serialized Contents string', async () => {
    const bytes = Buffer.from(signed);
    const firstLength = /\/ByteRange \[0 (\d+)/.exec(bytes.toString('latin1'))!;
    const lastDigit = firstLength.index + firstLength[0].length - 1;
    bytes[lastDigit] = bytes[lastDigit] === 0x38 ? 0x39 : 0x38;
    const [report] = await Document.Open(bytes).VerifySignatures();
    expect(report.structureFindings).toEqual([{ kind: 'contents-gap-mismatch' }]);
  });

  it('reports a signed extent whose revision footer cannot be confirmed', async () => {
    const bytes = Buffer.from(signed);
    bytes.write('%%END', bytes.lastIndexOf('%%EOF'));
    const [report] = await Document.Open(bytes).VerifySignatures();
    expect(report.structureFindings).toEqual([{ kind: 'signed-revision-unverified' }]);
  });

  it('reports that the final footer is unavailable even when the signed footer is intact', async () => {
    const doc = Document.Open(signed);
    doc.SetMetadata({ title: 'Reviewed' });
    const bytes = Buffer.from(doc.Save({ incremental: true }));
    bytes.write('%%END', bytes.lastIndexOf('%%EOF'));
    const [report] = await Document.Open(bytes).VerifySignatures();
    expect(report).toMatchObject({ integrity: 'valid', signature: 'valid' });
    expect(report.structureFindings).toEqual([{ kind: 'final-revision-unverified' }]);
  });

  it('checks that the signature field exists under the same name in the signed revision', async () => {
    const doc = Document.Open(signed);
    doc.Form.Get('Approval')!.Dict.set('T', pdfString('Renamed'));
    const [report] = await Document.Open(doc.Save({ incremental: true })).VerifySignatures();
    expect(report).toMatchObject({ name: 'Renamed', integrity: 'valid' });
    expect(report.structureFindings).toEqual([{ kind: 'signature-dictionary-unbound' }]);
  });
});

it('records duplicate signature dictionary keys after decoding their names', () => {
  const bytes = Buffer.from('<< /ByteRange [0 4 8 2] /Contents <00> /Cont#65nts <11> >>');
  const dict = new ObjectParser(new Lexer(bytes), undefined, undefined, false, true).parseObject();
  if (!isDict(dict)) throw new Error('expected a dictionary');
  const source = signatureDictionarySources.get(dict)!;
  expect(source.duplicateKeys).toBe(true);
  expect(bytes.subarray(source.contents.start, source.contents.end).toString()).toBe('<11>');
});

it('confirms the footer paired with a cross-reference stream', () => {
  const bytes = Buffer.from(buildXrefStreamPdf());
  const [revision] = readXref(bytes).revisions;
  expect(revisionFooterEnd(revision)).toBe(bytes.length - 1);
});
