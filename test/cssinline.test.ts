import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { computeStyles } from '../src/csscompute.js';
import { inlineContentOf } from '../src/cssinline.js';
import type { FamilyResolver } from '../src/cssinline.js';
import type { ComputedStyle, UnsupportedDeclaration } from '../src/cssprop.js';
import type { HtmlElement, HtmlNode } from '../src/htmldom.js';
import type { ResolvedFamily } from '../src/mdstyle.js';

/** A Standard-14 stub: enough to tell the four faces apart by name. */
const FAMILY: ResolvedFamily = {
  regular: 'Helvetica', bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique', boldItalic: 'Helvetica-BoldOblique',
};
const resolver: FamilyResolver = () => FAMILY;

function elementsOf(n: HtmlNode): HtmlElement[] {
  const out: HtmlElement[] = [];
  const walk = (x: HtmlNode): void => {
    if (x.kind === 'element') out.push(x);
    if (x.kind === 'element' || x.kind === 'document' || x.kind === 'fragment') {
      for (const c of x.children) walk(c);
    }
  };
  walk(n);
  return out;
}

/** Lower the inline children of `#t`. */
function lower(src: string): {
  runs: ReturnType<typeof inlineContentOf>['runs'];
  atomics: ReturnType<typeof inlineContentOf>['atomics'];
  unsupported: UnsupportedDeclaration[];
} {
  const doc = parseHtml(src);
  const { styles } = computeStyles(doc);
  const el = elementsOf(doc).find((e) => e.attrs.get('id') === 't') as HtmlElement;
  const style = styles.get(el) as ComputedStyle;
  const unsupported: UnsupportedDeclaration[] = [];
  const c = inlineContentOf(el.children, style, styles, resolver, unsupported, []);
  return { runs: c.runs, atomics: c.atomics, unsupported };
}

const texts = (src: string): string[] => lower(src).runs.map((r) => r.text);

describe('text and runs', () => {
  it('lowers a single text node to one run', () => {
    expect(texts('<p id=t>hello</p>')).toEqual(['hello']);
  });

  it('MERGES adjacent pieces of identical style into one run', () => {
    // A run per DOM node would give layoutRuns three runs for `a<span>b</span>c`
    // where one is right, and it would move bytes against the string path.
    expect(texts('<p id=t>a<span>b</span>c</p>')).toEqual(['abc']);
  });

  it('splits a run where the derived style changes', () => {
    expect(texts('<p id=t>a<b>b</b>c</p>')).toEqual(['a', 'b', 'c']);
  });

  it('picks the bold face at weight >= 600, matching fontmatch.ts bold slot', () => {
    // fontmatch.ts's bold slot is `weight >= 600`, so a family shipping
    // Semibold and no 700 still has a bold face. One rule, not two.
    const r = lower('<p id=t>a<span style="font-weight:600">b</span></p>').runs;
    expect(r[0]?.font).toBe('Helvetica');
    expect(r[1]?.font).toBe('Helvetica-Bold');
  });

  it('picks the italic and bold-italic faces', () => {
    expect(lower('<p id=t><i>a</i></p>').runs[0]?.font).toBe('Helvetica-Oblique');
    expect(lower('<p id=t><b><i>a</i></b></p>').runs[0]?.font)
      .toBe('Helvetica-BoldOblique');
  });

  it('carries font size and colour', () => {
    const r = lower('<p id=t style="font-size:20px;color:red">a</p>').runs[0];
    expect(r?.fontSize).toBe(20);
    expect(r?.color).toEqual([1, 0, 0]);
  });
});

describe('decoration', () => {
  it('maps underline and line-through', () => {
    expect(lower('<p id=t><u>a</u></p>').runs[0]?.underline).toBeTruthy();
    expect(lower('<p id=t><s>a</s></p>').runs[0]?.strikethrough).toBeTruthy();
  });

  it('maps a non-transparent background and omits a transparent one', () => {
    expect(lower('<p id=t><span style="background-color:yellow">a</span></p>')
      .runs[0]?.background).toEqual({ color: [1, 1, 0] });
    expect(lower('<p id=t>a</p>').runs[0]?.background).toBeUndefined();
  });

  it('records overline, which TextRun cannot express', () => {
    const { runs, unsupported } = lower(
      '<p id=t><span style="text-decoration:overline">a</span></p>');
    expect(runs[0]?.underline).toBeFalsy();
    expect(unsupported.some((u) => u.property === 'text-decoration-line')).toBe(true);
  });

  it('records a translucent text colour, whose alpha TextRun cannot carry', () => {
    const { runs, unsupported } = lower(
      '<p id=t style="color:rgba(255,0,0,0.5)">a</p>');
    expect(runs[0]?.color).toEqual([1, 0, 0]);          // flattened, not dropped
    expect(unsupported.some((u) => u.property === 'color')).toBe(true);
  });
});

describe('links', () => {
  it('sets link on the runs inside an <a href>', () => {
    const r = lower('<p id=t>a<a href="http://x/">b</a>c</p>').runs;
    expect(r.map((x) => x.link)).toEqual([undefined, 'http://x/', undefined]);
  });

  it('does NOT merge two differently-destined links that style identically', () => {
    // The destination is part of a run's identity: merging would point the
    // whole phrase at the second URI — output that renders perfectly and
    // links wrongly. mdruns.ts records the same rule.
    const r = lower('<p id=t><a href="x">a</a><a href="y">b</a></p>').runs;
    expect(r.length).toBe(2);
    expect(r.map((x) => x.link)).toEqual(['x', 'y']);
  });

  it('ignores an <a> with no href, which is not a link', () => {
    expect(lower('<p id=t><a>a</a></p>').runs[0]?.link).toBeUndefined();
  });
});

describe('white-space', () => {
  it('collapses runs of whitespace under the default normal', () => {
    expect(texts('<p id=t>a \n\t b</p>')).toEqual(['a b']);
  });

  it('strips whitespace at the START and END of the context', () => {
    expect(texts('<p id=t>   a   </p>')).toEqual(['a']);
  });

  it('protects indentation under pre', () => {
    // Through preformat, so the U+00A0 rule has one owner. layoutRuns
    // collapses runs of spaces, which would otherwise eat the indent.
    const r = texts('<p id=t style="white-space:pre">  a</p>');
    expect(r[0]).toBe('  a');
  });

  it('keeps newlines under pre-line but collapses spaces', () => {
    expect(texts('<p id=t style="white-space:pre-line">a  \n  b</p>'))
      .toEqual(['a\nb']);
  });

  it('turns <br> into a newline, which layoutRuns breaks on', () => {
    expect(texts('<p id=t>a<br>b</p>')).toEqual(['a\nb']);
  });
});

describe('nested boxes and atomics', () => {
  it('skips a display:none subtree entirely', () => {
    expect(texts('<p id=t>a<span style="display:none">HIDDEN</span>b</p>'))
      .toEqual(['ab']);
  });

  it('records an inline image as an atomic, positioned by run index', () => {
    const { runs, atomics } = lower('<p id=t>a<img src=x.png>b</p>');
    expect(atomics.length).toBe(1);
    expect(atomics[0]?.kind).toBe('image');
    expect(atomics[0]?.beforeRun).toBe(1);
    expect(runs.map((r) => r.text)).toEqual(['a', 'b']);
  });

  it('never throws, on any inline content', () => {
    for (const s of ['<p id=t></p>', '<p id=t> </p>', '<p id=t><span></span></p>',
      '<p id=t><a href="">x</a></p>', '<p id=t><br></p>']) {
      expect(() => lower(s), s).not.toThrow();
    }
  });
});
