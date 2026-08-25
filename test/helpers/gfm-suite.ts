import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** One example from GitHub's `spec.txt`.
 *
 *  `extension` is the word on the opening fence — `table`, `disabled`,
 *  `strikethrough`, `autolink`, `tagfilter` — and '' for a plain CommonMark
 *  example. Only the tagged ones are run; see the PROVENANCE for why. */
export interface GfmCase {
  markdown: string;
  html: string;
  example: number;
  section: string;
  extension: string;
  startLine: number;
}

const SPEC_URL = new URL('../fixtures/gfm/spec.txt', import.meta.url);
const FENCE = '`'.repeat(32);
const OPEN = `${FENCE} example`;

/** Tabs are written as U+2192 in the spec file, as in CommonMark's own. */
function body(lines: string[]): string {
  if (lines.length === 0) return '';
  return `${lines.join('\n')}\n`.replace(/→/g, '\t');
}

let cached: GfmCase[] | undefined;

/** Every example in the file, in spec order, numbered as the spec numbers them. */
export function loadGfmExamples(): GfmCase[] {
  if (cached !== undefined) return cached;
  const lines = readFileSync(fileURLToPath(SPEC_URL), 'utf8').split('\n');
  const out: GfmCase[] = [];
  let section = '';
  let example = 0;

  for (let i = 0; i < lines.length; i++) {
    const heading = /^#{1,6} +(.*)$/.exec(lines[i]);
    if (heading !== null) { section = heading[1].trim(); continue; }
    if (!lines[i].startsWith(OPEN)) continue;

    const extension = lines[i].slice(OPEN.length).trim();
    const startLine = i + 1;
    example++;

    const markdown: string[] = [];
    const html: string[] = [];
    let j = i + 1;
    for (; j < lines.length && lines[j] !== '.'; j++) markdown.push(lines[j]);
    for (j++; j < lines.length && !lines[j].startsWith(FENCE); j++) html.push(lines[j]);
    i = j;

    out.push({ markdown: body(markdown), html: body(html), example, section, extension, startLine });
  }

  cached = out;
  return out;
}

/** The examples GitHub tagged with an extension name — the only ones we run. */
export function gfmExtensionCases(): GfmCase[] {
  return loadGfmExamples().filter((c) => c.extension !== '');
}
