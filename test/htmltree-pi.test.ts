import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import type { HtmlNode, HtmlElement } from '../src/htmldom.js';

/** The first element with this tag name, in document order. */
function el(node: HtmlNode, name: string): HtmlElement {
  const found: HtmlElement[] = [];
  const walk = (n: HtmlNode): void => {
    if (n.kind === 'element' && n.name === name) found.push(n);
    if (n.kind === 'element' || n.kind === 'document' || n.kind === 'fragment')
      n.children.forEach(walk);
  };
  walk(node);
  if (found[0] === undefined) throw new Error(`no <${name}> in the tree`);
  return found[0];
}

/** Every node of a kind, anywhere in the tree. */
function all(node: HtmlNode, kind: HtmlNode['kind']): HtmlNode[] {
  const found: HtmlNode[] = [];
  const walk = (n: HtmlNode): void => {
    if (n.kind === kind) found.push(n);
    if (n.kind === 'element' || n.kind === 'document' || n.kind === 'fragment')
      n.children.forEach(walk);
  };
  walk(node);
  return found;
}

function asPi(n: HtmlNode | undefined): { target: string; data: string } {
  if (n === undefined || n.kind !== 'pi')
    throw new Error(`expected a pi node, got ${n === undefined ? 'nothing' : n.kind}`);
  return { target: n.target, data: n.data };
}

describe('processing instructions in the tree', () => {
  it('inserts a PI node in body', () => {
    const body = el(parseHtml('<body><?something>'), 'body');
    expect(asPi(body.children[0])).toEqual({ target: 'something', data: '' });
  });

  it('keeps a PI in document order beside its siblings', () => {
    const body = el(parseHtml('<body><?something><span>'), 'body');
    expect(body.children.map((c) => c.kind)).toEqual(['pi', 'element']);
  });

  it('carries the data through', () => {
    const body = el(parseHtml('<body><?target the data?>'), 'body');
    expect(asPi(body.children[0])).toEqual({ target: 'target', data: 'the data' });
  });

  it('goes wherever a comment goes — before <html> it lands on the document', () => {
    // A PI can appear anywhere a comment can, which is the rule that makes it
    // reach all fourteen comment branches rather than just "in body".
    const doc = parseHtml('<?something><html>');
    expect(asPi(doc.children[0])).toEqual({ target: 'something', data: '' });
  });

  it('lands in head when that is the insertion mode', () => {
    const head = el(parseHtml('<html><head><?something>'), 'head');
    expect(asPi(head.children[0])).toEqual({ target: 'something', data: '' });
  });

  it('makes a comment, not a PI, for a disallowed target', () => {
    const doc = parseHtml('<?xml version="1.0">Hi');
    expect(all(doc, 'pi')).toHaveLength(0);
    const comments = all(doc, 'comment') as { data: string }[];
    expect(comments[0]?.data).toBe('?xml version="1.0"');
  });

  it('makes a comment for a target that is not a name', () => {
    const doc = parseHtml('<?#');
    expect(all(doc, 'pi')).toHaveLength(0);
    expect((all(doc, 'comment')[0] as { data: string } | undefined)?.data).toBe('?#');
  });

  it('drops an unterminated PI entirely', () => {
    // The tokenizer emits the EOF token and never the buffer, so an
    // unterminated <? leaves NOTHING — not a PI, and not the comment the old
    // bogus-comment reading would have left behind.
    const doc = parseHtml('<body><?something');
    expect(all(doc, 'pi')).toHaveLength(0);
    expect(all(doc, 'comment')).toHaveLength(0);
  });

  it('parses a PI inside a table by foster parenting it like a comment', () => {
    const doc = parseHtml('<table><?something></table>');
    expect(all(doc, 'pi')).toHaveLength(1);
  });
});
