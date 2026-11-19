import { describe, expect, it } from 'vitest';
import { Document, TextAnnotation } from '../src/index.js';
import { isString, name } from '../src/types.js';

const pdfText = (value: string) => ({ kind: 'string' as const, bytes: new TextEncoder().encode(value) });

describe('annotation state records', () => {
  it.each([
    ['Marked', 'Marked'], ['Unmarked', 'Marked'],
    ['Accepted', 'Review'], ['Rejected', 'Review'], ['Cancelled', 'Review'],
    ['Completed', 'Review'], ['None', 'Review'],
  ] as const)('writes %s with its %s model as PDF strings', (state, model) => {
    const doc = Document.New();
    const { page } = doc.AddPage();
    const record = page.AddTextNote({ rect: [1, 2, 3, 4] });
    record.State = state;

    expect(record.Dict.get('State')).toEqual(pdfText(state));
    expect(record.Dict.get('StateModel')).toEqual(pdfText(model));
    expect(record.State).toBe(state);
    expect(record.StateModel).toBe(model);
  });

  it.each([['Marked', 'Unmarked'], ['Review', 'None']] as const)(
    'reads the %s model default from an existing PDF', (model, state) => {
      const doc = Document.New();
      const { page } = doc.AddPage();
      page.AddTextNote({ rect: [1, 2, 3, 4] }).Dict.set('StateModel', pdfText(model));
      const record = Document.Open(doc.Save()).Pages[0].Annotations[0] as TextAnnotation;
      expect(record.StateModel).toBe(model);
      expect(record.State).toBe(state);
      expect(record.Dict.has('State')).toBe(false);
    },
  );

  it('exposes ordinary notes and malformed records without inventing a state', () => {
    const doc = Document.New();
    const { page } = doc.AddPage();
    const record = page.AddTextNote({ rect: [1, 2, 3, 4] });
    expect(record.StateModel).toBeUndefined();
    expect(record.State).toBeUndefined();

    record.Dict.set('State', pdfText('Accepted'));
    expect(record.State).toBeUndefined();
    record.Dict.set('StateModel', pdfText('Marked'));
    expect(record.StateModel).toBe('Marked');
    expect(record.State).toBeUndefined();
    record.Dict.set('State', name('Marked'));
    expect(record.State).toBeUndefined();
    record.Dict.set('StateModel', pdfText('Custom'));
    expect(record.StateModel).toBeUndefined();
  });

  it('updates the model without carrying an incompatible state across', () => {
    const doc = Document.New();
    const { page } = doc.AddPage();
    const record = page.AddTextNote({ rect: [1, 2, 3, 4] });
    record.State = 'Accepted';
    record.StateModel = 'Review';
    expect(record.State).toBe('Accepted');
    record.State = undefined;
    expect(record.State).toBe('None');
    record.State = 'Rejected';
    record.StateModel = 'Marked';
    expect(record.Dict.has('State')).toBe(false);
    expect(record.State).toBe('Unmarked');
    record.State = 'Marked';
    record.StateModel = undefined;
    expect(record.Dict.has('State')).toBe(false);
    expect(record.Dict.has('StateModel')).toBe(false);
  });

  it('creates a reviewer history on one page and keeps the original markup free of state', () => {
    const doc = Document.New();
    doc.AddPage();
    const { page } = doc.AddPage();
    const parent = page.AddSquare({ rect: [10, 20, 30, 40] });
    const first = parent.AddStateReply({ state: 'Accepted', author: 'Zoë' });
    first.AddStateReply({ state: 'Completed', author: 'Zoë', contents: 'Done', rect: [1, 2, 3, 4] });
    parent.AddStateReply({ state: 'Marked', author: 'Ada' });

    const reopened = Document.Open(doc.Save());
    expect(reopened.Pages[0].Annotations).toHaveLength(0);
    const [original, accepted, completed, marked] = reopened.Pages[1].Annotations as [
      typeof parent, TextAnnotation, TextAnnotation, TextAnnotation,
    ];
    expect(original.Dict.has('State')).toBe(false);
    expect(original.Dict.has('StateModel')).toBe(false);
    expect(accepted.InReplyTo?.Dict).toBe(original.Dict);
    expect(accepted.State).toBe('Accepted');
    expect(accepted.Author).toBe('Zoë');
    expect(accepted.Rect).toEqual([10, 20, 30, 40]);
    expect(completed.InReplyTo?.Dict).toBe(accepted.Dict);
    expect(completed.State).toBe('Completed');
    expect(completed.StateModel).toBe('Review');
    expect(completed.Contents).toBe('Done');
    expect(completed.Rect).toEqual([1, 2, 3, 4]);
    expect(marked.InReplyTo?.Dict).toBe(original.Dict);
    expect(marked.State).toBe('Marked');
    expect(marked.StateModel).toBe('Marked');
    expect(marked.ReplyType).toBe('R');
    expect(isString(marked.Dict.get('State'))).toBe(true);
  });

  it('rejects invalid states, models, and reviewers before mutation', () => {
    const doc = Document.New();
    const { page } = doc.AddPage();
    const parent = page.AddTextNote({ rect: [1, 2, 3, 4] });
    parent.State = 'Accepted';
    expect(() => { parent.State = 'toString' as never; }).toThrow(TypeError);
    expect(() => { parent.StateModel = 'Unknown' as never; }).toThrow(TypeError);
    expect(parent.State).toBe('Accepted');
    expect(parent.StateModel).toBe('Review');
    expect(() => parent.AddStateReply({ state: 'toString' as never, author: 'Ada' })).toThrow(TypeError);
    expect(() => parent.AddStateReply({ state: 'Marked', author: '  ' })).toThrow(TypeError);
    expect(() => parent.AddStateReply({ state: 'Marked', author: undefined as never })).toThrow(TypeError);
    expect(page.Annotations).toHaveLength(1);
  });
});
