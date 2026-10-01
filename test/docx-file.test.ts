import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { docxFileToPdf, Document } from '../src/index.js';
import { buildDocx } from './helpers/build-docx.js';
import { p, r } from './helpers/wml.js';

describe('docxFileToPdf', () => {
  it('reads a .docx, writes the PDF, and returns what did not render', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'docx-'));
    const input = join(dir, 'in.docx'); const output = join(dir, 'out', 'o.pdf');
    writeFileSync(input, buildDocx(p(r('From a file.')) + p('<w:r><w:footnoteReference w:id="1"/></w:r>'),
      { core: '<dc:title>Filed</dc:title>' }));
    const { skipped } = await docxFileToPdf(input, output);
    expect(skipped).toContainEqual({ name: 'w:footnoteReference', count: 1, kind: 'dropped' });
    const out = Document.Open(new Uint8Array(readFileSync(output)));
    expect(out.Pages[0].GetText()).toContain('From a file.');
    expect(out.GetMetadata().title).toBe('Filed');
  });
});
