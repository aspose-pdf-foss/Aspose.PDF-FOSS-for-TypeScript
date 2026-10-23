// Writes test/fixtures/barcode-zxing/goldens.json: every case below encoded by
// our PDF417 and Data Matrix encoders, then read back by ZXing 3.5.3 -- a
// decoder we did not write. Each golden records the hash of the matrix ZXing
// read, the text it decoded and how many errors it had to correct; the suite
// requires the text to equal the input and the count to be ZERO, since
// Reed-Solomon would otherwise quietly mask an encoder bug.
//
// `npm run gen:barcode-goldens`. Needs a JDK on PATH and network access the
// first time (the ZXing jar from Maven Central, verified by SHA-256). Not run
// by `npm test`.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDataMatrix } from '../src/datamatrix.js';
import { BARCODE_CASES, DM_WRITER_CASES, bitsHash, matrixOf, matrixHash } from '../test/helpers/barcode-cases.js';

const JAR_URL = 'https://repo1.maven.org/maven2/com/google/zxing/core/3.5.3/core-3.5.3.jar';
const JAR_SHA256 = '8d8064c1636fdaef7189dd9055c7d59950a8940a12f2293956446ec3c109fd82';

const work = join(tmpdir(), 'pdf4ts-zxing-3.5.3');
mkdirSync(work, { recursive: true });
const jar = join(work, 'core-3.5.3.jar');
if (!existsSync(jar)) {
  const res = await fetch(JAR_URL);
  if (!res.ok) throw new Error(`${JAR_URL}: HTTP ${res.status}`);
  writeFileSync(jar, new Uint8Array(await res.arrayBuffer()));
}
const got = createHash('sha256').update(readFileSync(jar)).digest('hex');
if (got !== JAR_SHA256) throw new Error(`ZXing jar sha256 ${got}, expected ${JAR_SHA256}`);

const cls = join(work, 'cls');
execFileSync('javac', ['-cp', jar, '-d', cls, 'scripts/BarcodeOracle.java'], { stdio: 'inherit' });

const lines = BARCODE_CASES.map((c) => {
  const m = matrixOf(c);
  const w = m.width ?? m.size, h = m.height ?? m.size;
  return [c.name, c.kind, w, h, m.rowHeight ?? 1, m.dark.map((b) => (b ? '1' : '0')).join('')].join('\t');
});
const sep = process.platform === 'win32' ? ';' : ':';
const out = execFileSync('java', ['-cp', `${jar}${sep}${cls}`, 'BarcodeOracle'],
  { input: lines.join('\n') + '\n', encoding: 'utf8', maxBuffer: 1 << 26 });

const byName = new Map<string, string[]>();
for (const line of out.split(/\r?\n/)) if (line) byName.set(line.split('\t')[0]!, line.split('\t'));

const goldens = BARCODE_CASES.map((c) => {
  const r = byName.get(c.name);
  if (!r) throw new Error(`${c.name}: no answer from ZXing`);
  if (r[1] !== 'OK') throw new Error(`${c.name}: ZXing failed -- ${r.slice(2).join(' ')}`);
  const text = Buffer.from(r[3]!, 'base64').toString('utf8');
  const errors = Number(r[2]);
  if (text !== c.data) throw new Error(`${c.name}: ZXing read ${JSON.stringify(text.slice(0, 40))}`);
  if (errors !== 0) throw new Error(`${c.name}: ZXing corrected ${errors} errors`);
  return { name: c.name, sha256: matrixHash(matrixOf(c)), text, errorsCorrected: errors };
});

// ZXing's own WRITER on the same inputs: the hash of the matrix IT drew,
// which the suite requires ours to equal.
const wout = execFileSync('java', ['-cp', `${jar}${sep}${cls}`, 'BarcodeOracle'], {
  input: DM_WRITER_CASES.map((s, i) => `w${i}\tdmwrite\t${Buffer.from(s, 'utf8').toString('base64')}`).join('\n') + '\n',
  encoding: 'utf8',
});
const writerGoldens = DM_WRITER_CASES.map((data, i) => {
  const r = wout.split(/\r?\n/).find((l) => l.startsWith(`w${i}\t`))?.split('\t');
  if (!r || r[1] !== 'OK') throw new Error(`writer ${JSON.stringify(data)}: ${r?.slice(2).join(' ')}`);
  const sha256 = bitsHash(Number(r[2]), Number(r[3]), 1, r[4]!);
  if (sha256 !== matrixHash(makeDataMatrix(data)))
    throw new Error(`writer ${JSON.stringify(data)}: ZXing's modules differ from ours`);
  return { data, sha256 };
});

const javaVersion = spawnSync('java', ['-version'], { encoding: 'utf8' }).stderr.split(/\r?\n/)[0];
writeFileSync('test/fixtures/barcode-zxing/goldens.json', JSON.stringify({
  decoder: `ZXing core 3.5.3 (${JAR_URL}, sha256 ${JAR_SHA256})`,
  java: javaVersion,
  goldens,
  writerGoldens,
}, null, 1) + '\n');
console.log(`${goldens.length} goldens decoded with zero errors corrected; ${writerGoldens.length} writer goldens`);
