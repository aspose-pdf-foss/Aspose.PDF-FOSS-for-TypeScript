import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { UnsupportedFeatureError } from '../src/errors.js';

const enc = (s: string) => new TextEncoder().encode(s);

// Minimal hand-built file whose first object is a /Linearized parameter dict.
function linearizedLikeBytes(): Uint8Array {
  const body =
    '%PDF-1.7\n' +
    '1 0 obj\n<< /Linearized 1 /L 1000 /O 4 /E 500 /N 1 /T 800 /H [200 50] >>\nendobj\n' +
    '2 0 obj\n<< /Type /Catalog /Pages 3 0 R >>\nendobj\n' +
    '3 0 obj\n<< /Type /Pages /Kids [4 0 R] /Count 1 >>\nendobj\n' +
    '4 0 obj\n<< /Type /Page /Parent 3 0 R /MediaBox [0 0 200 200] >>\nendobj\n';
  const offsets: number[] = [];
  for (const seg of ['1 0 obj', '2 0 obj', '3 0 obj', '4 0 obj']) {
    offsets.push(enc(body.slice(0, body.indexOf(seg))).length);
  }
  const xrefStart = enc(body).length;
  let xref = 'xref\n0 5\n0000000000 65535 f \n';
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size 5 /Root 2 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

describe('Document.IsLinearized', () => {
  it('is true when the first object is a /Linearized dict', () => {
    expect(Document.Open(linearizedLikeBytes()).IsLinearized).toBe(true);
  });
  it('is false for a normal (non-linearized) document', () => {
    const doc = Document.Open(linearizedLikeBytes());
    const normal = Document.Open(doc.Save());      // re-saved: not linearized
    expect(normal.IsLinearized).toBe(false);
  });
});

describe('Save linearized — guards', () => {
  const onePage = () => Document.Open(linearizedLikeBytes());
  it('throws when combined with compressed', () => {
    expect(() => onePage().Save({ linearized: true, compressed: true }))
      .toThrow(UnsupportedFeatureError);
  });
  it('throws when combined with encrypt', () => {
    expect(() => onePage().Save({ linearized: true, encrypt: { userPassword: 'x' } as any }))
      .toThrow(UnsupportedFeatureError);
  });
});
