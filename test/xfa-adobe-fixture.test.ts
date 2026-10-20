// test/xfa-adobe-fixture.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { ADOBE_PROBES, ADOBE_RECORDED, adobeGoldens, loadAdobeProbe } from './helpers/xfa-adobe.js';

describe('Adobe Reader oracle fixture (164g.11)', () => {
  const g = adobeGoldens();
  it('holds a golden for every probe, and a probe for every golden', () => {
    expect(Object.keys(g.probes).sort()).toEqual([...ADOBE_PROBES, ...ADOBE_RECORDED].sort());
  });
  it.each(ADOBE_PROBES)('%s is a dynamic XFA document', (name) => {
    const doc = Document.Open(loadAdobeProbe(name));
    expect(doc.Pages.length).toBe(1);
    expect(g.probes[name].expect === 'match' || g.probes[name].reason !== undefined).toBe(true);
  });
});
