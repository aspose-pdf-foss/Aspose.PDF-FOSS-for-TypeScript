import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Document } from '../src/document.js';
import type { Flow, FlowOptions } from '../src/flow.js';
import { buildDocx } from './helpers/build-docx.js';
import { solidPng } from './helpers/solid-png.js';

// v9j3.6: FlowOptions.headingNumbering — Word-style per-level templates,
// numbered once at Render over every heading in the flow, in order.
function render(opts: FlowOptions, build: (f: Flow) => void): Document {
  const d = Document.New();
  const f = d.NewFlow(opts);
  build(f);
  f.Render();
  return d;
}
const lines = (d: Document): string[] =>
  d.Pages.flatMap((p) => p.GetText().split('\n')).map((s) => s.trim()).filter((s) => s !== '');

describe('labels', () => {
  it('defaults to 1., 1.1., 1.1.1.', () => {
    const d = render({ headingNumbering: {} }, (f) => {
      f.AddHeading(1, 'Intro').AddHeading(2, 'Scope').AddHeading(3, 'Detail').AddHeading(2, 'Terms').AddHeading(1, 'Body');
    });
    expect(lines(d)).toEqual(['1. Intro', '1.1. Scope', '1.1.1. Detail', '1.2. Terms', '2. Body']);
  });
  it('takes a template and a format per level', () => {
    const d = render({ headingNumbering: { levels: [
      { text: 'Chapter %1' }, { format: 'Alpha', text: '%2.' }, { format: 'roman', text: '%3)' },
    ] } }, (f) => {
      f.AddHeading(1, 'One').AddHeading(2, 'A').AddHeading(3, 'x').AddHeading(3, 'y').AddHeading(2, 'B').AddHeading(1, 'Two');
    });
    expect(lines(d)).toEqual(['Chapter 1 One', 'A. A', 'i) x', 'ii) y', 'B. B', 'Chapter 2 Two']);
  });
  it('a parent counter is written in the PARENT level\'s format', () => {
    const d = render({ headingNumbering: { levels: [{ format: 'Roman' }, { text: '%1.%2' }] } }, (f) => {
      f.AddHeading(1, 'a').AddHeading(1, 'b').AddHeading(2, 'c');
    });
    expect(lines(d)).toEqual(['I. a', 'II. b', 'II.1 c']);
  });
  it('honours start, and restarts every deeper level when a level advances', () => {
    const d = render({ headingNumbering: { levels: [{ start: 3 }, { start: 5 }] } }, (f) => {
      f.AddHeading(1, 'a').AddHeading(2, 'b').AddHeading(2, 'c').AddHeading(1, 'd').AddHeading(2, 'e');
    });
    expect(lines(d)).toEqual(['3. a', '3.5. b', '3.6. c', '4. d', '4.5. e']);
  });
  it('a level never reached shows its start value (Word\'s rule)', () => {
    const d = render({ headingNumbering: {} }, (f) => { f.AddHeading(1, 'a').AddHeading(3, 'b'); });
    expect(lines(d)).toEqual(['1. a', '1.1.1. b']);
  });
  it('numbered: false leaves a heading unlabelled and does not count it', () => {
    const d = render({ headingNumbering: {} }, (f) => {
      f.AddHeading(1, 'Preface', { numbered: false }).AddHeading(1, 'Intro').AddHeading(1, 'Body');
    });
    expect(lines(d)).toEqual(['Preface', '1. Intro', '2. Body']);
  });
  it('a heading of styled runs gains a leading label run', () => {
    const d = render({ headingNumbering: {} }, (f) => {
      f.AddHeading(1, [{ text: 'Bold ' }, { text: 'and italic', font: 'Helvetica-BoldOblique' }]);
    });
    expect(lines(d)).toEqual(['1. Bold and italic']);
  });
});

describe('an inline image keeps its place behind the label', () => {
  it('an atomic before run 1 still sits before that run once the label run is prepended', () => {
    // runs [Alpha, Beta] with an image before Beta. Prepending the label run
    // moves Beta to index 2; an unshifted atomic would land before Alpha,
    // pushing Alpha right by the image's width.
    const xOf = (withImage: boolean): number => {
      const d = render({ headingNumbering: {} }, (f) => {
        f.AddHeading(1, [{ text: 'Alpha ' }, { text: 'Beta' }],
          withImage ? { atomics: [{ beforeRun: 1, data: solidPng(4, 4, [0, 0, 255]), width: 40, height: 10 }] } : {});
      });
      return d.Pages[0].GetTextFragments().find((t) => t.text.includes('Alpha'))!.quad[0];
    };
    expect(xOf(true)).toBeCloseTo(xOf(false), 3);
  });
});

describe('every heading in the flow counts as one sequence', () => {
  it('AddHeading, Markdown and HTML headings number continuously', () => {
    const d = render({ headingNumbering: {} }, (f) => {
      f.AddHeading(1, 'Hand');
      f.AddMarkdown('# From markdown\n\n## Sub');
      f.AddHtml('<h1 style="font-family:Helvetica">From html</h1>');
    });
    expect(lines(d)).toEqual(['1. Hand', '2. From markdown', '2.1. Sub', '3. From html']);
  });
  it('DOCX headings keep Word\'s labels and are not numbered again', () => {
    const docx = buildDocx('<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>Word heading</w:t></w:r></w:p>');
    const d = render({ headingNumbering: {} }, (f) => { f.AddHeading(1, 'Mine'); f.AddDocx(docx); f.AddHeading(1, 'Next'); });
    expect(lines(d)).toEqual(['1. Mine', 'Word heading', '2. Next']);
  });
  it('a tagged heading\'s text includes its label', () => {
    const d = render({ tagged: true, headingNumbering: {} }, (f) => { f.AddHeading(2, 'Scope'); });
    const h = d.GetStructTree()!.Children[0].Children[0];
    expect(h.Type).toBe('H2');
    expect(h.GetText()).toBe('1.1. Scope');                       // level 1 never reached: its start
  });
});

describe('validation', () => {
  const bad = (headingNumbering: unknown): (() => void) => () => Document.New().NewFlow({ headingNumbering } as FlowOptions);
  it('refuses the wrong kind of thing with TypeError', () => {
    expect(bad(1)).toThrow(TypeError);
    expect(bad({ levels: 'x' })).toThrow(TypeError);
    expect(bad({ levels: [{ text: 3 }] })).toThrow(TypeError);
    expect(() => Document.New().NewFlow().AddHeading(1, 'x', { numbered: 'no' as never })).toThrow(TypeError);
  });
  it('refuses a value outside its set with RangeError', () => {
    expect(bad({ levels: [{}, {}, {}, {}, {}, {}, {}] })).toThrow(RangeError);
    expect(bad({ levels: [{ format: 'greek' }] })).toThrow(RangeError);
    expect(bad({ levels: [{ start: 0 }] })).toThrow(RangeError);
    expect(bad({ levels: [{ start: 1.5 }] })).toThrow(RangeError);
    expect(bad({ levels: [{ text: '%7' }] })).toThrow(RangeError);
  });
});

describe('a flow without headingNumbering is unchanged', () => {
  it('writes the same bytes with numbered: false and with nothing said', () => {
    const h = (d: Document): string => createHash('sha256').update(d.Save()).digest('hex');
    const a = render({}, (f) => { f.AddHeading(1, 'Intro').AddParagraph('Body'); });
    const b = render({}, (f) => { f.AddHeading(1, 'Intro', { numbered: true }).AddParagraph('Body'); });
    expect(h(a)).toBe(h(b));
    expect(lines(a)).toEqual(['Intro', 'Body']);
  });
});
