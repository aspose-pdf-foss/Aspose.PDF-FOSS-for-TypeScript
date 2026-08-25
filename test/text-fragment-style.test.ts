import { describe, it, expect } from 'vitest';
import { Document, type Page } from '../src/index.js';

/** flow.AddHeading draws in Helvetica-Bold and AddParagraph in Helvetica, so
 *  one rendered flow gives both a bold and a plain fragment. */
function rendered(): Page {
  const doc = Document.New();
  const flow = doc.NewFlow();
  flow.AddHeading(1, 'Bold heading');
  flow.AddParagraph('Plain body text.');
  const [page] = flow.Render();
  return page;
}

const fragOf = (page: Page, needle: string) =>
  page.GetTextFragments().find((f) => f.text.includes(needle))!;

describe('TextFragment style', () => {
  it('marks a fragment drawn in a bold face', () => {
    expect(fragOf(rendered(), 'Bold heading').bold).toBe(true);
  });

  // Absent, not `false`: a fragment is compared and snapshotted in several
  // tests, and a key that is always present moves output unrelated to this.
  it('omits the fields for a plain face', () => {
    const f = fragOf(rendered(), 'Plain body');
    expect(f.bold).toBeUndefined();
    expect(f.italic).toBeUndefined();
  });
});
