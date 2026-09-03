import { describe, it, expect } from 'vitest';
import { parseHtml, parseHtmlBytes } from '../src/htmltree.js';
import type { HtmlNode } from '../src/htmldom.js';

/** ASCII text as bytes. Every tag in these fixtures is ASCII, which is the
 *  whole reason a legacy document survives its first pass as UTF-8. */
const a = (s: string): Uint8Array => Uint8Array.from([...s], (c) => c.charCodeAt(0));

const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/** The discriminating triple: these three bytes decode to a DIFFERENT string
 *  under each encoding the tests below can reach, so one fixture separates
 *  every case. Verified against TextDecoder. */
const TRIPLE = Uint8Array.from([0xCF, 0xF0, 0xE8]);
const AS_CP1251 = 'При';
const AS_KOI8 = 'оПХ';
const AS_1252 = 'Ïðè';
const AS_UTF8 = '���';

const utf16le = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i * 2] = c & 0xFF;
    out[i * 2 + 1] = c >> 8;
  }
  return out;
};

function textOf(node: HtmlNode): string {
  if (node.kind === 'text') return node.data;
  if (node.kind === 'element' || node.kind === 'document' || node.kind === 'fragment')
    return node.children.map(textOf).join('');
  return '';
}

/** Every element with this tag name, in document order. */
function elements(node: HtmlNode, name: string): HtmlNode[] {
  const found: HtmlNode[] = [];
  const walk = (n: HtmlNode): void => {
    if (n.kind === 'element' && n.name === name) found.push(n);
    if (n.kind === 'element' || n.kind === 'document' || n.kind === 'fragment')
      n.children.forEach(walk);
  };
  walk(node);
  return found;
}

describe('parseHtmlBytes', () => {
  it('decodes as UTF-8 when nothing declares otherwise', () => {
    const doc = parseHtmlBytes(a('<p>caf') /* ASCII */);
    expect(textOf(doc)).toBe('caf');
  });

  it('restarts when a meta charset contradicts the tentative UTF-8', () => {
    // The whole feature: without the restart these bytes are three U+FFFD.
    const doc = parseHtmlBytes(cat(a('<meta charset="windows-1251"><p>'), TRIPLE));
    expect(textOf(doc)).toBe(AS_CP1251);
  });

  it('reads charset out of an http-equiv meta too', () => {
    const doc = parseHtmlBytes(cat(
      a('<meta http-equiv="content-type" content="text/html;charset=windows-1251"><p>'),
      TRIPLE));
    expect(textOf(doc)).toBe(AS_CP1251);
  });

  it('finds a meta past the 1024-byte window a prescan gives up on', () => {
    // We run NO prescan, so this document — which a browser decodes wrongly —
    // is one we get right. The divergence in mechanism, converging in result.
    const filler = `<!--${'a'.repeat(1200)}-->`;
    const doc = parseHtmlBytes(cat(
      a(`<head>${filler}<meta charset="windows-1251">`), a('<p>'), TRIPLE));
    expect(textOf(doc)).toBe(AS_CP1251);
  });

  it('lets an explicit encoding outrank the meta', () => {
    // A caller who read a Content-Type header knows more than the document.
    const doc = parseHtmlBytes(
      cat(a('<meta charset="windows-1251"><p>'), TRIPLE),
      { encoding: 'koi8-r' });
    expect(textOf(doc)).toBe(AS_KOI8);
  });

  it('ignores an explicit encoding no encoding claims', () => {
    const doc = parseHtmlBytes(cat(a('<meta charset="windows-1251"><p>'), TRIPLE),
      { encoding: 'nonsense-8' });
    expect(textOf(doc)).toBe(AS_CP1251);
  });

  it('lets a BOM outrank a contradicting meta', () => {
    const doc = parseHtmlBytes(cat(
      Uint8Array.from([0xEF, 0xBB, 0xBF]),
      a('<meta charset="windows-1251"><p>'), TRIPLE));
    expect(textOf(doc)).toBe(AS_UTF8);
  });

  it('lets a BOM outrank an explicit encoding too', () => {
    // §13.2.3.1 puts the BOM ABOVE transport-layer metadata, which is what
    // `encoding` models — a Content-Type charset is a claim about the bytes,
    // and the bytes themselves say otherwise. Only a user override would beat
    // it, and this library exposes none.
    const doc = parseHtmlBytes(
      cat(Uint8Array.from([0xEF, 0xBB, 0xBF]), a('<p>'), TRIPLE),
      { encoding: 'windows-1251' });
    expect(textOf(doc)).toBe(AS_UTF8);
  });

  it('honours a UTF-16LE BOM, which no meta scan could find', () => {
    const doc = parseHtmlBytes(cat(
      Uint8Array.from([0xFF, 0xFE]), utf16le(`<p>${AS_CP1251}`)));
    expect(textOf(doc)).toBe(AS_CP1251);
  });

  it('restarts at most once, so the first meta wins', () => {
    // After the restart the confidence is CERTAIN, which is what makes "at
    // most one restart" a proof rather than a limit: the second meta cannot
    // fire the rule again. Without that, this document never stops reparsing.
    const doc = parseHtmlBytes(cat(
      a('<meta charset="windows-1251"><meta charset="koi8-r"><p>'), TRIPLE));
    expect(textOf(doc)).toBe(AS_CP1251);
  });

  it('a meta that agrees makes the confidence certain, so a later one is ignored', () => {
    // §13.2.3.3 step 3: a declaration naming the encoding already in force
    // does not merely change nothing, it settles the question. Returning early
    // without recording that leaves the confidence tentative, and the second
    // meta then restarts a parse the first one had already vouched for.
    const doc = parseHtmlBytes(cat(
      a('<meta charset="utf-8"><meta charset="windows-1251"><p>'), TRIPLE));
    expect(textOf(doc)).toBe(AS_UTF8);
  });

  it('does not truncate the document when the meta agrees with the encoding', () => {
    // The restart stops the first parse early. A meta naming the encoding
    // already in force must NOT, or every UTF-8 page loses its body.
    const doc = parseHtmlBytes(a('<meta charset="utf-8"><p>alpha<p>omega'));
    expect(textOf(doc)).toBe('alphaomega');
    expect(elements(doc, 'p')).toHaveLength(2);
  });

  it('keeps the whole document across a restart', () => {
    const doc = parseHtmlBytes(cat(
      a('<meta charset="windows-1251"><p>alpha<p>'), TRIPLE, a('<p>omega')));
    expect(textOf(doc)).toBe(`alpha${AS_CP1251}omega`);
    expect(elements(doc, 'p')).toHaveLength(3);
  });

  it('acts on a meta reached through "in body", which the spec redirects', () => {
    // §13.2.6.4.7 processes a body <meta> "using the rules for the in head
    // insertion mode", so the change-the-encoding rule fires there too. The
    // obvious reading — that the rule lives in head and a body meta is too
    // late — is wrong, and this test asserted it before the spec corrected it.
    const doc = parseHtmlBytes(cat(
      a('<body><p>x<meta charset="windows-1251"><p>'), TRIPLE));
    expect(textOf(doc)).toBe(`x${AS_CP1251}`);
  });

  it('rewrites a meta-declared x-user-defined to windows-1252', () => {
    const doc = parseHtmlBytes(cat(a('<meta charset="x-user-defined"><p>'), TRIPLE));
    expect(textOf(doc)).toBe(AS_1252);
  });

  it('never throws on bytes that are not HTML at all', () => {
    const junk = new Uint8Array(256);
    for (let i = 0; i < 256; i++) junk[i] = i;
    expect(() => parseHtmlBytes(junk)).not.toThrow();
    expect(() => parseHtmlBytes(new Uint8Array())).not.toThrow();
  });
});

describe('parseHtml (string) is unaffected by the encoding machinery', () => {
  it('does not stop at a meta charset', () => {
    // The tentative-confidence guard is what keeps the string path
    // byte-identical: parseHtml never sets one, so the rule cannot fire.
    const doc = parseHtml('<meta charset="windows-1251"><p>alpha<p>omega');
    expect(textOf(doc)).toBe('alphaomega');
    expect(elements(doc, 'p')).toHaveLength(2);
    expect(elements(doc, 'meta')).toHaveLength(1);
  });
});
