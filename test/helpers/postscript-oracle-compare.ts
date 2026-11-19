import type { DecodedPng } from './decode-png.js';
import type { OracleRegion } from './postscript-oracle-cases.js';
export interface OracleStat { foreground:number; strictMismatches:number; edgeAccepted:number; mismatchFraction:number; maxDelta:number }
export interface OracleComparison { failures:string[]; whole:OracleStat & {pageFraction:number}; regions:(OracleStat & {id:string})[] }
export interface OraclePolicy { version:1; dpi:144; referenceHashes:Record<string,string>; pages:Record<string,{whole:number;regions:Record<string,number>}> }
const empty=():OracleStat=>({foreground:0,strictMismatches:0,edgeAccepted:0,mismatchFraction:0,maxDelta:0});
/** Opaque-white compositing makes RGB/RGBA comparisons agree. */
const rgb=(p:DecodedPng,x:number,y:number)=>{const c=p.at(x,y),a=c[3]/255;return [0,1,2].map(i=>Math.round(c[i]!*a+255*(1-a)));};
const delta=(a:number[],b:number[])=>Math.max(...a.map((v,i)=>Math.abs(v-b[i]!)));
const painted=(c:number[])=>c.some(v=>v<250);
export function compareOracle(ours:DecodedPng,reference:DecodedPng,regions:readonly OracleRegion[],scale:number):OracleComparison {
  const result:OracleComparison={failures:[],whole:{...empty(),pageFraction:0},regions:[]};
  if(ours.width!==reference.width||ours.height!==reference.height) {result.failures.push('dimensions');return result;}
  if(!(scale>0&&Number.isFinite(scale))) throw new Error('Invalid comparison scale');
  const w=ours.width,h=ours.height, flags=new Uint8Array(w*h), contrasts=new Uint16Array(w*h);
  const neighbors=(image:DecodedPng,x:number,y:number,fn:(c:number[])=>boolean)=>{
    for(let j=Math.max(0,y-1);j<=Math.min(h-1,y+1);j++) for(let i=Math.max(0,x-1);i<=Math.min(w-1,x+1);i++) if(fn(rgb(image,i,j)))return true;
    return false;
  };
  const coverageMatch=(image:DecodedPng,x:number,y:number,color:number[])=>{
    let low=rgb(image,x,y),high=low;
    neighbors(image,x,y,c=>{if(c.reduce((a,b)=>a+b,0)<low.reduce((a,b)=>a+b,0))low=c;
      if(c.reduce((a,b)=>a+b,0)>high.reduce((a,b)=>a+b,0))high=c;return false;});
    // A coverage shade lies on the RGB segment between local foreground and
    // background. Restrict this to a 3x3 neighborhood and the same delta 12.
    let lo=0,hi=1;
    for(let i=0;i<3;i++) {
      const span=high[i]!-low[i]!;
      if(span===0) {if(Math.abs(color[i]!-low[i]!)>12)return false;continue;}
      const a=(color[i]!-12-low[i]!)/span,b=(color[i]!+12-low[i]!)/span;
      lo=Math.max(lo,Math.min(a,b));hi=Math.min(hi,Math.max(a,b));
    }
    return lo<=hi;
  };
  for(let y=0;y<h;y++) for(let x=0;x<w;x++) {
    const a=rgb(ours,x,y),b=rgb(reference,x,y),d=delta(a,b),i=y*w+x;
    contrasts[i]=d; let f=(painted(a)?1:0)|(painted(b)?2:0);
    if(d>12) {
      f|=4;
      const edge=neighbors(ours,x,y,c=>delta(a,c)>12)||neighbors(reference,x,y,c=>delta(b,c)>12);
      if(edge&&(neighbors(reference,x,y,c=>delta(a,c)<=12)||coverageMatch(reference,x,y,a))
        &&(neighbors(ours,x,y,c=>delta(b,c)<=12)||coverageMatch(ours,x,y,b))) f|=8;
    }
    flags[i]=f;
  }
  function stats(x0:number,y0:number,x1:number,y1:number):OracleStat & {observed:number;expected:number} {
    const s={...empty(),observed:0,expected:0};
    for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++) {
      const i=y*w+x,f=flags[i]!;
      if(f&3)s.foreground++; if(f&1)s.observed++;if(f&2)s.expected++;
      if(f&4)s.strictMismatches++;if(f&8)s.edgeAccepted++;
      s.maxDelta=Math.max(s.maxDelta,contrasts[i]!);
    }
    s.mismatchFraction=(s.strictMismatches-s.edgeAccepted)/Math.max(1,s.foreground);return s;
  }
  const whole=stats(0,0,w,h);result.whole={...whole,pageFraction:whole.strictMismatches/(w*h)};
  if(whole.expected===0&&whole.strictMismatches>0)result.failures.push('blank page changed');
  for(const r of regions) {
    const [left,bottom,right,top]=r.box;
    const x0=Math.floor(left*scale),x1=Math.ceil(right*scale),y0=h-Math.ceil(top*scale),y1=h-Math.floor(bottom*scale);
    if(x0<0||y0<0||x1>w||y1>h||x0>=x1||y0>=y1) {result.failures.push(`region bounds: ${r.id}`);continue;}
    const s=stats(x0,y0,x1,y1);result.regions.push({...s,id:r.id});
    if(s.expected===0)result.failures.push(`empty reference region: ${r.id}`);
    if(s.observed===0)result.failures.push(`empty observed region: ${r.id}`);
    for(const probe of r.probes??[]) {
      const x=Math.floor(probe.x*scale),y=h-1-Math.floor(probe.y*scale);
      if(x<0||y<0||x>=w||y>=h||delta(rgb(ours,x,y),probe.rgb)>2||delta(rgb(reference,x,y),probe.rgb)>2) result.failures.push(`probe: ${r.id}`);
    }
  }
  return result;
}
