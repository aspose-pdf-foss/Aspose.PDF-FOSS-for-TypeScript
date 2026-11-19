import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { oracleCases } from './helpers/postscript-oracle-cases.js';
import { Document } from '../src/document.js';
import { LoadLimits } from '../src/loadlimits.js';
import { isStream, isName } from '../src/types.js';
import { decodeStream } from '../src/filters.js';
import { decodePng } from './helpers/decode-png.js';
import { compareOracle, type OraclePolicy } from './helpers/postscript-oracle-compare.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const corpus = join(root, 'test/fixtures/postscript-oracle');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('frozen independent PostScript oracle inputs', () => {
  it('retains all thirteen selected inputs and literal page boxes', () => {
    const cases = oracleCases(root);
    expect(cases.map(c => c.id)).toEqual([
      'ps-pages', 'ps-paths', 'ps-images', 'ps-fonts', 'ps-reuse',
      'eps-integer', 'eps-hires', 'eps-deferred', 'eps-epsi',
      'eps-dos-tiff', 'eps-dos-wmf', 'upstream-tiger', 'upstream-colorcir',
    ]);
    expect(cases[0]!.pages.map(p => p.mediaBox)).toEqual([[0,0,80,60], [0,0,80,60], [0,0,100,80]]);
    expect(cases.find(c => c.id === 'eps-hires')!.pages[0]!.mediaBox).toEqual([0,0,99.25,49.25]);
    expect(cases.find(c => c.id === 'upstream-tiger')!.pages[0]!.mediaBox).toEqual([0,0,550,568]);
    expect(cases.find(c => c.id === 'upstream-colorcir')!.pages[0]!.mediaBox).toEqual([0,0,595,842]);
  });
  it('reads immutable source bytes against separately frozen hashes', () => {
    for (const c of oracleCases(root)) {
      const bytes = readFileSync(join(corpus, c.source)), before = Buffer.from(bytes);
      expect(sha(bytes), c.id).toBe(c.sourceSha256);
      expect(bytes).toEqual(before);
      expect(c.pages.every(p => p.blank || p.regions.length > 0), c.id).toBe(true);
      for (const font of c.fonts) expect(sha(readFileSync(join(root, font.path))), font.name).toBe(font.sha256);
    }
  });
  it('pins the two unmodified external producer inputs', () => {
    const tiger = readFileSync(join(corpus, 'inputs/upstream-tiger.eps'));
    const circles = readFileSync(join(corpus, 'inputs/upstream-colorcir.ps'));
    expect(tiger.length).toBe(78687);
    expect(sha(tiger)).toBe('ed255555fdab768cce7f025dcde744a6807292cac40f80f73733fbffe61edb4f');
    expect(circles.length).toBe(2061);
    expect(sha(circles)).toBe('3867d5e63b6e48e67682970254161368e718a6fb486c49a8029689d2b5d7d9ce');
  });
});

describe('public imports against direct Ghostscript references',()=>{
  const cases=oracleCases(root);
  const refs=join(corpus,'references');
  const manifest=JSON.parse(readFileSync(join(refs,'manifest.json'),'utf8')) as {version:number;dpi:number;cases:({files:Record<string,string>}&ReturnType<typeof oracleCases>[number])[]};
  it('binds every frozen case and output to a separately reviewed policy',()=>{
    const policy=JSON.parse(readFileSync(join(corpus,'policy.json'),'utf8')) as OraclePolicy;
    expect(manifest.version).toBe(1);expect(manifest.dpi).toBe(144);
    expect(manifest.cases.map(c=>c.id)).toEqual(cases.map(c=>c.id));
    const hashes:Record<string,string>={}, keys:string[]=[];
    for(const c of cases) {
      const frozen=manifest.cases.find(m=>m.id===c.id)!;
      expect(frozen.sourceSha256).toBe(c.sourceSha256);expect(frozen.pages).toEqual(c.pages);expect(frozen.fonts).toEqual(c.fonts);
      Object.assign(hashes,frozen.files);
      expect(Object.keys(frozen.files).sort()).toEqual([`${c.id}.pdf`,...c.pages.map((_,i)=>`${c.id}-${i+1}.png`)].sort());
      for(let i=0;i<c.pages.length;i++) keys.push(`${c.id}:${i+1}`);
    }
    expect(policy.version).toBe(1);expect(policy.dpi).toBe(144);
    expect(policy.referenceHashes).toEqual(hashes);expect(Object.keys(policy.pages).sort()).toEqual(keys.sort());
    expect(readdirSync(refs).sort()).toEqual([...Object.keys(hashes),'manifest.json','runs.json'].sort());
    for(const [file,hash] of Object.entries(hashes)) expect(sha(readFileSync(join(refs,file))),file).toBe(hash);
  });
  for(const c of cases) it(c.id,()=>{
    const policy=JSON.parse(readFileSync(join(corpus,'policy.json'),'utf8')) as OraclePolicy;
    const d=Document.New();
    if(c.id==='upstream-colorcir') d.loadLimits=LoadLimits.defaults.with({maxPostScriptOperations:100_000_000});
    const input=readFileSync(join(corpus,c.source)), before=Buffer.from(input);
    d.AddPostScript(input,{format:c.format,fonts:c.fonts.map(f=>({name:f.name,bytes:readFileSync(join(root,f.path))}))});
    expect(input).toEqual(before);
    const doc=Document.Open(d.Save()), independent=Document.Open(readFileSync(join(refs,c.id+'.pdf')));
    expect(doc.Pages.length).toBe(c.pages.length);expect(independent.Pages.length).toBe(c.pages.length);
    for(let i=0;i<c.pages.length;i++) {
      const expected=c.pages[i]!, page=doc.Pages[i]!, gs=independent.Pages[i]!;
      for(const p of [page,gs]) {
        for(const box of [p.MediaBox,p.CropBox]) box.forEach((v,j)=>expect(v).toBeCloseTo(expected.mediaBox[j]!,6));
        expect(p.Rotate).toBe(0);
        for(const text of expected.text??[]) expect(p.GetText()).toContain(text);
      }
      const observed=decodePng(page.ToImage({scale:2})), reference=decodePng(readFileSync(join(refs,`${c.id}-${i+1}.png`)));
      const cmp=compareOracle(observed,reference,expected.regions,2), bounds=policy.pages[`${c.id}:${i+1}`]!;
      expect(cmp.failures).toEqual([]);
      expect(Object.keys(bounds.regions).sort()).toEqual(expected.regions.map(r=>r.id).sort());
      expect(Number.isFinite(bounds.whole)&&bounds.whole>=0).toBe(true);
      expect(bounds.whole).toBeLessThanOrEqual(expected.blank?0:c.id==='ps-images'?.1:Math.max(...expected.regions.map(r=>r.kind==='text'?.2:.05)));
      expect(cmp.whole.mismatchFraction,'whole foreground union').toBeLessThanOrEqual(bounds.whole);
      if(expected.blank) expect(cmp.whole.strictMismatches).toBe(0);
      for(const region of cmp.regions) {
        const limit=bounds.regions[region.id]!, kind=expected.regions.find(r=>r.id===region.id)!.kind;
        expect(Number.isFinite(limit)&&limit>=0).toBe(true);
        // The explicit RGB-only exception covers Mitchell versus bilinear;
        // exact independent sample checks below retain the source-color contract.
        expect(limit).toBeLessThanOrEqual(c.id==='ps-images'&&region.id==='rgb'?.15:kind==='text'?.2:.05);
        expect(region.mismatchFraction,region.id).toBeLessThanOrEqual(limit);
      }
    }
    if(c.id==='ps-fonts') for(const [pdf,tolerance] of [[doc,1e-6],[independent,3e-4]] as const) {
      const bars=pdf.Pages[0]!.GetPaths().filter(p=>p.fill&&Math.abs(p.bbox[0]-12)<tolerance&&Math.abs(p.bbox[3]-p.bbox[1]-2)<tolerance);
      for(const [y,width] of [[92,16.008],[60,16.0078125]]) {
        const bar=bars.find(p=>Math.abs(p.bbox[1]-y!)<tolerance);
        expect(bar,`advance bar ${y}`).toBeDefined();expect(Math.abs(bar!.bbox[2]-bar!.bbox[0]-width!)).toBeLessThan(tolerance);
      }
    }
    if(c.id==='ps-images') for(const pdf of [doc,independent]) {
      const images=[...pdf.objectEntries()].map(([,o])=>o).filter(o=>{
        if(!isStream(o))return false;const subtype=o.dict.get('Subtype');return isName(subtype)&&subtype.name==='Image';
      });
      const samples=images.map(o=>{if(!isStream(o))throw new Error('image');return Array.from(decodeStream(o));});
      for(const p of pdf.Pages) for(const image of p.InlineImages) samples.push(Array.from(image.Decode()));
      expect(samples).toContainEqual([255,0,0,0,255,0,0,0,255,255,255,0,0,255,255,255,0,255]);
      expect(samples).toContainEqual([0,127,255]);
    }
  },120000);
});
