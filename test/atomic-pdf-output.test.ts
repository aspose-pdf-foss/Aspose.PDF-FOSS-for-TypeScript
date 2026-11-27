import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { Document } from '../src/document.js';
import { buildClassicPdf } from './helpers/build-pdf.js';

vi.mock('node:fs', async (load) => {
  const actual = await load<typeof import('node:fs')>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync),
    fsyncSync: vi.fn(actual.fsyncSync), renameSync: vi.fn(actual.renameSync) };
});
const actual = await vi.importActual<typeof fs>('node:fs');
let dir: string;
let path: string;
const original = Buffer.from(buildClassicPdf(1));
const replacement = () => Document.Open(buildClassicPdf(2));

beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), 'atomic-pdf-'));
  path = join(dir, 'out.pdf');
});
afterEach(() => {
  vi.clearAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

for (const exists of [true, false]) {
  it.each(['write', 'flush', 'rename'])('%s failure preserves the directory when destination exists=' + exists, (op) => {
    if (exists) actual.writeFileSync(path, original);
    const error = new Error('injected ' + op + ' failure');
    if (op === 'write') vi.mocked(fs.writeFileSync).mockImplementationOnce((file) => {
      actual.writeFileSync(file, Buffer.from('%PDF-partial'));
      throw error;
    });
    if (op === 'flush') vi.mocked(fs.fsyncSync).mockImplementationOnce(() => { throw error; });
    if (op === 'rename') vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw error; });
    expect(() => replacement().WriteTo(path)).toThrow(error);
    expect(fs.readdirSync(dir)).toEqual(exists ? ['out.pdf'] : []);
    if (exists) expect(fs.readFileSync(path)).toEqual(original);
  });
}

it('flushes before replacement and publishes a complete PDF in the target directory', () => {
  actual.writeFileSync(path, original);
  const doc = replacement();
  const save = vi.spyOn(doc, 'Save');
  vi.mocked(fs.renameSync).mockImplementationOnce((stage, target) => {
    expect(fs.realpathSync(dirname(String(stage)))).toBe(fs.realpathSync(dir));
    expect(basename(String(stage))).not.toBe(basename(path));
    expect(fs.fsyncSync).toHaveBeenCalledOnce();
    expect(fs.readFileSync(path)).toEqual(original);
    expect(Document.OpenFile(String(stage)).Pages).toHaveLength(2);
    actual.renameSync(stage, target);
  });
  doc.WriteTo(path, { compressed: true });
  expect(save.mock.calls).toEqual([[{ compressed: true }]]);
  expect(fs.renameSync).toHaveBeenCalledOnce();
  expect(Document.OpenFile(path).Pages).toHaveLength(2);
  expect(fs.readdirSync(dir)).toEqual(['out.pdf']);
});

it('propagates a serialization error before touching the destination', () => {
  actual.writeFileSync(path, original);
  const doc = Document.New();
  expect(() => doc.WriteTo(path, { incremental: true })).toThrow();
  expect(fs.writeFileSync).not.toHaveBeenCalled();
  expect(fs.readFileSync(path)).toEqual(original);
  expect(fs.readdirSync(dir)).toEqual(['out.pdf']);
});

it('keeps the original bytes under other hard links', () => {
  actual.writeFileSync(path, original);
  const other = join(dir, 'other.pdf');
  fs.linkSync(path, other);
  replacement().WriteTo(path);
  expect(fs.readFileSync(other)).toEqual(original);
  expect(Document.OpenFile(path).Pages).toHaveLength(2);
});

for (const exists of [true, false]) it('follows a relative symlink chain (target exists=' + exists + ')', (ctx) => {
  const folder = join(dir, 'target');
  fs.mkdirSync(folder);
  const target = join(folder, 'real.pdf');
  if (exists) actual.writeFileSync(target, original);
  try {
    fs.symlinkSync(join('target', 'alias.pdf'), path, 'file');
    fs.symlinkSync('real.pdf', join(folder, 'alias.pdf'), 'file');
  } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return ctx.skip();
    throw error;
  }
  replacement().WriteTo(path);
  expect(fs.lstatSync(path).isSymbolicLink()).toBe(true);
  expect(fs.lstatSync(join(folder, 'alias.pdf')).isSymbolicLink()).toBe(true);
  expect(Document.OpenFile(target).Pages).toHaveLength(2);
  expect(fs.readdirSync(folder).sort()).toEqual(['alias.pdf', 'real.pdf']);
});

it.skipIf(process.platform === 'win32')('preserves existing permissions and applies umask to new files', () => {
  replacement().WriteTo(path);
  expect(fs.statSync(path).mode & 0o777).toBe(0o666 & ~process.umask());
  fs.chmodSync(path, 0o640);
  replacement().WriteTo(path);
  expect(fs.statSync(path).mode & 0o777).toBe(0o640);
});

it.skipIf(process.platform === 'win32')('refuses a link with an unrepresentable filename before staging', () => {
  const rawName = Buffer.from([0xff]);
  const target = Buffer.concat([Buffer.from(dir + sep), rawName]);
  actual.writeFileSync(target, original);
  fs.symlinkSync(rawName, path);
  expect(() => replacement().WriteTo(path)).toThrow();
  expect(fs.readFileSync(target)).toEqual(original);
  expect(fs.existsSync(join(dir, '\ufffd'))).toBe(false);
  expect(fs.readdirSync(dir)).toHaveLength(2);
});

it.skipIf(process.getuid?.() === 0)('respects a read-only target', () => {
  actual.writeFileSync(path, original);
  fs.chmodSync(path, 0o444);
  try {
    expect(() => replacement().WriteTo(path)).toThrow();
    expect(fs.readFileSync(path)).toEqual(original);
    expect(fs.readdirSync(dir)).toEqual(['out.pdf']);
  } finally {
    fs.chmodSync(path, 0o600);
  }
});

it('rejects directory paths and paths with a trailing separator', () => {
  actual.writeFileSync(path, original);
  expect(() => replacement().WriteTo(dir)).toThrow();
  expect(() => replacement().WriteTo(path + sep + '.')).toThrow();
  if (process.platform !== 'win32') expect(() => replacement().WriteTo(path + sep)).toThrow();
  expect(fs.readFileSync(path)).toEqual(original);
  expect(fs.readdirSync(dir)).toEqual(['out.pdf']);
});
