// Generates test/fixtures/qpdf/*.pdf and *.txt — incremental-save outputs that
// qpdf has inspected, plus its verdict on each.
//
// Every test of Save({ incremental: true }) reads the result back through our
// OWN parser, so it cannot catch an append our reader tolerates and the format
// does not. qpdf is a separately written implementation, so its verdict is
// evidence in a way our own round trip is not.
//
// It REFUSES to write anything when qpdf reports an error: a golden that
// freezes a defect is worse than no golden, the rule gen-svg-goldens.ts already
// follows for engine disagreement.
//
// Not part of `npm test`. Unlike the browser goldens, the tool here is an
// EXTERNAL BINARY rather than an npm package, so there is nothing to
// `npm i --no-save` — qpdf must be on PATH:
//
//   qpdf --version
//   npx tsx scripts/gen-qpdf-goldens.ts
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QPDF_FIXTURES } from '../test/helpers/qpdf-fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'test', 'fixtures', 'qpdf');

/** Run qpdf and return its combined output, whether or not it exits non-zero:
 *  `--check` uses the exit code to signal findings, and the text is the report
 *  we want either way. */
function qpdf(args: string[]): { text: string; ok: boolean } {
  try {
    return { text: execFileSync('qpdf', args, { encoding: 'utf8' }), ok: true };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { text: `${err.stdout ?? ''}${err.stderr ?? ''}`, ok: false };
  }
}

function main(): void {
  const version = qpdf(['--version']).text.split('\n')[0].trim();
  if (!version.startsWith('qpdf version')) {
    console.error('qpdf not found on PATH — install it and re-run.');
    process.exit(1);
  }
  console.log(version);

  mkdirSync(outDir, { recursive: true });
  const tmp = join(outDir, '.probe.pdf');
  const written: { name: string; bytes: number; sha256: string }[] = [];
  let failed = false;

  for (const f of QPDF_FIXTURES) {
    const bytes = f.build();
    writeFileSync(tmp, bytes);

    // An encrypted fixture needs a password to open; ours use the empty one.
    const pw = f.name.startsWith('encrypted-') ? ['--password='] : [];
    const check = qpdf([...pw, '--check', tmp]);
    const xref = qpdf([...pw, '--show-xref', tmp]);
    // --check exits non-zero for warnings as well as errors; the text is what
    // decides, and anything but the clean verdict is a refusal.
    const clean = /No syntax or stream encoding errors found/.test(check.text);
    if (!clean) {
      console.error(`REFUSING ${f.name}: qpdf reported a problem\n${check.text}`);
      failed = true;
      continue;
    }

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(join(outDir, `${f.name}.pdf`), bytes);
    writeFileSync(
      join(outDir, `${f.name}.txt`),
      `# ${f.name}\n# ${f.covers}\n# sha256 ${sha256}\n\n`
      + `$ qpdf --check\n${check.text.replace(new RegExp(tmp.replace(/[\\/]/g, '.'), 'g'), `${f.name}.pdf`)}\n`
      + `$ qpdf --show-xref\n${xref.text}`,
    );
    written.push({ name: f.name, bytes: bytes.length, sha256 });
    console.log(`  ok  ${f.name}  ${bytes.length} bytes`);
  }

  rmSync(tmp, { force: true });
  if (failed) { console.error('\nqpdf rejected at least one fixture; nothing further written.'); process.exit(1); }

  console.log('\nPaste into PROVENANCE.md:\n');
  console.log('| Fixture | Bytes | SHA-256 |');
  console.log('|---|---|---|');
  for (const w of written) console.log(`| \`${w.name}.pdf\` | ${w.bytes} | \`${w.sha256}\` |`);
}

main();
