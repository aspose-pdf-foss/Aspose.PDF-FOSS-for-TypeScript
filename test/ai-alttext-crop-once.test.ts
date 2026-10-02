import { describe, it, expect, vi } from 'vitest';

// Counts how often GenerateAltText builds a page renderer: the page canvas is
// rendered once per renderer, so one renderer per page is one render per page.
const made = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/raster.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/raster.js')>();
  return {
    ...mod,
    pageRegionRenderer: (...args: Parameters<typeof mod.pageRegionRenderer>) => {
      made.count++;
      return mod.pageRegionRenderer(...args);
    },
  };
});

import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { scriptedModel } from './helpers/scripted-model.js';

describe('GenerateAltText crops (u0ec)', () => {
  it('renders a page once for all of its image-less figures', async () => {
    const doc = Document.New(PageFormat.A4);
    const root = doc.CreateStructTree();
    doc.Pages[0]!.AddBarcode({ type: 'code128', data: 'ONE' }, [50, 600, 200, 60], { tag: root.Append('Figure') });
    doc.Pages[0]!.AddBarcode({ type: 'code128', data: 'TWO-TWO' }, [50, 300, 200, 60], { tag: root.Append('Figure') });
    const m = scriptedModel((_, n) => JSON.stringify({ alt: `Barcode ${n}.`, decorative: false }));
    const r = await doc.GenerateAltText(m);
    expect(r.figures.map((f) => f.status)).toEqual(['described', 'described']);
    expect(m.requests).toHaveLength(2);
    expect(made.count).toBe(1);
  });
});
