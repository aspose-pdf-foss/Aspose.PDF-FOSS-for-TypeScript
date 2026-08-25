import { describe, it, expect } from 'vitest';
import { Document, visitContent } from '../src/index.js';
import type { GlyphEvent } from '../src/index.js';
import { buildArtifactPdf } from './helpers/build-artifact-pdf.js';

describe('content walk artifact tracking', () => {
  it('tags glyphs with mcid / artifact / loose provenance', () => {
    const doc = Document.Open(buildArtifactPdf());
    const runs: Record<string, { mcid?: number; artifact?: boolean }> = {};
    visitContent(doc, doc.Pages[0], {
      glyph: (e: GlyphEvent) => {
        const tag = e.mcid !== undefined ? `mcid${e.mcid}` : e.artifact ? 'artifact' : 'loose';
        runs[tag] ??= { mcid: e.mcid, artifact: e.artifact };
      },
    });
    expect(runs['mcid0']).toBeTruthy();
    expect(runs['artifact']).toEqual({ mcid: undefined, artifact: true });
    expect(runs['loose']).toEqual({ mcid: undefined, artifact: undefined });
  });
});
