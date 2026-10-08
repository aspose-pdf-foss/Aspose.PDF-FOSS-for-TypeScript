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
//
// RE-RECORDED ONCE, by r9u0, for five cases (replace-center did not move):
// reflow now drops text-positioning a later Tm supersedes (dropDeadPositioning).
// Verified before re-recording: every glyph origin, the page rendered at 2x
// and every annotation quad were IDENTICAL with the pass on and off; only the
// bytes shrank (325 -> 283 for replace-left). Do not refresh it again without
// the same check.
const RECORDED: Record<string, string> = {
  'replace-left': '1ec9012630b77757fa902174f779fab1e0c75590d1889587da71dd674023810f',
  'replace-justify': '4fe667364f80b0b03e04b394b123b21ce1e2e07d7e1b8e1146c22f03aee838c2',
  'replace-center': 'd9722b660cbb92538d204a6b7dcae2e6fb53a6772f4cc54bdbf7d48f5d544c6f',
  'replace-right': '58468e886980e42197b9a75bc801af4cd886e66d94462177d5f8ba8019ae2a9d',
  'restyle-reflow': 'c1be75796e8d6737673f7c012b809cfd194a03acbb5ac62cf73ea3107f9318b0',
  'replace-link': '04ed8d091542d5034dfe00cf65e74542fab21fbfa9ed1e5a7f26e4ceb870dae1',
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
