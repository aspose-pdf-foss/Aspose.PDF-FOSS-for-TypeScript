import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isArray, isDict, isName } from '../src/types.js';
import { buildFlattenTarget } from './helpers/build-flatten-target.js';
import { buildFlattenFormTarget } from './helpers/build-flatten-form.js';

const content = (doc: Document, i = 0) =>
  new TextDecoder('latin1').decode(doc.Pages[i].Contents);

const annots = (doc: Document, i = 0) => {
  const a = doc.resolve(doc.Pages[i].Dict.get('Annots'));
  return isArray(a) ? a : [];
};

describe('public Flatten API (L3)', () => {
  describe('Page.FlattenAnnotations / Document.FlattenAnnotations', () => {
    it('page-level flattens the page and returns the count', () => {
      const doc = Document.Open(buildFlattenTarget());
      const n = doc.Pages[0].FlattenAnnotations();
      expect(n).toBe(2);
      expect(content(doc)).toMatch(/\/Fm0 Do/);
      // only the Hidden + appearance-less annotations remain.
      expect(annots(doc).length).toBe(2);
    });

    it('document-level aggregates across all pages', () => {
      const doc = Document.Open(buildFlattenTarget());
      expect(doc.FlattenAnnotations()).toBe(2);
    });

    it('appearances survive Save/Open and the baked annotations are gone', () => {
      const doc = Document.Open(buildFlattenTarget());
      doc.FlattenAnnotations();
      const reopened = Document.Open(doc.Save());
      expect(content(reopened)).toMatch(/\/Fm0 Do/);
      // two visible stamps baked -> two remain (Hidden + no-appearance).
      expect(annots(reopened).length).toBe(2);
    });
  });

  describe('Document.FlattenForm', () => {
    it('bakes widgets, drops the AcroForm, and returns the count', () => {
      const doc = Document.Open(buildFlattenFormTarget());
      const n = doc.FlattenForm();
      expect(n).toBe(2);
      expect(content(doc)).toMatch(/\/Fm0 Do/);
      expect(doc.catalog().has('AcroForm')).toBe(false);
    });

    it('after Save/Open there are no interactive fields and no widget annots', () => {
      const doc = Document.Open(buildFlattenFormTarget());
      doc.FlattenForm();
      const reopened = Document.Open(doc.Save());

      expect(reopened.Form.Fields.length).toBe(0);
      expect(reopened.catalog().has('AcroForm')).toBe(false);
      const remaining = annots(reopened).map((e) => {
        const d = reopened.resolve(e as never);
        const s = isDict(d) ? d.get('Subtype') : undefined;
        return isName(s) ? s.name : undefined;
      });
      expect(remaining).not.toContain('Widget'); // only the sticky note survives
      expect(remaining).toContain('Text');
    });
  });
});
