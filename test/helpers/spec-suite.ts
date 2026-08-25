import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** One example from the official CommonMark suite. */
export interface SpecCase {
  markdown: string;
  html: string;
  example: number;
  section: string;
  startLine: number;
}

interface RawCase {
  markdown: string; html: string; example: number; section: string; start_line: number;
}

const SPEC_URL = new URL('../fixtures/commonmark/spec.json', import.meta.url);

let cached: SpecCase[] | undefined;

/** All 652 cases, in spec order. */
export function loadSpecCases(): SpecCase[] {
  if (cached === undefined) {
    const raw: RawCase[] = JSON.parse(readFileSync(fileURLToPath(SPEC_URL), 'utf8'));
    cached = raw.map((c) => ({
      markdown: c.markdown, html: c.html, example: c.example,
      section: c.section, startLine: c.start_line,
    }));
  }
  return cached;
}

/** The cases belonging to the named sections. Throws if a name matches nothing,
 *  so a typo in a section gate fails loudly instead of vacuously passing. */
export function casesInSections(...sections: string[]): SpecCase[] {
  const all = loadSpecCases();
  const want = new Set(sections);
  for (const s of sections) {
    if (!all.some((c) => c.section === s)) throw new Error(`no spec section named ${JSON.stringify(s)}`);
  }
  return all.filter((c) => want.has(c.section));
}
