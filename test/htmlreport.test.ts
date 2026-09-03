import { describe as suite, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import {
  CONSTRUCTS, HTML_POLICY_SIZE, describe, elementPolicy, selectedOptionText,
} from '../src/htmlreport.js';
import type { HtmlElement, HtmlNode } from '../src/htmldom.js';

/** The first element named `name` anywhere in a parsed source. */
function el(src: string, name: string): HtmlElement {
  const seek = (ns: HtmlNode[]): HtmlElement | undefined => {
    for (const n of ns) {
      if (n.kind !== 'element') continue;
      if (n.name === name) return n;
      const hit = seek(n.children);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  const hit = seek(parseHtml(`<!doctype html>${src}`).children);
  if (hit === undefined) throw new Error(`no <${name}>`);
  return hit;
}

suite('the construct vocabulary', () => {
  it('has exactly 21 entries', () => {
    // Asserted by SIZE so a half-filled table is a red build rather than a
    // silently unreported element — htmlforeign.ts's pattern with its five
    // asserted table sizes.
    expect(CONSTRUCTS.length).toBe(21);
  });

  it('has no duplicates', () => {
    expect(new Set(CONSTRUCTS).size).toBe(CONSTRUCTS.length);
  });

  it('has exactly 7 entries in the element policy table', () => {
    // The SECOND size assertion, and the more important of the two: a
    // half-transcribed policy table is an element that silently renders as
    // though HTML said nothing about it.
    expect(HTML_POLICY_SIZE).toBe(7);
    for (const name of ['iframe', 'object', 'video', 'audio', 'canvas',
      'textarea', 'button']) {
      expect(elementPolicy(el(`<${name}></${name}>`, name)), name).toBeDefined();
    }
  });
});

suite('describe', () => {
  it('is the construct alone when there is no detail', () => {
    expect(describe({ el: null, kind: 'dropped', construct: 'iframe' }))
      .toBe('iframe');
  });

  it('joins the detail with a colon, the old string form', () => {
    // The pre-zch2.7 strings were 'image:pic.png' and 'float:left'; a caller
    // that only logs keeps getting exactly those.
    expect(describe({
      el: null, kind: 'dropped', construct: 'image', detail: 'pic.png',
    })).toBe('image:pic.png');
    expect(describe({
      el: null, kind: 'degraded', construct: 'float', detail: 'left',
    })).toBe('float:left');
  });
});

suite('elementPolicy', () => {
  it('suppresses an iframe, which HTML says is ignored', () => {
    expect(elementPolicy(el('<iframe>fb</iframe>', 'iframe')))
      .toEqual({ content: 'suppress', kind: 'dropped', construct: 'iframe' });
  });

  it('suppresses math by NAMESPACE, not by tag name', () => {
    // <math> puts its whole subtree in the math namespace, so keying on the
    // namespace catches a subtree whose root was spelled some other way and
    // cannot be fooled by an HTML element that happens to be called `math`.
    expect(elementPolicy(el('<math><mi>x</mi></math>', 'math'))?.content)
      .toBe('suppress');
  });

  it('no longer suppresses svg, which zch2.12 RENDERS', () => {
    // The policy is silent for an <svg> now; cssinline.ts and cssbox.ts turn
    // it into an atomic before the policy is consulted, and cssflow.ts reports
    // only what the IMPORTER could not draw.
    expect(elementPolicy(el('<svg><circle/></svg>', 'svg'))).toBeUndefined();
  });

  it('KEEPS the children of object, video, audio and canvas', () => {
    // These children ARE fallback content a browser renders when the thing
    // cannot load. Suppressing them would blank a page whose content sits in
    // <object> fallback.
    for (const name of ['object', 'video', 'audio', 'canvas']) {
      const p = elementPolicy(el(`<${name}>fb</${name}>`, name));
      expect(p?.content, name).toBe('render');
      expect(p?.kind, name).toBe('degraded');
    }
  });

  it('keeps a textarea and a button, whose text is what a browser draws', () => {
    expect(elementPolicy(el('<textarea>t</textarea>', 'textarea'))?.content)
      .toBe('render');
    expect(elementPolicy(el('<button>Go</button>', 'button'))?.content)
      .toBe('render');
  });

  it('names NO policy for input or select, which cssinline.ts owns', () => {
    // Their text is SELECTED rather than kept or suppressed, so a policy
    // entry would be a second statement about them that could drift.
    expect(elementPolicy(el('<input>', 'input'))).toBeUndefined();
    expect(elementPolicy(el('<select><option>a</select>', 'select')))
      .toBeUndefined();
  });

  it('names no policy for an ordinary or unknown element', () => {
    // An element the table does not name keeps its children and earns no
    // record — what a browser does, so correct rather than a gap.
    expect(elementPolicy(el('<p>x</p>', 'p'))).toBeUndefined();
    expect(elementPolicy(el('<my-widget>x</my-widget>', 'my-widget')))
      .toBeUndefined();
  });

  it('does not mistake an SVG-namespaced <a> for an HTML one', () => {
    // Namespace-keyed, so it must not fire on the HTML elements that share a
    // name with an SVG one.
    expect(elementPolicy(el('<a href=x>t</a>', 'a'))).toBeUndefined();
  });
});

suite('selectedOptionText', () => {
  it('takes the option carrying `selected`', () => {
    expect(selectedOptionText(el(
      '<select><option>a<option selected>b<option>c</select>', 'select')))
      .toBe('b');
  });

  it('falls back to the FIRST option when none is selected', () => {
    // What a browser shows in a closed control.
    expect(selectedOptionText(el(
      '<select><option>a<option>b</select>', 'select'))).toBe('a');
  });

  it('finds an option nested in an optgroup', () => {
    expect(selectedOptionText(el(
      '<select><optgroup><option>a<option selected>b</optgroup></select>',
      'select'))).toBe('b');
  });

  it('is undefined for a select with no options', () => {
    expect(selectedOptionText(el('<select></select>', 'select')))
      .toBeUndefined();
  });

  it('trims and collapses the option text', () => {
    expect(selectedOptionText(el(
      '<select><option>\n  a  b \n</select>', 'select'))).toBe('a b');
  });
});
