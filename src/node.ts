import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Document, SplitOptions } from './document.js';
import { Metadata, MetadataUpdate } from './metadata.js';
import { ImageOptions } from './raster.js';
import type { ExportFormDataOptions, ImportOptions, ImportReport } from './formdata.js';
import type { MarkdownExportOptions } from './mdexport.js';
import type { DocxOptions } from './docxexport.js';

/** Read a PDF from disk, split it, and write `page-N.pdf` files into `outDir`. */
export async function splitPdfFile(inputPath: string, outDir: string, options?: SplitOptions): Promise<string[]> {
  const input = new Uint8Array(await readFile(inputPath));
  const docs = Document.Open(input).Split(options);
  await mkdir(outDir, { recursive: true });
  const paths: string[] = [];
  for (let i = 0; i < docs.length; i++) {
    const p = join(outDir, `page-${i + 1}.pdf`);
    await writeFile(p, docs[i].Save());
    paths.push(p);
  }
  return paths;
}

/** Read a PDF from disk, render page `pageIndex` (0-based) to a PNG, and write
 *  it to `outPath`. See `Page.ToImage` for the option semantics. */
export async function savePageImageFile(
  inputPath: string,
  pageIndex: number,
  outPath: string,
  options?: ImageOptions,
): Promise<void> {
  const input = new Uint8Array(await readFile(inputPath));
  const doc = Document.Open(input);
  const png = doc.Pages[pageIndex].ToImage(options);
  await writeFile(outPath, png);
}

/** Read a PDF from disk, export it to Markdown, and write it to `outPath`.
 *
 *  With `images: 'external'` each distinct image is written beside the Markdown
 *  at the path the document references — `images/img-1.png` relative to
 *  `outPath`'s own directory, so the file is portable as a folder. Returns every
 *  path written, the Markdown first. */
export async function saveMarkdownFile(
  inputPath: string,
  outPath: string,
  options?: MarkdownExportOptions,
): Promise<string[]> {
  const input = new Uint8Array(await readFile(inputPath));
  const { markdown, images } = Document.Open(input).ToMarkdownAssets(options);
  const base = dirname(outPath);
  await mkdir(base, { recursive: true });
  await writeFile(outPath, markdown);
  const written = [outPath];
  for (const img of images) {
    const p = join(base, img.path);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, img.bytes);
    written.push(p);
  }
  return written;
}

/** Read a PDF from disk, export it to a `.docx`, and write it to `outPath`.
 *
 *  Unlike `saveMarkdownFile` there are no sidecar files to write: a `.docx`
 *  carries its own images inside the package. */
export async function saveDocxFile(
  inputPath: string, outPath: string, options?: DocxOptions,
): Promise<void> {
  const input = new Uint8Array(await readFile(inputPath));
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, Document.Open(input).ToDocx(options));
}

/** Read a PDF from disk and return its document metadata (/Info). */
export async function readMetadataFile(inputPath: string): Promise<Metadata> {
  const input = new Uint8Array(await readFile(inputPath));
  return Document.Open(input).GetMetadata();
}

/**
 * Read a PDF, merge `update` into its metadata, and write the result to
 * `outputPath`. undefined leaves a field unchanged, null deletes it, a value sets it.
 */
export async function updateMetadataFile(
  inputPath: string,
  outputPath: string,
  update: MetadataUpdate,
): Promise<void> {
  const input = new Uint8Array(await readFile(inputPath));
  const doc = Document.Open(input);
  doc.SetMetadata(update);
  await writeFile(outputPath, doc.Save());
}

/** Read a PDF, remove all document metadata, and write the result to `outputPath`. */
export async function clearMetadataFile(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  const input = new Uint8Array(await readFile(inputPath));
  const doc = Document.Open(input);
  doc.ClearMetadata();
  await writeFile(outputPath, doc.Save());
}

/** Read a PDF from disk and write its form-field values to `fdfPath` as FDF. */
export async function exportFdfFile(
  pdfPath: string,
  fdfPath: string,
  options?: ExportFormDataOptions,
): Promise<void> {
  const doc = Document.Open(new Uint8Array(await readFile(pdfPath)));
  await writeFile(fdfPath, doc.ExportFdf(options));
}

/** Read a PDF from disk and write its form-field values to `xfdfPath` as XFDF. */
export async function exportXfdfFile(
  pdfPath: string,
  xfdfPath: string,
  options?: ExportFormDataOptions,
): Promise<void> {
  const doc = Document.Open(new Uint8Array(await readFile(pdfPath)));
  await writeFile(xfdfPath, doc.ExportXfdf(options));
}

/** Import FDF field values into a PDF on disk. Writes to `outPath`, which
 *  defaults to `pdfPath` (in-place rewrite). */
export async function importFdfFile(
  pdfPath: string,
  fdfPath: string,
  outPath = pdfPath,
  options?: ImportOptions,
): Promise<ImportReport> {
  const doc = Document.Open(new Uint8Array(await readFile(pdfPath)));
  const report = doc.ImportFdf(new Uint8Array(await readFile(fdfPath)), options);
  await writeFile(outPath, doc.Save());
  return report;
}

/** Import XFDF field values into a PDF on disk. See importFdfFile. */
export async function importXfdfFile(
  pdfPath: string,
  xfdfPath: string,
  outPath = pdfPath,
  options?: ImportOptions,
): Promise<ImportReport> {
  const doc = Document.Open(new Uint8Array(await readFile(pdfPath)));
  const report = doc.ImportXfdf(new Uint8Array(await readFile(xfdfPath)), options);
  await writeFile(outPath, doc.Save());
  return report;
}
