// krf2.2: Artifact.Remove() and page.RemoveArtifacts(filter) -- the span goes,
// with every resource only it used, and nothing another page holds moves.
import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import type { Page } from '../src/page.js';
import { isDict, type PdfDict } from '../src/types.js';
import {
  buildArtifactRemovePdf, buildNestedAcrossFormPdf, buildThreeArtifactsPdf,
} from './helpers/build-artifact-remove-pdf.js';
import {
  buildArtifactsPdf, buildNestedArtifactPdf, buildUnbalancedArtifactPdf,
} from './helpers/build-artifacts-pdf.js';
import { buildDecorateTarget } from './helpers/build-decorate-pdf.js';
import { buildPngRgb } from './helpers/build-embed-images.js';

const open = () => Document.Open(buildArtifactRemovePdf());
const decoded = (p: Page) => new TextDecoder('latin1').decode(p.Contents);
const sub = (doc: Document, p: Page, key: string): string[] => {
  const r = p.Resources;
  const d = r ? doc.resolve(r.get(key)) : undefined;
  return isDict(d) ? [...d.keys()].sort() : [];
};
const subtypes = (p: Page) => p.Artifacts.map((a) => a.subtype);

describe('page.RemoveArtifacts', () => {
  it('removes a watermark that opens in one /Contents stream and closes in the next', () => {
    const doc = open();
    const [p1] = doc.Pages;
    expect(p1.RemoveArtifacts({ subtype: 'Watermark' })).toBe(1);
    expect(subtypes(p1)).toEqual(['Header']);
    const text = p1.GetText();
    expect(text).not.toContain('WM');
    expect(text).toContain('body');
    expect(text).toContain('keep');
    expect(decoded(p1)).not.toMatch(/BDC|EMC.*EMC/);
  });

  it('prunes what only the span used, and keeps what other content names', () => {
    const doc = open();
    const [p1] = doc.Pages;
    p1.RemoveArtifacts({ subtype: 'Watermark' });
    expect(sub(doc, p1, 'XObject')).toEqual(['Fm1', 'Fm2']);
    expect(sub(doc, p1, 'ExtGState')).toEqual([]);
    expect(sub(doc, p1, 'Font')).toEqual(['F1']);
  });

  it('keeps a font named only by a form that inherits the page resources', () => {
    const doc = open();
    const p2 = doc.Pages[1];
    p2.RemoveArtifacts({ subtype: 'Watermark' });
    expect(sub(doc, p2, 'Font')).toEqual(['F1']);
    expect(p2.GetText()).toContain('keep');
    expect(p2.GetText()).not.toContain('WM');
  });

  it('leaves another page sharing the same /Resources untouched', () => {
    const doc = open();
    const [p1, p2] = doc.Pages;
    p1.RemoveArtifacts({ subtype: 'Watermark' });
    p1.RemoveArtifacts({ subtype: 'Header' });
    expect(subtypes(p2)).toEqual(['Watermark', 'Header']);
    expect(sub(doc, p2, 'XObject')).toEqual(['Fm0', 'Fm1', 'Fm2']);
    expect(sub(doc, p2, 'ExtGState')).toEqual(['GS0']);
    expect(p2.GetText()).toContain('WM');
  });

  it('removes an artifact inside a form from this page’s copy only, keeping the rest of the form', () => {
    const doc = open();
    const [p1, p2] = doc.Pages;
    expect(p1.RemoveArtifacts({ subtype: 'Header' })).toBe(1);
    expect(subtypes(p1)).toEqual(['Watermark']);
    expect(p1.GetPaths().some((p) => p.fill?.rgb.join() === '0,255,0')).toBe(true);
    expect(p1.GetPaths().some((p) => p.fill?.rgb.join() === '255,0,0')).toBe(false);
    expect(p2.GetPaths().some((p) => p.fill?.rgb.join() === '255,0,0')).toBe(true);
  });

  it('drops the removed form from the saved file once no page draws it', () => {
    const doc = open();
    for (const p of doc.Pages) p.RemoveArtifacts({ subtype: 'Watermark' });
    const saved = new TextDecoder('latin1').decode(doc.Save());
    expect(saved).not.toContain('0 0 50 50 re');
    expect(saved).toContain('0 0 10 10 re');
  });

  it('accepts a predicate and a type filter', () => {
    const doc = open();
    expect(doc.Pages[0].RemoveArtifacts((a) => a.subtype === 'Header')).toBe(1);
    expect(doc.Pages[1].RemoveArtifacts({ type: 'Pagination' })).toBe(2);
    expect(doc.Pages[1].Artifacts).toEqual([]);
  });

  it('refuses a missing or empty filter before touching the page', () => {
    const doc = open();
    const before = decoded(doc.Pages[0]);
    const p = doc.Pages[0] as unknown as { RemoveArtifacts(f?: unknown): number };
    expect(() => p.RemoveArtifacts()).toThrow(TypeError);
    expect(() => p.RemoveArtifacts({})).toThrow(TypeError);
    expect(() => p.RemoveArtifacts({ subtype: 5 })).toThrow(TypeError);
    expect(decoded(doc.Pages[0])).toBe(before);
  });

  it('removes a nested artifact with its parent, counting both', () => {
    const doc = Document.Open(buildNestedArtifactPdf());
    expect(doc.Pages[0].RemoveArtifacts(() => true)).toBe(2);
    expect(doc.Pages[0].Artifacts).toEqual([]);
    expect(doc.Pages[0].GetPaths()).toEqual([]);
  });

  it('removes a form whose own artifact was also selected, without putting it back', () => {
    const doc = Document.Open(buildNestedAcrossFormPdf());
    const p = doc.Pages[0];
    expect(p.Artifacts.map((a) => a.addr.path)).toEqual([[], ['FmX']]);
    expect(p.RemoveArtifacts(() => true)).toBe(2);
    expect(sub(doc, p, 'XObject')).toEqual([]);
    expect(p.GetPaths()).toHaveLength(1);
  });

  it('removes only the inner artifact when only it is selected', () => {
    const doc = Document.Open(buildNestedArtifactPdf());
    expect(doc.Pages[0].RemoveArtifacts({ type: 'Layout' })).toBe(1);
    expect(doc.Pages[0].Artifacts.map((a) => a.type)).toEqual(['Page']);
    expect(doc.Pages[0].GetPaths()).toHaveLength(1);
  });

  it('refuses an artifact never closed by an EMC, changing nothing', () => {
    const doc = Document.Open(buildUnbalancedArtifactPdf());
    const before = decoded(doc.Pages[0]);
    expect(() => doc.Pages[0].RemoveArtifacts(() => true)).toThrow(RangeError);
    expect(decoded(doc.Pages[0])).toBe(before);
  });
});

describe('PageArtifact.Remove', () => {
  it('removes the one artifact it names', () => {
    const doc = Document.Open(buildArtifactsPdf());
    const [header] = doc.Pages[0].Artifacts;
    header.Remove();
    expect(doc.Pages[0].Artifacts.map((a) => a.subtype)).toEqual([undefined]);
  });

  it('refuses a handle an earlier removal made stale', () => {
    const doc = Document.Open(buildArtifactsPdf());
    const [header, bare] = doc.Pages[0].Artifacts;
    header.Remove();
    const before = decoded(doc.Pages[0]);
    expect(() => bare.Remove()).toThrow(RangeError);
    expect(decoded(doc.Pages[0])).toBe(before);
    doc.Pages[0].Artifacts[0].Remove();
    expect(doc.Pages[0].Artifacts).toEqual([]);
  });

  it('refuses a stale handle whose address now opens a DIFFERENT artifact', () => {
    const doc = Document.Open(buildThreeArtifactsPdf());
    const [first, second] = doc.Pages[0].Artifacts;
    first.Remove();
    expect(() => second.Remove()).toThrow(RangeError);
    expect(doc.Pages[0].Artifacts.map((a) => a.bbox![0])).toEqual([60, 110]);
  });

  it('keeps reading as a plain record', () => {
    const doc = Document.Open(buildArtifactsPdf());
    const [a] = doc.Pages[0].Artifacts;
    expect(Object.keys(a)).not.toContain('Remove');
    expect(typeof a.Remove).toBe('function');
  });
});

describe('undoing this library’s own decoration (krf2.1 + krf2.2)', () => {
  it('a typed image watermark comes off one page and stays on the other', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 2 }));
    doc.AddWatermark({ image: buildPngRgb(), artifact: true });
    doc.AddHeaderFooter({ footer: { center: '{page}' }, artifact: true });
    expect(doc.Pages[0].RemoveArtifacts({ subtype: 'Watermark' })).toBe(1);
    expect(doc.Pages[0].Images).toHaveLength(0);
    expect(doc.Pages[1].Images).toHaveLength(1);
    expect(subtypes(doc.Pages[0])).toEqual(['Footer']);
    expect(doc.Pages[0].GetText()).toContain('1');
    const again = Document.Open(doc.Save());
    expect(again.Pages[0].Images).toHaveLength(0);
    expect(again.Pages[1].Images).toHaveLength(1);
  });

  it('removing the watermark from every page removes the image from the file', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 2 }));
    doc.AddWatermark({ image: buildPngRgb(), artifact: true });
    for (const p of doc.Pages) p.RemoveArtifacts({ subtype: 'Watermark' });
    const again = Document.Open(doc.Save());
    const images = [...again.objectEntries()].filter(([, o]) =>
      o !== null && typeof o === 'object' && 'kind' in o && o.kind === 'stream'
      && (o.dict.get('Subtype') as { name?: string } | undefined)?.name === 'Image');
    expect(images).toEqual([]);
    expect(isDict(again.Pages[0].Resources as PdfDict)).toBe(true);
  });
});
