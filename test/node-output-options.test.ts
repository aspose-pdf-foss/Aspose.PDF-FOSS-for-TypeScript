import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as files from '../src/node.js';
import { Document, type FileOutputOptions } from '../src/index.js';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { buildTextAndImagePage } from './helpers/build-edit-pdf.js';
import { buildDocx } from './helpers/build-docx.js';

let dir: string;
const path = (name: string) => join(dir, name);
const pdf = () => path('source.pdf');

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pdf-output-options-'));
  const bytes = buildTextAndImagePage('BT /F1 10 Tf 50 250 Td (caption) Tj ET q 100 0 0 100 50 50 cm /Im0 Do Q');
  const doc = Document.Open(bytes);
  await Promise.all([
    writeFile(pdf(), bytes),
    writeFile(path('source.fdf'), doc.ExportFdf()),
    writeFile(path('source.xfdf'), doc.ExportXfdf()),
    writeFile(path('source.json'), doc.ExportJson()),
    writeFile(path('source.xml'), doc.ExportXml()),
    writeFile(path('source.txt'), 'Hello'),
    writeFile(path('source.html'), '<p>Hello</p>'),
    writeFile(path('source.docx'), buildDocx('<w:p><w:r><w:t>Hello</w:t></w:r></w:p>')),
  ]);
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

type OutputCase = [string, (out: string, options: FileOutputOptions) => Promise<unknown>];
const singleFiles: OutputCase[] = [
  ['savePageImageFile', (out, o) => files.savePageImageFile(pdf(), 0, out, o)],
  ['saveMarkdownFile', (out, o) => files.saveMarkdownFile(pdf(), out, o)],
  ['saveDocxFile', (out, o) => files.saveDocxFile(pdf(), out, o)],
  ['updateMetadataFile', (out, o) => files.updateMetadataFile(pdf(), out, { title: 'changed' }, o)],
  ['clearMetadataFile', (out, o) => files.clearMetadataFile(pdf(), out, o)],
  ['exportFdfFile', (out, o) => files.exportFdfFile(pdf(), out, o)],
  ['exportXfdfFile', (out, o) => files.exportXfdfFile(pdf(), out, o)],
  ['exportJsonFile', (out, o) => files.exportJsonFile(pdf(), out, o)],
  ['exportXmlFile', (out, o) => files.exportXmlFile(pdf(), out, o)],
  ['importFdfFile', (out, o) => files.importFdfFile(pdf(), path('source.fdf'), out, o)],
  ['importXfdfFile', (out, o) => files.importXfdfFile(pdf(), path('source.xfdf'), out, o)],
  ['importJsonFile', (out, o) => files.importJsonFile(pdf(), path('source.json'), out, o)],
  ['importXmlFile', (out, o) => files.importXmlFile(pdf(), path('source.xml'), out, o)],
  ['textFileToPdf', (out, o) => files.textFileToPdf(path('source.txt'), out, o)],
  ['htmlFileToPdf', (out, o) => files.htmlFileToPdf(path('source.html'), out, o)],
  ['docxFileToPdf', (out, o) => files.docxFileToPdf(path('source.docx'), out, o)],
];

describe('create-only Node outputs', () => {
  it.each(singleFiles)('%s captures overwrite at entry and preserves an occupied destination', async (name, run) => {
    const out = path(name);
    await writeFile(out, 'original');
    const options = { overwrite: false };
    const result = run(out, options);
    options.overwrite = true;
    await expect(result).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(out, 'utf8')).toBe('original');
  });

  it('allows exactly one competing writer to publish a complete PDF', async () => {
    const out = path('race.pdf');
    const titles = ['first', 'second'];
    const results = await Promise.allSettled(titles.map(title =>
      files.updateMetadataFile(pdf(), out, { title }, { overwrite: false })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'EEXIST' } });
    expect((await files.readMetadataFile(out)).title).toBe(titles[results.findIndex(r => r.status === 'fulfilled')]);
  });

  it('retains export options supplied by an instance getter', async () => {
    class ExportOptions {
      overwrite = false;
      #indent = 2;
      get indent() { return this.#indent; }
    }
    const out = path('indented.json');
    await files.exportJsonFile(pdf(), out, new ExportOptions());
    expect(await readFile(out, 'utf8')).toContain('\n  "fields"');
  });

  it('reads a file policy getter only at entry when exporting JSON', async () => {
    let reads = 0;
    const out = path('captured.json');
    await files.exportJsonFile(pdf(), out, {
      get overwrite() {
        if (++reads > 1) throw new Error('file policy read again');
        return false;
      },
    });
    expect(JSON.parse(await readFile(out, 'utf8')).fields).toEqual([]);
    expect(reads).toBe(1);
  });

  it('leaves the first split page and stops at an occupied second page', async () => {
    const source = path('three.pdf'), out = path('split');
    await writeFile(source, buildClassicPdf(3));
    await mkdir(out);
    await writeFile(join(out, 'page-2.pdf'), 'original');
    const options = { overwrite: false };
    const result = files.splitPdfFile(source, out, options);
    options.overwrite = true;
    await expect(result).rejects.toMatchObject({ code: 'EEXIST' });
    expect((await readdir(out)).sort()).toEqual(['page-1.pdf', 'page-2.pdf']);
    expect(Document.Open(await readFile(join(out, 'page-1.pdf'))).Pages).toHaveLength(1);
    expect(await readFile(join(out, 'page-2.pdf'), 'utf8')).toBe('original');
  });

  it('preserves an existing extracted image and rejects the file conflict', async () => {
    const out = path('extract'), image = join(out, 'img-1.png');
    await mkdir(out);
    await writeFile(image, 'original');
    const options = { overwrite: false };
    const result = files.saveImagesFile(pdf(), out, options);
    options.overwrite = true;
    await expect(result).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readdir(out)).toEqual(['img-1.png']);
    expect(await readFile(image, 'utf8')).toBe('original');
  });

  it('leaves the published Markdown and preserves an occupied sidecar', async () => {
    const out = path('sidecars/doc.md'), image = path('sidecars/images/img-1.png');
    await mkdir(dirname(image), { recursive: true });
    await writeFile(image, 'original');
    await expect(files.saveMarkdownFile(pdf(), out, { images: 'external', overwrite: false }))
      .rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(out, 'utf8')).toContain('](images/img-1.png)');
    expect(await readFile(image, 'utf8')).toBe('original');
  });
});
