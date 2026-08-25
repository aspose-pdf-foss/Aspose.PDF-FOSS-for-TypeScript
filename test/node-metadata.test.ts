import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readMetadataFile,
  updateMetadataFile,
  clearMetadataFile,
} from '../src/node.js';
import { buildClassicPdf } from './helpers/build-pdf.js';
import * as api from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'pdfmeta-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Write a fixture PDF with the given /Info to a fresh path and return it. */
function fixture(name: string, info?: Record<string, string>): string {
  const p = join(dir, name);
  writeFileSync(p, buildClassicPdf(1, info ? { info } : {}));
  return p;
}

describe('readMetadataFile', () => {
  it('reads standard and custom fields from a file', async () => {
    const input = fixture('read.pdf', { Title: 'Hi', Author: 'Ada', Custom1: 'X' });
    const meta = await readMetadataFile(input);
    expect(meta.title).toBe('Hi');
    expect(meta.author).toBe('Ada');
    expect(meta.custom).toEqual({ Custom1: 'X' });
  });
});

describe('updateMetadataFile', () => {
  it('merges updates and preserves untouched fields', async () => {
    const input = fixture('upd-in.pdf', { Title: 'Old', Author: 'Ada' });
    const output = join(dir, 'upd-out.pdf');
    await updateMetadataFile(input, output, { title: 'New', custom: { K: 'V' } });
    const meta = await readMetadataFile(output);
    expect(meta.title).toBe('New');
    expect(meta.author).toBe('Ada');
    expect(meta.custom).toEqual({ K: 'V' });
  });

  it('deletes a field when set to null', async () => {
    const input = fixture('del-in.pdf', { Title: 'Old', Author: 'Ada' });
    const output = join(dir, 'del-out.pdf');
    await updateMetadataFile(input, output, { author: null });
    const meta = await readMetadataFile(output);
    expect(meta.author).toBeUndefined();
    expect(meta.title).toBe('Old');
  });

  it('edits in place when input and output paths are the same', async () => {
    const path = fixture('inplace.pdf', { Title: 'Old' });
    await updateMetadataFile(path, path, { title: 'New' });
    const meta = await readMetadataFile(path);
    expect(meta.title).toBe('New');
  });
});

describe('clearMetadataFile', () => {
  it('removes all metadata', async () => {
    const input = fixture('clr-in.pdf', { Title: 'Old', Author: 'Ada', Custom1: 'X' });
    const output = join(dir, 'clr-out.pdf');
    await clearMetadataFile(input, output);
    const meta = await readMetadataFile(output);
    expect(meta).toEqual({ custom: {} });
  });
});

describe('index exports', () => {
  it('re-exports the metadata file wrappers', () => {
    expect(typeof api.readMetadataFile).toBe('function');
    expect(typeof api.updateMetadataFile).toBe('function');
    expect(typeof api.clearMetadataFile).toBe('function');
  });
});
