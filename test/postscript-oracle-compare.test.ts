import { describe, expect, it } from 'vitest';
import { decodePng } from './helpers/decode-png.js';
import { encodePng } from '../src/pngencode.js';
import { compareOracle } from './helpers/postscript-oracle-compare.js';
const image=(w=100,h=100,marks:[number,number,number,number,number[]][]=[])=>{
  const data=new Uint8Array(w*h*3).fill(255);
  for(const [x,y,sw,sh,rgb] of marks) for(let j=y;j<y+sh;j++) for(let i=x;i<x+sw;i++) data.set(rgb,(j*w+i)*3);
  return decodePng(encodePng(w,h,data,'rgb'));
};
const glyph={id:'glyph',box:[10,85,13,90] as [number,number,number,number],kind:'text' as const};
describe('independent foreground comparisons',()=>{
  it('compares identical occupied regions',()=>{
    const a=image(100,100,[[10,10,3,5,[0,0,0]]]);
    expect(compareOracle(a,a,[glyph],1).failures).toEqual([]);
    expect(compareOracle(a,a,[glyph],1).whole.mismatchFraction).toBe(0);
  });
  it('refuses dimensions without sampling out of bounds',()=>{
    expect(compareOracle(image(2,2),image(3,2),[],1).failures).toContain('dimensions');
  });
  it('does not dilute a lost glyph into a white page',()=>{
    const result=compareOracle(image(),image(100,100,[[10,10,3,5,[0,0,0]]]),[glyph],1);
    expect(result.regions[0]!.foreground).toBe(15);
    expect(result.regions[0]!.mismatchFraction).toBe(1);
    expect(result.failures).toContain('empty observed region: glyph');
  });
  it('refuses unexpected marks on a blank page',()=>{
    expect(compareOracle(image(100,100,[[1,1,1,1,[0,0,0]]]),image(),[],1).failures).toContain('blank page changed');
  });
  it('counts interior color drift and checks literal probes',()=>{
    const region={...glyph,box:[10,80,20,90] as [number,number,number,number],probes:[{x:15,y:85,rgb:[255,0,0] as [number,number,number]}]};
    const result=compareOracle(image(100,100,[[10,10,10,10,[0,255,0]]]),image(100,100,[[10,10,10,10,[255,0,0]]]),[region],1);
    expect(result.regions[0]!.mismatchFraction).toBe(1);
    expect(result.failures).toContain('probe: glyph');
  });
  it('detects a two-point displacement',()=>{
    const a=image(100,100,[[10,10,3,5,[0,0,0]]]), b=image(100,100,[[12,10,3,5,[0,0,0]]]);
    expect(compareOracle(a,b,[{...glyph,box:[8,83,18,92]}],1).regions[0]!.mismatchFraction).toBeGreaterThan(.2);
  });
  it('rejects empty reference regions and out-of-image regions',()=>{
    expect(compareOracle(image(),image(),[glyph],1).failures).toContain('empty reference region: glyph');
    expect(compareOracle(image(),image(),[{...glyph,box:[-1,0,2,2]}],1).failures).toContain('region bounds: glyph');
  });
  it('accepts a symmetric one-pixel edge shift while retaining strict counts',()=>{
    const a=image(100,100,[[10,10,10,10,[0,0,0]]]), b=image(100,100,[[11,10,10,10,[0,0,0]]]);
    const result=compareOracle(a,b,[],1);
    expect(result.whole.strictMismatches).toBe(20); expect(result.whole.edgeAccepted).toBe(20);
    expect(result.whole.mismatchFraction).toBe(0);
  });
  it('accepts different coverage shades only within a one-pixel edge',()=>{
    const a=image(10,10,[[2,2,5,5,[0,0,0]],[1,2,1,5,[80,80,80]]]);
    const b=image(10,10,[[2,2,5,5,[0,0,0]],[1,2,1,5,[160,160,160]]]);
    expect(compareOracle(a,b,[],1).whole.strictMismatches).toBe(5);
    expect(compareOracle(a,b,[],1).whole.mismatchFraction).toBe(0);
  });
});
