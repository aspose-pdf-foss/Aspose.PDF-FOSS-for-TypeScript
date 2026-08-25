import { describe, it, expect } from 'vitest';
import { serializeDocument } from '../src/serializer.js';
import { Document } from '../src/document.js';
import { PdfDict, PdfObject, name, ref } from '../src/types.js';

/** A tiny live doc: 1=Catalog -> 2=Pages -> 3=Page (+ an orphan 9). */
function tinyDoc(): { objects: Map<number, PdfObject>; trailer: PdfDict } {
  const page: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Page')], ['Parent', ref(2)], ['MediaBox', [0, 0, 100, 100]],
  ]);
  const pages: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Pages')], ['Count', 1], ['Kids', [ref(3)]],
  ]);
  const catalog: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Catalog')], ['Pages', ref(2)],
  ]);
  const orphan: PdfDict = new Map<string, PdfObject>([['Dead', name('Yes')]]);
  const objects = new Map<number, PdfObject>([[1, catalog], [2, pages], [3, page], [9, orphan]]);
  const trailer: PdfDict = new Map<string, PdfObject>([['Root', ref(1)]]);
  return { objects, trailer };
}

describe('serializeDocument', () => {
  it('emits a parseable PDF whose catalog and one page round-trip', () => {
    const { objects, trailer } = tinyDoc();
    const re = Document.Open(serializeDocument(objects, trailer));
    expect(re.Pages.length).toBe(1);
    expect(re.Pages[0].MediaBox).toEqual([0, 0, 100, 100]);
  });

  it('drops objects unreachable from /Root', () => {
    const { objects, trailer } = tinyDoc();
    const out = new TextDecoder('latin1').decode(serializeDocument(objects, trailer));
    expect(out.includes('/Dead')).toBe(false); // orphan 9 swept
  });

  it('renumbers reachable objects compactly 1..N with the root first', () => {
    const { objects, trailer } = tinyDoc();
    const out = new TextDecoder('latin1').decode(serializeDocument(objects, trailer));
    expect(out.includes('xref\n0 4\n')).toBe(true); // 3 reachable + free head
    expect(/\/Root 1 0 R/.test(out)).toBe(true);    // catalog renumbered to 1
  });

  it('preserves /ID and /Info references', () => {
    const { objects, trailer } = tinyDoc();
    const info: PdfDict = new Map<string, PdfObject>([
      ['Title', { kind: 'string', bytes: new TextEncoder().encode('T') }],
    ]);
    objects.set(7, info);
    trailer.set('Info', ref(7));
    trailer.set('ID', [
      { kind: 'string', bytes: Uint8Array.from([1, 2]) },
      { kind: 'string', bytes: Uint8Array.from([3, 4]) },
    ]);
    const re = Document.Open(serializeDocument(objects, trailer));
    expect(re.GetMetadata().title).toBe('T');
    expect(re.trailer.get('ID')).toBeDefined();
  });

  it('is stable across reopen (second serialize equals first)', () => {
    const { objects, trailer } = tinyDoc();
    const first = serializeDocument(objects, trailer);
    const reopened = Document.Open(first);
    const second = serializeDocument(
      (reopened as any).objects as Map<number, PdfObject>,
      reopened.trailer,
    );
    expect(second).toEqual(first);
  });
});
