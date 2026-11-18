import { describe, expect, it } from 'vitest';
import { PsInterpreter } from '../src/psvm.js';
import { installPsGraphics } from '../src/psgraphics.js';
import { compilePsProgram, quadraticPsPath, standardPsEncoding, standardPsProgram, standardPsWidth, suppliedPsProgram } from '../src/psfontprogram.js';
import { integer, name, type PsDictionary, type PsValue } from '../src/psvalue.js';
import { buildType1, t1cs, t1num } from './helpers/build-type1.js';
import { buildInkTtf, buildMinimalTtf } from './helpers/build-sfnt.js';
import { IDENTITY } from '../src/text.js';
import { UnsupportedFeatureError } from '../src/errors.js';

function setup() { const vm = new PsInterpreter(); const graphics = installPsGraphics(vm); return { vm, graphics }; }
function type1MetricsFixture(vm: PsInterpreter, metrics?: PsValue): PsDictionary {
  const dict = vm.memory.dictionary(), priv = vm.memory.dictionary(), chars = vm.memory.dictionary();
  vm.memory.put(dict, name('FontType'), integer(1));
  vm.memory.put(priv, name('lenIV'), integer(-1));
  vm.memory.put(chars, name('A'), vm.memory.string(t1cs(t1num(5), t1num(500), 13, t1num(0), t1num(0), 21, t1num(100), t1num(0), 5, 14)));
  vm.memory.put(dict, name('Private'), priv); vm.memory.put(dict, name('CharStrings'), chars);
  if (metrics) { const map = vm.memory.dictionary(); vm.memory.put(map, name('A'), metrics); vm.memory.put(dict, name('Metrics'), map); }
  return dict;
}
describe('PostScript font program snapshots', () => {
  it('compiles plaintext Type 1 and shifts outlines for four-number Metrics', () => {
    const { vm, graphics } = setup();
    const dict = type1MetricsFixture(vm, vm.memory.arrayFrom([10, 20, 600, 30].map(integer)));
    const glyph = compilePsProgram(vm, dict, graphics.decode).glyph('A');
    expect(glyph.advance).toEqual([600, 30]); expect(glyph.sidebearing).toEqual([10, 20]);
    expect(glyph.path.segments[0]).toEqual({ op: 'M', x: 10, y: 20 }); expect(glyph.unicode).toBe('A');
  });
  it.each([['number', 650, [650, 0], [5, 0]], ['pair', [15, 700], [700, 0], [15, 0]]] as const)
    ('accepts %s Metrics form', (_, value, advance, sidebearing) => {
      const { vm, graphics } = setup();
      const glyph = compilePsProgram(vm, type1MetricsFixture(vm, typeof value === 'number' ? integer(value) : vm.memory.arrayFrom(value.map(integer))), graphics.decode).glyph('A');
      expect(glyph.advance).toEqual(advance); expect(glyph.sidebearing).toEqual(sidebearing);
    });
  it('reads protected Private and CharStrings internally without weakening source access', () => {
    const { vm, graphics } = setup(), dict = type1MetricsFixture(vm);
    const priv = vm.memory.get(dict, name('Private')) as PsDictionary, chars = vm.memory.get(dict, name('CharStrings')) as PsDictionary;
    vm.memory.restrictAccess(priv, 'noaccess'); vm.memory.restrictAccess(chars, 'noaccess');
    expect(compilePsProgram(vm, dict, graphics.decode).glyph('A').advance).toEqual([500, 0]);
    expect(() => vm.memory.entries(priv)).toThrow(/invalidaccess/);
  });
  it('falls back by name to an empty .notdef without inventing Unicode', () => {
    const { vm, graphics } = setup(); const glyph = compilePsProgram(vm, type1MetricsFixture(vm), graphics.decode).glyph('missing');
    expect(glyph.name).toBe('.notdef'); expect(glyph.path.segments).toEqual([]); expect(glyph.unicode).toBeUndefined();
  });
  it.each(['CDevProc', 'GlyphDirectory', 'BuildGlyph', 'BuildChar'])('rejects unsupported %s', key => {
    const { vm, graphics } = setup(), dict = type1MetricsFixture(vm); vm.memory.put(dict, name(key), vm.memory.array(0, true));
    expect(() => compilePsProgram(vm, dict, graphics.decode)).toThrow(UnsupportedFeatureError);
  });
  it('rejects unsupported OtherSubrs without silently producing an empty glyph', () => {
    const { vm, graphics } = setup(), dict = type1MetricsFixture(vm), chars = vm.memory.get(dict, name('CharStrings')) as PsDictionary;
    vm.memory.put(chars, name('A'), vm.memory.string(t1cs(t1num(0), t1num(9), 12, 16, 14)));
    expect(() => compilePsProgram(vm, dict, graphics.decode).glyph('A')).toThrow(UnsupportedFeatureError);
  });
  it('rejects malformed supplied fonts with invalidfont', () => {
    const { vm, graphics } = setup(); expect(() => suppliedPsProgram(vm, new Uint8Array([1, 2]), graphics.decode)).toThrow(/invalidfont/);
  });
  it('converts quadratics to exact cubics', () => {
    const { vm } = setup();
    const path = quadraticPsPath([[{ x: 0, y: 0, on: true }, { x: 3, y: 6, on: false }, { x: 6, y: 0, on: true }]], IDENTITY, vm.budget);
    expect(path.segments[1]).toEqual({ op: 'C', x1: 2, y1: 4, x2: 4, y2: 4, x: 6, y: 0 });
    expect(path.segments.at(-1)).toEqual({ op: 'Z' });
  });
  it('normalizes off-curve starts and implied on-curve midpoints', () => {
    const { vm } = setup();
    const path = quadraticPsPath([[{ x: 0, y: 2, on: false }, { x: 2, y: 2, on: false }]], IDENTITY, vm.budget);
    expect(path.segments[0]).toEqual({ op: 'M', x: 1, y: 2 });
    expect(path.segments.filter(segment => segment.op === 'C')).toHaveLength(2);
  });
  it('uses original AFM glyph names and advances for Standard 14 programs', () => {
    const { vm, graphics } = setup();
    expect(standardPsEncoding('Helvetica')[39]).toBe('quoteright');
    expect(standardPsWidth('Helvetica', 'A')).toBe(667);
    expect(standardPsWidth('Courier', 'fi')).toBe(600);
    const glyph = standardPsProgram(vm, 'Helvetica', graphics.decode).glyph('A');
    expect(glyph.advance).toEqual([667, 0]); expect(glyph.path.segments.length).toBeGreaterThan(0);
  });
  it('uses explicit Type 42 name-to-GID mapping and strips odd sfnts compatibility bytes', () => {
    const { vm, graphics } = setup(), dict = vm.memory.dictionary(), chars = vm.memory.dictionary(), bytes = buildMinimalTtf();
    // gid zero is genuinely empty; cmap A selects malformed gid one instead.
    vm.memory.put(dict, name('FontType'), integer(42)); vm.memory.put(chars, name('A'), integer(0));
    vm.memory.put(dict, name('CharStrings'), chars);
    const padded = new Uint8Array(101); padded.set(bytes.subarray(0, 100)); padded[100] = 255;
    const chunks = [padded, bytes.subarray(100)];
    vm.memory.put(dict, name('sfnts'), vm.memory.arrayFrom(chunks.map(chunk => vm.memory.string(chunk))));
    const glyph = compilePsProgram(vm, dict, graphics.decode).glyph('A');
    expect(glyph.path.segments).toEqual([]); expect(glyph.advance).toEqual([0.5, 0]);
  });
  it('preserves supplied Type 1 sidebearings and bounds cached-glyph work', () => {
    const { vm, graphics } = setup();
    const program = suppliedPsProgram(vm, buildType1({ charstrings: { A: t1cs(t1num(15), t1num(550), 13, 14) } }), graphics.decode);
    expect(program.glyph('A').sidebearing).toEqual([15, 0]);
    const left = vm.budget.remainingOperations; program.glyph('A');
    expect(vm.budget.remainingOperations).toBeLessThan(left);
  });
  it('uses Symbol and Dingbats built-in glyph identities and AFM widths', () => {
    expect(standardPsEncoding('Symbol')[65]).toBe('Alpha');
    expect(standardPsEncoding('ZapfDingbats')[35]).toBe('a202');
    expect(standardPsWidth('Symbol', 'Alpha')).toBe(722);
    expect(standardPsWidth('ZapfDingbats', 'a202')).toBe(974);
  });
  it('keeps AFM widths for StandardEncoding glyphs absent from WinAnsi', () => {
    expect(standardPsWidth('Helvetica', 'Lslash')).toBe(556);
    expect(standardPsWidth('Times-Italic', 'lslash')).toBe(278);
  });
  it.each([0, 4])('decrypts dictionary charstrings with lenIV %i and shares the decode total', lenIV => {
    const { vm, graphics } = setup(), dict = type1MetricsFixture(vm);
    const chars = vm.memory.get(dict, name('CharStrings')) as PsDictionary;
    const priv = vm.memory.get(dict, name('Private')) as PsDictionary;
    const plain = t1cs(t1num(10), t1num(20), t1num(500), t1num(30), 12, 7, 14);
    const cipher = new Uint8Array(plain.length + lenIV); let r = 4330;
    for (let i = 0; i < cipher.length; i++) { const c = (i < lenIV ? 0 : plain[i - lenIV]!) ^ (r >> 8); cipher[i] = c; r = ((c + r) * 52845 + 22719) & 65535; }
    vm.memory.put(priv, name('lenIV'), integer(lenIV)); vm.memory.put(chars, name('A'), vm.memory.string(cipher));
    const glyph = compilePsProgram(vm, dict, graphics.decode).glyph('A');
    expect(glyph.advance).toEqual([500, 30]); expect(glyph.sidebearing).toEqual([10, 20]);
    expect(graphics.decode.decoded).toBe(plain.length);
  });
  it('normalizes the named Type 42 outline rather than following its cmap', () => {
    const { vm, graphics } = setup(), dict = vm.memory.dictionary(), chars = vm.memory.dictionary();
    vm.memory.put(dict, name('FontType'), integer(42)); vm.memory.put(dict, name('CharStrings'), chars);
    vm.memory.put(chars, name('B'), integer(1));
    vm.memory.put(dict, name('sfnts'), vm.memory.arrayFrom([vm.memory.string(buildInkTtf())]));
    const g = compilePsProgram(vm, dict, graphics.decode).glyph('B');
    expect(g.advance).toEqual([1, 0]); expect(g.path.segments[0]).toEqual({ op: 'M', x: 0.1, y: 0 });
    expect(g.box[0]).toBeCloseTo(0.1); expect(g.box[2]).toBeCloseTo(0.9); expect(g.box[3]).toBeCloseTo(0.7);
  });
  it('strictly composes seac in dictionary fonts', () => {
    const { vm, graphics } = setup(), dict = type1MetricsFixture(vm), chars = vm.memory.get(dict, name('CharStrings')) as PsDictionary;
    vm.memory.put(chars, name('acute'), vm.memory.string(t1cs(t1num(0), t1num(0), 13, t1num(0), t1num(0), 21, 14)));
    vm.memory.put(chars, name('Aacute'), vm.memory.string(t1cs(t1num(5), t1num(500), 13, t1num(0), t1num(30), t1num(100), t1num(65), t1num(194), 12, 6)));
    const g = compilePsProgram(vm, dict, graphics.decode).glyph('Aacute');
    expect(g.path.segments.filter(s => s.op === 'M')).toEqual([{ op: 'M', x: 5, y: 0 }, { op: 'M', x: 35, y: 100 }]);
  });
});
