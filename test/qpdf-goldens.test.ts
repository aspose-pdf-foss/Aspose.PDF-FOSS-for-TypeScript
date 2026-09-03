import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { QPDF_FIXTURES } from './helpers/qpdf-fixtures.js';

const dir = join('test', 'fixtures', 'qpdf');

/** These assert BYTE-IDENTITY against outputs qpdf inspected offline; they run
 *  no qpdf themselves, so CI needs nothing installed. The fence is indirect and
 *  worth stating plainly: a change to the append reddens these, which is the
 *  signal to re-run `npx tsx scripts/gen-qpdf-goldens.ts` and let qpdf pass
 *  judgement again. They are NOT a snapshot to refresh blindly — the point is
 *  that the bytes an external implementation approved cannot drift unnoticed.
 *
 *  The `.txt` reports beside each fixture are EVIDENCE, not assertions: nothing
 *  compares them here, and reading them as a gate would be a mistake. */
describe('incremental-save output qpdf has approved', () => {
  it('covers every fixture the generator writes', () => {
    expect(QPDF_FIXTURES.map((f) => f.name)).toEqual([
      'base', 'one-edit', 'freed-object', 'classic-onto-xref-stream', 'encrypted-preserved',
    ]);
  });

  for (const f of QPDF_FIXTURES) {
    it(`reproduces ${f.name}.pdf byte for byte`, () => {
      const path = join(dir, `${f.name}.pdf`);
      expect(existsSync(path), `missing golden ${path} — run the generator`).toBe(true);
      expect(new Uint8Array(readFileSync(path))).toEqual(f.build());
    });

    it(`keeps the qpdf report for ${f.name}`, () => {
      const report = readFileSync(join(dir, `${f.name}.txt`), 'utf8');
      // The verdict the generator refused to write without.
      expect(report).toContain('No syntax or stream encoding errors found');
    });
  }

  // The freed object is the shape our own reader provably cannot check, since
  // readXref drops free entries (2yvi). qpdf honours it, and that is recorded
  // in the report rather than merely asserted here.
  it('records that qpdf sees the freed object as gone', () => {
    const report = readFileSync(join(dir, 'freed-object.txt'), 'utf8');
    const xref = report.slice(report.indexOf('--show-xref'));
    expect(xref).toContain('6/0:');
    expect(xref).not.toContain('5/0:');
  });
});
