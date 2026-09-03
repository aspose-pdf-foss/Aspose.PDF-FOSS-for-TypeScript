import { describe, it, expect } from 'vitest';
import {
  createDocument, createElement, createFragment, appendChild, insertBefore, removeChild,
  childrenOf,
} from '../src/htmldom.js';

describe('the HTML node model', () => {
  it('appends and links the parent both ways', () => {
    const doc = createDocument();
    const html = createElement('html');
    appendChild(doc, html);
    expect(doc.children).toEqual([html]);
    expect(html.parent).toBe(doc);
  });

  // The adoption agency MOVES live nodes. A node reachable from two parents is
  // a cycle that hangs the serializer rather than failing an assertion.
  it('detaches from the old parent on a move', () => {
    const doc = createDocument();
    const a = createElement('a');
    const b = createElement('b');
    const t = createElement('i');
    appendChild(doc, a);
    appendChild(doc, b);
    appendChild(a, t);
    expect(a.children).toEqual([t]);
    appendChild(b, t);
    expect(a.children).toEqual([]);
    expect(b.children).toEqual([t]);
    expect(t.parent).toBe(b);
  });

  it('inserts before a reference child', () => {
    const doc = createDocument();
    const a = createElement('a');
    const b = createElement('b');
    const c = createElement('c');
    appendChild(doc, a);
    appendChild(doc, c);
    insertBefore(doc, b, c);
    expect(doc.children.map((n) => (n as { name: string }).name)).toEqual(['a', 'b', 'c']);
  });

  it('detaches on insertBefore too', () => {
    const doc = createDocument();
    const host = createElement('host');
    const moved = createElement('moved');
    const ref = createElement('ref');
    appendChild(doc, host);
    appendChild(host, moved);
    appendChild(doc, ref);
    insertBefore(doc, moved, ref);
    expect(host.children).toEqual([]);
    expect(doc.children.map((n) => (n as { name: string }).name)).toEqual(['host', 'moved', 'ref']);
  });

  it('removes a child and clears its parent', () => {
    const doc = createDocument();
    const a = createElement('a');
    appendChild(doc, a);
    removeChild(a);
    expect(doc.children).toEqual([]);
    expect(a.parent).toBeNull();
  });

  it('removing an unparented node is a no-op rather than a throw', () => {
    expect(() => removeChild(createElement('a'))).not.toThrow();
  });

  it('reports children of leaf kinds as empty', () => {
    expect(childrenOf({ kind: 'text', data: 'x', parent: null })).toEqual([]);
  });
});

describe('element namespaces', () => {
  // The default is the fence: every call site written before zch2.1.3.1
  // keeps meaning exactly what it meant, which is what makes "the 1,317
  // green cases stay byte-identical" something the suite checks.
  it('defaults an element to the HTML namespace', () => {
    expect(createElement('div').ns).toBe('html');
    expect(createElement('div', new Map([['a', '1']])).ns).toBe('html');
  });

  it('takes a namespace as its third argument', () => {
    expect(createElement('svg', undefined, 'svg').ns).toBe('svg');
    expect(createElement('mi', new Map(), 'math').ns).toBe('math');
  });
});

describe('the template content fragment', () => {
  // A separate NODE, not a second children array: a template's content is not
  // part of the document, so zch2.2's traversal must not walk it, and
  // appendChild/removeChild need a real parent object to point at.
  it('creates a fragment that holds children like any parent', () => {
    const frag = createFragment();
    const el = createElement('div');
    appendChild(frag, el);
    expect(frag.children).toEqual([el]);
    expect(el.parent).toBe(frag);
  });

  it('detaches from a fragment on a move, as from any parent', () => {
    const frag = createFragment();
    const doc = createDocument();
    const el = createElement('div');
    appendChild(frag, el);
    appendChild(doc, el);
    expect(frag.children).toEqual([]);
    expect(el.parent).toBe(doc);
  });

  it('removes a child of a fragment and clears its parent', () => {
    const frag = createFragment();
    const el = createElement('div');
    appendChild(frag, el);
    removeChild(el);
    expect(frag.children).toEqual([]);
    expect(el.parent).toBeNull();
  });

  it('reports a fragment’s children through childrenOf', () => {
    const frag = createFragment();
    const el = createElement('div');
    appendChild(frag, el);
    expect(childrenOf(frag)).toEqual([el]);
  });

  // Absent rather than empty on every other element: `content` present is how
  // the serializer and zch2.2 tell a template from anything else.
  it('leaves content absent on an ordinary element', () => {
    expect(createElement('div').content).toBeUndefined();
  });
});
