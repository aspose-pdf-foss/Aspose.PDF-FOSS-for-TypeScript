import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PROBES, BARCODE, buildPaperBarcodeProbe } from './helpers/build-paper-barcode-probe.js';

// What Adobe Reader's own script engine computed for each probe, transcribed
// from test/fixtures/paper-barcode/<name>.png (see that directory's
// PROVENANCE.md). Our recomputation must equal it exactly.
const goldens = JSON.parse(readFileSync(new URL('./fixtures/paper-barcode/goldens.json', import.meta.url), 'utf8')) as {
  probes: { name: string; content: string }[];
};

describe('paper barcode content against Adobe Reader 26.1', () => {
  it('has a golden for every probe and a probe for every golden', () => {
    expect(goldens.probes.map((g) => g.name).sort()).toEqual(PROBES.map((p) => p.name).sort());
  });

  for (const p of PROBES) {
    it(p.name, () => {
      const doc = buildPaperBarcodeProbe(p, 'ours');
      const report = doc.Form.RefreshBarcodes();
      expect(report.notRecomputed).toEqual([]);
      const bc = doc.Form.Get(BARCODE)!;
      expect(bc.Value).toBe(goldens.probes.find((g) => g.name === p.name)!.content);
    });
  }
});
