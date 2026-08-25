import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Document } from '../src/document.js';

// Recovery asserted on damaged files whose *sources* we did not write.
// test/trailer-rebuild.test.ts and test/objstm-recovery.test.ts damage
// builder-made PDFs, which can only show that the reader survives our own
// writer's layout. Ghostscript and qpdf lay a file out differently — a classic
// table Ghostscript wrote, an /ObjStm qpdf packed — so these are the fixtures
// that can catch the reader having learned our writer's habits.
//
// Bytes and provenance: test/fixtures/corrupt/PROVENANCE.md.

const read = (n: string) => new Uint8Array(readFileSync(`test/fixtures/corrupt/${n}`));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** The pristine Ghostscript file the four classic-table fixtures are cut from.
 *  Comparing against its text is what makes "recovered" mean "correct". */
const PRISTINE = new Uint8Array(readFileSync('test/fixtures/pdfx/ghostscript-x3-noicc.pdf'));

describe('the fixtures are the bytes PROVENANCE.md describes', () => {
  // A recovery test that passes because the file was never actually broken is
  // this suite's failure mode, and it is easy to produce by accident. Pinning
  // the hashes means a regenerated or half-written fixture fails loudly here
  // rather than quietly weakening every assertion below.
  it.each([
    ['gs-x3-startxref-past-eof.pdf', 7496,
      '08035fefd8717b50bfdca0acea76c4508cef815df6925bc6df1c7de6119da7ab'],
    ['gs-x3-trailer-keyword-destroyed.pdf', 7495,
      'c6ffc02fc48d326fb3462ac8dfa7c62fcdb808e675b6cd66cfcf34aad0b811da'],
    ['gs-x3-offsets-shifted.pdf', 7513,
      '38f0bc8c73fbea34e4beaa11d17c0a6d77fbf98319a8db6a0013f7dc02e148d0'],
    ['gs-x3-truncated-mid-stream.pdf', 5247,
      'b0f7b1cd9e6f5cbe48c960f5d00a9bcc2742b59d9c325302c3e7652302732d23'],
    ['qpdf-objstm-source.pdf', 5956,
      '48b3e7b7d5206adfca5bc846594300cf744a935969b0fb8c782b3f00ccd34755'],
    ['qpdf-objstm-payload-damaged.pdf', 5956,
      '42585b86253d46cd3c491784a86d6e01243a4cfd7932ebc2515674ed8bd8dfcc'],
  ])('%s', (name, bytes, digest) => {
    const b = read(name as string);
    expect(b.length).toBe(bytes);
    expect(sha(b)).toBe(digest);
  });
});

describe('the sources open cleanly', () => {
  // Half of what makes the damaged assertions mean anything: if the source did
  // not open cleanly, "recovered" would be indistinguishable from "was never
  // broken", and a damage function that silently did nothing would pass.
  it.each([
    ['ghostscript (classic xref table)', PRISTINE],
    ['qpdf (/ObjStm + xref stream)', read('qpdf-objstm-source.pdf')],
  ])('%s', (_label, bytes) => {
    const doc = Document.Open(bytes as Uint8Array);
    expect(doc.recovery).toBeUndefined();
    expect(doc.Pages.length).toBe(1);
    expect(doc.Pages[0].GetText().length).toBeGreaterThan(0);
  });
});

describe('a damaged Ghostscript file recovers its content intact', () => {
  const expected = Document.Open(PRISTINE).Pages[0].GetText();

  it.each([
    ['gs-x3-startxref-past-eof.pdf', 'startxref-unreadable'],
    ['gs-x3-trailer-keyword-destroyed.pdf', 'xref-unparsable'],
    ['gs-x3-offsets-shifted.pdf', 'xref-unparsable'],
    ['gs-x3-truncated-mid-stream.pdf', 'startxref-unreadable'],
  ])('%s recovers by %s', (name, reason) => {
    const doc = Document.Open(read(name as string));

    expect(doc.recovery!.reason).toBe(reason);
    expect(doc.Pages.length).toBe(1);
    // The whole point: not merely "a page came back" but the same text the
    // undamaged file yields, from a producer that is not ours.
    expect(doc.Pages[0].GetText()).toBe(expected);
  });

  it('recovers a truncated file by sweeping, not by reading its xref', () => {
    // Distinct from the shared assertion above: the cut removed the xref table
    // and the trailer outright, so every object here came from the sweep.
    const doc = Document.Open(read('gs-x3-truncated-mid-stream.pdf'));
    expect(doc.recovery!.repaired.length).toBeGreaterThan(0);
  });

  it('saves a recovered file back to one that opens cleanly', () => {
    // Save() rewrites the whole reachable graph, so recovery is a repair the
    // caller can keep — asserted on third-party bytes, where a producer's
    // layout is the thing being rebuilt.
    const doc = Document.Open(read('gs-x3-offsets-shifted.pdf'));
    const round = Document.Open(doc.Save());
    expect(round.recovery).toBeUndefined();
    expect(round.Pages[0].GetText()).toBe(expected);
  });
});

describe('a damaged qpdf /ObjStm degrades per object', () => {
  it('opens, and reports what the container cost', () => {
    const doc = Document.Open(read('qpdf-objstm-payload-damaged.pdf'));

    expect(doc.recovery!.reason).toBe('objstm-undecodable');
    const damage = doc.recovery!.objectStreams!;
    expect(damage.length).toBe(1);
    expect(damage[0].recovered.length).toBeGreaterThan(0);
    expect(damage[0].lost.length).toBeGreaterThan(0);
    // The page tree is ahead of the damage in qpdf's packing order, so it
    // survives — the file is still a document rather than an error.
    expect(doc.Pages.length).toBe(1);
  });

  it('resolves every object the container lost as null', () => {
    const doc = Document.Open(read('qpdf-objstm-payload-damaged.pdf'));
    for (const n of doc.recovery!.objectStreams![0].lost) {
      expect(doc.resolve({ kind: 'ref', num: n, gen: 0 })).toBe(null);
    }
  });
});
