// The options TOCOptions inherits from TextBlockOptions but does not control
// itself (issue 1gg0.14). rowStampOptions/rowBlockOptions copy a hardcoded field
// list, so anything the Omit promises and the copies forget is silently dropped.
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';
import type { Page } from '../src/page.js';
import type { TOCEntry, TOCOptions } from '../src/toc.js';

const decoded = (page: Page) => new TextDecoder('latin1').decode(page.Contents);

// buildStampTarget's page is 300x200 and already shows "Original".
const RECT: [number, number, number, number] = [10, 20, 250, 150];
const ENTRIES: TOCEntry[] = [{ title: 'Intro', page: 1 }];

function stampTargetTOC(opts?: TOCOptions): Page {
  const page = Document.Open(buildStampTarget()).Pages[0];
  page.AddTOC(ENTRIES, RECT, opts);
  return page;
}

describe('TOC honours the inherited behind option', () => {
  it('sinks its rows beneath existing content', () => {
    const c = decoded(stampTargetTOC({ behind: true }));
    expect(c.indexOf('Intro')).toBeLessThan(c.indexOf('Original'));
  });

  it('defaults to drawing on top', () => {
    const c = decoded(stampTargetTOC());
    expect(c.indexOf('Intro')).toBeGreaterThan(c.indexOf('Original'));
  });

  it('rejects a non-boolean behind before painting anything', () => {
    const page = Document.Open(buildStampTarget()).Pages[0];
    const before = decoded(page);
    expect(() => page.AddTOC(ENTRIES, RECT, { behind: 'yes' as unknown as boolean }))
      .toThrow(TypeError);
    expect(decoded(page)).toBe(before);
  });
});

describe('TOCOptions hides the internal artifact flag', () => {
  it('does not accept artifact', () => {
    // A TOC decides artifact-ness itself (the dot leader is marked one), and a
    // caller-supplied artifact would collide with `tagged` only in
    // validateMarking — after earlier rows had been painted.
    // @ts-expect-error artifact is @internal on StampOptions
    const opts: TOCOptions = { artifact: true };
    expect(opts).toBeDefined();
  });
});
