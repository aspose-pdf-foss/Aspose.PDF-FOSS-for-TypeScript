import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildPages } from '../src/pagetree.js';
import { extractPage, defaultPrunePolicy } from '../src/extractor.js';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { isDict, name } from '../src/types.js';

describe('extractPage', () => {
  it('collects page + contents, excludes /Parent', () => {
    const doc = Document.Open(buildClassicPdf(2));
    const page = buildPages(doc).pages[0];
    const { objects, pageNum } = extractPage(doc, page.Dict, defaultPrunePolicy());
    // The page object itself and its contents stream must be present.
    expect(objects.size).toBeGreaterThanOrEqual(2);
    const pageObj = objects.get(pageNum);
    expect(isDict(pageObj!)).toBe(true);
    if (isDict(pageObj!)) expect(pageObj.has('Parent')).toBe(false);
  });

  it('strips GoTo actions but keeps URI links', () => {
    const doc = Document.Open(buildClassicPdf(1));
    const policy = defaultPrunePolicy();
    const goto = new Map<string, any>([['S', name('GoTo')]]);
    const uri = new Map<string, any>([['S', name('URI')], ['URI', { kind: 'string', bytes: new TextEncoder().encode('http://x') }]]);
    const a1 = new Map<string, any>([['Subtype', name('Link')], ['A', goto]]);
    const a2 = new Map<string, any>([['Subtype', name('Link')], ['A', uri]]);
    const out = policy.sanitizeAnnots(doc, [a1, a2]) as Map<string, any>[];
    expect(out[0].has('A')).toBe(false);      // GoTo stripped
    expect(out[1].has('A')).toBe(true);       // URI kept
  });
});
