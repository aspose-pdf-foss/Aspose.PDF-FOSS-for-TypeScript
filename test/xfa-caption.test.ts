// test/xfa-caption.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { adobeGoldens, loadAdobeProbe } from './helpers/xfa-adobe.js';

/**
 * 164g.36: a caption that states NO reserve takes its measured text. Adobe
 * probe t121 lays out six such fields; the oracle harness compares a field's
 * WIDGET, which excludes the caption, so these are compared here: the widget's
 * BOTTOM is the bottom of Adobe's field box (the box's height, caption
 * included) and its TOP sits below the caption by the caption's measured height.
 *
 * capWide's caption is one 16-W word in a 0.5in field: Adobe splits it between
 * characters (four lines, 36.8pt), which is the rule `layoutRuns`'
 * `breakAnywhere` adds for XFA.
 */
const PAGE_H = 792;
const ORIGIN = 36;
const TOL = 0.05;
const goldens = adobeGoldens();

/** The caption heights the captions take, by Adobe's rule (164g.32): one 8pt
 *  line is 8, n lines are 9.6(n-1) + 8, own margins and own size count. t114 is
 *  not compared: its Myriad Pro row has no face here, and a leaf that cannot be
 *  measured leaves its whole `tb` subform without a height. */
const CAPTION: Record<string, Record<string, number>> = {
  t121: {
    capWide: 9.6 * 3 + 8,
    capFit: 8,
    capTwo: 9.6 * 2 + 8,
    capMar: 2 + 8 + 3,
    capBig: 12,
    fixFit: 8,
  },
};

for (const [t, fields] of Object.entries(CAPTION)) describe(`Adobe ${t}: reserve-less captions (164g.36)`, () => {
  const probe = goldens.probes[t];
  const doc = Document.Open(loadAdobeProbe(t));
  doc.ConvertXfaToAcroForm();
  const subTop = probe.subforms['form1.S'][0][2];
  for (const [name, cap] of Object.entries(fields)) {
    it(`${name}: the widget sits below its ${String(cap)}pt caption, inside Adobe's box`, () => {
      const [, x, y, w, h] = probe.fields[`form1.S.${name}`][0];
      const top = ORIGIN + subTop + y;
      const want = [ORIGIN + x, PAGE_H - (top + h), ORIGIN + x + w, PAGE_H - (top + cap)];
      const field = doc.Form.Get(`form1[0].S[0].${name}[0]`);
      expect(field, name).toBeDefined();
      const got = doc.resolve(field!.Dict.get('Rect')) as number[];
      for (let i = 0; i < 4; i++) expect(Math.abs(got[i] - want[i]), `${name} [${String(i)}] ${got.join(' ')} vs ${want.join(' ')}`).toBeLessThanOrEqual(TOL);
    });
  }
});
