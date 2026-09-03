/** Loader for CourtBouillon's css-parsing-tests corpus, plus the serializer
 *  that renders our types into its JSON — the oracle's other half.
 *
 *  Test-only. Nothing in `src/` may import this, the rule
 *  `test/helpers/wpt-tree.ts` and `test/helpers/md-html.ts` already set. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..', 'fixtures', 'css-parsing',
);

export type CssSuite =
  | 'component_value_list' | 'one_component_value' | 'declaration_list'
  | 'one_declaration' | 'rule_list' | 'one_rule' | 'stylesheet'
  | 'blocks_contents';

export const CSS_SUITES: CssSuite[] = [
  'component_value_list', 'one_component_value', 'declaration_list',
  'one_declaration', 'rule_list', 'one_rule', 'stylesheet', 'blocks_contents',
];

export interface CssCase {
  suite: CssSuite;
  index: number;
  input: string;
  expected: unknown;
}

/** Render our token and node types into the corpus's JSON.
 *
 *  Written from the corpus README and from the DATA, which disagree in two
 *  places where the data wins: a dimension is five elements though the prose
 *  says four, and there are nine error kinds where the prose lists five.
 *
 *  Deliberately NOT written from whatever our types make convenient — a
 *  serializer bent to fit the types hides bugs in those types. */
export function serializeCss(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(serializeCss);
  const v = value as Record<string, unknown>;
  switch (v['kind']) {
    case 'whitespace': return ' ';
    case 'colon': return ':';
    case 'semicolon': return ';';
    case 'comma': return ',';
    case 'cdo': return '<!--';
    case 'cdc': return '-->';
    case 'column': return '||';
    case 'delim': return v['value'];
    case 'match': return v['value'];
    case 'ident': return ['ident', v['value']];
    case 'at-keyword': return ['at-keyword', v['value']];
    case 'string': return ['string', v['value']];
    case 'url': return ['url', v['value']];
    case 'hash': return ['hash', v['value'], v['id'] === true ? 'id' : 'unrestricted'];
    case 'number':
      return ['number', v['repr'], v['value'], v['int'] === true ? 'integer' : 'number'];
    case 'percentage':
      return ['percentage', v['repr'], v['value'], v['int'] === true ? 'integer' : 'number'];
    case 'dimension':
      return ['dimension', v['repr'], v['value'],
        v['int'] === true ? 'integer' : 'number', v['unit']];
    case 'unicode-range': return ['unicode-range', v['start'], v['end']];
    case 'block': {
      const pair = v['open'] === '{' ? '{}' : v['open'] === '[' ? '[]' : '()';
      return [pair, ...(v['contents'] as unknown[]).map(serializeCss)];
    }
    // `args` is absent on the tokenizer's FLAT function token, which the
    // parser always wraps before anything is serialized. The `?? []` keeps a
    // leak from crashing here so it surfaces as a failed comparison against
    // the corpus, which names the case, rather than as a stack trace.
    case 'function':
      return ['function', v['name'],
        ...((v['args'] as unknown[] | undefined) ?? []).map(serializeCss)];
    case 'at-rule':
      return ['at-rule', v['name'], serializeCss(v['prelude']),
        v['block'] === null ? null : serializeCss(v['block'])];
    case 'qualified-rule':
      return ['qualified rule', serializeCss(v['prelude']), serializeCss(v['block'])];
    case 'declaration':
      return ['declaration', v['name'], serializeCss(v['value']), v['important']];
    case 'error': return ['error', v['code']];
    default: return value;
  }
}

/** Each file is a FLAT array of alternating input and expected value, not an
 *  array of pairs. Reading it as pairs yields half the cases and a trailing
 *  undefined, which reads as a corpus problem rather than a reader bug. */
export function loadCssCases(suites?: CssSuite[]): CssCase[] {
  const want = suites ?? CSS_SUITES;
  const out: CssCase[] = [];
  for (const suite of want) {
    if (!CSS_SUITES.includes(suite)) throw new Error(`${suite} is not a declared suite`);
    const raw = JSON.parse(readFileSync(join(DIR, `${suite}.json`), 'utf8')) as unknown[];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      out.push({
        suite,
        index: i / 2,
        input: raw[i] as string,
        expected: raw[i + 1],
      });
    }
  }
  return out;
}
