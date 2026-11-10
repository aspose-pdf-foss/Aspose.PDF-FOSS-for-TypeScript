import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildPages } from '../src/pagetree.js';
import { extractPage, defaultPrunePolicy } from '../src/extractor.js';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { isDict, name } from '../src/types.js';
import { buildDefaultedPagePdf, buildInheritedPageCopyPdf } from './helpers/build-page-tree-pdf.js';

describe('extractPage', () => {
  it('keeps explicit prune exclusions authoritative over materialized defaults', () => {
    const doc = Document.Open(buildDefaultedPagePdf({ root: '' }));
    const policy = defaultPrunePolicy();
    const keys = ['MediaBox', 'CropBox', 'Rotate', 'Resources'];
    for (const key of keys) policy.dropPageKeys.add(key);
    const { objects, pageNum } = extractPage(doc, doc.Pages[0].Dict, policy);
    const page = objects.get(pageNum);
    if (!isDict(page)) throw new Error('missing extracted page');
    for (const key of keys) expect(page.has(key)).toBe(false);
  });

  it('applies an explicit prune policy after materializing inherited attributes', () => {
    const doc = Document.Open(buildInheritedPageCopyPdf('nested'));
    const policy = defaultPrunePolicy();
    policy.dropPageKeys.add('Resources');
    const { objects, pageNum } = extractPage(doc, doc.Pages[0].Dict, policy);
    const page = objects.get(pageNum);
    expect(isDict(page)).toBe(true);
    if (!isDict(page)) throw new Error('missing extracted page');
    expect(page.has('Resources')).toBe(false);
    expect(page.has('Parent')).toBe(false);
  });

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
