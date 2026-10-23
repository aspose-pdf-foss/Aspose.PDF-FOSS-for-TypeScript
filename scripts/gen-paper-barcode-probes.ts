// Writes the Adobe Reader paper-barcode probes (2srz.4) to
// test/fixtures/paper-barcode/<name>.pdf, built by
// test/helpers/build-paper-barcode-probe.ts in 'oracle' mode: Reader
// calculates the barcode with Acrobat's template (version guard removed --
// Reader has no ADBE) and writes the result, as JSON, into a visible field.
// scripts/run-paper-barcode-probe.ps1 captures the window; the values are
// transcribed by hand into goldens.json.
//
// `npx tsx scripts/gen-paper-barcode-probes.ts [name...]` (default: all).
// Not run by `npm test`.
import { writeFileSync, mkdirSync } from 'node:fs';
import { PROBES, buildPaperBarcodeProbe } from '../test/helpers/build-paper-barcode-probe.js';

const want = process.argv.slice(2);
mkdirSync('test/fixtures/paper-barcode', { recursive: true });
for (const p of PROBES) {
  if (want.length > 0 && !want.includes(p.name)) continue;
  writeFileSync(`test/fixtures/paper-barcode/${p.name}.pdf`, buildPaperBarcodeProbe(p, 'oracle').Save());
  console.log(`wrote ${p.name}.pdf`);
}
