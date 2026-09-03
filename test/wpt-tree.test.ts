import { describe, it, expect } from 'vitest';
import { casesInBucket, serializeTree, serializeFragment } from './helpers/wpt-tree.js';
import { parseHtml, parseHtmlFragment } from '../src/htmltree.js';

describe('WPT tree construction', () => {
  // There is no allowlist: every in-scope case runs. The bucket counts are
  // asserted in test/wpt-tree-suite.test.ts, so a case cannot be reclassified
  // to dodge a failure. A case with a #document-fragment context is a FRAGMENT
  // parse and serializes with no document wrapper.
  for (const c of casesInBucket('inScope')) {
    it(`${c.file}#${c.index}: ${JSON.stringify(c.data).slice(0, 60)}`, () => {
      const got = c.fragmentContext === undefined
        ? serializeTree(parseHtml(c.data))
        : serializeFragment(parseHtmlFragment(c.data, c.fragmentContext));
      expect(got).toBe(c.document);
    });
  }
});
