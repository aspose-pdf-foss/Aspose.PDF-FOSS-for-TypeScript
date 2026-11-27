import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { clearMetadataFile, saveDocxFile } from '../src/node.js';
import { Document } from '../src/document.js';
import { buildClassicPdf } from './helpers/build-pdf.js';

vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename), link: vi.fn(actual.link),
    unlink: vi.fn(actual.unlink) };
});
const actual = await vi.importActual<typeof fs>('node:fs/promises');
const original = Buffer.from('previous destination bytes');
let dir: string;
let input: string;
let output: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'node-staged-output-'));
  input = join(dir, 'input.pdf');
  output = join(dir, 'out.pdf');
  await fs.writeFile(input, buildClassicPdf(2));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.open).mockImplementation(actual.open);
  vi.mocked(fs.link).mockImplementation(actual.link);
  vi.mocked(fs.rename).mockImplementation(actual.rename);
  vi.mocked(fs.unlink).mockImplementation(actual.unlink);
  await fs.rm(dir, { recursive: true, force: true });
});

it.each(['write', 'flush', 'rename'])('preserves the original PDF and removes the sibling on %s failure', async (op) => {
  await fs.writeFile(output, original);
  const error = new Error(op + ' failed');
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const fd = await actual.open(path, flags, mode);
    if (flags === 'wx' && op === 'write') {
      vi.spyOn(fd, 'writeFile').mockImplementation(async () => { await fd.write('partial'); throw error; });
    }
    if (flags === 'wx' && op === 'flush') vi.spyOn(fd, 'sync').mockRejectedValueOnce(error);
    return fd;
  });
  if (op === 'rename') vi.mocked(fs.rename).mockRejectedValueOnce(error);
  await expect(clearMetadataFile(input, output)).rejects.toBe(error);
  expect(await fs.readFile(output)).toEqual(original);
  expect((await fs.readdir(dir)).sort()).toEqual(['input.pdf', 'out.pdf']);
});

it('keeps an occupied dangling symlink and creates no target', async (ctx) => {
  try {
    await fs.symlink('missing.pdf', output, 'file');
  } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return ctx.skip();
    throw error;
  }
  await expect(clearMetadataFile(input, output, { overwrite: false })).rejects.toMatchObject({ code: 'EEXIST' });
  expect((await fs.lstat(output)).isSymbolicLink()).toBe(true);
  expect((await fs.readdir(dir)).sort()).toEqual(['input.pdf', 'out.pdf']);
  await clearMetadataFile(input, output);
  expect((await fs.lstat(output)).isSymbolicLink()).toBe(true);
  expect(Document.Open(await fs.readFile(join(dir, 'missing.pdf'))).Pages).toHaveLength(2);
});

it('publishes only complete files and propagates a hard-link failure without a fallback', async () => {
  const error = Object.assign(new Error('hard links unavailable'), { code: 'ENOTSUP' });
  vi.mocked(fs.link).mockImplementationOnce(async (stage, target) => {
    expect(await fs.realpath(dirname(String(stage)))).toBe(await fs.realpath(dir));
    expect(basename(String(target))).toBe('out.pdf');
    expect(Document.Open(await fs.readFile(stage)).Pages).toHaveLength(2);
    throw error;
  });
  await expect(clearMetadataFile(input, output, { overwrite: false })).rejects.toBe(error);
  expect(await fs.readdir(dir)).toEqual(['input.pdf']);
});

it('preserves a competitor that claims the destination immediately before publication', async () => {
  vi.mocked(fs.link).mockImplementationOnce(async (stage, target) => {
    await fs.writeFile(output, original, { flag: 'wx' });
    await actual.link(stage, target);
  });
  await expect(clearMetadataFile(input, output, { overwrite: false })).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await fs.readFile(output)).toEqual(original);
  expect((await fs.readdir(dir)).sort()).toEqual(['input.pdf', 'out.pdf']);
});

it('replaces only the requested hard link and preserves its POSIX access mode', async () => {
  await fs.writeFile(output, original);
  if (process.platform !== 'win32') await fs.chmod(output, 0o640);
  const alias = join(dir, 'alias.pdf');
  await actual.link(output, alias);
  await clearMetadataFile(input, output);
  expect(await fs.readFile(alias)).toEqual(original);
  expect(Document.Open(await fs.readFile(output)).Pages).toHaveLength(2);
  if (process.platform !== 'win32') expect((await fs.stat(output)).mode & 0o777).toBe(0o640);
});

it('reports that the exclusive destination was published if removing its sibling fails', async () => {
  const error = Object.assign(new Error('unlink denied'), { code: 'EPERM' });
  vi.mocked(fs.unlink).mockRejectedValueOnce(error);
  await expect(clearMetadataFile(input, output, { overwrite: false })).rejects.toMatchObject({
    message: expect.stringContaining('published'), cause: error,
  });
  expect(Document.Open(await fs.readFile(output)).Pages).toHaveLength(2);
});

it('retains the publication and cleanup errors when both fail', async () => {
  const conflict = Object.assign(new Error('occupied'), { code: 'EEXIST' });
  const denied = new Error('unlink denied');
  vi.mocked(fs.link).mockRejectedValueOnce(conflict);
  vi.mocked(fs.unlink).mockRejectedValueOnce(denied);
  await expect(clearMetadataFile(input, output, { overwrite: false })).rejects.toMatchObject({
    code: 'EEXIST', errors: [conflict, denied],
  });
});

it('discards a flushed sibling if cancellation arrives during staging', async () => {
  await fs.writeFile(output, original);
  const controller = new AbortController();
  const reason = new Error('cancelled while flushing');
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const fd = await actual.open(path, flags, mode);
    if (flags === 'wx') {
      const sync = fd.sync.bind(fd);
      vi.spyOn(fd, 'sync').mockImplementation(async () => { await sync(); controller.abort(reason); });
    }
    return fd;
  });
  await expect(saveDocxFile(input, output, { signal: controller.signal })).rejects.toBe(reason);
  expect(await fs.readFile(output)).toEqual(original);
  expect((await fs.readdir(dir)).sort()).toEqual(['input.pdf', 'out.pdf']);
});
