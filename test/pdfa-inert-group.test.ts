import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { usesTransparency } from '../src/pdfatransparency.js';
import { name, type PdfDict, type PdfObject } from '../src/types.js';
import { buildPdfaPdf } from './helpers/build-pdfa-pdf.js';

/**
 * Dropping an inert transparency group for PDF/A-1 (`ixxw.5`).
 *
 * ISO 19005-1 prohibits transparency, and `ConvertToPdfA` cannot flatten it —
 * correctly, since flattening means rasterizing the page and losing its text.
 * But producers STAMP `/Group /S /Transparency` on pages that use no
 * transparency at all, and such a group cannot change the rendered result, so
 * removing it costs nothing and is the difference between a document that
 * converts and one that does not.
 *
 * The predicate is DELIBERATELY CONSERVATIVE and deliberately does NOT read
 * content streams: every ExtGState in a resource dictionary counts, whether or
 * not any operator selects it. A group is dropped only when transparency can
 * be ruled out entirely; real transparency keeps its group and is still
 * reported unresolved.
 */

const R = (o: PdfObject | undefined): PdfObject => (o === undefined ? null : o);
const d = (...pairs: [string, PdfObject][]): PdfDict => new Map<string, PdfObject>(pairs);
const res = (kind: string, key: string, v: PdfObject): PdfDict =>
  d([kind, d([key, v])]);

describe('usesTransparency — the conservative predicate', () => {
  it('is false for absent or empty resources', () => {
    expect(usesTransparency(undefined, R)).toBe(false);
    expect(usesTransparency(d(), R)).toBe(false);
  });

  describe('ExtGState', () => {
    const gs = (...pairs: [string, PdfObject][]) =>
      usesTransparency(res('ExtGState', 'GS', d(...pairs)), R);

    it('a soft mask is transparency; /None is not', () => {
      expect(gs(['SMask', d(['S', name('Alpha')])])).toBe(true);
      expect(gs(['SMask', name('None')])).toBe(false);
    });
    it('a non-Normal blend mode is transparency', () => {
      expect(gs(['BM', name('Multiply')])).toBe(true);
      expect(gs(['BM', name('Normal')])).toBe(false);
      expect(gs(['BM', name('Compatible')])).toBe(false);
    });
    it('constant alpha below 1 is transparency, on either key', () => {
      expect(gs(['CA', 0.5])).toBe(true);
      expect(gs(['ca', 0.5])).toBe(true);
      expect(gs(['CA', 1])).toBe(false);
      expect(gs(['ca', 1])).toBe(false);
    });
    // The rule `transparencyRule` already records: doc.resolve(undefined) is
    // null and `null !== undefined`, so a resolved-value test reports a soft
    // mask for every ExtGState that has none.
    it('an ExtGState carrying none of them is not transparency', () => {
      expect(gs(['LW', 2])).toBe(false);
    });
  });

  describe('XObjects', () => {
    const img = (...pairs: [string, PdfObject][]): PdfObject => ({
      kind: 'stream',
      dict: d(['Subtype', name('Image')], ['Width', 1], ['Height', 1], ...pairs),
      raw: new Uint8Array(1),
    });

    it('an image /SMask or /Mask is transparency', () => {
      expect(usesTransparency(res('XObject', 'Im', img(['SMask', 1])), R)).toBe(true);
      expect(usesTransparency(res('XObject', 'Im', img(['Mask', [0, 0]])), R)).toBe(true);
      expect(usesTransparency(res('XObject', 'Im', img()), R)).toBe(false);
    });

    const form = (...pairs: [string, PdfObject][]): PdfObject => ({
      kind: 'stream',
      dict: d(['Subtype', name('Form')], ['BBox', [0, 0, 1, 1]], ...pairs),
      raw: new Uint8Array(0),
    });

    it('a nested transparency group is transparency', () => {
      expect(usesTransparency(
        res('XObject', 'Fm', form(['Group', d(['S', name('Transparency')])])), R)).toBe(true);
      // A /Group that is not a transparency group says nothing.
      expect(usesTransparency(
        res('XObject', 'Fm', form(['Group', d(['S', name('Other')])])), R)).toBe(false);
    });

    it('descends into a form’s own resources', () => {
      const inner = res('ExtGState', 'GS', d(['ca', 0.5]));
      expect(usesTransparency(
        res('XObject', 'Fm', form(['Resources', inner])), R)).toBe(true);
    });
  });

  it('descends into a tiling pattern’s resources', () => {
    const pat: PdfObject = {
      kind: 'stream',
      dict: d(['PatternType', 1], ['Resources', res('ExtGState', 'GS', d(['BM', name('Screen')]))]),
      raw: new Uint8Array(0),
    };
    expect(usesTransparency(res('Pattern', 'P0', pat), R)).toBe(true);
  });

  // A form whose resources reach itself is malformed but reachable from a file
  // we did not write, and the walk must not follow it forever.
  it('terminates on a resource cycle', () => {
    const resources: PdfDict = d();
    const form: PdfObject = {
      kind: 'stream',
      dict: d(['Subtype', name('Form')], ['Resources', resources]),
      raw: new Uint8Array(0),
    };
    resources.set('XObject', d(['Fm', form]));
    expect(usesTransparency(resources, R)).toBe(false);
  });
});

describe('ConvertToPdfA — an inert transparency group is dropped at part 1', () => {
  const hasGroup = (doc: Document) =>
    new TextDecoder('latin1').decode(doc.Save()).includes('/Transparency');

  it('drops a group the page cannot use, and then passes the rule', () => {
    const doc = Document.Open(buildPdfaPdf({ transparencyGroup: true }, 1));
    const report = doc.ConvertToPdfA('1b');
    expect(report.applied.map((a) => a.rule)).toContain('Transparency');
    expect(report.unresolved.map((e) => e.rule)).not.toContain('Transparency');
    expect(hasGroup(doc)).toBe(false);
  });

  it('KEEPS a group beside real transparency, and still reports it', () => {
    const doc = Document.Open(buildPdfaPdf({ transparencyGroup: true, lowAlpha: true }, 1));
    const report = doc.ConvertToPdfA('1b');
    expect(report.applied.map((a) => a.rule)).not.toContain('Transparency');
    expect(report.unresolved.map((e) => e.rule)).toContain('Transparency');
    expect(hasGroup(doc)).toBe(true);
  });

  // Parts 2/3/4 permit transparency outright, so there is no rule to satisfy
  // and removing the group would be a change nobody asked for.
  it('leaves the group alone at part 2', () => {
    const doc = Document.Open(buildPdfaPdf({ transparencyGroup: true }, 2));
    const report = doc.ConvertToPdfA('2b');
    expect(report.applied.map((a) => a.rule)).not.toContain('Transparency');
    expect(hasGroup(doc)).toBe(true);
  });

  /**
   * `/Resources` is an INHERITABLE page attribute (32000-1 7.7.3.4), and
   * Ghostscript, Word and others put it on the `/Pages` node. Reading the
   * page's own key finds nothing, concludes "inert" and drops a group that was
   * doing something — the wrong-FALSE direction, which is the one that loses
   * rendering rather than merely leaving a document reported.
   *
   * Measured: no fixture in `buildPdfaPdf` inherits its resources, so the raw
   * read reddened NOTHING until this existed. `colorconvert.ts` shipped the
   * same bug (`85l8.5`) and it degraded a whole pass.
   */
  it('sees an ExtGState the page INHERITS from the /Pages node', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const objs = [
      '',
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 99 99] '
        + '/Resources << /ExtGState << /GS << /Type /ExtGState /ca 0.5 >> >> >> >>',
      '<< /Type /Page /Parent 2 0 R /Group << /S /Transparency >> >>',
    ];
    let body = '%PDF-1.4\n';
    const off: number[] = [];
    for (let i = 1; i < objs.length; i++) {
      off[i] = enc(body).length;
      body += `${i} 0 obj\n${objs[i]}\nendobj\n`;
    }
    const xo = enc(body).length;
    let x = `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
    for (let i = 1; i < objs.length; i++) x += `${String(off[i]!).padStart(10, '0')} 00000 n \n`;
    const doc = Document.Open(enc(
      body + x + `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xo}\n%%EOF\n`));

    const report = doc.ConvertToPdfA('1b');
    expect(report.applied.map((a) => a.rule)).not.toContain('Transparency');
    expect(hasGroup(doc)).toBe(true);
  });

  it('is declined by preserve: [‘transparency’]', () => {
    const doc = Document.Open(buildPdfaPdf({ transparencyGroup: true }, 1));
    const report = doc.ConvertToPdfA('1b', { preserve: ['transparency'] });
    expect(report.applied.map((a) => a.rule)).not.toContain('Transparency');
    expect(report.unresolved.map((e) => e.rule)).toContain('Transparency');
    expect(hasGroup(doc)).toBe(true);
  });
});
