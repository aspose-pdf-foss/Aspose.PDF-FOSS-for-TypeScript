// scripts/gen-aform-goldens.mjs
// Regenerates test/fixtures/aform/*.json from pdf.js's AForm implementation at
// a pinned commit (jzn8). NOT run by `npm test`; needs network access to
// raw.githubusercontent.com. Run: npm run gen:aform
//
// This is the ONLY place pdf.js's JavaScript runs, and it runs at development
// time. The library itself never executes JavaScript (6t2v.2).
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

process.env.TZ = 'UTC';
if (new Date(0).getTimezoneOffset() !== 0) {
  console.error('could not switch to UTC; run with TZ=UTC in the environment');
  process.exit(1);
}

const SHA = 'd52fdf411a6e4d338180687456e0df019e28475e';
const FILES = [
  'src/scripting_api/aform.js', 'src/scripting_api/util.js',
  'src/scripting_api/constants.js', 'src/scripting_api/pdf_object.js',
  'src/shared/scripting_utils.js', 'src/shared/math_clamp.js',
];
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'aform');

// ---- polyfills pdf.js relies on and Node 24 lacks ---------------------------
// getOrInsertComputed is the upsert proposal; semantics are trivial.
if (!Map.prototype.getOrInsertComputed) {
  Map.prototype.getOrInsertComputed = function (k, f) {
    if (!this.has(k)) this.set(k, f(k));
    return this.get(k);
  };
}
// Math.sumPrecise must be EXACTLY rounded. This one is exact BigInt arithmetic
// in units of 2^-1074 — deliberately a different algorithm from src/afcalc.ts's
// Shewchuk summation, so the golden and the implementation cannot share a bug.
function scaled(x) {
  if (x === 0) return 0n;
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x);
  const bits = dv.getBigUint64(0);
  const neg = (bits >> 63n) === 1n;
  const exp = Number((bits >> 52n) & 0x7ffn);
  let mant = bits & ((1n << 52n) - 1n);
  let e;
  if (exp === 0) e = -1074; else { mant |= 1n << 52n; e = exp - 1075; }
  const v = mant << BigInt(e + 1074);
  return neg ? -v : v;
}
function fromScaled(s) {
  if (s === 0n) return 0;
  const neg = s < 0n;
  let m = neg ? -s : s;
  const bl = m.toString(2).length;
  let shift = 0;
  if (bl > 53) {
    shift = bl - 53;
    const rem = m & ((1n << BigInt(shift)) - 1n);
    const half = 1n << BigInt(shift - 1);
    m >>= BigInt(shift);
    if (rem > half || (rem === half && (m & 1n) === 1n)) m += 1n;
  }
  const r = Number(m) * 2 ** (shift - 1074);
  return neg ? -r : r;
}
if (!Math.sumPrecise) {
  Math.sumPrecise = (xs) => { let acc = 0n; for (const x of xs) acc += scaled(x); return fromScaled(acc); };
}

// ---- fetch the pinned sources -----------------------------------------------
const root = mkdtempSync(join(tmpdir(), 'pdfjs-aform-'));
const sources = {};
for (const f of FILES) {
  const res = await fetch(`https://raw.githubusercontent.com/mozilla/pdf.js/${SHA}/${f}`);
  if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
  const text = await res.text();
  mkdirSync(dirname(join(root, f)), { recursive: true });
  writeFileSync(join(root, f), text);
  sources[f] = createHash('sha256').update(text).digest('hex');
}
const imp = (f) => import(pathToFileURL(join(root, f)).href);
const { AForm } = await imp('src/scripting_api/aform.js');
const { Util } = await imp('src/scripting_api/util.js');
const { DateFormats, TimeFormats } = await imp('src/shared/scripting_utils.js');

// A FRESH Util per case: util.js caches its scand regex with the /g flag, so a
// reused instance alternates between matching and failing on the same input.
function fresh(fields = {}) {
  const util = new Util({});
  const doc = {
    getField: (n) => (Object.hasOwn(fields, n)
      ? { getArray: () => fields[n].map((v) => ({ value: v })) } : null),
  };
  const app = { alert() {}, _eventDispatcher: { mergeChange: (e) => e.value } };
  const color = { black: ['G', 0], red: ['RGB', 1, 0, 0] };
  return { aform: new AForm(doc, app, util, color), util };
}
function run(fn, args, value, fields) {
  const { aform } = fresh(fields);
  globalThis.event = { value, willCommit: true, rc: true, target: { name: 'f', textColor: null } };
  aform[fn](...args);
  return globalThis.event;
}
const strictOk = (fmt, v) => v === '' || fresh().util._scand(fmt, v, true) !== null;

// ---- the grids ----------------------------------------------------------------
const out = {};
const NUM_VALUES = ['0', '-0', '1', '-1', '0.5', '-0.5', '1.005', '2.675', '1234567.891',
  '-1234567.891', '999.9999', '1e15', '-1e15', 'abc', '', '  42 ', '1,5', '0.0001',
  '12345678901234567890'];

out['number-format'] = [];
for (const value of NUM_VALUES) for (let nDec = 0; nDec <= 3; nDec++)
  for (let sep = 0; sep <= 4; sep++) for (let neg = 0; neg <= 3; neg++)
    for (const cur of ['', '$', '€ ']) for (const prepend of [true, false]) {
      const args = [nDec, sep, neg, 0, cur, prepend];
      out['number-format'].push({ args, value, out: String(run('AFNumber_Format', args, value).value) });
    }

out['percent-format'] = [];
for (const value of NUM_VALUES) for (let nDec = 0; nDec <= 3; nDec++)
  for (let sep = 0; sep <= 4; sep++) for (const prepend of [false, true]) {
    const args = [nDec, sep, prepend];
    out['percent-format'].push({ args, value, out: String(run('AFPercent_Format', args, value).value) });
  }

const KEY_VALUES = ['1.5', '1,5', '-2', '+3.', '  4 ', '.5', ',5', '1,234.5', 'abc', '', '1e3', '12.', '-.5', '   '];
out['number-keystroke'] = [];
for (const value of KEY_VALUES) for (let sep = 0; sep <= 4; sep++) {
  const a1 = [2, sep, 0, 0, '', true];
  out['number-keystroke'].push({ fn: 'AFNumber_Keystroke', args: a1, value, rc: run('AFNumber_Keystroke', a1, value).rc });
  const a2 = [2, sep];
  out['number-keystroke'].push({ fn: 'AFPercent_Keystroke', args: a2, value, rc: run('AFPercent_Keystroke', a2, value).rc });
}

const SEEDS = [
  Date.UTC(2024, 1, 29, 13, 5, 9), Date.UTC(1999, 11, 31, 0, 0, 0), Date.UTC(2000, 0, 1, 12, 0, 0),
  Date.UTC(2049, 5, 15, 23, 59, 59), Date.UTC(2050, 5, 15, 1, 2, 3), Date.UTC(2024, 6, 4, 0, 30, 0),
];
const MISMATCH = ['', 'garbage', '2024-13-40', '03/04/24', 'March 4, 2024', '12:30 PM', '0:00 am',
  'Feb 30, 2024', '31/12/1999', '2024-02-30'];
const PICTURES = ['yyyy-mm-dd', 'dd.mm.yyyy', 'mmmm d, yyyy HH:MM:ss', 'ddd mmm d yyyy', 'h:MM tt',
  'HH:MM:ss', 'yy/m/d', '\\Y yyyy', 'd-mmm-yyyy h:MM:ss tt'];
const printd = (fmt, t) => fresh().util.printd(fmt, new Date(t));
const valuesFor = (fmt) => [...new Set([
  ...SEEDS.map((t) => printd(fmt, t)), ...SEEDS.map((t) => printd('mm/dd/yyyy', t)), ...MISMATCH,
])];
const dateJobs = [
  ...DateFormats.map((f, i) => ({ fn: 'AFDate_Format', kfn: 'AFDate_Keystroke', args: [i], fmt: f })),
  ...TimeFormats.map((f, i) => ({ fn: 'AFTime_Format', kfn: 'AFTime_Keystroke', args: [i], fmt: f })),
  ...PICTURES.map((f) => ({ fn: 'AFDate_FormatEx', kfn: 'AFDate_KeystrokeEx', args: [f], fmt: f })),
];
out['date-format'] = [];
out['date-keystroke'] = [];
for (const job of dateJobs) for (const value of valuesFor(job.fmt)) {
  const strict = strictOk(job.fmt, value);
  out['date-format'].push(strict
    ? { fn: job.fn, args: job.args, value, strict, out: String(run(job.fn, job.args, value).value) }
    : { fn: job.fn, args: job.args, value, strict });
  out['date-keystroke'].push(strict
    ? { fn: job.kfn, args: job.args, value, strict, rc: run(job.kfn, job.args, value).rc }
    : { fn: job.kfn, args: job.args, value, strict });
}
for (const i of [-1, 14, 99]) for (const value of ['03/04/24', '']) {
  out['date-keystroke'].push({ fn: 'AFDate_Keystroke', args: [i], value, strict: true, rc: run('AFDate_Keystroke', [i], value).rc });
}

const SPECIAL_VALUES = ['12345', '123456789', '5551234', '5555551234', '555-555-1234', '123-45-6789', 'abc123', '', '1'];
out['special-format'] = [];
for (let psf = 0; psf <= 3; psf++) for (const value of SPECIAL_VALUES)
  out['special-format'].push({ psf, value, out: String(run('AFSpecial_Format', [psf], value).value) });

const SK_VALUES = ['12345', '1234', '12345-6789', '123456789', '555-1234', '5551234', '(555) 555-1234',
  '5555551234', '123-45-6789', 'abc', '',
  // Separators only: stripping leaves '', where pdf.js falls back to the raw value.
  '---', '( )'];
const MASKS = ['999-9999', 'AAA-9999', 'OOO', 'XX-99', '99999'];
const MASK_VALUES = ['555-1234', '5551234', 'ABC-1234', 'AB1-1234', 'a1B', 'a1Bc', 'Zz-12', 'Zz12', '12345', '1234', ''];
out['special-keystroke'] = [];
for (let psf = 0; psf <= 3; psf++) for (const value of SK_VALUES)
  out['special-keystroke'].push({ fn: 'AFSpecial_Keystroke', args: [psf], value, rc: run('AFSpecial_Keystroke', [psf], value).rc });
for (const mask of MASKS) for (const value of MASK_VALUES)
  out['special-keystroke'].push({ fn: 'AFSpecial_KeystrokeEx', args: [mask], value, rc: run('AFSpecial_KeystrokeEx', [mask], value).rc });

out['range-validate'] = [];
for (const [bG, bL] of [[false, false], [true, false], [false, true], [true, true]])
  for (const [nG, nL] of [[0, 100], [-5.5, 5.5]])
    for (const value of ['-1', '0', '50', '100', '101', 'abc', '', '1,5', '-5.5', '5.6']) {
      const args = [bG, nG, bL, nL];
      out['range-validate'].push({ args, value, rc: run('AFRange_Validate', args, value).rc });
    }

const CALC = [
  ['SUM', ['1', '2']], ['SUM', ['0.1', '0.2']], ['SUM', ['0.1', '0.2', '0.3']],
  ['SUM', ['1e16', '1', '-1e16']], ['SUM', ['1,5', '2']], ['SUM', ['abc', '3']], ['SUM', ['', '4']],
  ['SUM', []], ['AVG', ['1', '2', '4']], ['AVG', ['0.1', '0.2', '0.4']], ['PRD', ['1.1', '1.1', '1.1']],
  ['PRD', []], ['MIN', ['3', '-2', 'abc']], ['MAX', ['3', '-2', '7.5']],
  ['SUM', ['123456.1234567', '0.0000004']], ['AVG', ['1', 'abc']], ['SUM', ['1e300', '1e300', '-1e300']],
];
out['simple-calculate'] = CALC.map(([op, values]) => {
  const fields = Object.fromEntries(values.map((v, i) => [`f${i}`, [v]]));
  const e = run('AFSimple_Calculate', [op, values.map((_, i) => `f${i}`)], '', fields);
  return { op, values, out: e.value };
});

// ---- write --------------------------------------------------------------------
mkdirSync(OUT, { recursive: true });
const counts = {};
for (const [name, recs] of Object.entries(out)) {
  counts[name] = recs.length;
  writeFileSync(join(OUT, `${name}.json`), `[\n${recs.map((r) => JSON.stringify(r)).join(',\n')}\n]\n`);
}
const strictFalse = {
  'date-format': out['date-format'].filter((r) => !r.strict).length,
  'date-keystroke': out['date-keystroke'].filter((r) => !r.strict).length,
};
writeFileSync(join(OUT, 'meta.json'), `${JSON.stringify({ sha: SHA, sources, counts, strictFalse }, null, 2)}\n`);
console.log(JSON.stringify({ counts, strictFalse }, null, 2));
