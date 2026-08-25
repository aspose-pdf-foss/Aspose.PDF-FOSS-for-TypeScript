import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitPdfFile } from '../src/node.js';
import { buildClassicPdf } from './helpers/build-pdf.js';

const dir = mkdtempSync(join(tmpdir(), 'pdfsplit-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('splitPdfFile', () => {
  it('writes one file per page', async () => {
    const input = join(dir, 'in.pdf');
    writeFileSync(input, buildClassicPdf(2));
    const outDir = join(dir, 'out');
    const written = await splitPdfFile(input, outDir);
    expect(written.length).toBe(2);
    expect(readdirSync(outDir).sort()).toEqual(['page-1.pdf', 'page-2.pdf']);
  });
});
