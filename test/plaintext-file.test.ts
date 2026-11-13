import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document, textFileToPdf, PdfParseError, UnsupportedFeatureError } from '../src/index.js';

async function files(run: (input: string, output: string, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'plain-text-'));
  try { await run(join(dir, 'input.txt'), join(dir, 'out', 'output.pdf'), dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
const texts = (bytes: Uint8Array) => Document.Open(bytes).Pages.map((p) => p.GetText().trimEnd());

describe('textFileToPdf (nh1t.5)', () => {
  it('reads UTF-8, creates output directories and writes the paginated PDF', async () => files(async (input, output) => {
    await writeFile(input, 'literal <b>&\r\nnext\fpage two');
    await textFileToPdf(input, output, { title: 'Imported file' });
    const bytes = await readFile(output);
    expect(texts(bytes)).toEqual(['literal <b>&\nnext', 'page two']);
    expect(Document.Open(bytes).GetMetadata().title).toBe('Imported file');
  }));

  it.each([
    ['UTF-8', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('café')]), ['café']],
    ['UTF-16LE', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('A\fB', 'utf16le')]), ['A', 'B']],
    ['UTF-16BE', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('A\fB', 'utf16le').swap16()]), ['A', 'B']],
  ] as const)('lets a %s BOM outrank an explicit encoding', async (_name, bytes, expected) => files(async (input, output) => {
    await writeFile(input, bytes);
    await textFileToPdf(input, output, { encoding: 'windows-1252' });
    expect(texts(await readFile(output))).toEqual(expected);
  }));

  it('accepts an explicit legacy encoding without a BOM', async () => files(async (input, output) => {
    await writeFile(input, Buffer.from([99, 97, 102, 233]));
    await textFileToPdf(input, output, { encoding: 'windows-1252' });
    expect(texts(await readFile(output))).toEqual(['café']);
  }));

  it('registers fontData in the output document for Unicode text', async () => files(async (input, output) => {
    await writeFile(input, 'Привет');
    await textFileToPdf(input, output, { fontData: new Uint8Array(await readFile('fonts/LiberationMono-Regular.ttf')) });
    expect(texts(await readFile(output))).toEqual(['Привет']);
  }));

  it('does not replace an existing output when the font cannot draw the input', async () => files(async (input, _output, dir) => {
    const output = join(dir, 'existing.pdf');
    await writeFile(input, 'Ж');
    await writeFile(output, 'keep this');
    await expect(textFileToPdf(input, output)).rejects.toBeInstanceOf(UnsupportedFeatureError);
    expect(await readFile(output, 'utf8')).toBe('keep this');
  }));

  it('rejects malformed UTF-8 before creating an output directory', async () => files(async (input, output, dir) => {
    await writeFile(input, Buffer.from([0xc3, 0x28]));
    await expect(textFileToPdf(input, output)).rejects.toBeInstanceOf(PdfParseError);
    await expect(access(join(dir, 'out'))).rejects.toMatchObject({ code: 'ENOENT' });
  }));

  it('rejects an unknown encoding label', async () => files(async (input, output) => {
    await writeFile(input, 'a');
    await expect(textFileToPdf(input, output, { encoding: 'unknown-text-encoding' })).rejects.toBeInstanceOf(TypeError);
  }));

  it('rejects conflicting font options before writing', async () => files(async (input, output) => {
    await writeFile(input, 'a');
    await expect(textFileToPdf(input, output, { font: 'Courier', fontData: new Uint8Array() })).rejects.toBeInstanceOf(TypeError);
  }));

  it('writes one blank page for an empty file', async () => files(async (input, output) => {
    await writeFile(input, '');
    await textFileToPdf(input, output);
    expect(texts(await readFile(output))).toEqual(['']);
  }));

  it('honors cancellation before reading a missing file', async () => files(async (input, output) => {
    const reason = new Error('cancel before I/O');
    await expect(textFileToPdf(input, output, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
  }));

  it('captures controls once across rendering and saving', async () => files(async (input, output) => {
    await writeFile(input, 'a\fb');
    let calls = 0;
    const options = {
      signal: new AbortController().signal,
      onProgress: () => {
        calls++;
        options.signal = AbortSignal.abort(new Error('replacement signal'));
        options.onProgress = () => { throw new Error('replacement callback'); };
      },
    };
    await textFileToPdf(input, output, options);
    expect(texts(await readFile(output))).toEqual(['a', 'b']);
    expect(calls).toBeGreaterThan(1);
  }));
});
