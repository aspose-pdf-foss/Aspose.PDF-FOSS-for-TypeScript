/** Reader for web-platform-tests' HTML tree-construction `.dat` corpus, plus
 *  the html5lib `| ` tree serializer that is the oracle's other half.
 *
 *  Test-only. Nothing in `src/` may import this — the rule
 *  `test/helpers/md-html.ts` already sets for CommonMark's HTML oracle. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocument } from '../../src/htmldom.js';
import type { HtmlDocument, HtmlFragment, HtmlNode } from '../../src/htmldom.js';
import type { FragmentContext } from '../../src/htmltree.js';

const DIR = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..', 'fixtures', 'wpt', 'tree-construction',
);

export const DAT_FILES = [
  'adoption01', 'adoption02', 'blocks', 'comments01', 'doctype01', 'domjs-unsafe',
  'entities01', 'entities02', 'foreign-fragment', 'html5test-com', 'inbody01', 'isindex',
  'main-element', 'math', 'menuitem-element', 'namespace-sensitivity', 'noscript01',
  'pending-spec-changes-plain-text-unsafe', 'pending-spec-changes', 'plain-text-unsafe',
  'processing-instructions', 'quirks01', 'ruby', 'scriptdata01', 'scripted_adoption01',
  'scripted_ark', 'scripted_foster01', 'scripted_webkit01', 'search-element', 'svg',
  'tables01', 'template', 'tests1', 'tests10', 'tests11', 'tests12', 'tests14', 'tests15',
  'tests16', 'tests17', 'tests18', 'tests19', 'tests2', 'tests20', 'tests21', 'tests22',
  'tests23', 'tests24', 'tests25', 'tests26', 'tests3', 'tests4', 'tests5', 'tests6',
  'tests7', 'tests8', 'tests9', 'tests_innerHTML_1', 'tricky01', 'void-in-phrasing',
  'webkit01', 'webkit02',
].map((n) => `${n}.dat`);

export type Bucket =
  | 'inScope' | 'scripted' | 'selectedContent';

export interface WptCase {
  file: string;
  index: number;
  data: string;
  document: string;
  fragmentContext?: FragmentContext;
  bucket: Bucket;
}

/** Split one .dat file into raw chunks. The boundary is a blank line
 *  IMMEDIATELY followed by '#data' — not any blank line, since payloads
 *  contain them, and not any '#' line, since payloads contain those too. */
function chunksOf(text: string): string[] {
  return text.split(/\n\n(?=#data\n)/).filter((c) => c.startsWith('#data\n'));
}

/** Split a chunk into its directive sections. A section runs to the next line
 *  that is exactly '#' + a lowercase/hyphen word. */
function sectionsOf(chunk: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let cur: string | null = null;
  for (const line of chunk.split('\n')) {
    const m = /^#([a-z-]+)$/.exec(line);
    if (m !== null) { cur = m[1] as string; out[cur] = []; continue; }
    if (cur !== null) (out[cur] as string[]).push(line);
  }
  return out;
}

function classify(
  file: string,
  s: Record<string, string[]>,
  data: string,
  doc: string,
): Bucket {
  // zch2.1.3.3 retired the `fragment` bucket — a case with a context is now
  // driven through parseHtmlFragment rather than excluded. The third and last
  // retirement, after `foreign` and `template`, and the only one that masked
  // nothing: all 196 became in-scope.
  if (s['script-on'] !== undefined || file.startsWith('scripted_')) return 'scripted';
  // zch2.1.3.1 retired the `foreign` bucket and zch2.1.3.2 retired `template`,
  // both by deleting the predicate outright rather than replacing it. Note
  // what deleting the template test REVEALED: two of its 112 cases are really
  // processing-instruction cases, which it had been matching first.
  // Excluded: the expectation is a DOM behaviour, not a parse. <selectedcontent>
  // clones the selected <option>'s subtree into itself, so WPT's expected tree
  // holds text no parser ever put there. See PROVENANCE.md and 4h3p.
  if (/^\| +<selectedcontent>/m.test(doc)) return 'selectedContent';
  // zch2.9 RETIRED the processing-instruction exclusion. whatwg/html#12118
  // (merged 2026-06-25) made `<?target data?>` a real processing instruction,
  // htmltoken.ts implements it, and all 88 cases are back in scope. The
  // disagreement did not go away — it moved to the OTHER corpus, whose pin
  // predates the change and whose upstream is dormant. See
  // test/fixtures/html5lib/PROVENANCE.md.
  return 'inScope';
}

/** The `#document-fragment` line is a bare name for an HTML context (`td`)
 *  and two space-separated words for a foreign one (`svg path`, `math ms`). */
function parseFragmentContext(line: string): FragmentContext {
  const parts = line.trim().split(/\s+/);
  if (parts.length >= 2 && (parts[0] === 'svg' || parts[0] === 'math')) {
    return { name: parts[1] as string, ns: parts[0] };
  }
  return { name: parts[0] as string };
}

export function loadWptCases(files?: string[]): WptCase[] {
  const want = files ?? DAT_FILES;
  const cases: WptCase[] = [];
  for (const file of want) {
    if (!DAT_FILES.includes(file)) throw new Error(`${file} is not a declared .dat file`);
    const text = readFileSync(join(DIR, file), 'utf8');
    let index = 0;
    for (const chunk of chunksOf(text)) {
      const s = sectionsOf(chunk);
      const data = (s['data'] ?? []).join('\n');
      const document = (s['document'] ?? []).join('\n').replace(/\n+$/, '');
      const rawContext = s['document-fragment']?.join('\n');
      const fragmentContext = rawContext === undefined
        ? undefined : parseFragmentContext(rawContext);
      cases.push({
        file,
        index: index++,
        data,
        document,
        ...(fragmentContext === undefined ? {} : { fragmentContext }),
        bucket: classify(file, s, data, document),
      });
    }
  }
  return cases;
}

export function casesInBucket(b: Bucket): WptCase[] {
  return loadWptCases().filter((c) => c.bucket === b);
}

// ---- the serializer -------------------------------------------------------

/** Serialize a document in html5lib's `| ` format, written from the format
 *  description rather than from whatever our DOM makes convenient — a
 *  serializer bent to fit the tree hides bugs in that tree.
 *
 *  Every node emits `| ` + two spaces per depth + its body. Text is quoted and
 *  NOT escaped, so a newline passes through raw and its continuation lines are
 *  bare, which is exactly what the corpus records. */
/** A fragment expectation has NO document wrapper — the root's children are
 *  serialized at depth 0. Built by wrapping them in a throwaway document so
 *  the one walk in serializeTree stays the only walk.
 *
 *  The children are PUSHED DIRECTLY rather than through appendChild, which
 *  would reparent them and destroy the very tree being serialized. */
export function serializeFragment(frag: HtmlFragment): string {
  const doc = createDocument();
  for (const child of frag.children) doc.children.push(child);
  return serializeTree(doc);
}

export function serializeTree(doc: HtmlDocument): string {
  const lines: string[] = [];
  const walk = (nodes: HtmlNode[], depth: number): void => {
    for (const n of nodes) {
      const pad = `| ${'  '.repeat(depth)}`;
      switch (n.kind) {
        case 'element': {
          // A foreign element is `<ns name>`. Note SVG's own root comes out
          // `<svg svg>`: the prefix is the NAMESPACE, not the tag, so it
          // repeats — that reads like a bug and is the format.
          const prefix = n.ns === 'html' ? '' : `${n.ns} `;
          lines.push(`${pad}<${prefix}${n.name}>`);
          for (const name of [...n.attrs.keys()].sort()) {
            lines.push(`| ${'  '.repeat(depth + 1)}${name}="${n.attrs.get(name) as string}"`);
          }
          // A template's children live in its content fragment, which the
          // format spells as the BARE WORD `content` one level in, with the
          // children a further level in. The element's own children array
          // stays empty for the life of the parse.
          if (n.content !== undefined) {
            lines.push(`| ${'  '.repeat(depth + 1)}content`);
            walk(n.content.children, depth + 2);
          }
          walk(n.children, depth + 1);
          break;
        }
        case 'text':
          lines.push(`${pad}"${n.data}"`);
          break;
        case 'comment':
          lines.push(`${pad}<!-- ${n.data} -->`);
          break;
        case 'pi':
          // html5lib renders a PI as `<?target data?>`, one space between the
          // two halves even when the data is empty.
          lines.push(`${pad}<?${n.target} ${n.data}?>`);
          break;
        case 'doctype': {
          const ids = n.publicId === '' && n.systemId === ''
            ? '' : ` "${n.publicId}" "${n.systemId}"`;
          lines.push(`${pad}<!DOCTYPE ${n.name}${ids}>`);
          break;
        }
        default:
          break;
      }
    }
  };
  walk(doc.children, 0);
  return lines.join('\n');
}
