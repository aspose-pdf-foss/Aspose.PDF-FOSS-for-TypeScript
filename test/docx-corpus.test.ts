import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readDocx } from '../src/wmlread.js';
import {
  readTruth, readerDisagreements, leafDiff, comparable, truthOf, COUNT_KEYS, SKIP_MAP, type DocxTruth, type TruthCounts,
} from './helpers/docx-truth.js';

// m2fp.4's corpus: .docx files written by Word 2010 and LibreOffice, each READ
// by both (test/fixtures/docx/PROVENANCE.md). readDocx is held to what the two
// readers AGREE on; where they disagree, the disagreement itself is pinned.
const DIR = join(__dirname, 'fixtures', 'docx');
// OURS, read by Word (m2fp.3, m2fp.5, m2fp.10): every oracle document is named *-oracle.docx.
const NOT_CORPUS = { has: (f: string): boolean => /-oracle\.docx$/.test(f) };
const files = readdirSync(DIR).filter((f) => f.endsWith('.docx') && !NOT_CORPUS.has(f)).sort();
const disagreements = JSON.parse(readFileSync(join(DIR, 'disagreements.json'), 'utf8')) as Record<string, string[]>;

// The text-box recipe's words: both applications read a text box as a separate
// story, while readDocx keeps an unknown construct's text inline (m2fp.3's
// visible-beats-dropped rule), so they are stripped before comparing.
const OTHER_STORY_TEXT = ['Boxed words'];

// Where readDocx differs from what both readers agree on, and the issue that
// owns it. Fixing one reddens its pin on purpose.
const KNOWN_GAPS: Record<string, { path: string; issue: string }[]> = {};
const KNOWN_SKIP_GAPS: Record<string, { count: keyof TruthCounts; issue: string }[]> = {};


function truthsOf(f: string): DocxTruth[] {
  const base = join(DIR, f.replace(/\.docx$/, ''));
  return ['word', 'lo'].map((k) => `${base}.${k}.json`).filter(existsSync).map(readTruth);
}

function get(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const m of path.matchAll(/[^.[\]]+|\[(\d+)\]/g)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[m[1] ?? m[0]];
  }
  return cur;
}

it('has a corpus, every file with at least one reader\'s truth and a disagreements entry', () => {
  expect(files.length).toBeGreaterThanOrEqual(6);
  const missing = files.filter((f) => truthsOf(f).length === 0 || !(f in disagreements));
  expect(missing).toEqual([]);
});

describe.each(files)('%s', (f) => {
  const truths = truthsOf(f);
  const ours = readDocx(new Uint8Array(readFileSync(join(DIR, f))));
  const pinned = disagreements[f] ?? [];
  const set = new Set(pinned);
  // An array the readers disagree on in LENGTH is compared only up to the
  // shorter of THEIRS: past it one reader's elements have no witness. Its OWN
  // length must still fall between theirs — or a readDocx that stops early at a
  // section break or a merged cell passes the very file that covers it.
  const lengths = new Map<string, { min: number; max: number }>();
  for (const p of pinned) {
    if (!p.endsWith('.length') || truths.length < 2) continue;
    const base = p.slice(0, -'.length'.length);
    const lens = truths.map((t) => (get(comparable(t), base) as unknown[] | undefined)?.length ?? 0);
    lengths.set(base, { min: Math.min(...lens), max: Math.max(...lens) });
  }
  const excluded = (path: string): boolean => {
    if (set.has(path)) return true;
    for (const [base, { min }] of lengths) {
      if (!path.startsWith(`${base}[`)) continue;
      const i = Number(/^\[(\d+)\]/.exec(path.slice(base.length))![1]);
      if (i >= min) return true;
    }
    return false;
  };
  const oursTruth = truthOf(ours, OTHER_STORY_TEXT);

  it('pins exactly where the two readers disagree', () => {
    const got = truths.length === 2 ? readerDisagreements(truths[0], truths[1]).sort() : [];
    expect(got).toEqual([...pinned].sort());
  });

  it('still compares at least one paragraph\'s text', () => {
    // Counts the paragraph TEXTS the exclusions leave compared, not the paragraph
    // count: a pin on every paragraphs[i].text must not pass as "compared".
    const compared = truths[0].paragraphs.filter((_, i) => !excluded(`paragraphs[${i}].text`)).length;
    expect(compared).toBeGreaterThan(0);
  });

  it('matches the readers wherever they agree', () => {
    const diff = leafDiff(comparable(truths[0]), oursTruth).filter((p) => !excluded(p));
    for (const [base, { min, max }] of lengths) {
      const mine = (get(oursTruth, base) as unknown[] | undefined)?.length ?? 0;
      if (mine < min || mine > max) diff.push(`${base}.length (ours ${mine}, readers ${min}..${max})`);
    }
    expect(diff.sort()).toEqual((KNOWN_GAPS[f] ?? []).map((g) => g.path).sort());
  });

  it('records every construct the readers found and readDocx does not model', () => {
    const names = new Set(ours.unsupported.map((u) => u.name));
    const missing = COUNT_KEYS.filter((k) => truths.every((t) => t.counts[k] > 0) && !SKIP_MAP[k].some((n) => names.has(n)));
    expect(missing).toEqual((KNOWN_SKIP_GAPS[f] ?? []).map((g) => g.count));
  });
});
