import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Document, SplitOptions } from './document.js';
import { Metadata, MetadataUpdate } from './metadata.js';
import { ImageOptions } from './raster.js';
import type { ExportFormDataOptions, ImportOptions, ImportReport } from './formdata.js';
import type { MarkdownExportOptions } from './mdexport.js';
import type { DocxOptions } from './docxexport.js';
import { parseHtmlBytes } from './htmltree.js';
import type { HtmlFlowOptions } from './htmlflow.js';
import type { FlowOptions } from './flow.js';
import type { NotRendered } from './htmlreport.js';
import type { UnsupportedDeclaration } from './cssprop.js';

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

/** How {@link htmlFileToPdf} reads, renders and resolves. Everything
 *  `doc.AddHtml` takes — the HTML options plus the flow's page geometry — and
 *  two things only a FILE has: the bytes' encoding, and a directory to resolve
 *  a relative `<img src>` against. */
export interface HtmlFileOptions extends HtmlFlowOptions, FlowOptions {
  /** Document title. Non-empty. Default: the source's own `<title>`. */
  title?: string;
  /** The encoding to decode the file with — from an HTTP header, say, or a
   *  caller who simply knows. Outranks the document's own `<meta>`; only a
   *  byte order mark beats it. A label no encoding claims is ignored. */
  encoding?: string;
}

/** Read an HTML file from disk, render it, and write the PDF to `outPath`.
 *  The one-call form of `parseHtmlBytes` + `Document.New` + `AddHtml` + `Save`
 *  — and the only entry point in this library that reads HTML from a file.
 *
 *  The encoding is worked out from the bytes the way HTML Standard §13.2.3
 *  says to: a byte order mark, else `options.encoding`, else UTF-8 corrected
 *  by the document's own `<meta charset>`. That is the whole reason a file
 *  entry point is worth having — a caller doing `readFile(p, 'utf8')` on a
 *  legacy page gets silent mojibake all the way into the PDF, and the caller
 *  is precisely the party who does not know the encoding.
 *
 *  A relative `<img src>` is read from beside the HTML file unless the caller
 *  supplies its own `resolveImage`, which always wins. That resolution is
 *  CONFINED to the input's own directory: a URL scheme, an absolute path, and
 *  anything that climbs out with `..` are all refused, and refused images are
 *  reported in `skipped` like any other construct that did not render. The
 *  library still touches no network — `https:` is declined, not fetched.
 *
 *  Returns what did not render, exactly as the three in-memory entry points
 *  do. */
export async function htmlFileToPdf(
  inputPath: string,
  outPath: string,
  options: HtmlFileOptions = {},
): Promise<{ skipped: NotRendered[]; unsupported: UnsupportedDeclaration[] }> {
  // `encoding` is ours and `resolveImage` gets a default, so both are taken
  // out before the rest is forwarded — the destructure-it-out rule textedit.ts
  // already follows for `region`, so a key we own cannot reach a consumer that
  // would silently accept it.
  const { encoding, resolveImage, ...flow } = options;
  const bytes = new Uint8Array(await readFile(inputPath));
  const tree = parseHtmlBytes(bytes, { encoding });
  const doc = Document.New();
  const { skipped, unsupported } = doc.AddHtml(tree, {
    ...flow,
    resolveImage: resolveImage ?? siblingImages(dirname(resolve(inputPath))),
  });
  await mkdir(dirname(resolve(outPath)), { recursive: true });
  await writeFile(outPath, doc.Save());
  return { skipped, unsupported };
}

/** Read an image from beside the HTML file, for a src that stays inside it. */
function siblingImages(base: string): (src: string, alt: string) => Uint8Array | undefined {
  return (src) => {
    const path = confinedPath(base, src);
    if (path === undefined) return undefined;
    try {
      return new Uint8Array(readFileSync(path));
    } catch {
      // A src naming nothing readable is an image we could not resolve, which
      // `skipped` already has a vocabulary for. It is never an exception.
      return undefined;
    }
  };
}

/** `src` resolved against `base`, or `undefined` if it does not stay there.
 *
 *  Three refusals, and each is a different mistake. A URL SCHEME is not a path
 *  at all — `https:` must be declined rather than fetched, and on Windows a
 *  drive letter matches this too, which is the answer we want. An ABSOLUTE
 *  path ignores `base` outright. And a path that climbs out with `..` is the
 *  one that looks relative and is not: it is checked AFTER resolution, since
 *  `a/../../b` escapes while starting with neither `/` nor `..`.
 *
 *  Note, measured, and it covers NOTHING: deleting the SCHEME test reddens no
 *  case at all. `resolve(base, 'https://example.com/logo.png')` yields a path
 *  INSIDE `base` (a directory literally named `https:`), so the confinement
 *  admits it and the read then fails because no such file exists — the same
 *  `undefined`, by luck rather than by rule. It is retained because "no file
 *  is there" is not a safety property and because declining a scheme outright
 *  is the honest statement of "this library fetches nothing"; a colon is
 *  illegal in a Windows filename, so no portable fixture can separate the two.
 *  Do not read the green suite as covering that line. */
function confinedPath(base: string, src: string): string | undefined {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(src)) return undefined;
  if (src.startsWith('/') || src.startsWith('\\') || isAbsolute(src)) return undefined;
  const target = resolve(base, src);
  const rel = relative(base, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return target;
}
