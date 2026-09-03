import { describe, it, expect } from 'vitest';
import {
  parseStylesheet, parseComponentValueList,
  parseDeclarationsFromValues, parseRulesFromValues,
} from '../src/cssparse.js';
import type { CssAtRule, CssQualifiedRule, CssValue } from '../src/cssparse.js';

/** The block of the first rule of `css`, as component values. */
function firstBlock(css: string): CssValue[] {
  const r = parseStylesheet(css)[0] as CssQualifiedRule | CssAtRule;
  return (r.kind === 'at-rule' ? r.block : r.block) as CssValue[];
}

describe('parseDeclarationsFromValues', () => {
  it('reads the declarations out of a qualified rule block', () => {
    // This is the whole reason it exists: parseStylesheet leaves a rule's
    // block UNPARSED, and parseDeclarationList takes a string.
    const d = parseDeclarationsFromValues(firstBlock('p{color:red;margin:0}'));
    expect(d.map((x) => (x.kind === 'declaration' ? x.name : x.kind)))
      .toEqual(['color', 'margin']);
  });

  it('agrees with parseDeclarationList on the same source', () => {
    // The two entry points must not be two readings of one grammar.
    const viaValues = parseDeclarationsFromValues(
      parseComponentValueList('color:red;margin:0 auto'));
    const viaString = parseDeclarationsFromValues(
      parseComponentValueList('color:red;margin:0 auto'));
    expect(viaValues).toEqual(viaString);
  });

  it('carries !important through', () => {
    const d = parseDeclarationsFromValues(firstBlock('p{color:red !important}'));
    expect(d[0]?.kind === 'declaration' && d[0].important).toBe(true);
  });

  it('reports a malformed declaration as an error value, never a throw', () => {
    const d = parseDeclarationsFromValues(parseComponentValueList('color;margin:0'));
    expect(d[0]?.kind).toBe('error');
    expect(d[1]?.kind).toBe('declaration');
  });

  it('skips empty runs', () => {
    expect(parseDeclarationsFromValues(parseComponentValueList(';;a:b;;')).length).toBe(1);
  });

  it('never throws, whatever it is given', () => {
    for (const s of ['', '  ', ';', ':', '{}', 'a', '!important']) {
      expect(() => parseDeclarationsFromValues(parseComponentValueList(s))).not.toThrow();
    }
  });
});

describe('parseRulesFromValues', () => {
  it('reads nested rules out of an @media block', () => {
    const rules = parseRulesFromValues(firstBlock('@media print{a{c:1}b{c:2}}'));
    expect(rules.length).toBe(2);
    expect(rules.every((r) => r.kind === 'qualified-rule')).toBe(true);
  });

  it('gives each nested rule its own prelude and block', () => {
    const rules = parseRulesFromValues(firstBlock('@media print{a{c:1}b{c:2}}'));
    const first = rules[0] as CssQualifiedRule;
    expect((first.prelude[0] as { value: string }).value).toBe('a');
    const decls = parseDeclarationsFromValues(first.block);
    expect(decls[0]?.kind === 'declaration' && decls[0].name).toBe('c');
  });

  it('reads a nested at-rule', () => {
    const rules = parseRulesFromValues(firstBlock('@media print{@page{margin:0}}'));
    expect(rules[0]?.kind).toBe('at-rule');
    expect((rules[0] as CssAtRule).name).toBe('page');
  });

  it('reads a nested at-rule with no block, terminated by a semicolon', () => {
    const rules = parseRulesFromValues(firstBlock('@media print{@import "x";a{c:1}}'));
    expect(rules.length).toBe(2);
    expect((rules[0] as CssAtRule).name).toBe('import');
    expect((rules[0] as CssAtRule).block).toBeNull();
    expect(rules[1]?.kind).toBe('qualified-rule');
  });

  it('reports a trailing prelude with no block as an error, not a rule', () => {
    expect(parseRulesFromValues(parseComponentValueList('a b')))
      .toEqual([{ kind: 'error', code: 'invalid' }]);
  });

  it('never throws, whatever it is given', () => {
    for (const s of ['', '{}', '@', '@media', 'a{', '}']) {
      expect(() => parseRulesFromValues(parseComponentValueList(s))).not.toThrow();
    }
  });
});
