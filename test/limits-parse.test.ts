import { describe, it, expect, afterEach } from 'vitest';
import { closeSync, ftruncateSync, openSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document } from '../src/document.js';
import { LoadLimits, type LimitField } from '../src/loadlimits.js';
import { ResourceLimitError, PdfParseError } from '../src/errors.js';
import { parseFunction } from '../src/pdffunction.js';
import { decodeObjStm } from '../src/objstm.js';
import { deflateSync } from 'node:zlib';
import { ref, isRef, type PdfDict, type PdfObject } from '../src/types.js';
import {
  buildObjectsPdf, BASE_OBJECTS, prevChainPdf, selfPrevPdf, manyRowsPdf,
  deepArrayPdf, deepDictPdf, wideArrayPdf, wideDictPdf, longStringPdf, longStreamPdf,
  deepPageTreePdf, deepOutlinePdf, deepFieldPdf, deepNameTreePdf, deepFormXObjectPdf,
} from './helpers/build-hostile-pdf.js';

/** Open `buf` under `patch` and return the ResourceLimitError it raised. */
function refusal(buf: Uint8Array, patch: Parameters<LoadLimits['with']>[0]): ResourceLimitError {
  try {
    Document.Open(buf, { limits: LoadLimits.defaults.with(patch) });
  } catch (e) {
    if (e instanceof ResourceLimitError) return e;
    throw e;
  }
  throw new Error('opened without reaching the limit');
}

function expectLimit(e: ResourceLimitError, field: LimitField): void {
  expect(e.limit).toBe(field);
  expect(e).not.toBeInstanceOf(PdfParseError);
}

const small = () => buildObjectsPdf(BASE_OBJECTS);

describe('maxFileBytes', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'ibzo2-')); dirs.push(d); return d; };

  it('refuses a buffer one byte over, and admits one exactly at the bound', () => {
    const buf = small();
    expectLimit(refusal(buf, { maxFileBytes: buf.length - 1 }), 'maxFileBytes');
    expect(Document.Open(buf, { limits: LoadLimits.defaults.with({ maxFileBytes: buf.length }) })
      .Pages.length).toBe(1);
  });

  it('refuses a 2 GiB file from its SIZE, before reading a byte of it', () => {
    // The acceptance input. ftruncate makes it without writing 2 GiB, and the
    // refusal must come from a stat: reading it first is the exhaustion the
    // bound exists to prevent, and readFileSync would throw its own error past
    // 2 GiB anyway — which is not a ResourceLimitError.
    const path = join(tempDir(), 'huge.pdf');
    const fd = openSync(path, 'w');
    ftruncateSync(fd, 2 * 1024 ** 3 + 1);
    closeSync(fd);
    let err: unknown;
    try { Document.OpenFile(path); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ResourceLimitError);
    expectLimit(err as ResourceLimitError, 'maxFileBytes');
  });

  it('applies the caller policy to OpenFile, not only to Open', () => {
    const path = join(tempDir(), 'small.pdf');
    const buf = small();
    writeFileSync(path, buf);
    expect(() => Document.OpenFile(path, { limits: LoadLimits.defaults.with({ maxFileBytes: 10 }) }))
      .toThrow(ResourceLimitError);
    expect(Document.OpenFile(path).Pages.length).toBe(1);
  });

  it('is skipped entirely under unlimited()', () => {
    expect(Document.Open(small(), { limits: LoadLimits.unlimited() }).Pages.length).toBe(1);
  });
});

describe('maxXrefSections', () => {
  it('refuses a /Prev chain one section over, and admits one at the bound', () => {
    const buf = prevChainPdf(5);
    expectLimit(refusal(buf, { maxXrefSections: 4 }), 'maxXrefSections');
    expect(Document.Open(buf, { limits: LoadLimits.defaults.with({ maxXrefSections: 5 }) })
      .Revisions.length).toBe(5);
  });

  it('does NOT fall back to the recovery sweep when the bound is reached', () => {
    // A ResourceLimitError out of readXref must escape Open. Caught as damage,
    // the file is swept and opens anyway — the bound would then refuse nothing.
    expect(() => Document.Open(prevChainPdf(5),
      { limits: LoadLimits.defaults.with({ maxXrefSections: 1 }) })).toThrow(ResourceLimitError);
  });
});

describe('/Prev cycle', () => {
  it('is DAMAGE, not a limit: the file opens through the recovery ladder and says why', () => {
    // A cycle is a broken file rather than a large one, so it is a
    // PdfParseError inside readXref, which Open answers by sweeping. It opened
    // silently before ibzo.2; it still opens, and now reports what it cut.
    const doc = Document.Open(selfPrevPdf());
    expect(doc.Pages.length).toBe(1);
    expect(doc.recovery?.reason).toBe('xref-unparsable');
    expect(doc.recovery?.detail).toMatch(/cycle/);
  });

  it('opens a chain without a cycle with no recovery at all', () => {
    expect(Document.Open(prevChainPdf(3)).recovery).toBeUndefined();
  });
});

describe('maxObjects', () => {
  it('refuses a classic xref producing one row over, and admits one at the bound', () => {
    const buf = manyRowsPdf(20);          // 4 + 20 rows, free head included
    expectLimit(refusal(buf, { maxObjects: 23 }), 'maxObjects');
    expect(Document.Open(buf, { limits: LoadLimits.defaults.with({ maxObjects: 24 }) }).Pages.length).toBe(1);
  });

  it('refuses a 10-million-row xref under the DEFAULTS', () => {
    // The acceptance input: before ibzo.2 this killed the process outright.
    expectLimit(refusal(manyRowsPdf(10_000_000), {}), 'maxObjects');
  }, 120_000);
});

describe('maxNestingDepth (COS grammar)', () => {
  it('refuses an array one level over, and admits one at the bound', () => {
    expectLimit(refusal(deepArrayPdf(11), { maxNestingDepth: 10 }), 'maxNestingDepth');
    expect(Document.Open(deepArrayPdf(10), { limits: LoadLimits.defaults.with({ maxNestingDepth: 10 }) })
      .Pages.length).toBe(1);
  });

  it('counts dictionaries as well as arrays', () => {
    expectLimit(refusal(deepDictPdf(11), { maxNestingDepth: 10 }), 'maxNestingDepth');
  });

  it('refuses a 10,000-deep array under the DEFAULTS rather than reporting damage', () => {
    // The acceptance input. Before ibzo.2 the stack overflowed, the build loop
    // caught the RangeError, and Open threw PdfParseError "could not be parsed"
    // — a hostile file misreported as a broken one.
    expectLimit(refusal(deepArrayPdf(10_000), {}), 'maxNestingDepth');
  });

  it('escapes the build loop per-object catch rather than triggering the sweep', () => {
    // The object is in the xref, so the ordinary build parses it; the limit must
    // escape build's per-object catch rather than trigger the sweep.
    const e = refusal(deepArrayPdf(11), { maxNestingDepth: 10 });
    expect(e.reached).toBe(11);
  });
});

describe('maxContainerItems', () => {
  it('refuses an array one item over, and admits one at the bound', () => {
    expectLimit(refusal(wideArrayPdf(11), { maxContainerItems: 10 }), 'maxContainerItems');
    expect(Document.Open(wideArrayPdf(10), { limits: LoadLimits.defaults.with({ maxContainerItems: 10 }) })
      .Pages.length).toBe(1);
  });

  it('counts a dictionary by its ENTRIES, not by its tokens', () => {
    // A dict of 10 entries is 20 tokens; counting tokens halves the bound.
    expectLimit(refusal(wideDictPdf(11), { maxContainerItems: 10 }), 'maxContainerItems');
    expect(Document.Open(wideDictPdf(10), { limits: LoadLimits.defaults.with({ maxContainerItems: 10 }) })
      .Pages.length).toBe(1);
  });
});

describe('maxObjectBytes', () => {
  it('refuses a stream whose payload is over the bound', () => {
    const e = refusal(longStreamPdf(1000), { maxObjectBytes: 999 });
    expectLimit(e, 'maxObjectBytes');
    expect(Document.Open(longStreamPdf(1000), { limits: LoadLimits.defaults.with({ maxObjectBytes: 1100 }) })
      .Pages.length).toBe(1);
  });

  it('refuses a non-stream object whose encoded span is over the bound', () => {
    expectLimit(refusal(longStringPdf(1000), { maxObjectBytes: 999 }), 'maxObjectBytes');
  });
});

describe('maxNestingDepth (graph walks)', () => {
  // Every object in these files is FLAT, so the COS grammar sees no depth at
  // all: only a walk that follows references can. Before ibzo.2 each of them
  // ended in a raw RangeError, or, for a name tree, in unbounded recursion.
  const under = (n: number) => ({ limits: LoadLimits.defaults.with({ maxNestingDepth: n }) });
  const limitOf = (f: () => unknown): ResourceLimitError => {
    try { f(); } catch (e) { if (e instanceof ResourceLimitError) return e; throw e; }
    throw new Error('walked without reaching the limit');
  };

  it('bounds the page tree, which Open itself walks', () => {
    expectLimit(refusal(deepPageTreePdf(11), { maxNestingDepth: 10 }), 'maxNestingDepth');
    expect(Document.Open(deepPageTreePdf(10), under(10)).Pages.length).toBe(1);
  });

  it('refuses a 20,000-deep page tree under the DEFAULTS instead of overflowing the stack', () => {
    expectLimit(refusal(deepPageTreePdf(20_000), {}), 'maxNestingDepth');
  });

  it('bounds the outline tree', () => {
    expectLimit(limitOf(() => Document.Open(deepOutlinePdf(11), under(10)).GetOutlines()), 'maxNestingDepth');
    expect(Document.Open(deepOutlinePdf(10), under(10)).GetOutlines()).toHaveLength(1);
  });

  it('bounds the form field tree', () => {
    expectLimit(limitOf(() => Document.Open(deepFieldPdf(11), under(10)).Form.Fields), 'maxNestingDepth');
    expect(Document.Open(deepFieldPdf(10), under(10)).Form.Fields).toHaveLength(1);
  });

  it('bounds a name tree', () => {
    expectLimit(limitOf(() => Document.Open(deepNameTreePdf(11), under(10)).GetNamedDestinations()),
      'maxNestingDepth');
    expect(Document.Open(deepNameTreePdf(10), under(10)).GetNamedDestinations()).toHaveLength(1);
  });

  it('treats a name tree that names itself as damage, not as a limit', () => {
    // A cycle is a broken file; it yields what it can — nothing — and does not
    // throw, the rule the page tree's and outline's own cycle guards set.
    expect(Document.Open(deepNameTreePdf(0, true)).GetNamedDestinations()).toEqual([]);
  });

  it('bounds the Form XObject resource graph behind page.Images', () => {
    expectLimit(limitOf(() => Document.Open(deepFormXObjectPdf(10), under(10)).Pages[0].Images), 'maxNestingDepth');
    expect(Document.Open(deepFormXObjectPdf(9), under(10)).Pages[0].Images).toHaveLength(1);
  });
});

describe('maxNestingDepth (functions)', () => {
  // Type 3 stitching nests functions through /Functions; each node is its own
  // object, so the COS grammar sees nothing. parseFunction had NO cycle guard.
  const objs = new Map<number, PdfObject>();
  const R = (o: PdfObject | undefined): PdfObject => (o === undefined ? null : isRef(o) ? objs.get(o.num) ?? null : o);
  const INFLATE = (s: { raw: Uint8Array }) => s.raw;
  const stitch = (child: PdfObject): PdfDict => new Map<string, PdfObject>([
    ['FunctionType', 3], ['Domain', [0, 1]], ['Bounds', []], ['Encode', [0, 1]], ['Functions', [child]],
  ]);
  const leaf: PdfDict = new Map<string, PdfObject>([['FunctionType', 2], ['Domain', [0, 1]], ['C0', [0]], ['C1', [1]], ['N', 1]]);
  /** A chain of `depth` functions, each stitching the next, object 1 on top. */
  const chain = (depth: number): PdfObject => {
    objs.clear();
    for (let i = 1; i < depth; i++) objs.set(i, stitch(ref(i + 1)));
    objs.set(depth, leaf);
    return ref(1);
  };

  it('refuses a chain one level over, and admits one at the bound', () => {
    let err: unknown;
    try { parseFunction(chain(11), R, INFLATE, LoadLimits.defaults.with({ maxNestingDepth: 10 })); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ResourceLimitError);
    expectLimit(err as ResourceLimitError, 'maxNestingDepth');
    expect(parseFunction(chain(10), R, INFLATE, LoadLimits.defaults.with({ maxNestingDepth: 10 }))([0.5]))
      .toEqual([0.5]);
  });

  it('treats a function that stitches itself as damage and evaluates to the fallback', () => {
    // A cycle is a broken file, not a large one: no throw, and the cyclic
    // member contributes the constant a missing function already does.
    objs.clear();
    objs.set(1, stitch(ref(1)));
    expect(parseFunction(ref(1), R, INFLATE)([0.5])).toEqual([0]);
  });
});

describe('maxObjects beyond the xref', () => {
  it('counts an object stream header pair by pair, which /N does not bound', () => {
    // /N may claim 2^31: the header loop stops at the first non-pair token, not
    // at /N, so the pairs actually present are what must be counted.
    const header = Array.from({ length: 12 }, (_, i) => `${i + 10} 0`).join(' ');
    const body = Array.from({ length: 12 }, () => '1').join(' ');
    const payload = new TextEncoder().encode(`${header} ${body}`);
    const s = { kind: 'stream' as const, raw: new Uint8Array(deflateSync(payload)),
      dict: new Map<string, PdfObject>([['Type', { kind: 'name', name: 'ObjStm' }], ['N', 2147483647],
        ['First', header.length + 1], ['Filter', { kind: 'name', name: 'FlateDecode' }]]) };
    let err: unknown;
    try { decodeObjStm(s, 99, LoadLimits.defaults.with({ maxObjects: 11 })); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ResourceLimitError);
    expectLimit(err as ResourceLimitError, 'maxObjects');
  });

  it('bounds the recovery sweep, the ladder\'s fourth refusal', () => {
    // A lost startxref sends Open to sweepObjects, which reads every `N G obj`
    // header in the file without any xref at all. Four headers here.
    const good = buildObjectsPdf([...BASE_OBJECTS, '<< >>']);
    const text = new TextDecoder('latin1').decode(good);
    const broken = new TextEncoder().encode(text.replace(/startxref\n\d+/, 'startxref\n999999'));
    expect(Document.Open(broken).recovery).toBeDefined();
    expectLimit(refusal(broken, { maxObjects: 3 }), 'maxObjects');
    expect(Document.Open(broken, { limits: LoadLimits.defaults.with({ maxObjects: 4 }) }).Pages.length).toBe(1);
  });
});

describe('a bound reached inside an object stream', () => {
  it('escapes decodeObjStm rather than being reported as a lost object', () => {
    // decodeObjStm parses each object in its own try so damage costs only that
    // object. A bound reached there is not damage: swallowed, the object is
    // listed in RecoveryReport.objectStreams as lost, and — because an
    // undecodable container never triggers the sweep — the document OPENS
    // with the hostile object quietly gone and nothing refused.
    const doc = Document.New();
    let nested: PdfObject = [];
    for (let i = 0; i < 10; i++) nested = [nested];   // 11 levels
    doc.catalog().set('Deep', doc.allocObject(nested));
    const bytes = doc.Save({ compressed: true });
    expect(new TextDecoder('latin1').decode(bytes)).toContain('/ObjStm');
    expectLimit(refusal(bytes, { maxNestingDepth: 10 }), 'maxNestingDepth');
    expect(Document.Open(bytes, { limits: LoadLimits.defaults.with({ maxNestingDepth: 11 }) }).recovery)
      .toBeUndefined();
  });
});
