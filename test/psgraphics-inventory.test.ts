import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runGraphics } from './helpers/ps-graphics.js';
import { PsInterpreter } from '../src/psvm.js';
import { installPsGraphics } from '../src/psgraphics.js';
import { Document } from '../src/document.js';
import { appendPsPages } from '../src/pspdf.js';
const programs = [
  'gsave grestore gsave grestoreall initgraphics gstate dup currentgstate dup gstate copy pop setgstate',
  'matrix dup identmatrix pop dup defaultmatrix pop currentmatrix setmatrix initmatrix 2 3 translate 2 2 scale 30 rotate matrix concat',
  'matrix matrix matrix concatmatrix pop matrix matrix invertmatrix pop 1 2 transform pop pop 1 2 itransform pop pop 1 2 dtransform pop pop 1 2 idtransform pop pop',
  'newpath 1 2 moveto currentpoint pop pop 3 4 lineto 1 2 rmoveto 2 3 rlineto 1 2 3 4 5 6 curveto 1 2 3 4 5 6 rcurveto closepath',
  '0 0 10 0 90 arc 0 0 10 90 0 arcn 0 0 moveto 10 0 10 10 2 arct 10 10 0 10 2 arcto pop pop pop pop flattenpath reversepath pathbbox pop pop pop pop',
  '0 0 moveto 2 2 lineto 0 0 10 10 setbbox {pop pop} {pop pop} {pop pop pop pop pop pop} {} pathforall strokepath',
  '{ucache 0 0 10 10 setbbox 0 0 moveto 5 5 lineto} uappend false upath pop {0 0 10 10 setbbox 0 0 moveto 5 5 lineto} ustrokepath',
  '0 0 10 10 rectclip clipsave 0 0 moveto 10 0 lineto 10 10 lineto closepath clip eoclip cliprestore clippath initclip',
  '0 0 1 1 rectfill 0 0 1 1 rectstroke 0 0 moveto 1 1 lineto stroke 0 0 1 1 rectclip fill eofill',
  '{0 0 10 10 setbbox 0 0 moveto 5 5 lineto} ufill {0 0 10 10 setbbox 0 0 moveto 5 5 lineto} ueofill {0 0 10 10 setbbox 0 0 moveto 5 5 lineto} ustroke',
  '1 setlinewidth currentlinewidth pop 1 setlinecap currentlinecap pop 1 setlinejoin currentlinejoin pop 2 setmiterlimit currentmiterlimit pop [1 2] 0 setdash currentdash pop pop',
  '1 setflat currentflat pop true setstrokeadjust currentstrokeadjust pop true setoverprint currentoverprint pop',
  '0 setgray currentgray pop 1 0 0 setrgbcolor currentrgbcolor pop pop pop 0 1 1 sethsbcolor currenthsbcolor pop pop pop 0 0 0 1 setcmykcolor currentcmykcolor pop pop pop pop',
  '/DeviceGray setcolorspace currentcolorspace pop 0.5 setcolor currentcolor pop',
  '1 1 8 [1 0 0 -1 0 1] <80> image 1 1 true [1 0 0 -1 0 1] <80> imagemask 1 1 8 [1 0 0 -1 0 1] <ff0000> false 3 colorimage',
  '<< /FormType 1 /BBox [0 0 1 1] /Matrix [1 0 0 1 0 0] /PaintProc { pop 0 0 1 1 rectfill } >> execform',
  '<< /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 1 1] /XStep 2 /YStep 2 /PaintProc { pop 0 setgray 0 0 1 1 rectfill } >> matrix makepattern setpattern 0 0 10 10 rectfill',
  'currentfile bytesavailable pop currentfile fileposition pop (41>) /ASCIIHexDecode filter dup read pop pop closefile',
  'currentfile 1 string readstring A pop pop currentfile 1 string readhexstring 42 pop pop currentfile 10 string readline AB\n pop pop',
  'currentpagedevice pop << /PageSize [20 20] >> setpagedevice 0 0 1 1 rectfill copypage erasepage showpage gsave nulldevice grestore',
];
describe('approved PostScript graphics inventory', () => {
  it('saves and reopens the provenance-recorded composite fixture', () => {
    const vm = new PsInterpreter(); const graphics = installPsGraphics(vm);
    vm.run(readFileSync(new URL('./fixtures/postscript-graphics/composite.ps', import.meta.url)));
    const doc = Document.New(); appendPsPages(doc, graphics.finish());
    const reopened = Document.Open(doc.Save());
    expect(reopened.Pages).toHaveLength(1);
    expect(reopened.Pages[0]!.Images).toHaveLength(1);
  });
  it.each(programs)('executes %s', source => { expect(() => runGraphics(source)).not.toThrow(); });
  it('exercises every approved operator through source and exposes systemdict probes', () => {
    const spec = readFileSync(new URL('../docs/superpowers/specs/2026-11-18-postscript-graphics-design.md', import.meta.url), 'utf8');
    const section = spec.slice(spec.indexOf('- State and matrices.'), spec.indexOf('User paths include'));
    const names = [...section.matchAll(/`([a-z]+)`/g)].map(match => match[1]!);
    const words = new Set(programs.join(' ').split(/[^a-z]+/));
    expect(names.filter(name => !words.has(name))).toEqual([]);
    const { vm } = runGraphics(names.map(name => `systemdict /${name} known`).join(' '));
    expect(vm.stack.every(value => value.kind === 'boolean' && value.value)).toBe(true);
  });
  it('rejects duplicate installation before altering the active session', () => {
    const vm = new PsInterpreter(); const graphics = installPsGraphics(vm);
    const before = vm.lookup('moveto');
    expect(() => installPsGraphics(vm)).toThrow(/invalidaccess/);
    expect(vm.lookup('moveto')).toBe(before);
    vm.run(new TextEncoder().encode('0 0 1 1 rectfill showpage'));
    expect(graphics.finish()).toHaveLength(1);
  });
});
