// Builds test/fixtures/zip/ from three ZIP writers that are not ours, and a
// manifest whose hashes come from the INPUT files — never from reading the
// archives — so the test's oracle is outside the reader it checks.
// Needs Windows (tar.exe, PowerShell) and git. Not run by `npm test`.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const OUT = join(import.meta.dirname, '..', 'test', 'fixtures', 'zip');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const u16 = (b, at) => b[at] | (b[at + 1] << 8);
const u32 = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim();
// Windows' own libarchive bsdtar, named explicitly: under Git Bash a bare `tar`
// is GNU tar, which writes no ZIP and reads a drive letter as a remote host.
const TAR = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

const INPUTS = {
  'a.txt': Buffer.from('hello zip '.repeat(200) + '\n'),
  'sub/b.txt': Buffer.from('x\n'),
  'bin.dat': Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
  'café.txt': Buffer.from('café\n'),
};
const src = mkdtempSync(join(tmpdir(), 'zipfx-'));
for (const [p, b] of Object.entries(INPUTS)) {
  mkdirSync(join(src, p, '..'), { recursive: true });
  writeFileSync(join(src, p), b);
}
mkdirSync(OUT, { recursive: true });
// .NET's CreateFromDirectory refuses to overwrite, so a re-run starts clean.
for (const n of ['tar.zip', 'net.zip', 'git.zip']) rmSync(join(OUT, n), { force: true });

/** Flags of every central record, and the comment length — a guard that each
 *  fixture still has the property it is vendored for. */
function survey(zip) {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6]));
  const flags = [];
  let at = u32(zip, eocd + 16);
  for (let i = 0; i < u16(zip, eocd + 10); i++) {
    flags.push(u16(zip, at + 8));
    at += 46 + u16(zip, at + 28) + u16(zip, at + 30) + u16(zip, at + 32);
  }
  return { flags, comment: u16(zip, eocd + 20) };
}
const hashes = (map) => Object.fromEntries(
  Object.entries(map).map(([p, b]) => [p, { size: b.length, sha256: sha(b) }]));

const archives = {};

// libarchive: é is transliterated, so café.txt is left out.
const tarList = ['a.txt', 'sub/b.txt', 'bin.dat'];
run(TAR, ['-a', '-cf', join(OUT, 'tar.zip'), ...tarList], src);
archives['tar.zip'] = { entries: hashes(Object.fromEntries(tarList.map((p) => [p, INPUTS[p]]))) };

// .NET Framework writes '\' separators; the manifest records the name it writes.
run('powershell', ['-NoProfile', '-Command',
  `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory('${src}', '${join(OUT, 'net.zip')}')`]);
archives['net.zip'] = { entries: hashes(Object.fromEntries(
  Object.entries(INPUTS).map(([p, b]) => [p.replaceAll('/', '\\'), b]))) };

// git: two committed files at a pinned commit; hashes from `git show`, not the zip.
const commit = run('git', ['rev-parse', 'HEAD']);
const gitPaths = ['src/crc32.ts', 'src/zip.ts'];
run('git', ['archive', '--format=zip', '-o', join(OUT, 'git.zip'), commit, '--', ...gitPaths]);
archives['git.zip'] = { entries: hashes(Object.fromEntries(gitPaths.map((p) => [p,
  execFileSync('git', ['show', `${commit}:${p}`])]))) };

for (const name of Object.keys(archives)) {
  const s = survey(readFileSync(join(OUT, name)));
  archives[name].comment = s.comment;
  archives[name].flags = s.flags;
}
const need = (ok, why) => { if (!ok) throw new Error(`fixture lost its reason to exist: ${why}`); };
need(archives['tar.zip'].flags.some((f) => f & 8), 'tar.zip has no data descriptor');
need(archives['net.zip'].flags.some((f) => f & 0x800), 'net.zip has no bit-11 name');
need(archives['git.zip'].comment > 0, 'git.zip has no archive comment');

const producers = {
  tar: run(TAR, ['--version']).split('\n')[0],
  dotnet: run('powershell', ['-NoProfile', '-Command', '[System.Environment]::Version.ToString()']),
  git: run('git', ['--version']),
  commit,
};
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ producers, archives }, null, 2) + '\n');
rmSync(src, { recursive: true, force: true });
console.log(JSON.stringify(producers, null, 2));
for (const n of Object.keys(archives)) console.log(n, sha(readFileSync(join(OUT, n))));
