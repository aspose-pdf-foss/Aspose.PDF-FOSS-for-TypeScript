import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { isArray, isDict } from '../src/types.js';

const BOX: [number, number, number, number] = [72, 400, 200, 300];
const T = 'The quick brown fox jumps over the lazy dog and then keeps running far away into the woods';
const block = (align: 'left' | 'justify' | 'center' | 'right') => {
  const d = Document.New(PageFormat.A4);
  d.Pages[0].AddTextBlock(T, BOX, { fontSize: 12, align });
  return Document.Open(d.Save());
};
/** Decoded page content plus every annotation's /QuadPoints and /Rect. */
const digest = (doc: Document): string => {
  const h = createHash('sha256');
  h.update(doc.Pages[0].Contents);
  const annots = doc.resolve(doc.Pages[0].Dict.get('Annots'));
  if (isArray(annots)) for (const a of annots) {
    const d = doc.resolve(a);
    if (isDict(d)) h.update(JSON.stringify([doc.resolve(d.get('QuadPoints')), doc.resolve(d.get('Rect'))]));
  }
  return h.digest('hex');
};

// Recorded BEFORE 6y39 touched src/. A red case here is a regression of the
// unhyphenated path, never a golden to refresh.
const RECORDED: Record<string, string> = {
  'replace-left': '24de01a570ffdbc879085043f4194672d5a7f6576718c30d1b9d8004ef7584a4',
  'replace-justify': '2940a67f2c10a8fbf39f683287f4ac0a0bb223fedbb00c3d7f469cb791a1a4d7',
  'replace-center': 'd9722b660cbb92538d204a6b7dcae2e6fb53a6772f4cc54bdbf7d48f5d544c6f',
  'replace-right': 'd464c4daa47f616bed63d657b1081a638915113e37ad076a4a5a2cfdd082ad40',
  'restyle-reflow': 'a73efbbf252830bcea4175b55255caf0615a09bdf45a0e6eb27126df53211e74',
  'replace-link': 'df1974edd46f49f191a6f0e1c08404066ba1fa861547e5e0ca439196fa8c4f5a',
};

describe('reflow without hyphenate is byte-identical (6y39 fence)', () => {
  const cases: Record<string, () => Document> = {
    'replace-left': () => { const d = block('left'); d.Pages[0].ReplaceText('quick', 'remarkably quick', { adjust: 'reflow' }); return d; },
    'replace-justify': () => { const d = block('justify'); d.Pages[0].ReplaceText('quick', 'remarkablyquick', { adjust: 'reflow' }); return d; },
    'replace-center': () => { const d = block('center'); d.Pages[0].ReplaceText('lazy dog', 'cat', { adjust: 'reflow' }); return d; },
    'replace-right': () => { const d = block('right'); d.Pages[0].ReplaceText('fox', 'foxes and hounds', { adjust: 'reflow' }); return d; },
    'restyle-reflow': () => { const d = block('left'); d.Pages[0].RestyleText('quick', { fontSize: 20, underline: true }, { adjust: 'reflow' }); return d; },
    'replace-link': () => {
      const d = block('left');
      const m = d.Pages[0].Search('lazy dog')[0];
      d.Pages[0].AddLink({ rect: m.quads[0], action: { type: 'uri', uri: 'https://example.com' } });
      d.Pages[0].AddHighlight({ quads: m.quads.flatMap(([x0, y0, x1, y1]) => [x0, y1, x1, y1, x0, y0, x1, y0]) });
      d.Pages[0].ReplaceText('quick', 'remarkably quick', { adjust: 'reflow' });
      return d;
    },
  };
  for (const [name, make] of Object.entries(cases)) {
    it(name, () => {
      const got = digest(make());
      if (RECORDED[name] === '') console.log(`RECORD ${name} ${got}`);
      expect(got).toBe(RECORDED[name]);
    });
  }
});
