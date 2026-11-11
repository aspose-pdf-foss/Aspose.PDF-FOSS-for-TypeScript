import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { savePageImageFile, saveMarkdownFile, saveDocxFile, htmlFileToPdf, docxFileToPdf } from '../src/node.js';
import type { OperationControlOptions } from '../src/checkpoint.js';
import { buildTextAndImagePage } from './helpers/build-edit-pdf.js';
import { buildDocx } from './helpers/build-docx.js';
import { Document } from '../src/document.js';

const cases = [
  { name: 'savePageImageFile', source: 'source.pdf', out: 'out.png', run: (src: string, out: string, o: OperationControlOptions) => savePageImageFile(src, 0, out, o) },
  { name: 'saveMarkdownFile', source: 'source.pdf', out: 'out.md', run: (src: string, out: string, o: OperationControlOptions) => saveMarkdownFile(src, out, { images: 'external', ...o }) },
  { name: 'saveDocxFile', source: 'source.pdf', out: 'out.docx', run: (src: string, out: string, o: OperationControlOptions) => saveDocxFile(src, out, o) },
  { name: 'htmlFileToPdf', source: 'source.html', out: 'out.pdf', run: (src: string, out: string, o: OperationControlOptions) => htmlFileToPdf(src, out, o) },
  { name: 'docxFileToPdf', source: 'source.docx', out: 'out.pdf', run: (src: string, out: string, o: OperationControlOptions) => docxFileToPdf(src, out, o) },
];

describe('controlled Node conversion helpers', () => {
  for (const c of cases) it(`${c.name} stops before writes and preserves successful output`, async () => {
    const parent = resolve(tmpdir()), dir = await mkdtemp(join(parent, 'pdf4ts-control-'));
    if (!resolve(dir).startsWith(parent + sep)) throw new Error('Unexpected test directory');
    try {
      await writeFile(join(dir, 'source.pdf'), buildTextAndImagePage('BT /F1 12 Tf 20 100 Td (First) Tj ET q 30 0 0 30 10 10 cm /Im0 Do Q'));
      await writeFile(join(dir, 'source.html'), '<p>First paragraph.</p><p>Second paragraph.</p>');
      await writeFile(join(dir, 'source.docx'), buildDocx('<w:p><w:r><w:t>First paragraph.</w:t></w:r></w:p>'));
      const out = join(dir, c.out), reason = new Error('cancelled');
      await writeFile(out, 'sentinel');
      const before = (await readdir(dir)).sort();
      await expect(c.run(join(dir, 'missing'), out, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
      const controller = new AbortController();
      let handle: NodeJS.Immediate | undefined;
      try {
        await expect(c.run(join(dir, c.source), out, { signal: controller.signal, onProgress: () => {
          handle = setImmediate(() => controller.abort(reason));
        } })).rejects.toBe(reason);
      } finally { if (handle) clearImmediate(handle); }
      expect(await readFile(out, 'utf8')).toBe('sentinel');
      expect((await readdir(dir)).sort()).toEqual(before);
      await c.run(join(dir, c.source), out, {});
      const result = await readFile(out);
      expect(result.length).toBeGreaterThan(8);
      if (c.out.endsWith('.pdf')) expect(Document.Open(result).Pages.length).toBeGreaterThan(0);
      let calls = 0;
      const options: { signal: AbortSignal; onProgress: () => void } = {
        signal: new AbortController().signal,
        onProgress: () => {
          calls++;
          options.signal = AbortSignal.abort(new Error('replacement'));
          options.onProgress = () => { throw new Error('replacement callback'); };
        },
      };
      await c.run(join(dir, c.source), out, options);
      expect(calls).toBeGreaterThan(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
