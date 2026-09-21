import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Document } from '../src/document.js';
import { pruneDefaultResources } from '../src/drprune.js';
import { isDict } from '../src/types.js';
import { buildObjectsPdf } from './helpers/build-hostile-pdf.js';

/** Counts `parseContentStream` calls. A module mock rather than a spy, since
 *  `drprune.ts` holds the function as a direct ESM import binding. */
const parses = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/content.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/content.js')>();
  return {
    ...actual,
    parseContentStream: (...args: Parameters<typeof actual.parseContentStream>) => {
      parses.count++;
      return actual.parseContentStream(...args);
    },
  };
});

/** Three widgets sharing ONE `/AP /N` stream that names `/X0`, which resolves
 *  only through `/DR`; `/X0` names `/X1` and `/X1` names `/X2`, so the kept
 *  `/DR` streams need a fixpoint to charge. Four distinct streams in all. */
function sharedAppearancePdf(): Uint8Array {
  const stream = (s: string, dict = '') => `<< ${dict}/Length ${s.length} >>\nstream\n${s}\nendstream`;
  const form = (s: string) => stream(s, '/Type /XObject /Subtype /Form /BBox [0 0 10 10] ');
  const widget = (i: number) =>
    `<< /Type /Annot /Subtype /Widget /FT /Tx /T (f${i}) /P 3 0 R /Rect [0 0 10 10] /AP << /N 5 0 R >> >>`;
  return buildObjectsPdf([
    '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [9 0 R 10 0 R 11 0 R] '
      + '/DR << /XObject << /X0 6 0 R /X1 7 0 R /X2 8 0 R >> >> >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Annots [9 0 R 10 0 R 11 0 R] /Contents 4 0 R >>',
    stream('n'),
    form('/X0 Do'),
    form('/X1 Do'),
    form('/X2 Do'),
    form('n'),
    widget(0), widget(1), widget(2),
  ]);
}

describe('pruneDefaultResources parses each distinct stream once per pass (ibzo.9)', () => {
  beforeEach(() => { parses.count = 0; });

  it('does not re-parse an /AP shared by several widgets, nor a /DR stream on each fixpoint round', () => {
    const doc = Document.Open(sharedAppearancePdf());
    parses.count = 0;
    const result = pruneDefaultResources(doc);
    // The fixture must actually reach the fixpoint: all three are kept.
    expect(result.skipped).toBeUndefined();
    const acro = doc.resolve(doc.catalog().get('AcroForm'));
    const dr = isDict(acro) ? doc.resolve(acro.get('DR')) : undefined;
    const xo = isDict(dr) ? doc.resolve(dr.get('XObject')) : undefined;
    expect(isDict(xo) ? [...xo.keys()].sort() : []).toEqual(['X0', 'X1', 'X2']);
    // Re-parsing gives 3 (the shared /AP) + 3 + 3 (two fixpoint rounds) = 9.
    expect(parses.count).toBe(4);
  });
});
