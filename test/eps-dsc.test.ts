import { describe, it, expect } from 'vitest';
import { readEpsBox } from '../src/epsdsc.js';
import { PsBudget } from '../src/psbudget.js';
import { LoadLimits } from '../src/loadlimits.js';
import { PdfParseError } from '../src/errors.js';
import { epsSource } from './helpers/build-eps.js';
import { psBytes, joinPs } from './helpers/ps-font-program.js';
const read=(b:Uint8Array)=>readEpsBox(b,new PsBudget());
describe('outer EPS DSC bounds',()=>{
 it('accepts an implicit outer prolog boundary',()=>{
   expect(read(epsSource('%%EndProlog\nshowpage'))).toEqual([-10,20,90,70]);
 });
 it.each([
   ['explicit then implicit', '%%BeginProlog\n%%EndProlog\n%%EndProlog'],
   ['two implicit ends', '%%EndProlog\n%%EndProlog'],
   ['implicit then explicit', '%%EndProlog\n%%BeginProlog\n%%EndProlog'],
   ['two explicit pairs', '%%BeginProlog\n%%EndProlog\n%%BeginProlog\n%%EndProlog'],
 ])('rejects duplicate outer prolog boundaries with %s', (_kind, body)=>{
   expect(()=>read(epsSource(body))).toThrow(/duplicate outer EndProlog/);
 });
 it('accepts nested prolog pairs on both sides of a single outer prolog end',()=>{
   const child = '%%BeginDocument: child.eps\n%%BeginProlog\n%%EndProlog\n%%EndDocument';
   const body = `%%BeginProlog\n${child}\n%%EndProlog\n${child}\nshowpage`;
   expect(read(epsSource(body))).toEqual([-10,20,90,70]);
 });
 it.each(['%ordinary', '%%Ignored: ordinary'])('does not promote string metadata after a form-feed-terminated %s comment', comment=>{
   const fake = `${comment}\f(label\n%%Trailer\n%%BoundingBox: 0 0 999 999\n) pop\n`;
   expect(()=>read(epsSource(fake,'%%BoundingBox: (atend)'))).toThrow(PdfParseError);
   expect(read(epsSource(fake+'%%Trailer\n%%BoundingBox: -10 20 90 70','%%BoundingBox: (atend)'))).toEqual([-10,20,90,70]);
 });
 it('ends recognized DSC arguments at form feed without creating a physical line start',()=>{
   expect(read(psBytes('%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: -10 20 90 70\f(label\n%%Trailer\n%%BoundingBox: 0 0 999 999\n) pop\n'))).toEqual([-10,20,90,70]);
 });
 it.each(['BoundingBox','BeginData'])('reserves bounded argument scratch before parsing hostile %s fields',key=>{
   const line=`%%${key}: ${'0 '.repeat(5000)}`;
   const allowed=64+line.length*2+64;
   expect(()=>readEpsBox(psBytes('%!PS\n'+line+'\n'),new PsBudget(LoadLimits.defaults.with({maxPostScriptVmBytes:allowed}))))
     .toThrowError(expect.objectContaining({limit:'maxPostScriptVmBytes',allowed}));
 });
 it('treats preview contents as opaque even when they look like unbalanced code',()=>{
   expect(read(epsSource('%%BeginPreview: 1 1 1 2\n(unclosed\n<~also unclosed\n%%EndPreview\n'))).toEqual([-10,20,90,70]);
 });
 it('accepts zero-byte counted blocks and ignores huge irrelevant comments without line scratch',()=>{
   expect(readEpsBox(epsSource('%%BeginBinary: 0\n%%EndBinary\n%'+ 'x'.repeat(2000)),new PsBudget(LoadLimits.defaults.with({maxObjectBytes:100})))).toEqual([-10,20,90,70]);
 });
 it.each(['\n','\r','\r\n'])('reads bounds with %j lines',eol=>{expect(read(epsSource('',undefined,eol))).toEqual([-10,20,90,70]);});
 it('prefers contained fractional HiRes bounds',()=>{expect(read(epsSource('', '%%BoundingBox: -10 20 90 70\n%%HiResBoundingBox: -9.5 20.25 89.75 69.5'))).toEqual([-9.5,20.25,89.75,69.5]);});
 it('resolves both deferred bounds from the outer trailer without final newline',()=>{expect(read(epsSource('%%Trailer\n%%BoundingBox: -10 20 90 70\n%%HiResBoundingBox: -9.5 20.25 89.75 69.5','%%BoundingBox: (atend)\n%%HiResBoundingBox: (atend)'))).toEqual([-9.5,20.25,89.75,69.5]);});
 it.each(['', '%%HiResBoundingBox: 0 0 2 2','%%BoundingBox: (atend)','%%BoundingBox: NaN 0 2 2','%%BoundingBox: 0 0 Infinity 2','%%BoundingBox: 0 0 0 2','%%BoundingBox: 2 0 1 2','%%BoundingBox: 0.5 0 2 2','%%BoundingBox: 0 0 2e2 2','%%BoundingBox: 0 0 9007199254740992 2','%%BoundingBox: -10 20 90 70\n%%BoundingBox: 0 0 2 2','%%BoundingBox: -10 20 90 70\n%%HiResBoundingBox: -11 20 90 70'])('refuses bad metadata %j',comments=>{expect(()=>read(epsSource('',comments))).toThrow(PdfParseError);});
 it('allows identical duplicates and absolute containment tolerance',()=>{expect(read(epsSource('','%%BoundingBox: 0 0 2 2\n%%BoundingBox: 0 0 2 2\n%%HiResBoundingBox: -0.00000005 0 2 2'))).toEqual([-0.00000005,0,2,2]);expect(()=>read(epsSource('','%%BoundingBox: 0 0 2 2\n%%HiResBoundingBox: -0.0000002 0 2 2'))).toThrow(PdfParseError);});
 it.each(['Document: child.eps','File: file.ps','Resource: font Test','Font: Font','ProcSet: Set','Prolog'])('ignores nested %s metadata',begin=>{const end=begin.split(':')[0];expect(read(epsSource(`%%Begin${begin}\n%%BoundingBox: 0 0 999 999\n%%Trailer\n%%End${end}\n`))).toEqual([-10,20,90,70]);});
 it.each(['(label\n%%Trailer\n%%BoundingBox: 0 0 999 999\n(nested\\)word)) pop','<abcd\n%%BoundingBox: 0 0 999 999\n> pop','<~abcd\n%%BoundingBox: 0 0 999 999\n~> pop','%%BeginPreview: 1 1 1 2\n%%BoundingBox: 0 0 999 999\n%%Trailer\n%%EndPreview'])('ignores lexical or preview spoof %j',body=>{const b=epsSource(body),before=b.slice();expect(read(b)).toEqual([-10,20,90,70]);expect(b).toEqual(before);});
 it.each(['Binary','Data'])('skips counted Begin%s bytes containing fake boundaries',kind=>{const payload=psBytes('%%EndDocument\n%%Trailer\n%%BoundingBox: 0 0 999 999\n(\xff');const b=joinPs(epsSource(`%%Begin${kind}: ${payload.length}${kind==='Data'?' Binary Bytes':''}\n`),payload,psBytes(`\n%%End${kind}\n`));expect(read(b)).toEqual([-10,20,90,70]);});
 it.each(['','ASCII Lines','Hex Lines','Binary Lines'])('supports counted line data %s',type=>{const count=type?2:12;const payload=type?'image\r\n%%Trailer\r\n':'image\n12345\n';expect(read(epsSource(`%%BeginData: ${count} ${type}\n${payload}%%EndData\n`))).toEqual([-10,20,90,70]);});
 it.each(['%%BeginData: 99999 Binary Bytes\nshort','%%BeginBinary: -1\n','%%BeginData: 2 Wrong Bytes\nx\n%%EndData','%%BeginBinary: 0\n%%EndData','%%BeginDocument: x\n%%EndFile','%%BeginDocument: x\n','(unterminated','%%Trailer\n%%Trailer','%%Trailer\n%%BoundingBox: 0 0 9 9'])('rejects broken structure %j',body=>{expect(()=>read(epsSource(body))).toThrow(PdfParseError);});
 it('ignores body boxes and post-EOF metadata',()=>{expect(read(epsSource('%%BoundingBox: 0 0 999 999\n%%EOF\n%%BoundingBox: 0 0 777 777'))).toEqual([-10,20,90,70]);});
 it.each([['maxPostScriptOperations',1],['maxPostScriptVmBytes',1],['maxObjectBytes',8],['maxNestingDepth',1],['maxContainerItems',1]] as const)('meters %s', (limit,allowed)=>{const b=epsSource('%%BeginDocument: x\n%%BeginFile: y\n%%EndFile\n%%EndDocument');expect(()=>readEpsBox(b,new PsBudget(LoadLimits.defaults.with({[limit]:allowed})))).toThrowError(expect.objectContaining({limit,allowed}));});
});
