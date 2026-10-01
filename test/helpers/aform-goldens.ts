// test/helpers/aform-goldens.ts
import { readFileSync } from 'node:fs';

const dir = new URL('../fixtures/aform/', import.meta.url);

/** One golden file from test/fixtures/aform/, generated from pinned pdf.js. */
export function loadGolden<T>(name: string): T[] {
  return JSON.parse(readFileSync(new URL(`${name}.json`, dir), 'utf8')) as T[];
}

export const goldenMeta = JSON.parse(readFileSync(new URL('meta.json', dir), 'utf8')) as {
  sha: string;
  sources: Record<string, string>;
  counts: Record<string, number>;
  strictFalse: Record<string, number>;
};
