import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { visitContent, mapRegions, GlyphEvent, ImageEvent } from '../src/text.js';
import { buildMultiStreamPage, buildSharedXObjectPages } from './helpers/build-edit-pdf.js';
import { buildImageOnlyPdf } from './helpers/build-text-pdf.js';

function collect(doc: Document, pageIndex = 0): GlyphEvent[] {
  const events: GlyphEvent[] = [];
  visitContent(doc, doc.Pages[pageIndex], { glyph: (e) => events.push(e) });
  return events;
}

describe('visitContent — glyph provenance', () => {
  it('tags each glyph with its stream + op index and device position', () => {
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 72 100 Td (Hi) Tj ET']));
    const events = collect(doc);
    expect(events.map((e) => e.text).join('')).toBe('Hi');
    expect(events[0].addr).toEqual({ path: [], streamIndex: 0, opIndex: 3 }); // the Tj op
    expect(events[0].quad[0]).toBeCloseTo(72, 1);   // pen x at start
    expect(events[0].quad[1]).toBeCloseTo(100, 1);  // baseline y
    expect(events[1].quad[0]).toBeGreaterThan(events[0].quad[0]); // H advances before i
  });

  it('descends into a Form XObject and records the path', () => {
    const doc = Document.Open(buildSharedXObjectPages());
    const events = collect(doc);
    expect(events.map((e) => e.text).join('')).toBe('shared');
    expect(events[0].addr.path).toEqual(['Fm0']);
  });
});

describe('visitContent — image placement', () => {
  it('emits an image event with the device-space placement box', () => {
    const doc = Document.Open(buildImageOnlyPdf()); // 'q 100 0 0 100 50 50 cm /Im0 Do Q'
    const images: ImageEvent[] = [];
    visitContent(doc, doc.Pages[0], { image: (e) => images.push(e) });
    expect(images).toHaveLength(1);
    expect(images[0].kind).toBe('xobject');
    expect(images[0].quad).toEqual([50, 50, 150, 150]); // unit square * cm
    expect(images[0].addr).toEqual({ path: [], streamIndex: 0, opIndex: 2 }); // the Do op
  });
});

describe('mapRegions', () => {
  it('returns only the glyphs inside the given rectangle', () => {
    // Two words far apart on one line; redact a rect around the first only.
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (AA) Tj 200 0 Td (BB) Tj ET']));
    const hits = mapRegions(doc, doc.Pages[0], [[45, 95, 75, 115]]);
    expect(hits.glyphs.map((g) => g.text).join('')).toBe('AA');
    expect(hits.images).toHaveLength(0);
  });

  it('catches an image overlapping the rectangle', () => {
    const doc = Document.Open(buildImageOnlyPdf()); // image at [50,50,150,150]
    const hits = mapRegions(doc, doc.Pages[0], [[140, 140, 160, 160]]); // clips a corner
    expect(hits.images).toHaveLength(1);
    expect(hits.glyphs).toHaveLength(0);
  });
});
