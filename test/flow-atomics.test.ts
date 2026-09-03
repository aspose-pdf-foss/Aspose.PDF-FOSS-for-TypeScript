import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { paragraph } from '../src/flow.js';
import { placeElements } from '../src/flowplace.js';
import type { Page } from '../src/page.js';

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

const content = (page: Page): string =>
  new TextDecoder('latin1').decode(page.Contents);

function place(atomics: unknown): Page {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  const els = paragraph([{ text: 'before ' }, { text: 'after' }],
    { fontSize: 12, atomics } as never);
  placeElements(doc, page, els, [20, 20, 400, 750], { paragraphSpacing: 0 });
  return page;
}

describe('paragraph({ atomics })', () => {
  it('takes BYTES and builds the XObject itself', () => {
    // cssflow.ts hands bytes and never a PdfStream, which is what keeps its
    // rule of touching no PDF object module.
    const page = place([{ beforeRun: 1, data: new Uint8Array(PNG_1x1),
      width: 20, height: 20 }]);
    expect(content(page)).toMatch(/\/Im\d+ Do/);
    expect(page.GetText()).toContain('before');
  });

  it('defaults align to baseline', () => {
    const page = place([{ beforeRun: 1, data: new Uint8Array(PNG_1x1),
      width: 20, height: 20 }]);
    expect(content(page)).toMatch(/ Do/);
  });

  it('rejects a bad atomic BEFORE emitting any byte', () => {
    // The rule every authoring entry point follows: a rejected call leaves the
    // document byte-identical.
    for (const bad of [
      { beforeRun: -1, data: new Uint8Array(PNG_1x1), width: 1, height: 1 },
      { beforeRun: 0, data: 'nope', width: 1, height: 1 },
      { beforeRun: 0, data: new Uint8Array(PNG_1x1), width: -1, height: 1 },
      { beforeRun: 0, data: new Uint8Array(PNG_1x1), width: 1, height: Number.NaN },
      { beforeRun: 0, data: new Uint8Array(PNG_1x1), width: 1, height: 1, align: 'middle' },
    ]) {
      expect(() => place([bad]), JSON.stringify(bad)).toThrow(TypeError);
    }
  });

  it('leaves an atomic-free paragraph exactly as it was', () => {
    const page = place(undefined);
    expect(content(page)).not.toMatch(/ Do/);
    expect(page.GetText()).toContain('before');
  });
});
