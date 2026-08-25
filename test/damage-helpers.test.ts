import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildClassicPdf } from './helpers/build-pdf.js';
import {
  corruptStartxref, destroyTrailer, prependBytes, corruptObjectBody,
  appendTruncatedCopy, truncateTail, corruptObjStmPayload,
} from './helpers/damage-pdf.js';

const good = () => buildClassicPdf(2);

/** A damaged file is one Open cannot read *cleanly*: it either throws, or it
 *  opens only by recovering. Asserting "throws" would go stale task by task as
 *  recovery lands — this stays true either way, and is still falsified outright
 *  by a damage function that does nothing. */
function notCleanlyOpenable(pdf: Uint8Array): boolean {
  try {
    return Document.Open(pdf).recovery !== undefined;
  } catch {
    return true;
  }
}

describe('damage helpers are load-bearing', () => {
  it('the undamaged fixture opens cleanly', () => {
    const doc = Document.Open(good());
    expect(doc.Pages.length).toBe(2);
    expect(doc.recovery).toBeUndefined();
    expect(notCleanlyOpenable(good())).toBe(false);
  });

  it.each([
    ['corruptStartxref', (p: Uint8Array) => corruptStartxref(p)],
    ['destroyTrailer', (p: Uint8Array) => destroyTrailer(p)],
    ['prependBytes', (p: Uint8Array) => prependBytes(p, 'X-Junk: 1\r\n')],
    ['corruptObjectBody', (p: Uint8Array) => corruptObjectBody(p, 3)],
    ['truncateTail', (p: Uint8Array) => truncateTail(p, 40)],
    ['prependBytes + fixStartxref', (p: Uint8Array) =>
      prependBytes(p, 'X-Junk: 1\r\n', { fixStartxref: true })],
  ])('%s damages the file', (_name, damage) => {
    expect(notCleanlyOpenable(damage(good()))).toBe(true);
  });

  it('corruptObjStmPayload damages the file', () => {
    // Needs a compressed fixture: buildClassicPdf writes no /ObjStm.
    const compressed = Document.Open(good()).Save({ compressed: true });
    const damaged = corruptObjStmPayload(compressed);
    expect(notCleanlyOpenable(damaged)).toBe(true);
    // In place, so the xref stays valid and the container is the only damage.
    expect(damaged.length).toBe(compressed.length);
  });

  it('round-trips every byte value unchanged', () => {
    // The helpers rebuild the file through a string. That mapping must be 1:1
    // over all 256 values: TextEncoder (UTF-8) inflates high bytes, and
    // TextDecoder('latin1') is really windows-1252, which silently rewrites
    // 0x80-0x9F while preserving length. Both would corrupt DEFLATE payloads.
    const all = new Uint8Array(256).map((_v, i) => i);
    const pdf = new Uint8Array([...buildClassicPdf(1), ...all]);
    const out = prependBytes(pdf, '');
    expect(out.length).toBe(pdf.length);
    expect([...out.subarray(out.length - 256)]).toEqual([...all]);
  });

  it('a damage function that changes nothing else preserves file length', () => {
    // Guards the latin1/UTF-8 trap: re-encoding through TextEncoder would
    // silently inflate the binary marker comment and every high byte with it.
    const pdf = good();
    expect(corruptObjectBody(pdf, 3).length).toBe(pdf.length);
    expect(destroyTrailer(pdf).length).toBe(pdf.length);
  });

  it('appendTruncatedCopy adds a second, unparsable copy of the object', () => {
    const pdf = appendTruncatedCopy(good(), 3);
    const text = new TextDecoder('latin1').decode(pdf);
    expect(text.match(/(^|\s)3 0 obj/g)?.length).toBe(2);
    // the original file still opens: the appended copy is past %%EOF and unreferenced
    expect(Document.Open(pdf).Pages.length).toBe(2);
  });
});
