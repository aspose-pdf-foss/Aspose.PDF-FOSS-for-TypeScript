import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Document } from '../src/document.js';
import { decodePng } from './helpers/decode-png.js';
import { samplesMatch, diffImages } from './helpers/compare-image.js';
import { GOLDEN_FIXTURES, DEFAULT_MAX_FAIL_FRACTION } from './helpers/svg-golden-fixtures.js';

// Browser-rendered goldens for ToSvg's transparency output, generated out of
// band by scripts/gen-svg-goldens.ts. They catch the shared-convention bug
// class: our SVG emitter and our rasterizer agreeing with each other and both
// disagreeing with what a real SVG engine paints. See PROVENANCE.md.
//
// ESM: no __dirname. Same idiom as test/jpeg-real.test.ts.
const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'fixtures', 'svg');

// A golden is committed only for fixtures where Chrome and resvg agreed with
// each other and with the ISO formulas. The rest are recorded as divergences in
// PROVENANCE.md; skipping here keeps the suite honest about what is verified.
const present = GOLDEN_FIXTURES.filter((fx) => existsSync(join(dir, `${fx.name}.png`)));

describe('ToSvg transparency — browser goldens', () => {
  it('has at least one golden committed', () => {
    expect(present.length).toBeGreaterThan(0);
  });

  for (const fx of present) {
    describe(fx.name, () => {
      const golden = decodePng(new Uint8Array(readFileSync(join(dir, `${fx.name}.png`))));
      const ours = decodePng(Document.Open(fx.pdf()).Pages[0].ToImage());

      it('renders at the golden’s dimensions', () => {
        expect([ours.width, ours.height]).toEqual([golden.width, golden.height]);
      });

      it('agrees with the browser on the composited interior colours', () => {
        // Tight: these points are flat, so antialiasing cannot explain a miss.
        expect(samplesMatch(golden, fx.probes)).toEqual([]);
        expect(samplesMatch(ours, fx.probes)).toEqual([]);
      });

      it('agrees with the browser across the whole page', () => {
        // Loose: sized for edge antialiasing, not for a wrong composite.
        const d = diffImages(golden, ours);
        expect(d.failFraction).toBeLessThanOrEqual(fx.maxFailFraction ?? DEFAULT_MAX_FAIL_FRACTION);
      });
    });
  }
});
