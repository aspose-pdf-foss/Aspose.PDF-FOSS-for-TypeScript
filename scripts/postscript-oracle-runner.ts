/** Generation only: direct Ghostscript execution, no library PS/DSC/render code. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Document } from '../src/document.js';
import { crc32 } from '../src/crc32.js';
import { decodePng } from '../test/helpers/decode-png.js';
import type { OracleCase } from '../test/helpers/postscript-oracle-cases.js';

export interface OracleCommand { executable:string; prefixArgs:readonly string[] }
export interface OraclePaths { input:string; setup:string; fontmap:string; pdfOutput:string; pngOutput:string; fontPaths:readonly string[] }
export function oracleCommands(c: OracleCase, p: OraclePaths): {pdf:string[];png:string[]} {
  const common=['-dSAFER','-dBATCH','-dNOPAUSE','-dNOPLATFONTS','-dNONATIVEFONTMAP',
    `-sFONTMAP=${p.fontmap}`,'-sFONTPATH=',`--permit-file-read=${[p.input,p.setup,p.fontmap,...p.fontPaths].join(delimiter)}`];
  const finish=['-f',p.setup,'-f',p.input,...(c.flushMarkedTail?['-c','showpage']:[])];
  const eps=c.setup==='eps-native'?['-dEPSCrop']:c.setup==='eps-literal'?['-dNOEPS']:[];
  return {
    pdf:[...common,'-sDEVICE=pdfwrite','-dCompatibilityLevel=1.7','-dAutoRotatePages=/None',
      '-sColorConversionStrategy=LeaveColorUnchanged','-dEmbedAllFonts=true','-dSubsetFonts=false',
      '-dOmitInfoDate=true','-dOmitID=true','-dOmitXMP=true','-r72',...eps,`-sOutputFile=${p.pdfOutput}`,...finish],
    png:[...common,'-sDEVICE=png16m','-r144','-dTextAlphaBits=4','-dGraphicsAlphaBits=4','-dGridFitTT=0','-dAlignToPixels=0',
      ...eps,`-sOutputFile=${p.pngOutput}`,...finish],
  };
}
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const psString=(s:string)=>`(${s.replaceAll('\\','/').replace(/[()\\]/g,'\\$&')})`;
const inside=(a:string,b:string)=>{const r=relative(a,b);return r===''||(!r.startsWith('..'+sep)&&r!=='..'&&!isAbsolute(r));};
async function exists(p:string) { try {await access(p);return true;} catch {return false;} }
async function noLinks(p:string) {
  for(let q=resolve(p);;) {
    try {if((await lstat(q)).isSymbolicLink()) throw new Error(`Output/input symlink refused: ${q}`);}
    catch(e) {if((e as NodeJS.ErrnoException).code!=='ENOENT') throw e;}
    const next=dirname(q); if(next===q) break; q=next;
  }
}
async function assertOwnedOutput(output:string):Promise<void> {
  if(!await exists(output))return;
  const refuse=()=>new Error(`Unmanaged output directory: ${output}`);
  if(!(await lstat(output)).isDirectory())throw refuse();
  const entries=await readdir(output);if(!entries.length)return;
  try {
    const manifest=JSON.parse(await readFile(join(output,'manifest.json'),'utf8'));
    if(manifest.version!==1||manifest.dpi!==144||!Array.isArray(manifest.cases)||!manifest.cases.length
      ||(manifest.generator!=='postscript-oracle-runner'&&!/^[0-9a-f]{64}$/.test(manifest.tool?.executableSha256??'')))throw refuse();
    const files=new Map<string,string>();
    for(const c of manifest.cases) {
      if(!/^[a-z0-9-]+$/.test(c.id)||!c.files||typeof c.files!=='object'||!Object.keys(c.files).length)throw refuse();
      for(const [file,hash] of Object.entries(c.files)) {
        if(!new RegExp(`^${c.id}(?:\\.pdf|-\\d+\\.png)$`).test(file)||typeof hash!=='string'||!/^[0-9a-f]{64}$/.test(hash)||files.has(file))throw refuse();
        files.set(file,hash);
      }
    }
    const allowed=new Set([...files.keys(),'manifest.json','runs.json']);
    if(entries.length!==allowed.size||entries.some(n=>!allowed.has(n)))throw refuse();
    for(const file of entries) {const info=await lstat(join(output,file));if(!info.isFile()||info.isSymbolicLink())throw refuse();}
    for(const [file,hash] of files) if(sha(await readFile(join(output,file)))!==hash)throw refuse();
  } catch(error) {throw new Error(`Unmanaged output directory: ${output}`,{cause:error});}
}
/** Directory handover; the old corpus is restored even after the first move. */
export async function publishOracleDirectory(staged:string, output:string,
  move:(from:string,to:string)=>Promise<void>=rename):Promise<void> {
  staged=resolve(staged); output=resolve(output);
  if(inside(output,staged)||inside(staged,output)) throw new Error('Overlapping output/staging');
  await noLinks(output); await noLinks(staged);
  await assertOwnedOutput(output);
  const backup=output+`.backup-${process.pid}-${Date.now()}`;
  if(await exists(backup)) throw new Error('Backup already exists');
  const prior=await exists(output); let moved=false;
  try { if(prior) {await move(output,backup); moved=true;} await move(staged,output); }
  catch(e) { if(moved) await rename(backup,output); throw e; }
  if(moved) await rm(backup,{recursive:true,force:true});
}
interface Run { args:string[]; stdout:string; stderr:string; status:number }
async function run(command:OracleCommand,args:string[],timeout:number):Promise<Run> {
  return new Promise((yes,no)=>execFile(command.executable,[...command.prefixArgs,...args],{
    windowsHide:true,timeout,maxBuffer:1024*1024,encoding:'utf8',
    env:{...process.env,SOURCE_DATE_EPOCH:'0',GS_FONTPATH:'',GS_OPTIONS:'',GS_LIB:''},
  },(error,stdout,stderr)=>{
    if(error) {no(new Error(`Ghostscript failed: ${error.message}\n${stdout}\n${stderr}`));return;}
    if(/substitut|can't find.*font|cannot find.*font|font.*not found|loading.*(?:nimbus|fallback)/i.test(stdout+'\n'+stderr)) {
      // Explicit requested font loads are checked separately by FontName below.
      if(/substitut|can't find.*font|cannot find.*font|font.*not found/i.test(stdout+'\n'+stderr)) {no(new Error('Ghostscript font substitution: '+stdout+stderr));return;}
    }
    yes({args:[command.executable,...command.prefixArgs,...args],stdout,stderr,status:0});
  }));
}
export async function generateOracles(options:{command:OracleCommand;root:string;outDir:string;cases:readonly OracleCase[];timeoutMs?:number}):Promise<void> {
  const root=await realpath(options.root), output=resolve(options.outDir), corpus=join(root,'test/fixtures/postscript-oracle');
  await noLinks(output);
  for(const protectedPath of [root,join(root,'.git'),join(root,'src'),join(root,'fonts'),join(corpus,'inputs')]) {
    if(inside(output,protectedPath)||(protectedPath!==root&&inside(protectedPath,output))) throw new Error(`Unsafe output: ${output}`);
  }
  await assertOwnedOutput(output);
  if(!options.cases.length) throw new Error('Empty oracle matrix');
  const ids=new Set<string>();
  for(const c of options.cases) {
    if(!/^[a-z0-9-]+$/.test(c.id)||ids.has(c.id)) throw new Error('Invalid/duplicate case'); ids.add(c.id);
    const input=resolve(corpus,c.source);
    if(!inside(join(corpus,'inputs'),input)||inside(output,input)) throw new Error('Input/output overlap');
    await noLinks(input);
    if(sha(await readFile(input))!==c.sourceSha256) throw new Error(`Source hash mismatch: ${c.id}`);
    for(const font of c.fonts) {
      const path=resolve(root,font.path);
      if(!inside(root,path)||inside(output,path)) throw new Error('Font/output overlap');
      if(sha(await readFile(path))!==font.sha256) throw new Error(`Font hash mismatch: ${font.name}`);
    }
  }
  const version=await run(options.command,['-version'],options.timeoutMs??60000);
  if(!/Ghostscript 10\.07\.1(?:\s|$)/.test(version.stdout)) throw new Error('Expected Ghostscript 10.07.1');
  await mkdir(dirname(output),{recursive:true});
  const scratch=await mkdtemp(join(dirname(output),'.oracle-stage-'));
  const staged=join(scratch,'references'); await mkdir(staged);
  const runs:Run[]=[version], entries:unknown[]=[];
  const portable=(s:string)=>s.replaceAll('\\','/').replaceAll(options.command.executable.replaceAll('\\','/'),'<GS>')
    .replaceAll(scratch.replaceAll('\\','/'),'<STAGE>').replaceAll(root.replaceAll('\\','/'),'<ROOT>');
  try {
    for(const c of options.cases) {
      const fontPaths=c.fonts.map(f=>resolve(root,f.path));
      const fontmap=join(scratch,c.id+'.Fontmap'), setup=join(scratch,c.id+'.host.ps');
      await writeFile(fontmap,c.fonts.map((f,i)=>`/${f.name} ${psString(fontPaths[i]!)} ;`).join('\n')+'\n');
      const fontChecks=c.fonts.map(f=>[
        // Match the public API's explicit StandardEncoding for supplied sfnts.
        ...(f.path.endsWith('.ttf')?[`/${f.name} findfont dup length dict begin { 1 index /FID ne { def } { pop pop } ifelse } forall /Encoding StandardEncoding def currentdict end /${f.name} exch definefont pop`]:[]),
        `/${f.name} findfont dup /FontName get (ORACLE-FONT:${f.name}=) print 256 string cvs print (\\n) print /PathLoad get (ORACLE-PATH:${f.name}=) print 4096 string cvs print (\\n) print`,
      ].join('\n')).join('\n');
      const host=c.setup==='eps-literal'
        ? (()=>{if(!c.epsBox)throw new Error('Literal EPS box required');const [x,y,x1,y1]=c.epsBox;return `<< /PageSize [${x1-x} ${y1-y}] >> setpagedevice ${-x} ${-y} translate`;})()
        : c.setup==='ps'?'<< /PageSize [595 842] >> setpagedevice':'';
      await writeFile(setup,`%!PS\n${fontChecks}\n${host}\n`);
      const paths:OraclePaths={input:resolve(corpus,c.source),setup,fontmap,fontPaths,
        pdfOutput:join(staged,c.id+'.pdf'),pngOutput:join(staged,c.id+'-%d.png')};
      const commands=oracleCommands(c,paths);
      for(const args of [commands.pdf,commands.png]) {
        const result=await run(options.command,args,options.timeoutMs??60000); runs.push(result);
        for(const font of c.fonts) {
          const loaded=resolve(root,font.path).replaceAll('\\','/');
          const lines=result.stdout.split(/\r?\n/);
          if(!lines.includes(`ORACLE-PATH:${font.name}=${loaded}`)||!lines.includes(`ORACLE-FONT:${font.name}=${font.name}`)) throw new Error(`Unverified font identity: ${font.name}\n${result.stdout}`);
        }
      }
      const pdf=await readFile(paths.pdfOutput);
      if(pdf.subarray(0,5).toString()!=='%PDF-') throw new Error('Invalid PDF header');
      const footer=/startxref\s+(\d+)\s+%%EOF[\t\n\r ]*$/.exec(pdf.subarray(-1024).toString('latin1'));
      if(!footer||!Number.isSafeInteger(Number(footer[1]))||Number(footer[1])<=0||Number(footer[1])>=pdf.length-20) throw new Error('Incomplete PDF framing');
      const doc=Document.Open(pdf);
      if(doc.recovery)throw new Error(`Recovered producer PDF: ${c.id}`);
      if(doc.Pages.length!==c.pages.length) throw new Error(`PDF page count: ${c.id}`);
      const files:Record<string,string>={[c.id+'.pdf']:sha(pdf)};
      for(let i=0;i<c.pages.length;i++) {
        const box=doc.Pages[i]!.MediaBox, expected=c.pages[i]!.mediaBox;
        if(box.some((v,j)=>Math.abs(v-expected[j]!)>1e-6)) throw new Error(`PDF dimensions: ${c.id} ${box}`);
        const file=`${c.id}-${i+1}.png`, bytes=await readFile(join(staged,file));
        if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('Invalid PNG header');
        const width=Math.round((expected[2]-expected[0])*2),height=Math.round((expected[3]-expected[1])*2);
        if(bytes.length<33||bytes.readUInt32BE(16)!==width||bytes.readUInt32BE(20)!==height||bytes[24]!==8||bytes[25]!==2||bytes[28]!==0) throw new Error(`PNG dimensions/format: ${c.id}`);
        const data:Buffer[]=[];let end=false;
        for(let pos=8;pos<bytes.length;) {
          if(pos+12>bytes.length)throw new Error('Truncated PNG chunk');
          const size=bytes.readUInt32BE(pos),next=pos+12+size;
          if(next>bytes.length||crc32(bytes.subarray(pos+4,next-4))!==bytes.readUInt32BE(next-4))throw new Error('Truncated/corrupt PNG chunk');
          const kind=bytes.toString('ascii',pos+4,pos+8);
          if(pos===8&&kind!=='IHDR')throw new Error('Missing PNG IHDR');
          if(kind==='IDAT')data.push(bytes.subarray(pos+8,next-4));
          if(kind==='IEND') {if(size!==0||next!==bytes.length)throw new Error('Invalid PNG end');end=true;}
          pos=next;
        }
        if(!end||inflateSync(Buffer.concat(data),{maxOutputLength:height*(1+width*3)+1}).length!==height*(1+width*3))throw new Error('Incomplete PNG samples');
        const png=decodePng(bytes);
        if(png.width!==Math.round((expected[2]-expected[0])*2)||png.height!==Math.round((expected[3]-expected[1])*2)||png.data.length!==png.width*png.height*3) throw new Error(`PNG dimensions: ${c.id} ${png.width}x${png.height}`);
        files[file]=sha(bytes);
      }
      entries.push({...c,files,host,setupSha256:sha(await readFile(setup)),fontmapSha256:sha(await readFile(fontmap))});
    }
    const expected=new Set((entries as {files:Record<string,string>}[]).flatMap(e=>Object.keys(e.files)));
    if((await readdir(staged)).some(n=>!expected.has(n))) throw new Error('Unexpected oracle output');
    const tool={version:version.stdout.trim(),executableSha256:sha(await readFile(options.command.executable))};
    await writeFile(join(staged,'manifest.json'),JSON.stringify({generator:'postscript-oracle-runner',version:1,dpi:144,tool,cases:entries},null,2)+'\n');
    await writeFile(join(scratch,'actual-runs.json'),JSON.stringify(runs,null,2)+'\n');
    await writeFile(join(staged,'runs.json'),JSON.stringify({bindings:{ROOT:'repository root',STAGE:'generation scratch directory',GS:'explicit executable'},runs},
      (_key,value:unknown)=>typeof value==='string'?portable(value):value,2)+'\n');
    // Log writes must succeed before publication so failure preserves old bytes.
    const logDir=join(root,'.tmp/lw8w5-last-generation'); await mkdir(logDir,{recursive:true});
    for(const name of await readdir(scratch)) if(name!=='references') await writeFile(join(logDir,name),await readFile(join(scratch,name)));
    await publishOracleDirectory(staged,output);
  } finally {
    // scratch was produced by mkdtemp, and cannot contain output or inputs.
    if(!inside(dirname(output),scratch)||inside(scratch,output)) throw new Error('Unsafe scratch cleanup');
    await rm(scratch,{recursive:true,force:true});
  }
}
