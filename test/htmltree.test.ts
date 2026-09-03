import { describe, it, expect } from 'vitest';
import { parseHtml, parseHtmlFragment } from '../src/htmltree.js';
import type { FragmentContext } from '../src/htmltree.js';
import { serializeTree, serializeFragment } from './helpers/wpt-tree.js';

const tree = (src: string): string => serializeTree(parseHtml(src));

// Every expectation below is COPIED FROM THE CORPUS, with its source case
// named. None is derived by hand: an invented expectation in a plan sends the
// implementer chasing a tree the oracle never asked for. The file#index
// comments are how a failure here is traced back to the vendored case.
describe('tree construction', () => {
  // tests1.dat#0
  it('synthesizes html, head and body', () => {
    expect(tree('Test')).toBe('| <html>\n|   <head>\n|   <body>\n|     "Test"');
  });

  // tests1.dat#1
  it('auto-closes a p at a block start tag', () => {
    expect(tree('<p>One<p>Two')).toBe(
      '| <html>\n|   <head>\n|   <body>\n|     <p>\n|       "One"\n|     <p>\n|       "Two"',
    );
  });

  // adoption01.dat#0. Wrong, the tree is merely mis-nested and still renders —
  // which is why the algorithm has a name rather than being "handle misnested
  // tags". Note the <a> is CLONED into the <p>: that clone is the algorithm's
  // whole observable effect here.
  it('runs the adoption agency on misnested formatting', () => {
    expect(tree('<a><p></a></p>')).toBe(
      '| <html>\n|   <head>\n|   <body>\n|     <a>\n|     <p>\n|       <a>',
    );
  });

  // adoption01.dat#5 — foster parenting AND the adoption agency together.
  // Everything lands BEFORE the <table>, never inside it.
  it('foster-parents stray content out of a table', () => {
    expect(tree('<table><a>1<p>2</a>3</p>')).toBe(
      '| <html>\n|   <head>\n|   <body>\n|     <a>\n|       "1"\n|     <p>\n|       <a>\n|         "2"\n|       "3"\n|     <table>',
    );
  });

  // tables01.dat#0 — the implied tbody/tr around a bare <th>.
  it('synthesizes tbody and tr around a bare th', () => {
    expect(tree('<table><th>')).toBe(
      '| <html>\n|   <head>\n|   <body>\n|     <table>\n|       <tbody>\n|         <tr>\n|           <th>',
    );
  });

  // tests1.dat#25 — the <b> re-opens inside the <div>, which is reconstruction
  // doing its job; without it the second <b> is simply absent.
  it('reconstructs active formatting elements', () => {
    expect(tree('<p><b><div><marquee></p></b></div>X')).toBe(
      '| <html>\n|   <head>\n|   <body>\n|     <p>\n|       <b>\n|     <div>\n|       <b>\n|         <marquee>\n|           <p>\n|           "X"',
    );
  });

  // html5test-com.dat#5
  it('keeps a doctype', () => {
    expect(tree('<!DOCTYPE html>')).toBe(
      '| <!DOCTYPE html>\n| <html>\n|   <head>\n|   <body>',
    );
  });

  // comments01.dat#15 — <title> is RCDATA, so its content is text.
  it('drives the tokenizer into RCDATA for title', () => {
    expect(tree('<html><!-- comment --><title>Comment before head</title>')).toBe(
      '| <html>\n|   <!--  comment  -->\n|   <head>\n|     <title>\n|       "Comment before head"\n|   <body>',
    );
  });

  // tests1.dat#26 — <script> is RAWTEXT and <title> RCDATA; the tags inside
  // both are text, and the </div> after the script closes nothing.
  it('drives the tokenizer into RAWTEXT for script', () => {
    expect(tree('<script><div></script></div><title><p></title><p><p>')).toBe(
      '| <html>\n|   <head>\n|     <script>\n|       "<div>"\n|     <title>\n|       "<p>"\n|   <body>\n|     <p>\n|     <p>',
    );
  });

  it('never throws, on any input', () => {
    for (const s of ['', '<', '</>', '<!', '</p>', '<table><td>', '<b><i></b></i>']) {
      expect(() => parseHtml(s)).not.toThrow();
    }
  });
});

describe('foreign content', () => {
  // tests10.dat#8 — note `<svg svg>`: the prefix is the namespace, not the
  // tag, so SVG's own root repeats. And the table is foster-parented out.
  it('parses an svg subtree into the SVG namespace', () => {
    expect(tree('<!DOCTYPE html><body><table><tbody><svg><g>foo</g><g>bar</g></svg></tbody></table>'))
      .toBe('| <!DOCTYPE html>\n| <html>\n|   <head>\n|   <body>\n|     <svg svg>\n|       <svg g>\n|         "foo"\n|       <svg g>\n|         "bar"\n|     <table>\n|       <tbody>');
  });

  // tests10.dat#1 — in HTML content `<![CDATA[` is a bogus comment.
  it('makes a comment of a CDATA section outside foreign content', () => {
    expect(tree('<!DOCTYPE html><svg></svg><![CDATA[a]]>')).toBe(
      '| <!DOCTYPE html>\n| <html>\n|   <head>\n|   <body>\n|     <svg svg>\n|     <!-- [CDATA[a]] -->',
    );
  });

  it('never throws on foreign input', () => {
    for (const s of ['<svg>', '<svg/>', '<math>', '<svg><foreignObject><div></div>',
      '<math><annotation-xml encoding=text/html><p>', '<svg><![CDATA[x]]>']) {
      expect(() => parseHtml(s)).not.toThrow();
    }
  });
});

describe('template', () => {
  // template.dat#0 — `content` is a bare word at depth + 1, the children at
  // depth + 2. A template's own children array stays empty.
  it('puts a template’s children in its content fragment', () => {
    expect(tree('<body><template>Hello</template>')).toBe(
      '| <html>\n|   <head>\n|   <body>\n|     <template>\n|       content\n|         "Hello"',
    );
  });

  // template.dat#3 — a template before <body> stays in <head>.
  it('keeps a template in head when that is where it opened', () => {
    expect(tree('<html><template>Hello</template>')).toBe(
      '| <html>\n|   <head>\n|     <template>\n|       content\n|         "Hello"\n|   <body>',
    );
  });

  // template.dat#8 — a template inside a table is NOT foster-parented out.
  it('leaves a template inside a table', () => {
    expect(tree('<table><template></template></table>')).toBe(
      '| <html>\n|   <head>\n|   <body>\n|     <table>\n|       <template>\n|         content',
    );
  });

  // template.dat#33 — the ONLY corpus case that can tell a mode STACK from a
  // single variable: the inner template must restore the outer one's mode.
  it('nests templates, restoring the outer mode', () => {
    expect(tree('<table><template><tr><template><td></template></tr></template></table>')).toBe(
      '| <html>\n|   <head>\n|   <body>\n|     <table>\n|       <template>\n|         content\n|           <tr>\n|             <template>\n|               content\n|                 <td>',
    );
  });

  // template.dat#45 — the stack switching twice inside one template.
  it('switches template mode per table construct', () => {
    expect(tree('<body><template><tr></tr><td></td></template>')).toBe(
      '| <html>\n|   <head>\n|   <body>\n|     <template>\n|       content\n|         <tr>\n|         <tr>\n|           <td>',
    );
  });

  it('never throws on template input', () => {
    for (const s of ['<template>', '</template>', '<template><template>',
      '<table><template><td>', '<template></body></template>']) {
      expect(() => parseHtml(s)).not.toThrow();
    }
  });
});

describe('fragment parsing', () => {
  const frag = (src: string, context: FragmentContext) =>
    serializeFragment(parseHtmlFragment(src, context));

  // tests_innerHTML_1.dat#0 — a <body> start tag inside a body context is
  // ignored, and the output has no document wrapper.
  it('parses into a body context', () => {
    expect(frag('<body><span>', { name: 'body' })).toBe('| <span>');
  });

  // tests_innerHTML_1.dat#2
  it('ignores a stray body tag in a div context', () => {
    expect(frag('<span><body>', { name: 'div' })).toBe('| <span>');
  });

  // foreign-fragment.dat#0 — THE case that proves adjustedCurrentNode. In an
  // SVG context the foreign rules run, so <nobr> breaks out and takes the X
  // with it; with the old alias it is an HTML element and the X lands beside.
  it('parses into an svg context as foreign content', () => {
    expect(frag('<nobr>X', { name: 'path', ns: 'svg' })).toBe('| <nobr>\n|   "X"');
  });

  // foreign-fragment.dat#4 — the context's own end tag closes nothing,
  // because the context element is not on the stack.
  it('ignores the context element’s own end tag', () => {
    expect(frag('</path>X', { name: 'path', ns: 'svg' })).toBe('| "X"');
  });

  // The tokenizer priming table: a title context is RCDATA, so a tag inside
  // it is text rather than markup.
  it('primes the tokenizer from the context name', () => {
    expect(frag('<p>', { name: 'title' })).toBe('| "<p>"');
  });

  it('never throws on any context', () => {
    // Typed explicitly: a bare array literal mixing entries with and without
    // `ns` widens it to `string`, which is not assignable to HtmlNamespace.
    const contexts: FragmentContext[] = [
      { name: 'td' }, { name: 'html' }, { name: 'template' },
      { name: 'select' }, { name: 'svg', ns: 'svg' }, { name: 'ms', ns: 'math' },
    ];
    for (const ctx of contexts) {
      expect(() => parseHtmlFragment('<div>x</div>', ctx)).not.toThrow();
    }
  });
});
