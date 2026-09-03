import { describe, it, expect } from 'vitest';
import {
  loadTokenizerCases, preSpecChangePiCases, SUITE_FILES, EXCLUDED, concatCharacterTokens,
} from './helpers/html5lib-tokenizer.js';
import { HtmlTokenizer, TokenizerState } from '../src/htmltoken.js';

const STATES: Record<string, TokenizerState> = {
  'Data state': TokenizerState.Data,
  'RCDATA state': TokenizerState.RCDATA,
  'RAWTEXT state': TokenizerState.RAWTEXT,
  'Script data state': TokenizerState.ScriptData,
  'PLAINTEXT state': TokenizerState.PLAINTEXT,
  'CDATA section state': TokenizerState.CdataSection,
};

/** Run one case and return its tokens in the suite's own spelling. */
function run(input: string, initialState: string, lastStartTag?: string) {
  const t = new HtmlTokenizer(input);
  const s = STATES[initialState];
  if (s === undefined) throw new Error(`unknown initial state ${initialState}`);
  t.setState(s);
  if (lastStartTag !== undefined) t.setLastStartTag(lastStartTag);
  const out: unknown[][] = [];
  for (;;) {
    const tok = t.next();
    if (tok.kind === 'eof') break;
    if (tok.kind === 'character') out.push(['Character', tok.data]);
    else if (tok.kind === 'comment') out.push(['Comment', tok.data]);
    // html5lib has no PI serialization: its suite predates whatwg/html#12118
    // and every case that would produce one is excluded (see PROVENANCE).
    else if (tok.kind === 'pi') out.push(['ProcessingInstruction', tok.target, tok.data]);
    else if (tok.kind === 'startTag') {
      const a: Record<string, string> = {};
      for (const [k, v] of tok.attrs) a[k] = v;
      out.push(tok.selfClosing ? ['StartTag', tok.name, a, true] : ['StartTag', tok.name, a]);
    } else if (tok.kind === 'endTag') out.push(['EndTag', tok.name]);
    else {
      out.push([
        'DOCTYPE',
        tok.name ?? null, tok.publicId ?? null, tok.systemId ?? null,
        !tok.forceQuirks,
      ]);
    }
  }
  return { tokens: concatCharacterTokens(out), errors: t.errors };
}

describe('html5lib tokenizer suite', () => {
  // There is no allowlist. Every declared file runs except the recorded
  // exclusions, so a file cannot be quietly dropped to make the suite green.
  it('runs every declared file except the recorded exclusions', () => {
    const ran = new Set(loadTokenizerCases().map((c) => c.file));
    const expected = SUITE_FILES.filter((f) => !EXCLUDED.some((e) => e.file === f));
    expect([...ran].sort()).toEqual([...expected].sort());
  });

  // zch2.9: the one CASE-level exclusion, counted so it cannot widen
  // unnoticed. These 38 assert `unexpected-question-mark-instead-of-tag-name`,
  // an error whatwg/html#12118 (merged 2026-06-25) deleted along with the
  // bogus-comment reading of `<?`. This pin is dated one day after that merge
  // and upstream has been dormant since, so there is no newer pin to take —
  // see test/fixtures/html5lib/PROVENANCE.md.
  it('excludes exactly the cases this pin predates a spec change on', () => {
    const excluded = preSpecChangePiCases();
    expect(excluded).toHaveLength(38);
    // Every one is a `<?` case, and every one asserts the retired error.
    for (const c of excluded) {
      expect(c.input).toContain('<?');
      expect(c.errors.map((e) => e.code))
        .toContain('unexpected-question-mark-instead-of-tag-name');
    }
  });

  for (const c of loadTokenizerCases()) {
    it(`${c.file}: ${c.description} [${c.initialState}]`, () => {
      const got = run(c.input, c.initialState, c.lastStartTag);
      expect(got.tokens).toEqual(c.output);
      expect(got.errors).toEqual(c.errors);
    });
  }
});
