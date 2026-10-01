import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';

const textOf = (doc: Document) => doc.Pages[0].GetText();

describe('FlowListItem.label', () => {
  it('draws the stated label instead of the computed ordinal', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddList([{ text: 'alpha', label: '1.a)' }, { text: 'beta', label: 'IV.' }], { ordered: true });
    flow.Render();
    const t = textOf(doc);
    expect(t).toContain('1.a)');
    expect(t).toContain('IV.');
    expect(t).not.toMatch(/(^|\s)1\.\s+alpha/);
  });

  it('measures a label into the marker width, so a wide label pushes the body right', () => {
    const at = (label: string): number => {
      const doc = Document.New();
      const flow = doc.NewFlow();
      flow.AddList([{ text: 'body', label }]);
      flow.Render();
      return doc.Pages[0].GetTextFragments().find((f) => f.text.includes('body'))!.quad[0];
    };
    expect(at('Section 12:')).toBeGreaterThan(at('a.') + 20);
  });

  it('draws no marker for an empty label', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    // Ordered, so without the label the marker would be the text '1.'; an
    // unordered list draws a vector bullet, which extracts no text either way.
    flow.AddList([{ text: 'solo', label: '' }], { ordered: true });
    flow.Render();
    expect(textOf(doc).trim()).toBe('solo');
  });

  it('refuses a label that is not a string', () => {
    const doc = Document.New();
    expect(() => doc.NewFlow().AddList([{ text: 'x', label: 3 as unknown as string }])).toThrow(TypeError);
  });

  it('leaves a checkbox marker in charge over a label', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddList([{ text: 'task', marker: 'checked', label: 'L.' }]);
    flow.Render();
    expect(textOf(doc)).not.toContain('L.');
  });
});
