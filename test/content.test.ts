import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { parseContentStream, serializeContentStream } from '../src/content.js';
import { Document } from '../src/document.js';
import { Page } from '../src/page.js';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { PdfDict, PdfStream, name } from '../src/types.js';
import { PdfParseError } from '../src/errors.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (u: Uint8Array) => new TextDecoder('latin1').decode(u);

describe('parseContentStream', () => {
  it('tokenizes a text block into ops with operands', () => {
    const ops = parseContentStream(enc('BT /F1 24 Tf 100 700 Td (Hello World) Tj ET'));
    expect(ops.map(o => o.operator)).toEqual(['BT', 'Tf', 'Td', 'Tj', 'ET']);
    expect(ops[0].operands).toEqual([]);                       // BT
    expect(ops[1].operands).toEqual([{ kind: 'name', name: 'F1' }, 24]); // Tf
    expect(ops[2].operands).toEqual([100, 700]);               // Td
    expect(ops[3].operands.length).toBe(1);                    // Tj
    expect(dec((ops[3].operands[0] as any).bytes)).toBe('Hello World');
    expect(ops[4].operands).toEqual([]);                       // ET
  });

  it('handles zero-operand graphics operators', () => {
    const ops = parseContentStream(enc('q 1 0 0 1 50 50 cm Q'));
    expect(ops.map(o => o.operator)).toEqual(['q', 'cm', 'Q']);
    expect(ops[1].operands).toEqual([1, 0, 0, 1, 50, 50]);
  });

  it('parses a TJ array operand', () => {
    const ops = parseContentStream(enc('[(A) -250 (B)] TJ'));
    expect(ops.length).toBe(1);
    expect(ops[0].operator).toBe('TJ');
    const arr = ops[0].operands[0] as any[];
    expect(dec(arr[0].bytes)).toBe('A');
    expect(arr[1]).toBe(-250);
    expect(dec(arr[2].bytes)).toBe('B');
  });

  it('parses a dict operand (marked content) and hex strings', () => {
    const ops = parseContentStream(enc('/Span <</MCID 0>> BDC <48656C6C6F> Tj EMC'));
    expect(ops.map(o => o.operator)).toEqual(['BDC', 'Tj', 'EMC']);
    const d = ops[0].operands[1] as PdfDict;
    expect(d.get('MCID')).toBe(0);
    expect(dec((ops[1].operands[0] as any).bytes)).toBe('Hello');
  });

  it('treats true/false/null as operands, not operators', () => {
    const ops = parseContentStream(enc('true /GS1 gs'));
    expect(ops.length).toBe(1);
    expect(ops[0].operator).toBe('gs');
    expect(ops[0].operands).toEqual([true, { kind: 'name', name: 'GS1' }]);
  });

  it('returns [] for empty input', () => {
    expect(parseContentStream(enc('   '))).toEqual([]);
  });

  // A stray `{` is what an undecrypted (or otherwise corrupt) content stream
  // hands the lexer. It has no operator meaning here, but it must be consumed:
  // the tokenizer used to return an empty keyword at an unchanged position, so
  // this loop appended ops until the heap died and took the process with it.
  it('consumes an unclaimed delimiter instead of spinning on it', () => {
    const ops = parseContentStream(enc('q 1 0 0 1 5 5 cm { BT ET } Q'));
    expect(ops.map(o => o.operator)).toEqual(['q', 'cm', '{', 'BT', 'ET', '}', 'Q']);
  });

  it('survives arbitrary binary — every byte value in operand position', () => {
    for (let b = 0; b < 256; b++) {
      expect(() => parseContentStream(Uint8Array.of(b, 32, 0x54, 0x6a))).not.toThrow(); // ` Tj`
    }
  });

  // A damaged (or still-encrypted) stream costs the bytes it damaged, not the
  // page: the ops on either side of the junk still come back.
  it('keeps extracting past a stray >', () => {
    const ops = parseContentStream(enc('BT (a) Tj > (b) Tj ET'));
    expect(ops.map(o => o.operator)).toEqual(['BT', 'Tj', '>', 'Tj', 'ET']);
    expect(dec((ops[1].operands[0] as any).bytes)).toBe('a');
    expect(dec((ops[3].operands[0] as any).bytes)).toBe('b');
  });

  it('captures an inline image as a BI op with dict + data', () => {
    const data = '\x01\x02\x03\x04';
    const ops = parseContentStream(enc(`q BI /W 2 /H 2 /CS /RGB /BPC 8 ID ${data}\nEI Q`));
    expect(ops.map(o => o.operator)).toEqual(['q', 'BI', 'Q']);
    const img = ops[1].inlineImage!;
    expect(img.dict.get('W')).toBe(2);
    expect(img.dict.get('H')).toBe(2);
    expect((img.dict.get('CS') as any).name).toBe('RGB');
    expect(dec(img.data)).toBe(data);
  });

  it('handles inline-image data that contains the bytes "EI"', () => {
    // 'EI' appears mid-data but is NOT whitespace-delimited, so it is not the terminator.
    const data = 'xEIx';
    const ops = parseContentStream(enc(`BI /W 1 /H 1 ID ${data}\nEI`));
    expect(ops.length).toBe(1);
    expect(dec(ops[0].inlineImage!.data)).toBe(data);
  });
});

describe('serializeContentStream', () => {
  it('round-trips operators and operands', () => {
    const src = 'BT /F1 24 Tf 100 700 Td [(A) -250 (B)] TJ ET q 1 0 0 1 5 5 cm /Im0 Do Q';
    const ops = parseContentStream(enc(src));
    const round = parseContentStream(serializeContentStream(ops));
    expect(round).toEqual(ops);
  });

  it('round-trips marked content with a dict operand', () => {
    const ops = parseContentStream(enc('/Span <</MCID 0>> BDC (hi) Tj EMC'));
    expect(parseContentStream(serializeContentStream(ops))).toEqual(ops);
  });

  it('round-trips an inline image', () => {
    const ops = parseContentStream(enc('BI /W 2 /H 2 /BPC 8 ID \x01\x02\x03\xFF\nEI'));
    const round = parseContentStream(serializeContentStream(ops));
    expect(round).toEqual(ops);
  });
});

describe('parseContentStream on a real Page.Contents', () => {
  it('parses Flate-decoded page content', () => {
    const doc = Document.Open(buildClassicPdf(1));
    const text = 'BT /F1 12 Tf 72 720 Td (Real page) Tj ET';
    const raw = new Uint8Array(deflateSync(Buffer.from(text)));
    const stream: PdfStream = {
      kind: 'stream',
      dict: new Map<string, any>([['Filter', name('FlateDecode')], ['Length', raw.length]]),
      raw,
    };
    const pageDict = new Map<string, any>([['Type', name('Page')], ['Contents', stream]]);
    const page = new Page(doc, pageDict, 1);

    const ops = parseContentStream(page.Contents);
    expect(ops.map(o => o.operator)).toEqual(['BT', 'Tf', 'Td', 'Tj', 'ET']);
    expect(dec((ops[3].operands[0] as any).bytes)).toBe('Real page');
  });

  it('extracts nothing from a page whose content was never decrypted', () => {
    // The reported crash, at the level it was reported: a file whose /Encrypt
    // dict the recovery path failed to find leaves every content stream as raw
    // ciphertext, and GetText tokenizes it. These are the captured bytes — the
    // `{` at offset 6 is the byte the tokenizer stood still on.
    const raw = Uint8Array.from(
      Buffer.from('f0ceb988f6027b85b190c68992a1d3927431421590b2a11f', 'hex'),
    );
    const doc = Document.Open(buildClassicPdf(1));
    const stream: PdfStream = {
      kind: 'stream', dict: new Map<string, any>([['Length', raw.length]]), raw,
    };
    const page = new Page(doc, new Map<string, any>([
      ['Type', name('Page')], ['Contents', stream],
    ]), 1);

    expect(page.GetText()).toBe('');
  });
});
