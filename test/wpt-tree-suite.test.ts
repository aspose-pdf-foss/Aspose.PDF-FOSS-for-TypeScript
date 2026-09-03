import { describe, it, expect } from 'vitest';
import {
  loadWptCases, casesInBucket, DAT_FILES, serializeTree, serializeFragment,
} from './helpers/wpt-tree.js';
import type { HtmlDocument } from '../src/htmldom.js';
import { createDocument, createElement, createFragment, appendChild } from '../src/htmldom.js';

describe('the WPT tree-construction loader', () => {
  it('declares 62 files', () => {
    expect(DAT_FILES.length).toBe(62);
  });

  // The bucket counts are asserted so a case that migrates upstream reddens
  // the build rather than quietly shrinking what zch2.1.2 tests.
  it('classifies every case into exactly one bucket, with known counts', () => {
    const all = loadWptCases();
    expect(all.length).toBe(1936);
    expect(casesInBucket('scripted').length).toBe(14);
    expect(casesInBucket('selectedContent').length).toBe(4);
    expect(casesInBucket('inScope').length).toBe(1918);
    const sum = (['scripted', 'selectedContent', 'inScope'] as const)
      .reduce((n, b) => n + casesInBucket(b).length, 0);
    expect(sum).toBe(1936);
  });

  // zch2.9 retired the processing-instruction bucket, so the 88 cases it held
  // are now RUN. These are the ones whose exclusion was subtlest, kept as
  // assertions in the opposite direction: an exclusion that crept back would
  // redden here rather than quietly shrinking the suite again.
  it('runs the two template cases that were really PI cases', () => {
    // The template bucket had been masking these until zch2.1.3.2; both expect
    // a real PI node inside template content.
    const inScope = casesInBucket('inScope').map((c) => `${c.file}#${c.index}`);
    expect(inScope).toContain('processing-instructions.dat#119');
    expect(inScope).toContain('processing-instructions.dat#123');
  });

  it('runs both shapes of the old PI disagreement', () => {
    const inScope = casesInBucket('inScope').map((c) => `${c.file}#${c.index}`);
    // An UNTERMINATED `<?` — WPT leaves nothing, and so do we now, because the
    // tokenizer emits the EOF token and never the buffer.
    for (const id of ['processing-instructions.dat#100', 'processing-instructions.dat#105',
      'tests1.dat#39']) expect(inScope).toContain(id);
    // And the three where a comment was always the right answer, which we
    // matched before this change and still match.
    for (const id of ['comments01.dat#13', 'processing-instructions.dat#106', 'tests1.dat#40']) {
      expect(inScope).toContain(id);
    }
  });

  it('splits cases on a blank line followed by #data, not on any blank line', () => {
    const c = loadWptCases(['tests1.dat']);
    expect(c.length).toBe(112);
    expect(c[0]?.data).toBe('Test');
    expect(c[0]?.document).toBe('| <html>\n|   <head>\n|   <body>\n|     "Test"');
  });

  // A text or comment node containing a newline serializes with only its FIRST
  // line prefixed; the rest are bare. A reader that requires '| ' everywhere
  // silently drops them.
  it('keeps the continuation lines of a multi-line node', () => {
    const c = loadWptCases(['comments01.dat'])
      .find((x) => x.data === 'FOO<!-- BAR --!\n>BAZ');
    expect(c).toBeDefined();
    expect(c?.document).toBe(
      '| <html>\n|   <head>\n|   <body>\n|     "FOO"\n|     <!--  BAR --!\n>BAZ -->',
    );
  });

  it('records a fragment context', () => {
    const c = casesInBucket('inScope').find((x) => x.fragmentContext !== undefined);
    expect(c?.fragmentContext?.name).toBeTruthy();
  });

  it('rejects a file that is not in the declared list', () => {
    expect(() => loadWptCases(['nope.dat'])).toThrow(/not a declared/);
  });

  it('numbers cases within a file so a test name is stable', () => {
    const c = loadWptCases(['tests1.dat']);
    expect(c.map((x) => x.index).slice(0, 3)).toEqual([0, 1, 2]);
  });
});

describe('the html5lib tree serializer', () => {
  /** Build the tree tests1.dat case 0 expects, by hand. */
  function helloTree(): HtmlDocument {
    const doc = createDocument();
    const html = createElement('html');
    const head = createElement('head');
    const body = createElement('body');
    appendChild(doc, html);
    appendChild(html, head);
    appendChild(html, body);
    appendChild(body, { kind: 'text', data: 'Test', parent: null });
    return doc;
  }

  // The whole point: our serializer must reproduce a vendored expectation
  // byte for byte, from a tree we built by hand.
  it('reproduces a vendored #document exactly', () => {
    const expected = loadWptCases(['tests1.dat'])[0]?.document;
    expect(serializeTree(helloTree())).toBe(expected);
  });

  it('indents two spaces per depth after the pipe', () => {
    expect(serializeTree(helloTree())).toBe(
      '| <html>\n|   <head>\n|   <body>\n|     "Test"',
    );
  });

  it('sorts attributes by name, one per line, indented one level past the element', () => {
    const doc = createDocument();
    const el = createElement('div', new Map([['z', '1'], ['a', '2']]));
    appendChild(doc, el);
    expect(serializeTree(doc)).toBe('| <div>\n|   a="2"\n|   z="1"');
  });

  it('quotes text without escaping and passes a newline through raw', () => {
    const doc = createDocument();
    appendChild(doc, { kind: 'text', data: 'a\nb"c', parent: null });
    expect(serializeTree(doc)).toBe('| "a\nb"c"');
  });

  it('writes a comment and a bare doctype', () => {
    const doc = createDocument();
    appendChild(doc, { kind: 'comment', data: ' x ', parent: null });
    appendChild(doc, { kind: 'doctype', name: 'html', publicId: '', systemId: '', parent: null });
    expect(serializeTree(doc)).toBe('| <!--  x  -->\n| <!DOCTYPE html>');
  });

  it('writes a doctype with public and system identifiers', () => {
    const doc = createDocument();
    appendChild(doc, { kind: 'doctype', name: 'html', publicId: 'P', systemId: 'S', parent: null });
    expect(serializeTree(doc)).toBe('| <!DOCTYPE html "P" "S">');
  });
});

describe('foreign elements in the serializer', () => {
  // html5lib writes a foreign element as `<ns name>` and an HTML one bare.
  // Note SVG's own root serializes `<svg svg>` — the prefix is the namespace,
  // not the tag, so it repeats. That reads like a bug and is the format.
  it('prefixes a foreign element with its namespace', () => {
    const doc = createDocument();
    const svg = createElement('svg', undefined, 'svg');
    const g = createElement('g', undefined, 'svg');
    const mi = createElement('mi', undefined, 'math');
    appendChild(doc, svg);
    appendChild(svg, g);
    appendChild(doc, mi);
    expect(serializeTree(doc)).toBe('| <svg svg>\n|   <svg g>\n| <math mi>');
  });

  it('leaves an HTML element unprefixed', () => {
    const doc = createDocument();
    appendChild(doc, createElement('div'));
    expect(serializeTree(doc)).toBe('| <div>');
  });

  // Adjusted foreign attributes are stored under their DISPLAY key, so the
  // serializer needs no namespace logic for attributes and its existing sort
  // already produces the corpus's order.
  it('writes a namespaced attribute from its key, sorted with the rest', () => {
    const doc = createDocument();
    const g = createElement('g', new Map([['xml lang', 'en'], ['xlink href', 'foo']]), 'svg');
    appendChild(doc, g);
    expect(serializeTree(doc)).toBe('| <svg g>\n|   xlink href="foo"\n|   xml lang="en"');
  });
});

describe('template content in the serializer', () => {
  // template.dat#0. `content` is a BARE WORD at depth + 1 — no angle
  // brackets — and the template's children sit at depth + 2.
  it('writes a content fragment as a bare word one level in', () => {
    const doc = createDocument();
    const tmpl = createElement('template');
    tmpl.content = createFragment();
    appendChild(doc, tmpl);
    appendChild(tmpl.content, { kind: 'text', data: 'Hello', parent: null });
    expect(serializeTree(doc)).toBe('| <template>\n|   content\n|     "Hello"');
  });

  it('writes an empty content fragment as the bare word alone', () => {
    const doc = createDocument();
    const tmpl = createElement('template');
    tmpl.content = createFragment();
    appendChild(doc, tmpl);
    expect(serializeTree(doc)).toBe('| <template>\n|   content');
  });

  // A template's own children array stays empty and is NOT serialized — the
  // content fragment is the only place its children live.
  it('serializes the fragment rather than the element’s own children', () => {
    const doc = createDocument();
    const tmpl = createElement('template');
    tmpl.content = createFragment();
    appendChild(doc, tmpl);
    appendChild(tmpl.content, createElement('span'));
    expect(serializeTree(doc)).toBe('| <template>\n|   content\n|     <span>');
  });
});

describe('the fragment context and its serialization', () => {
  // The .dat line is a bare name for an HTML context and two words for a
  // foreign one. 67 of the 196 are foreign, so a bare string cannot carry it.
  it('parses a bare context name as HTML', () => {
    const c = loadWptCases(['tests_innerHTML_1.dat'])[0];
    expect(c?.fragmentContext).toEqual({ name: 'body' });
  });

  it('parses a two-word context into a namespace and a name', () => {
    const c = loadWptCases(['foreign-fragment.dat'])[0];
    expect(c?.fragmentContext).toEqual({ name: 'path', ns: 'svg' });
  });

  it('parses a math context', () => {
    const c = loadWptCases(['foreign-fragment.dat'])
      .find((x) => x.fragmentContext?.ns === 'math');
    expect(c?.fragmentContext?.ns).toBe('math');
  });

  it('leaves fragmentContext absent on a document case', () => {
    expect(loadWptCases(['tests1.dat'])[0]?.fragmentContext).toBeUndefined();
  });

  // A fragment expectation has NO document wrapper: the root's children are
  // serialized at depth 0.
  it('serializes a fragment at depth zero', () => {
    const frag = createFragment();
    const span = createElement('span');
    appendChild(frag, span);
    appendChild(span, { kind: 'text', data: 'x', parent: null });
    expect(serializeFragment(frag)).toBe('| <span>\n|   "x"');
  });

  it('serializes an empty fragment as the empty string', () => {
    expect(serializeFragment(createFragment())).toBe('');
  });

  it('reproduces a vendored fragment expectation exactly', () => {
    const expected = loadWptCases(['tests_innerHTML_1.dat'])[0]?.document;
    const frag = createFragment();
    appendChild(frag, createElement('span'));
    expect(serializeFragment(frag)).toBe(expected);
  });
});
