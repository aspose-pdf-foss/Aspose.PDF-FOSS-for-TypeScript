import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { encodePng } from '../src/pngencode.js';
import { generateOracles, oracleCommands, publishOracleDirectory } from '../scripts/postscript-oracle-runner.js';
import type { OracleCase } from './helpers/postscript-oracle-cases.js';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const owned: string[] = [];
afterEach(() => { for (const p of owned.splice(0)) rmSync(p, { recursive:true, force:true }); });
function hashTree(dir: string): Record<string,string> {
  const result: Record<string,string> = {};
  function walk(p: string, prefix: string) {
    for (const d of readdirSync(p, {withFileTypes:true})) {
      const key = prefix + d.name;
      if (d.isDirectory()) { result[key+'/']='<dir>'; walk(join(p,d.name),key+'/'); }
      else result[key]=sha(readFileSync(join(p,d.name)));
    }
  }
  walk(dir,''); return result;
}
function fixture(mode='ok') {
  const root=mkdtempSync(join(tmpdir(), 'ps oracle $() ` ')); owned.push(root);
  const corpus=join(root,'test/fixtures/postscript-oracle'); mkdirSync(join(corpus,'inputs'),{recursive:true});
  const source=Buffer.from('%!PS\nshowpage\n');
  const cases: OracleCase[]=['first','second'].map(id => {
    writeFileSync(join(corpus,'inputs',id+'.ps'),source);
    return {id,source:`inputs/${id}.ps`,sourceSha256:sha(source),format:'ps',setup:'ps',
      flushMarkedTail:false,fonts:[],pages:[{mediaBox:[0,0,2,2],regions:[]}]};
  });
  const pdf=join(root,'template.pdf'), png=join(root,'template.png');
  writeFileSync(pdf,buildClassicPdf(1,{mediaBox:[0,0,2,2]}));
  writeFileSync(png,encodePng(4,4,new Uint8Array(4*4*3).fill(255),'rgb'));
  const outDir=join(corpus,'references'); mkdirSync(outDir,{recursive:true});
  const old=Buffer.from('old reference bytes');writeFileSync(join(outDir,'old-1.png'),old);
  writeFileSync(join(outDir,'manifest.json'),JSON.stringify({generator:'postscript-oracle-runner',version:1,dpi:144,cases:[{id:'old',files:{'old-1.png':sha(old)}}]}));
  writeFileSync(join(outDir,'runs.json'),'{}');
  return {root,outDir,cases,command:{executable:process.execPath,
    prefixArgs:[resolve('test/helpers/fake-ghostscript.mjs'),mode,pdf,png]},timeoutMs:5000};
}
describe('staged PostScript reference generation', () => {
  it('separates vector and raster options and preserves literal argv', () => {
    const f=fixture(); const input='a "quote" $() ` file.ps';
    const args=oracleCommands(f.cases[0]!, {input,setup:'host.ps',fontmap:'Fontmap',pdfOutput:'x.pdf',pngOutput:'x-%d.png',fontPaths:['font name.t1']});
    const separator = process.platform === 'win32' ? ';' : ':';
    const permitRead = `--permit-file-read=${input}${separator}host.ps${separator}Fontmap${separator}font name.t1`;
    for (const argv of [args.pdf, args.png]) {
      expect(argv.filter(arg => arg.startsWith('--permit-file-read='))).toEqual([permitRead]);
    }
    expect(args.pdf).toContain(input); expect(args.pdf).toContain('-dOmitID=true');
    expect(args.pdf).not.toContain('-dTextAlphaBits=4'); expect(args.png).toContain('-r144');
    expect(args.png).toContain('-dTextAlphaBits=4');
    expect(args.png).toContain('-dGridFitTT=0'); expect(args.png).toContain('-dAlignToPixels=0');
    for (const a of [args.pdf,args.png]) for(const flag of ['-dSAFER','-dBATCH','-dNOPAUSE','-dNOPLATFONTS','-dNONATIVEFONTMAP']) expect(a).toContain(flag);
    expect(args.pdf).not.toContain('-dNOFONTMAP');
    expect(args.pdf).toContain('-dOmitXMP=true');
    expect(oracleCommands({...f.cases[0]!,setup:'eps-native'}, {input,setup:'s',fontmap:'f',pdfOutput:'p',pngOutput:'n',fontPaths:[]}).png).toContain('-dEPSCrop');
    expect(oracleCommands({...f.cases[0]!,setup:'eps-literal'}, {input,setup:'s',fontmap:'f',pdfOutput:'p',pngOutput:'n',fontPaths:[]}).png).toContain('-dNOEPS');
  });
  it('publishes only a complete validated set', async () => {
    const f=fixture(); await generateOracles(f);
    const names=readdirSync(f.outDir);
    expect(names).toEqual(['first-1.png','first.pdf','manifest.json','runs.json','second-1.png','second.pdf']);
    const logs=readFileSync(join(f.outDir,'runs.json'),'utf8');
    expect(logs).not.toContain(f.root.replaceAll('\\','\\\\')); expect(logs).not.toContain('.oracle-stage-');
  });
  for (const mode of ['version','exit','later','timeout','missing','corrupt','truncated','extra','substitution','overflow','pdf-no-startxref','pdf-no-eof','pdf-recovery']) {
    it(`preserves every prior file after ${mode}`, async () => {
      const f=fixture(mode), before=hashTree(f.outDir);
      if(mode==='timeout') f.timeoutMs=200;
      await expect(generateOracles(f)).rejects.toThrow();
      expect(hashTree(f.outDir)).toEqual(before);
    });
  }
  for (const change of ['source','font','pages','dimensions']) {
    it(`refuses changed ${change} before publishing`, async () => {
      const f=fixture(), before=hashTree(f.outDir);
      if(change==='source') f.cases[0]!.sourceSha256='0'.repeat(64);
      if(change==='font') f.cases[0]!.fonts=[{name:'Missing',path:'template.pdf',sha256:'0'.repeat(64)}];
      if(change==='pages') f.cases[0]!.pages=[...f.cases[0]!.pages,...f.cases[0]!.pages];
      if(change==='dimensions') f.cases[0]!.pages=[{mediaBox:[0,0,9,9],regions:[]}];
      await expect(generateOracles(f)).rejects.toThrow(); expect(hashTree(f.outDir)).toEqual(before);
    });
  }
  it('restores the prior directory if the second rename fails', async () => {
    const f=fixture(), before=hashTree(f.outDir), staged=join(f.root,'staged'); mkdirSync(staged);
    writeFileSync(join(staged,'new'),'new'); let calls=0;
    await expect(publishOracleDirectory(staged,f.outDir,async(a,b)=>{if(++calls===2) throw new Error('handover'); await rename(a,b);})).rejects.toThrow('handover');
    expect(hashTree(f.outDir)).toEqual(before);
  });
  it('refuses a silent nominal font fallback even when input hashes match', async () => {
    const f=fixture(), before=hashTree(f.outDir);
    f.cases[0]!.fonts=[{name:'Missing',path:'template.pdf',sha256:sha(readFileSync(join(f.root,'template.pdf')))}];
    await expect(generateOracles(f)).rejects.toThrow('Unverified font identity');
    expect(hashTree(f.outDir)).toEqual(before);
  });
  for(const mode of ['wrongfontprefix','wrongfontearlier']) it(`refuses the wrong selected font after ${mode}`,async()=>{
    const f=fixture(mode),before=hashTree(f.outDir);
    f.cases[0]!.fonts=[{name:'Missing',path:'template.pdf',sha256:sha(readFileSync(join(f.root,'template.pdf')))}];
    await expect(generateOracles(f)).rejects.toThrow('Unverified font identity');expect(hashTree(f.outDir)).toEqual(before);
  });
  for(const dest of ['docs','scripts','test/helpers','external output']) it(`preserves unmanaged custom output ${dest}`,async()=>{
    const f=fixture(),outDir=join(f.root,dest);mkdirSync(join(outDir,'nested'),{recursive:true});
    writeFileSync(join(outDir,'nested/user-work'),'keep every byte');const before=hashTree(outDir);
    await expect(generateOracles({...f,outDir})).rejects.toThrow(/unmanaged output/i);expect(hashTree(outDir)).toEqual(before);
  });
  it('regenerates an owned custom set but refuses extra user files',async()=>{
    const f=fixture(),outDir=join(f.root,'custom refs');
    await generateOracles({...f,outDir});await generateOracles({...f,outDir});
    writeFileSync(join(outDir,'user-notes'),'preserve');const before=hashTree(outDir);
    await expect(generateOracles({...f,outDir})).rejects.toThrow(/unmanaged output/i);expect(hashTree(outDir)).toEqual(before);
  });
  for (const target of ['.','src','fonts','test/fixtures/postscript-oracle/inputs','.git','test']) {
    it(`rejects unsafe output ${target}`, async () => {
      const f=fixture(); await expect(generateOracles({...f,outDir:resolve(f.root,target)})).rejects.toThrow(/output/i);
    });
  }
});
