import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as {
  engines?: { node?: string };
};
const readme = readFileSync(`${root}README.md`, 'utf8');

describe('package metadata', () => {
  it('declares a Node engine floor', () => {
    expect(pkg.engines?.node).toBeDefined();
  });

  it('declares the same floor the README states', () => {
    // `ul19` was exactly this drift: the README named a version and the
    // manifest named none, so an installer had nothing to check against. The
    // two are stated in different files by different kinds of author, so
    // nothing but a test keeps them in step.
    //
    // What is pinned is the NUMBER, not the spelling. The pattern accepts
    // `≥ 22`, `>= 22` and `22 or later` because the README has been written
    // all three ways — replacing it with the GitHub-facing rewrite moved it
    // from the first to the third and turned this red, which is the drift
    // working as intended rather than a reason to narrow the prose.
    const declared = /(\d+)/.exec(pkg.engines?.node ?? '')?.[1];
    const m = /Node\.js\s*(?:≥|>=)\s*(\d+)|Node\.js\s+(\d+)\s+or later/.exec(readme);
    const documented = m?.[1] ?? m?.[2];
    expect(documented).toBeDefined();      // the README claim still parses
    expect(declared).toBe(documented);
  });
});
