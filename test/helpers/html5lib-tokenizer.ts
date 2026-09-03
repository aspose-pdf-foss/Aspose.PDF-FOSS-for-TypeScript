import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'fixtures', 'html5lib', 'tokenizer');

/** The 14 files vendored from html5lib-tests, in a fixed order so a run's
 *  output is stable. */
export const SUITE_FILES = [
  'contentModelFlags.test', 'domjs.test', 'entities.test', 'escapeFlag.test',
  'namedEntities.test', 'numericEntities.test', 'pendingSpecChanges.test',
  'test1.test', 'test2.test', 'test3.test', 'test4.test',
  'unicodeChars.test', 'unicodeCharsProblematic.test', 'xmlViolation.test',
];

/** Excluded files, with a reason each — never a silent skip, the rule
 *  test/commonmark-spec.test.ts's five-entry GFM divergence list already sets. */
export const EXCLUDED = [
  {
    file: 'xmlViolation.test',
    reason:
      'Encodes an XML-compatibility output mode this library does not implement — ' +
      'U+FFFF folded to U+FFFD, FF treated as a space, "--" rewritten inside a ' +
      'comment. Its root key is "xmlViolationTests" rather than "tests", so the ' +
      'exclusion is structural rather than a name match.',
  },
];

export interface Html5libCase {
  file: string;
  description: string;
  input: string;
  initialState: string;
  lastStartTag?: string;
  output: unknown[][];
  errors: { code: string; line: number; col: number }[];
}

/** Resolve one level of \uXXXX escaping. The suite double-escapes a case whose
 *  input or expectation holds a character JSON cannot carry legibly. */
export function unescapeDoubled(s: string): string {
  return s.replace(/\\u([0-9A-Fa-f]{4})/g, (_m, h: string) =>
    String.fromCharCode(parseInt(h, 16)));
}

/** Fold consecutive Character tokens into one. The suite's expectations assume
 *  it; a tokenizer legitimately emits them one code point at a time. */
export function concatCharacterTokens(out: unknown[][]): unknown[][] {
  const merged: unknown[][] = [];
  for (const t of out) {
    const prev = merged[merged.length - 1];
    if (t[0] === 'Character' && prev !== undefined && prev[0] === 'Character') {
      prev[1] = String(prev[1]) + String(t[1]);
      continue;
    }
    merged.push([...t]);
  }
  return merged;
}

interface RawCase {
  description: string;
  input: string;
  output: unknown[][];
  initialStates?: string[];
  lastStartTag?: string;
  doubleEscaped?: boolean;
  errors?: { code: string; line: number; col: number }[];
}

/** Load the suite. Defaults to every declared file that is not excluded. */
/** A case this PIN expects to tokenize the pre-#12118 way.
 *
 *  whatwg/html#12118 (merged 2026-06-25) made `<?target data?>` a real
 *  processing instruction; tag open's `?` branch no longer reports
 *  `unexpected-question-mark-instead-of-tag-name` at all, so a case asserting
 *  that error is asserting a state the tokenizer no longer has.
 *
 *  The predicate is COMPUTED over the expected errors rather than a list of
 *  ids, so a case cannot be reclassified to dodge a failure — the rule the WPT
 *  loader already follows. See test/fixtures/html5lib/PROVENANCE.md for why
 *  this pin cannot simply be moved forward. */
function isPreSpecChangePi(c: Html5libCase): boolean {
  return c.errors.some((e) => e.code === 'unexpected-question-mark-instead-of-tag-name');
}

/** The cases `loadTokenizerCases` drops, so the suite can assert how many
 *  there are rather than letting the exclusion widen unnoticed. */
export function preSpecChangePiCases(files?: string[]): Html5libCase[] {
  return buildTokenizerCases(files).filter(isPreSpecChangePi);
}

export function loadTokenizerCases(files?: string[]): Html5libCase[] {
  return buildTokenizerCases(files).filter((c) => !isPreSpecChangePi(c));
}

function buildTokenizerCases(files?: string[]): Html5libCase[] {
  const want = files ?? SUITE_FILES.filter((f) => !EXCLUDED.some((e) => e.file === f));
  const cases: Html5libCase[] = [];
  for (const file of want) {
    if (!SUITE_FILES.includes(file)) throw new Error(`${file} is not a declared suite file`);
    const doc = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as Record<string, RawCase[]>;
    const raw = doc['tests'];
    if (raw === undefined) {
      throw new Error(`${file} has no "tests" key (root keys: ${Object.keys(doc).join(', ')})`);
    }
    for (const c of raw) {
      const de = c.doubleEscaped === true;
      const input = de ? unescapeDoubled(c.input) : c.input;
      const output = concatCharacterTokens(
        c.output.map((t) => t.map((v) => (de && typeof v === 'string' ? unescapeDoubled(v) : v))),
      );
      for (const initialState of c.initialStates ?? ['Data state']) {
        cases.push({
          file,
          description: c.description,
          input,
          initialState,
          lastStartTag: c.lastStartTag,
          output,
          errors: c.errors ?? [],
        });
      }
    }
  }
  return cases;
}
