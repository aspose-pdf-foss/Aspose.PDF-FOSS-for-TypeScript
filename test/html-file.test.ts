import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { htmlFileToPdf } from '../src/node.js';
import { Document } from '../src/document.js';
import { buildPngRgb } from './helpers/build-embed-images.js';

let dir = '';

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'html-file-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** ASCII text as bytes, so a fixture can carry non-UTF-8 bytes beside it. */
const a = (s: string): Uint8Array => Uint8Array.from([...s], (c) => c.charCodeAt(0));

const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/** Three bytes that are not valid UTF-8, and that decode differently under
 *  every encoding these tests reach.
 *
 *  Both spellings used here are deliberately WinAnsi-representable. The
 *  obvious fixture — 'При' in windows-1251 — decodes perfectly and then makes
 *  the FLOW throw, because a character outside WinAnsi has no glyph in the
 *  Standard-14 fallback. That is a pre-existing defect in the HTML render path
 *  (`doc.AddHtml('<p>При</p>')` throws with no bytes involved at all), filed
 *  as zch2.13; testing the encoding through it would measure the wrong thing.
 *  The Cyrillic cases live in `html-parse-bytes.test.ts`, which only parses. */
const TRIPLE = Uint8Array.from([0xCF, 0xF0, 0xE8]);
const AS_1252 = 'Ïðè';
const AS_MAC = 'œË';

const pageText = async (path: string): Promise<string> => {
  const doc = Document.Open(new Uint8Array(await readFile(path)));
  return doc.Pages.map((p) => p.GetText()).join('\n');
};

describe('htmlFileToPdf', () => {
  it('renders an HTML file to a PDF on disk', async () => {
    const src = join(dir, 'page.html');
    const out = join(dir, 'out.pdf');
    await writeFile(src, '<p>alpha bravo</p>');

    await htmlFileToPdf(src, out);

    expect(await pageText(out)).toContain('alpha bravo');
  });

  it('decodes a legacy file through its own meta charset', async () => {
    // The end-to-end point of zch2.8: read as UTF-8 by a caller, these bytes
    // reach the PDF as three U+FFFD.
    const src = join(dir, 'legacy.html');
    const out = join(dir, 'out.pdf');
    await writeFile(src, cat(a('<meta charset="windows-1252"><p>'), TRIPLE));

    await htmlFileToPdf(src, out);

    expect(await pageText(out)).toContain(AS_1252);
  });

  it('lets an explicit encoding outrank the file\'s own meta', async () => {
    const src = join(dir, 'legacy.html');
    const out = join(dir, 'out.pdf');
    await writeFile(src, cat(a('<meta charset="windows-1252"><p>'), TRIPLE));

    await htmlFileToPdf(src, out, { encoding: 'macintosh' });

    expect(await pageText(out)).toContain(AS_MAC);
  });

  it('resolves a relative img src from a sibling file', async () => {
    const src = join(dir, 'page.html');
    const out = join(dir, 'out.pdf');
    await writeFile(join(dir, 'logo.png'), buildPngRgb());
    await writeFile(src, '<p>x</p><img src="logo.png" alt="a logo">');

    const { skipped } = await htmlFileToPdf(src, out);

    expect(skipped.filter((s) => s.construct === 'image')).toHaveLength(0);
  });

  it('resolves a src in a subdirectory of the input', async () => {
    const src = join(dir, 'page.html');
    const out = join(dir, 'out.pdf');
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'assets', 'logo.png'), buildPngRgb());
    await writeFile(src, '<p>x</p><img src="assets/logo.png" alt="a logo">');

    const { skipped } = await htmlFileToPdf(src, out);

    expect(skipped.filter((s) => s.construct === 'image')).toHaveLength(0);
  });

  it('refuses a src that escapes the input directory', async () => {
    // The confinement, and the only rule here with a security argument: a
    // document we did not write must not name arbitrary paths.
    const inner = join(dir, 'site');
    await mkdir(inner);
    await writeFile(join(dir, 'secret.png'), buildPngRgb());
    const src = join(inner, 'page.html');
    const out = join(dir, 'out.pdf');
    await writeFile(src, '<p>x</p><img src="../secret.png" alt="escapes">');

    const { skipped } = await htmlFileToPdf(src, out);

    expect(skipped.filter((s) => s.construct === 'image')).toHaveLength(1);
  });

  it('refuses an absolute src', async () => {
    const abs = join(dir, 'logo.png');
    await writeFile(abs, buildPngRgb());
    const inner = join(dir, 'site');
    await mkdir(inner);
    const src = join(inner, 'page.html');
    const out = join(dir, 'out.pdf');
    await writeFile(src, `<p>x</p><img src="${abs.replace(/\\/g, '/')}" alt="absolute">`);

    const { skipped } = await htmlFileToPdf(src, out);

    expect(skipped.filter((s) => s.construct === 'image')).toHaveLength(1);
  });

  it('refuses a src carrying a URL scheme', async () => {
    const src = join(dir, 'page.html');
    const out = join(dir, 'out.pdf');
    await writeFile(join(dir, 'logo.png'), buildPngRgb());
    await writeFile(src, '<p>x</p><img src="https://example.com/logo.png" alt="remote">');

    const { skipped } = await htmlFileToPdf(src, out);

    // The library touches no network, and a scheme must not be mistaken for a
    // relative path on the way to the filesystem.
    expect(skipped.filter((s) => s.construct === 'image')).toHaveLength(1);
  });

  it('still decodes a data: URI, which needs no resolver at all', async () => {
    const src = join(dir, 'page.html');
    const out = join(dir, 'out.pdf');
    const b64 = Buffer.from(buildPngRgb()).toString('base64');
    await writeFile(src, `<p>x</p><img src="data:image/png;base64,${b64}" alt="inline">`);

    const { skipped } = await htmlFileToPdf(src, out);

    expect(skipped.filter((s) => s.construct === 'image')).toHaveLength(0);
  });

  it('lets a caller-supplied resolveImage win outright', async () => {
    const src = join(dir, 'page.html');
    const out = join(dir, 'out.pdf');
    // No file on disk at all: only the caller's resolver can answer.
    await writeFile(src, '<p>x</p><img src="anything.png" alt="from the caller">');

    const asked: string[] = [];
    const { skipped } = await htmlFileToPdf(src, out, {
      resolveImage: (s) => { asked.push(s); return buildPngRgb(); },
    });

    expect(asked).toEqual(['anything.png']);
    expect(skipped.filter((s) => s.construct === 'image')).toHaveLength(0);
  });

  it('adopts the document title', async () => {
    const src = join(dir, 'page.html');
    const out = join(dir, 'out.pdf');
    await writeFile(src, '<title>Quarterly report</title><p>x</p>');

    await htmlFileToPdf(src, out);

    const doc = Document.Open(new Uint8Array(await readFile(out)));
    expect(doc.GetMetadata().title).toBe('Quarterly report');
  });
});
