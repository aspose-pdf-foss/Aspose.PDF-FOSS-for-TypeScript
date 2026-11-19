import { describe, it, expect } from 'vitest';
import { framePostScript } from '../src/eps.js';
import { PsBudget } from '../src/psbudget.js';
import { LoadLimits } from '../src/loadlimits.js';
import { PdfParseError, UnsupportedFeatureError } from '../src/errors.js';
import { epsSource, dosEps } from './helpers/build-eps.js';
import { psBytes, joinPs } from './helpers/ps-font-program.js';
const frame = (b: Uint8Array, mode: 'auto' | 'ps' | 'eps' = 'auto') => framePostScript(b, mode, new PsBudget());
describe('PS/EPS byte framing', () => {
  it('does not let a MacBinary signature inside a DOS preview change framing', () => {
    const code = psBytes('%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 1 1\n');
    const wrapped = dosEps(code, new Uint8Array(256)); wrapped.set(psBytes('mBIN'), 102);
    expect(frame(wrapped).source).toEqual(code);
  });
  it.each(['1.0', '2.0', '3.0'])('identifies EPSF %s at the first line', version => {
    expect(frame(psBytes(`%!PS-Adobe-3.0 EPSF-${version}\n`)).kind).toBe('eps');
  });
  it.each(['', '1 2 add', '%!PS-Adobe-3.0\nshowpage', '%!PS\n% EPSF-3.0'])('keeps ordinary/headerless PS: %j', s => {
    expect(frame(psBytes(s)).kind).toBe('ps');
  });
  it('does not search prefixes or later lines for an EPS header', () => { expect(frame(joinPs(psBytes(' \n'), epsSource())).kind).toBe('ps'); });
  it.each(['tiff', 'wmf'] as const)('extracts exactly the declared code, skipping %s previews', kind => {
    const code = epsSource('1 2 add'), wrapped = dosEps(code, psBytes('quit undefinedName'), kind), found = frame(wrapped);
    expect(found.kind).toBe('eps'); expect(found.source).toEqual(code); expect(found.source.buffer).toBe(wrapped.buffer);
  });
  it.each([['ps', epsSource()], ['ps', dosEps(epsSource())], ['eps', psBytes('%!PS\nshowpage')]] as const)('rejects explicit %s contradictions', (mode, b) => { expect(() => frame(b, mode)).toThrow(PdfParseError); });
  it.each([[4,0], [4,29], [4,0x80000000], [4,0xffffffff], [8,0], [8,0xffffffff], [20,1], [20,31], [24,0xffffffff]])('rejects malformed span field %i=%i', (at, value) => {
    const b = dosEps(epsSource(), psBytes('preview')); new DataView(b.buffer).setUint32(at, value, true); expect(() => frame(b)).toThrow(PdfParseError);
  });
  it.each([4,12,29])('rejects a truncated %i-byte binary header', n => { expect(() => frame(dosEps(epsSource()).slice(0,n))).toThrow(PdfParseError); });
  it('allows unused bytes beyond a shortened opaque preview', () => { const b=dosEps(epsSource(),psBytes('preview')); new DataView(b.buffer).setUint32(24,1,true); expect(frame(b).kind).toBe('eps'); });
  it('validates both declared previews and overlap', () => {
    const b = dosEps(epsSource(), psBytes('preview')), v = new DataView(b.buffer); v.setUint32(12, v.getUint32(20,true),true); v.setUint32(16,7,true);
    expect(() => frame(b)).toThrow(PdfParseError);
  });
  it('checks a non-sentinel byte-XOR checksum', () => {
    const b = dosEps(epsSource()), v = new DataView(b.buffer); let checksum=0; for(let i=0;i<28;i++) checksum ^= b[i]!;
    v.setUint16(28,checksum,true); expect(frame(b).kind).toBe('eps'); b[29] ^= 1; expect(() => frame(b)).toThrow(PdfParseError);
  });
  it('requires EPS identity inside a DOS wrapper', () => { expect(() => frame(dosEps(psBytes('1 2 add')))).toThrow(PdfParseError); });
  it.each([0x00051600,0x00051607])('refuses Macintosh envelope %i', magic => { const b=new Uint8Array(128); new DataView(b.buffer).setUint32(0,magic); expect(() => frame(b)).toThrow(UnsupportedFeatureError); });
  it('refuses a recognized full MacBinary header', () => {
    const b = new Uint8Array(128); b[1] = 5; b.set(psBytes('a.eps'), 2); b.set(psBytes('mBIN'), 102); b[122] = 130; b[123] = 129;
    expect(() => frame(b)).toThrow(UnsupportedFeatureError);
  });
  it.each(['%!PS-Adobe-3.0\n', '%!PS-Adobe-3.0 EPSF-3.0\n'])('keeps ASCII source with mBIN at byte 102: %j', header => {
    const prefix = header + '%%BoundingBox: 0 0 1 1\n%';
    const source = psBytes(prefix + 'x'.repeat(102 - prefix.length) + 'mBIN\n');
    expect(frame(source).source).toEqual(source);
  });
  it('charges original wrapper bytes before extracting a short source', () => {
    const b=dosEps(epsSource(),new Uint8Array(100)); expect(() => framePostScript(b,'auto',new PsBudget(LoadLimits.defaults.with({maxFileBytes:50})))).toThrowError(expect.objectContaining({limit:'maxFileBytes', reached:b.length, allowed:50}));
  });
  it('meters detection work', () => { expect(() => framePostScript(epsSource(),'auto',new PsBudget(LoadLimits.defaults.with({maxPostScriptOperations:1})))).toThrowError(expect.objectContaining({limit:'maxPostScriptOperations'})); });
});
