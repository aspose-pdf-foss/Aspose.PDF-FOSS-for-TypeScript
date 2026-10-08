// test/toc-leader-identity.test.ts
// A FENCE recorded before v9j3.1 moved the dot-leader count into tabstops.ts.
// A red case is a regression, never a golden to refresh.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';

const RECORDED: Record<string, string> = {
  plain: 'd72f8a963e47a657763321672cf216d710168cb9a2a7e359f1d61312a8400db0',
  tagged: '3de52e0e6782f56586680024148159ff2a94252707bb939317d3305e816a7c0a',
  long: '8a9dfbb5f6846cae415c3e9792778b3f366ba056f6ca6c357310eb812355b2ca',
};
const make: Record<string, () => Document> = {
  plain: () => { const d = Document.New(PageFormat.A4); for (let i = 0; i < 3; i++) d.AddPage(); d.Pages[0].AddTOC([{ title: 'Intro', page: 2 }, { title: 'Methods', page: 3 }, { title: 'Results', page: 4, level: 2 }], [72, 300, 400, 400]); return d; },
  tagged: () => { const d = Document.New(PageFormat.A4); d.AddPage(); d.CreateStructTree(); d.Pages[0].AddTOC([{ title: 'Intro', page: 2 }], [72, 300, 400, 400], { tagged: true }); return d; },
  long: () => { const d = Document.New(PageFormat.A4); d.AddPage(); d.Pages[0].AddTOC([{ title: 'A very long chapter title that wraps across more than one line of the table of contents', page: 2 }], [72, 300, 200, 400]); return d; },
};
describe('TOC dot leaders are byte-identical (v9j3.1 fence)', () => {
  for (const [name, f] of Object.entries(make)) {
    it(name, () => {
      const contents = f().Pages[0].Contents;
      // Non-vacuous: every fixture really draws a dot leader.
      expect(new TextDecoder('latin1').decode(contents)).toMatch(/(.{3,}) Tj/);
      const got = createHash('sha256').update(contents).digest('hex');
      if (RECORDED[name] === '') console.log(`RECORD ${name} ${got}`);
      expect(got).toBe(RECORDED[name]);
    });
  }
});
