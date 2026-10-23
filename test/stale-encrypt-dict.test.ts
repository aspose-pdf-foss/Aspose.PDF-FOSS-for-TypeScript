// e8y8: an encrypted document may carry a second, unreferenced encryption
// dictionary. An encryption dictionary is never encrypted (32000-1 7.6.1), so
// that copy is plaintext; decrypting it threw on AES unpadding, the strict
// last rung counted the object unparseable, and the whole file was refused.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Document } from '../src/document.js';
import { isDict, isString, ref } from '../src/types.js';
import { buildStaleEncryptPdf } from './helpers/build-stale-encrypt-pdf.js';

describe('a second, plaintext encryption dictionary', () => {
  for (const algorithm of ['aes128', 'aes256', 'rc4'] as const) {
    it(`opens cleanly and is left undecrypted (${algorithm})`, () => {
      const f = buildStaleEncryptPdf(algorithm);
      const doc = Document.Open(f.bytes);
      expect(doc.recovery).toBeUndefined();
      expect(doc.Pages[0].GetText()).toContain('stale');
      // rc4 cannot throw, so it garbled the copy silently: comparing the
      // strings is what sees the rule under every cipher.
      const stale = doc.resolve(ref(f.staleNum));
      expect(isDict(stale)).toBe(true);
      const O = isDict(stale) ? stale.get('O') : undefined;
      const U = isDict(stale) ? stale.get('U') : undefined;
      expect(isString(O) && Buffer.from(O.bytes).equals(Buffer.from(f.O))).toBe(true);
      expect(isString(U) && Buffer.from(U.bytes).equals(Buffer.from(f.U))).toBe(true);
    });
  }

  it('opens the 2021-03 DD 3019, whose object 5706 is such a copy', () => {
    // LiveCycle Designer 11.0, AESV2; the trailer names object 6579 and an
    // identical, unreferenced dict sits at 5706. qpdf --check finds nothing.
    const doc = Document.Open(readFileSync(join(__dirname, 'fixtures', 'xfa', 'dod-dd3019-2021.pdf')));
    expect(doc.recovery).toBeUndefined();
    expect(doc.Pages.length).toBe(5);
    expect(doc.Form.Fields.length).toBe(1156);
    expect(doc.Pages[0].GetText()).toContain('RESUSCITATION');
  });

  it('still decrypts an ordinary dict carrying strings', () => {
    const f = buildStaleEncryptPdf('aes128');
    const doc = Document.Open(f.bytes);
    doc.SetMetadata({ title: 'Kept' });
    const again = Document.Open(doc.Save());
    expect(again.GetMetadata().title).toBe('Kept');
  });
});
