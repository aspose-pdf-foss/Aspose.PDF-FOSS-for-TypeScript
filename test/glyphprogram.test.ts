import { describe, it, expect } from 'vitest';
import { loadEmbeddedProgram, gidForProgram, programAdvance } from '../src/glyphprogram.js';
import { PdfDict, PdfObject, PdfStream } from '../src/types.js';
import { buildMinimalTtf, buildHead } from './helpers/build-sfnt.js';
import { buildWidthCff, buildNameKeyedCff } from './helpers/build-cff.js';
import { buildType1, t1num, t1cs } from './helpers/build-type1.js';

const id = (o: PdfObject | undefined): PdfObject => (o ?? null) as PdfObject;
const inflate = (s: { raw: Uint8Array }) => s.raw;
const dict = (entries: Record<string, PdfObject>): PdfDict => new Map(Object.entries(entries));
const stream = (raw: Uint8Array): PdfStream => ({ kind: 'stream', dict: new Map(), raw });

describe('loadEmbeddedProgram', () => {
  it('loads a TrueType program from /FontFile2', () => {
    const p = loadEmbeddedProgram(dict({ FontFile2: stream(buildMinimalTtf()) }), id, inflate);
    expect(p.sfnt).toBeDefined();
    expect(p.cff).toBeUndefined();
    expect(p.type1).toBeUndefined();
  });

  it('loads a bare CFF program from /FontFile3', () => {
    const p = loadEmbeddedProgram(dict({ FontFile3: stream(buildWidthCff()) }), id, inflate);
    expect(p.cff).toBeDefined();
    expect(p.sfnt).toBeUndefined();
  });

  it('loads a Type 1 program from /FontFile', () => {
    const prog = buildType1({ charstrings: { '.notdef': t1cs(14), A: t1cs(t1num(0), t1num(600), 13, 14) } });
    const p = loadEmbeddedProgram(dict({ FontFile: stream(prog) }), id, inflate);
    expect(p.type1).toBeDefined();
  });

  it('returns nothing for a descriptor with no program, and never throws', () => {
    expect(loadEmbeddedProgram(dict({}), id, inflate)).toEqual({});
    expect(loadEmbeddedProgram(undefined, id, inflate)).toEqual({});
    // A corrupt program is a broken font, not a broken document.
    expect(loadEmbeddedProgram(
      dict({ FontFile2: stream(Uint8Array.from([1, 2, 3, 4])) }), id, inflate,
    )).toEqual({});
  });
});

describe('programAdvance — normalisation to 1/1000 em', () => {
  it('divides out a TrueType unitsPerEm of 2048', () => {
    // buildHmtx gives gid1 an advance of 600 font units. At 2048/em that is
    // 600 * 1000 / 2048 = 292.97 em-thousandths. Skipping the division reports
    // 600, which is 2.048x too wide — and looks entirely plausible.
    const ttf = buildMinimalTtf({ head: buildHead(2048) });
    const p = loadEmbeddedProgram(dict({ FontFile2: stream(ttf) }), id, inflate);
    expect(programAdvance(p, 1)).toBeCloseTo(292.969, 2);
  });

  it('leaves a 1000/em TrueType alone', () => {
    const p = loadEmbeddedProgram(dict({ FontFile2: stream(buildMinimalTtf()) }), id, inflate);
    expect(programAdvance(p, 1)).toBeCloseTo(600, 6);
  });

  it('reports CFF charstring widths', () => {
    const p = loadEmbeddedProgram(dict({ FontFile3: stream(buildWidthCff()) }), id, inflate);
    expect(programAdvance(p, 0)).toBeCloseTo(250, 6);
    expect(programAdvance(p, 1)).toBeCloseTo(500, 6);
  });

  it('reports Type 1 hsbw widths', () => {
    const prog = buildType1({
      charstrings: {
        '.notdef': t1cs(t1num(0), t1num(300), 13, 14),
        A: t1cs(t1num(0), t1num(742), 13, 14),
      },
    });
    const p = loadEmbeddedProgram(dict({ FontFile: stream(prog) }), id, inflate);
    expect(programAdvance(p, p.type1!.gidForName('A')!)).toBeCloseTo(742, 6);
  });

  it('answers undefined with no program at all', () => {
    expect(programAdvance({}, 0)).toBeUndefined();
  });
});

describe('gidForProgram', () => {
  it('routes a TrueType through its cmap, by Unicode then by code', () => {
    const p = loadEmbeddedProgram(dict({ FontFile2: stream(buildMinimalTtf()) }), id, inflate);
    expect(gidForProgram(p, 0x41, 'A', undefined)).toBe(1);
    expect(gidForProgram(p, 0x42, '', undefined)).toBe(2);
    expect(gidForProgram(p, 0x5a, 'Z', undefined)).toBeUndefined();
  });

  it('routes a Type 1 program by glyph name, and answers undefined for a name it lacks', () => {
    const prog = buildType1({
      charstrings: { '.notdef': t1cs(14), A: t1cs(t1num(0), t1num(600), 13, 14) },
    });
    const p = loadEmbeddedProgram(dict({ FontFile: stream(prog) }), id, inflate);
    const nameFor = (c: number) => (c === 0x41 ? 'A' : 'nosuchglyph');
    expect(gidForProgram(p, 0x41, 'A', nameFor)).toBe(p.type1!.gidForName('A'));
    // No substitute exists for a Type 1 name the program does not define.
    expect(gidForProgram(p, 0x42, 'B', nameFor)).toBeUndefined();
  });

  it('routes a name-keyed CFF through its charset', () => {
    const p = loadEmbeddedProgram(dict({ FontFile3: stream(buildNameKeyedCff()) }), id, inflate);
    const names = p.cff!.charsetNames();
    const target = names[1]!;
    expect(gidForProgram(p, 0x41, 'A', () => target)).toBe(1);
  });
});
