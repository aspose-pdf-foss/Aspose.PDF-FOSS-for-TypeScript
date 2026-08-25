import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document } from '../src/document.js';
import { exportFdfFile, exportXfdfFile, importFdfFile, importXfdfFile } from '../src/node.js';
import { buildFormPdf } from './helpers/build-form-pdf.js';

async function fixture(): Promise<{ dir: string; pdf: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'fdf-'));
  const pdf = join(dir, 'form.pdf');
  const doc = Document.Open(buildFormPdf());
  doc.Form.Get('name')!.Value = 'Ada';
  await writeFile(pdf, doc.Save());
  return { dir, pdf };
}

describe('node form-data wrappers', () => {
  it('exports and re-imports XFDF through the filesystem', async () => {
    const { dir, pdf } = await fixture();
    const data = join(dir, 'out.xfdf');
    await exportXfdfFile(pdf, data);
    expect(new TextDecoder().decode(await readFile(data))).toContain('<value>Ada</value>');

    const target = join(dir, 'blank.pdf');
    await writeFile(target, buildFormPdf());
    const report = await importXfdfFile(target, data);
    expect(report.imported).toContain('name');
    expect(Document.Open(new Uint8Array(await readFile(target))).Form.Get('name')!.Value).toBe('Ada');
  });

  it('exports and re-imports FDF through the filesystem', async () => {
    const { dir, pdf } = await fixture();
    const data = join(dir, 'out.fdf');
    await exportFdfFile(pdf, data);
    expect(new TextDecoder('latin1').decode(await readFile(data))).toContain('%FDF-');

    const target = join(dir, 'blank.pdf');
    await writeFile(target, buildFormPdf());
    await importFdfFile(target, data);
    expect(Document.Open(new Uint8Array(await readFile(target))).Form.Get('name')!.Value).toBe('Ada');
  });

  it('writes to outPath when given, leaving the source untouched', async () => {
    const { dir, pdf } = await fixture();
    const data = join(dir, 'out.xfdf');
    await exportXfdfFile(pdf, data);

    const source = join(dir, 'blank.pdf');
    const out = join(dir, 'filled.pdf');
    await writeFile(source, buildFormPdf());
    await importXfdfFile(source, data, out);
    expect(Document.Open(new Uint8Array(await readFile(source))).Form.Get('name')!.Value).toBe('Bob');
    expect(Document.Open(new Uint8Array(await readFile(out))).Form.Get('name')!.Value).toBe('Ada');
  });

  it('passes export options through', async () => {
    const { dir, pdf } = await fixture();
    const lean = join(dir, 'lean.xfdf');
    const full = join(dir, 'full.xfdf');
    await exportXfdfFile(pdf, lean);
    await exportXfdfFile(pdf, full, { includeEmpty: true });
    expect((await readFile(full)).length).toBeGreaterThan((await readFile(lean)).length);
  });
});
