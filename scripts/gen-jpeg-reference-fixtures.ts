/** One-time generator for ka3t; never run by npm test.
 * npx tsx scripts/gen-jpeg-reference-fixtures.ts /path/to/pinned/jpeg[.exe]
 * Build and license details: test/fixtures/jpeg/PROVENANCE.md.
 * No repository JPEG encoder, decoder or upsampler participates here. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepStrictEqual } from 'node:assert';
import { readPnm } from '../test/helpers/read-pnm.js';

const codec = process.argv[2];
if (!codec) throw new Error('pass the path to the pinned external jpeg executable');
const executable = resolve(codec);
const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/jpeg');
const width = 37, height = 29;

function source(name: string, components: number, w = width, h = height): void {
  const samples = Buffer.alloc(w * h * components);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (y * w + x) * components;
    samples[p] = (17 * x + 31 * y + 73 * ((x + y) % 3) + (x > 18 ? 93 : 0)) & 255;
    if (components === 3) {
      samples[p + 1] = (211 - 11 * x + 23 * y + (y > 13 ? 79 : 0)) & 255;
      samples[p + 2] = (41 + 7 * x - 19 * y + 131 * ((x >> 2) & 1)) & 255;
    }
  }
  writeFileSync(join(dir, name), Buffer.concat([
    Buffer.from(`${components === 1 ? 'P5' : 'P6'}\n${w} ${h}\n255\n`), samples,
  ]));
}

function run(args: string[]): void {
  // A tool failure must not reuse a previous generation's output.
  rmSync(join(dir, args[args.length - 1]), { force: true });
  const result = spawnSync(executable, args, { cwd: dir, encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0 || /failed - error/i.test(result.stderr + result.stdout))
    throw new Error(`external jpeg ${args.join(' ')}: ${result.stderr}\n${result.stdout}`);
  if (readFileSync(join(dir, args[args.length - 1])).length === 0) throw new Error('external jpeg wrote an empty output');
}

const sha256 = (file: string) => createHash('sha256').update(readFileSync(join(dir, file))).digest('hex');
source('reference-gray.pgm', 1);
source('reference-rgb.ppm', 3);
source('reference-edge.pgm', 1, 38, 30);

const cases = [
  { name: 'reference-lossless-gray', source: 'reference-gray.pgm', args: ['-p', '-c', '-h'], exact: true },
  { name: 'reference-lossless-rgb', source: 'reference-rgb.ppm', args: ['-p', '-c', '-h'], exact: true },
  { name: 'reference-hier-noexp', source: 'reference-gray.pgm', args: ['-q', '73', '-c', '-h', '-y', '0'], exact: true },
  { name: 'reference-hier-exp', source: 'reference-gray.pgm', args: ['-q', '73', '-c', '-h', '-y', '1'], exact: true },
  { name: 'reference-hier-dct', source: 'reference-gray.pgm', args: ['-q', '73', '-c', '-h', '-y', '2'], exact: false },
  { name: 'reference-hier-prog', source: 'reference-gray.pgm', args: ['-q', '73', '-c', '-h', '-v', '-y', '2'], exact: false },
  { name: 'reference-hier-arith', source: 'reference-gray.pgm', args: ['-q', '73', '-c', '-a', '-y', '2'], exact: false },
  { name: 'reference-hier-arith-prog', source: 'reference-gray.pgm', args: ['-q', '73', '-c', '-a', '-v', '-y', '2'], exact: false },
  { name: 'reference-hier-exp-edge', source: 'reference-edge.pgm', args: ['-q', '73', '-c', '-h', '-y', '1'], exact: true },
  // The external codec's all-predictive pyramid drops one source LSB at some
  // interpolated positions. Its DECODE is still an exact oracle for our EXP.
  { name: 'reference-hier-lossless-exp', source: 'reference-gray.pgm', args: ['-p', '-c', '-h', '-y', '2'], exact: false },
];

const fixtures = cases.map((entry) => {
  const jpeg = `${entry.name}.jpg`;
  const decoded = `${entry.name}.decoded.${entry.source.endsWith('.ppm') ? 'ppm' : 'pgm'}`;
  const encodeArgs = [...entry.args, entry.source, jpeg];
  const decodeArgs = [jpeg, decoded];
  run(encodeArgs);
  run(decodeArgs);
  const original = readPnm(readFileSync(join(dir, entry.source)));
  const golden = readPnm(readFileSync(join(dir, decoded)));
  deepStrictEqual([golden.width, golden.height, golden.magic, golden.max], [original.width, original.height, original.magic, 255]);
  if (entry.exact) deepStrictEqual(golden.data, original.data);
  let sourceMaxError = 0;
  for (let i = 0; i < original.data.length; i++) sourceMaxError = Math.max(sourceMaxError, Math.abs(golden.data[i] - original.data[i]));
  console.log(`${jpeg}: ${readFileSync(join(dir, jpeg)).length} bytes; reference ${entry.exact ? 'equals source' : 'saved independently'}`);
  return {
    jpeg, source: entry.source, decoded, width: original.width, height: original.height,
    exactSource: entry.exact, sourceMaxError, encodeArgs, decodeArgs,
    sha256: { jpeg: sha256(jpeg), source: sha256(entry.source), decoded: sha256(decoded) },
  };
});

writeFileSync(join(dir, 'reference-manifest.json'), JSON.stringify({
  codec: 'Thomas Richter libjpeg', commit: 'c719010a26ce0c666e98b2acf924ad5fc24b4f5d',
  codecBinarySha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
  sourceLicense: 'MIT (authored for this repository)', fixtures,
}, null, 2) + '\n');
