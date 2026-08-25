import { describe, it, expect } from 'vitest';
import { docxBody } from '../src/docxflow.js';
import type { DocList, DocListItem, DocNode } from '../src/docmodel.js';

const noImages = { add: () => undefined };
const noLinks = { add: () => 'rIdX' };
const run = (nodes: DocNode[]) => docxBody(nodes, noImages, noLinks);

const item = (text: string, checked?: boolean): DocListItem => ({
  kind: 'listItem',
  blocks: [{ kind: 'container', type: 'P', children: [{ kind: 'text', text }] }],
  ...(checked !== undefined ? { checked } : {}),
});

const list = (ordered: boolean, items: DocListItem[], start?: number): DocList => ({
  kind: 'list', ordered, items, ...(start !== undefined ? { start } : {}),
});

describe('docxBody lists', () => {
  it("gives each item a numPr referencing the list's numId", () => {
    const { xml, nums } = run([list(false, [item('one'), item('two')])]);
    expect(nums).toEqual([{ numId: 1, ordered: false }]);
    expect(xml.match(/<w:numId w:val="1"\/>/g)?.length).toBe(2);
  });

  // Two sibling lists must not continue each other's numbering.
  it('allocates a numId per list', () => {
    const { nums } = run([list(true, [item('a')]), list(true, [item('b')])]);
    expect(nums.map((n) => n.numId)).toEqual([1, 2]);
  });

  it("reports an ordered list's start", () => {
    expect(run([list(true, [item('a')], 5)]).nums[0])
      .toEqual({ numId: 1, ordered: true, start: 5 });
  });

  it('raises ilvl for a nested list', () => {
    const outer: DocListItem = {
      kind: 'listItem',
      blocks: [
        { kind: 'container', type: 'P', children: [{ kind: 'text', text: 'outer' }] },
        list(false, [item('inner')]),
      ],
    };
    const { xml, nums } = run([list(false, [outer])]);
    expect(xml).toContain('<w:ilvl w:val="0"/>');
    expect(xml).toContain('<w:ilvl w:val="1"/>');
    expect(nums.length).toBe(2);      // a nested list is a list in its own right
  });

  // A task's state is CONTENT, not a marker the serializer re-derives -- the one
  // place the marker-suppression rule does not apply, exactly as the HTML export
  // emits a disabled checkbox.
  // The box is its OWN run, deliberately: folding it into the first text run
  // would give it that run's emphasis, so a bold task would get a bold box.
  it("writes a task item's state as a literal box", () => {
    const { xml } = run([list(false, [item('done', true), item('todo', false)])]);
    expect(xml).toContain('<w:t xml:space="preserve">☒ </w:t>');
    expect(xml).toContain('<w:t xml:space="preserve">☐ </w:t>');
    expect(xml.indexOf('☒ ')).toBeLessThan(xml.indexOf('done'));
  });

  it('leaves a plain item unmarked', () => {
    const { xml } = run([list(false, [item('plain')])]);
    expect(xml).not.toContain('☐');
    expect(xml).not.toContain('☒');
  });

  // Only the FIRST block of an item carries the marker; the rest are indented
  // siblings, or Word restarts the number on every paragraph.
  it('marks only the first block of a multi-block item', () => {
    const multi: DocListItem = {
      kind: 'listItem',
      blocks: [
        { kind: 'container', type: 'P', children: [{ kind: 'text', text: 'first' }] },
        { kind: 'container', type: 'P', children: [{ kind: 'text', text: 'second' }] },
      ],
    };
    const { xml } = run([list(true, [multi])]);
    expect(xml.match(/<w:numPr>/g)?.length).toBe(1);
  });
});
