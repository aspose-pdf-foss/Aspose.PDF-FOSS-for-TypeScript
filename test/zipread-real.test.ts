import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { openZip } from '../src/zipread.js';
import { unzip } from './helpers/unzip.js';

// Three ZIP writers that are not ours (test/fixtures/zip/PROVENANCE.md). The
// manifest's hashes come from the INPUT files, so the oracle is outside the
// reader under test.
const DIR = join(__dirname, 'fixtures', 'zip');
const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')) as {
  archives: Record<string, { comment: number; entries: Record<string, { size: number; sha256: string }> }>;
};
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

describe.each(Object.keys(manifest.archives))('%s, written by a third party', (name) => {
  const bytes = new Uint8Array(readFileSync(join(DIR, name)));
  const want = manifest.archives[name].entries;

  it('holds exactly the files its inputs had, byte for byte', () => {
    const z = openZip(bytes);
    const files = z.entries.filter((e) => !e.path.endsWith('/') && !e.path.endsWith('\\'));
    expect(files.map((e) => e.path).sort()).toEqual(Object.keys(want).sort());
    for (const e of files) {
      const out = z.read(e.path);
      expect(out.length).toBe(want[e.path].size);
      expect(sha(out)).toBe(want[e.path].sha256);
    }
  });

  it('agrees with the independent APPNOTE test reader', () => {
    const z = openZip(bytes);
    for (const e of unzip(bytes)) expect(sha(z.read(e.path))).toBe(sha(e.bytes));
  });
});

describe('the properties each fixture is vendored for', () => {
  it('git.zip carries an archive comment, read from its raw end record', () => {
    expect(manifest.archives['git.zip'].comment).toBeGreaterThan(0);
  });

  it('net.zip names a file with a backslash and a UTF-8 é', () => {
    const paths = openZip(new Uint8Array(readFileSync(join(DIR, 'net.zip')))).entries.map((e) => e.path);
    expect(paths).toContain('sub\\b.txt');
    expect(paths).toContain('café.txt');
  });
});
