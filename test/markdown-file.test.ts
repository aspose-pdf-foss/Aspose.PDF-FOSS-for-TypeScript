import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveMarkdownFile } from '../src/node.js';
import { buildTextAndImagePage } from './helpers/build-edit-pdf.js';

const FIGURE_PAGE = 'BT /F1 10 Tf 50 250 Td (caption) Tj ET q 100 0 0 100 50 50 cm /Im0 Do Q';

/** A temp directory holding `in.pdf`, and its path. */
async function fixture(): Promise<{ dir: string; pdf: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'md-export-'));
  const pdf = join(dir, 'in.pdf');
  await writeFile(pdf, buildTextAndImagePage(FIGURE_PAGE));
  return { dir, pdf };
}

describe('saveMarkdownFile', () => {
  it('writes the markdown and its images, returning every path', async () => {
    const { dir, pdf } = await fixture();
    try {
      const out = join(dir, 'out', 'doc.md');
      const written = await saveMarkdownFile(pdf, out, { images: 'external' });

      expect(written[0]).toBe(out);
      expect(written).toHaveLength(2);

      const md = await readFile(out, 'utf8');
      expect(md).toContain('](images/img-1.png)');

      // The image path in the Markdown is relative to the Markdown itself.
      const png = await readFile(join(dir, 'out', 'images', 'img-1.png'));
      expect(Array.from(png.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes only the markdown when images are inline', async () => {
    const { dir, pdf } = await fixture();
    try {
      const out = join(dir, 'doc.md');
      const written = await saveMarkdownFile(pdf, out);
      expect(written).toEqual([out]);
      expect(await readFile(out, 'utf8')).toContain('data:image/png;base64,');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
