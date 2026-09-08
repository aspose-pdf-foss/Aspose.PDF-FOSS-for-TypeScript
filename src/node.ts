import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Document, SplitOptions } from './document.js';
import { Metadata, MetadataUpdate } from './metadata.js';
import { ImageOptions } from './raster.js';
import { imageExtension, imageKey, type SaveImageOptions } from './imagehref.js';
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

/** How {@link saveImagesFile} encodes what it writes: {@link ImageInfo.Save}'s
 *  options, forwarded verbatim, so this module invents no image vocabulary of
 *  its own. */
export type SaveImagesOptions = SaveImageOptions;

/** One image the extraction could not write, and why. */
export interface SkippedImage {
  /** 0-based index of the page whose resources reached it. */
  page: number;
  /** Its resource key on that page, e.g. `Im0`. Unique within one resource
   *  dictionary, which is why it names an image here rather than a file. */
  name: string;
  /** What went wrong, from the encoder. */
  reason: string;
}

/** Read a PDF from disk and write every image it embeds into `outDir` as a
 *  file, returning the paths written and the images that could not be.
 *
 *  Names are `img-1`, `img-2`, … in document order, and **the extension always
 *  comes from the media type the encoder reports, never from the source image**
 *  — that one step is what the wrapper exists to get right, since JPEG bytes
 *  written under `.png` give a file no viewer opens. Encoding is
 *  {@link ImageInfo.Save}'s: faithful by default, so an unmasked `DCTDecode`
 *  is extracted byte for byte with no generation loss; pass `format` to force
 *  one.
 *
 *  **One file per DISTINCT picture.** Identity is a hash of the encoded bytes
 *  ({@link imageKey}), not the stream object, so a logo drawn on forty pages —
 *  or a merged document holding forty copies of it — is written once. This is
 *  the rule the Markdown and `.docx` exports already use for the same reason.
 *
 *  A picture that will not encode costs ITSELF and not the run: it lands in
 *  `skipped` and its neighbours are still written, which is `encodeImage`'s
 *  posture rather than `ImageInfo.Save`'s — a caller asking about ONE image
 *  wants to be told, and a caller asking for all of them wants the other 199.
 *  A document with no images is not a failure: it returns two empty arrays and
 *  an empty directory, which is a true answer.
 *
 *  **Inline `BI … EI` images are out of reach**, not silently missed:
 *  `page.Images` structurally never sees one, since an inline image occupies
 *  no `/XObject` entry, and `InlineImageInfo` has no `Save`. */
export async function saveImagesFile(
  inputPath: string,
  outDir: string,
  options?: SaveImagesOptions,
): Promise<{ written: string[]; skipped: SkippedImage[] }> {
  const input = new Uint8Array(await readFile(inputPath));
  const doc = Document.Open(input);
  await mkdir(outDir, { recursive: true });

  const seen = new Set<string>();
  const written: string[] = [];
  const skipped: SkippedImage[] = [];

  const pages = doc.Pages;
  for (let i = 0; i < pages.length; i++) {
    for (const image of pages[i].Images) {
      let enc;
      try {
        enc = image.Save(options);
      } catch (e) {
        skipped.push({ page: i, name: image.Name, reason: (e as Error).message });
        continue;
      }
      const key = imageKey(enc.bytes);
      if (seen.has(key)) continue;
      seen.add(key);
      const p = join(outDir, `img-${written.length + 1}.${imageExtension(enc.mediaType)}`);
      await writeFile(p, enc.bytes);
      written.push(p);
    }
  }
  return { written, skipped };
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
