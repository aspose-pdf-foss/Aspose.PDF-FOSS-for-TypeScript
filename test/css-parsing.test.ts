import { describe, it, expect } from 'vitest';
import { loadCssCases, serializeCss } from './helpers/css-parsing.js';
import type { CssSuite } from './helpers/css-parsing.js';
import * as P from '../src/cssparse.js';

const ENTRY: Record<CssSuite, (src: string) => unknown> = {
  component_value_list: P.parseComponentValueList,
  one_component_value: P.parseOneComponentValue,
  declaration_list: P.parseDeclarationList,
  one_declaration: P.parseOneDeclaration,
  rule_list: P.parseRuleList,
  one_rule: P.parseOneRule,
  stylesheet: P.parseStylesheet,
  blocks_contents: P.parseBlocksContents,
};

describe('css-parsing-tests', () => {
  // No allowlist and no bucket predicate: all 149 cases run. The per-suite
  // counts are asserted in test/css-parsing-suite.test.ts.
  for (const c of loadCssCases()) {
    it(`${c.suite}#${c.index}: ${JSON.stringify(c.input).slice(0, 60)}`, () => {
      expect(serializeCss(ENTRY[c.suite](c.input))).toEqual(c.expected);
    });
  }
});
