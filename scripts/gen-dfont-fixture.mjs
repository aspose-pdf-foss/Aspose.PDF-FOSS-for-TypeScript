// Build the `.dfont` suitcase `test/fixtures/fonts/` holds, by driving
// FontForge over four faces already vendored in `fonts/`.
//
// WHY THIS EXISTS. `src/dfont.ts` reads a Macintosh resource-fork container,
// and its unit tests build suitcases with `test/helpers/build-dfont.ts`, which
// transcribes the same section of Inside Macintosh the reader does. That is
// the shared-convention class `test/fixtures/` exists to guard against: the
// two halves of our own understanding can agree and both be wrong. FontForge
// is a container writer we did not write, so a suitcase it produced is bytes
// our reading did not shape.
//
// WHY NOT A REAL MAC SUITCASE. `l1my.7` proposed vendoring `Monaco.dfont` or
// `Geneva.dfont` from a macOS `/System/Library/Fonts`. Those are Apple
// copyright with no redistribution grant — the same objection
// `test/fixtures/icc/PROVENANCE.md` records for `RSWOP.icm`, and unlike a
// golden table our tests need the BYTES, so it cannot be reduced to a table.
// The payload here is Liberation, OFL-1.1, already in this repo under
// `fonts/LICENSE-OFL.txt`; what is being cross-checked is the container around
// it, which the payload's identity does not affect.
//
// Deterministic: FontForge writes the same bytes on every run (verified by
// generating twice and comparing sha256), so re-running produces no diff.
// Not run by `npm test`.
//
// Usage:
//   npm run gen:dfont
//   npm run gen:dfont -- --fontforge "C:/Users/you/FontForge/bin/fontforge.exe"
import { writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outPath = join(repo, 'test', 'fixtures', 'fonts', 'LiberationSans.dfont');

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const fontforge = flag('fontforge') ?? process.env.FONTFORGE ?? 'fontforge';

// The face that is CURRENT when GenerateFamily runs is excluded from the
// suitcase, so all four are named in the array and a fifth open font is not
// needed — the current one is simply listed there too. Found by measurement:
// the array wants FILE PATHS, not PostScript names, and naming only the
// "other" three silently drops the fourth face.
const FACES = [
  'fonts/LiberationSans-Regular.ttf',
  'fonts/LiberationSans-Bold.ttf',
  'fonts/LiberationSans-Italic.ttf',
  'fonts/LiberationSans-BoldItalic.ttf',
];

const script = [
  ...FACES.map((f) => `Open("${f}")`),
  `GenerateFamily($1, "", 0, [${FACES.map((f) => `"${f}"`).join(', ')}])`,
  '',
].join('\n');

const scriptPath = join(tmpdir(), `gen-dfont-${process.pid}.pe`);
writeFileSync(scriptPath, script);

try {
  mkdirSync(dirname(outPath), { recursive: true });
  // FontForge writes progress and a kern/GPOS advisory to stderr; neither is
  // an error, so stderr is captured rather than inherited.
  execFileSync(fontforge, ['-quiet', '-script', scriptPath, outPath], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (e) {
  console.error(
    `FontForge failed. Install it (https://fontforge.org) and put it on PATH,\n`
    + `or pass --fontforge <path>. Tried: ${fontforge}\n`);
  throw e;
} finally {
  rmSync(scriptPath, { force: true });
}

const bytes = readFileSync(outPath);
const sha256 = createHash('sha256').update(bytes).digest('hex');
console.log(`wrote ${outPath} (${bytes.length} bytes, sha256 ${sha256.slice(0, 16)}…)`);
console.log(`fontforge: ${execFileSync(fontforge, ['--version'], { encoding: 'utf8' })
  .split('\n')[0].trim()}`);
