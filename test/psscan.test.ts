import { describe, expect, it } from 'vitest';
import { PsScanner } from '../src/psscan.js';
import { PsBudget } from '../src/psbudget.js';
import { PsMemory } from '../src/psmemory.js';
import { LoadLimits, type LoadLimitPatch } from '../src/loadlimits.js';
import { type PsValue } from '../src/psvalue.js';

const bytes = (s: string) => Uint8Array.from(s, c => c.charCodeAt(0));
function scanner(s: string, patch: LoadLimitPatch = {}) {
  return new PsScanner(bytes(s), new PsMemory(new PsBudget(LoadLimits.defaults.with(patch))));
}
function all(s: PsScanner): PsValue[] {
  const values: PsValue[] = [];
  for (let value = s.next(); value !== undefined; value = s.next()) values.push(value);
  return values;
}
function stringBytes(s: string): number[] {
  const value = scanner(s).next();
  expect(value?.kind).toBe('string');
  if (value?.kind !== 'string') throw new Error('expected string');
  return Array.from(value.body.bytes.subarray(value.offset, value.offset + value.length));
}

describe('lazy PostScript scanner', () => {
  it('preserves integer versus real types and recognizes exponents and radix integers', () => {
    expect(all(scanner('12 -2147483648 +23 1.0 .5 1. 1e2 -2E-2 16#FF 2#101 36#z 2147483648'))).toEqual([
      {kind:'integer',value:12,executable:false}, {kind:'integer',value:-2147483648,executable:false},
      {kind:'integer',value:23,executable:false}, {kind:'real',value:1,executable:false},
      {kind:'real',value:0.5,executable:false}, {kind:'real',value:1,executable:false},
      {kind:'real',value:100,executable:false}, {kind:'real',value:-0.02,executable:false},
      {kind:'integer',value:255,executable:false}, {kind:'integer',value:5,executable:false},
      {kind:'integer',value:35,executable:false}, {kind:'real',value:2147483648,executable:false},
    ]);
  });
  it('keeps PostScript names byte-preserving and emits executable construction delimiters', () => {
    expect(all(scanner('/A#41 /\xff foo [ ] << >> /'))).toEqual([
      {kind:'name',text:'A#41',executable:false}, {kind:'name',text:'\xff',executable:false},
      {kind:'name',text:'foo',executable:true}, {kind:'name',text:'[',executable:true},
      {kind:'name',text:']',executable:true}, {kind:'name',text:'<<',executable:true},
      {kind:'name',text:'>>',executable:true}, {kind:'name',text:'',executable:false},
    ]);
  });
  it('treats malformed number-like words as names and refuses real overflow', () => {
    expect(all(scanner('1e 2#2 1#0 37#1 12abc + - .'))).toEqual([
      {kind:'name',text:'1e',executable:true}, {kind:'name',text:'2#2',executable:true},
      {kind:'name',text:'1#0',executable:true}, {kind:'name',text:'37#1',executable:true},
      {kind:'name',text:'12abc',executable:true}, {kind:'name',text:'+',executable:true},
      {kind:'name',text:'-',executable:true}, {kind:'name',text:'.',executable:true},
    ]);
    expect(() => scanner('1e999').next()).toThrowError(expect.objectContaining({errorName:'limitcheck',offset:0}));
  });
  it('decodes nested literal strings, escapes, octal truncation and CRLF normalization', () => {
    expect(stringBytes('(A(B)C\\n\\r\\t\\b\\f\\(\\)\\\\\\q\\101\\777\\12Z)')).toEqual([65,40,66,41,67,10,13,9,8,12,40,41,92,113,65,255,10,90]);
    expect(stringBytes('(a\r\nb\rc\nd\\\r\ne\\\nf\\\rg)')).toEqual([97,10,98,10,99,10,100,101,102,103]);
    expect(stringBytes('(\x00\xff)')).toEqual([0,255]);
  });
  it('decodes odd hex nibbles and whitespace', () => {
    expect(stringBytes('<4 1\r\n4\t2F>')).toEqual([65,66,240]);
    expect(stringBytes('<>')).toEqual([]);
  });
  it('decodes ASCII85 zero groups and partial groups', () => {
    expect(stringBytes('<~87cURD_*#TDfTZ)+T~>')).toEqual([72,101,108,108,111,44,32,119,111,114,108,100,33]);
    expect(stringBytes('<~z !!~>')).toEqual([0,0,0,0,0]);
    expect(stringBytes('<~~>')).toEqual([]);
  });
  it('builds nested executable procedures while leaving brackets as names', () => {
    const value = scanner('{1 {2} [ /x ] << >>}').next();
    expect(value).toMatchObject({kind:'array',executable:true,length:7,body:{packed:false,values:[
      {kind:'integer',value:1,executable:false},
      {kind:'array',executable:true,length:1,body:{values:[{kind:'integer',value:2,executable:false}]}},
      {kind:'name',text:'[',executable:true}, {kind:'name',text:'x',executable:false},
      {kind:'name',text:']',executable:true}, {kind:'name',text:'<<',executable:true},
      {kind:'name',text:'>>',executable:true},
    ]}});
  });
  it('resolves immediate names only when reached and also inside procedures', () => {
    let binding: PsValue = {kind:'integer',value:1,executable:false};
    const source = bytes('/x //x {//x}');
    const scan = new PsScanner(source, new PsMemory(new PsBudget()), text => {
      expect(text).toBe('x'); return binding;
    });
    expect(scan.next()).toEqual({kind:'name',text:'x',executable:false});
    binding = {kind:'integer',value:2,executable:false};
    expect(scan.next()).toBe(binding);
    binding = {kind:'integer',value:3,executable:false};
    expect(scan.next()).toMatchObject({kind:'array',body:{values:[{kind:'integer',value:3,executable:false}]}});
    expect(() => scanner('//missing').next()).toThrowError(expect.objectContaining({errorName:'undefined',offset:0}));
  });
  it('preserves live source and byte positions without consuming trailing delimiters', () => {
    const source = bytes('%comment\r\n123[456');
    const scan = new PsScanner(source, new PsMemory(new PsBudget()));
    expect(scan.source).toBe(source);
    expect(scan.position).toBe(0);
    expect(scan.next()).toEqual({kind:'integer',value:123,executable:false});
    expect(scan.position).toBe(13);
    expect(scan.next()).toEqual({kind:'name',text:'[',executable:true});
    source[14] = 57;
    expect(scan.next()).toEqual({kind:'integer',value:956,executable:false});
    expect(scan.position).toBe(17);
    expect(scan.next()).toBeUndefined();
    const data = scanner('read DATA 2');
    data.next(); data.position = 10;
    expect(data.next()).toEqual({kind:'integer',value:2,executable:false});
  });
  it('skips all PostScript whitespace and comments including a comment at EOF', () => {
    expect(all(scanner('\x00\t\n\f\r %abc\n1%last'))).toEqual([{kind:'integer',value:1,executable:false}]);
  });
  // Adobe PLRM token p703 and Syntax pp26-27: CRLF is one separator.
  it.each(['15', '2.5', '16#ff', 'abc', '/abc', '//abc'])('consumes one whitespace terminator after %s', token => {
    for (const separator of [' ', '\t', '\x00', '\f', '\n', '\r', '\r\n']) {
      const scan = new PsScanner(bytes(token + separator + ' rest'), new PsMemory(new PsBudget()), () => ({kind:'integer',value:7,executable:false}));
      scan.next();
      expect(scan.position).toBe(token.length + separator.length);
      expect(scan.source[scan.position]).toBe(32);
    }
  });
  it.each(['15', 'abc', '/abc', '//abc'])('retains a non-whitespace delimiter after %s', token => {
    for (const delimiter of ['[', ']', '{', '}', '(', ')', '<', '>', '/', '%']) {
      const scan = new PsScanner(bytes(token + delimiter), new PsMemory(new PsBudget()), () => ({kind:'integer',value:7,executable:false}));
      scan.next(); expect(scan.position).toBe(token.length);
    }
  });
  it('ends comments at form feed without discarding the next token', () => {
    expect(all(scanner('% comment\f42'))).toEqual([{kind:'integer',value:42,executable:false}]);
  });
  it('charges consumed terminators as source work without extending a word token span', () => {
    expect(scanner('abc\r\n', {maxObjectBytes:3}).next()).toEqual({kind:'name',text:'abc',executable:true});
    expect(() => scanner('1 ', {maxPostScriptOperations:3}).next()).toThrowError(expect.objectContaining({limit:'maxPostScriptOperations',allowed:3,reached:4}));
    expect(() => scanner('{abc\r\n}', {maxObjectBytes:5}).next()).toThrowError(expect.objectContaining({limit:'maxObjectBytes',allowed:5,reached:6,detail:'PostScript procedure'}));
  });
  it('bounds malformed-token diagnostics before their view, copy and proportional work', () => {
    // (bad: 144 builder bytes, a 64-byte view, then 64 + 4 string bytes;
    // four source reads followed by four initialization work units.
    expect(() => scanner('(bad', {maxPostScriptVmBytes:207}).next()).toThrowError(expect.objectContaining({limit:'maxPostScriptVmBytes',allowed:207,reached:208,detail:'PostScript error-token view'}));
    expect(() => scanner('(bad', {maxPostScriptVmBytes:275}).next()).toThrowError(expect.objectContaining({limit:'maxPostScriptVmBytes',allowed:275,reached:276,detail:'string'}));
    expect(() => scanner('(bad', {maxPostScriptVmBytes:276,maxPostScriptOperations:8}).next()).toThrowError(expect.objectContaining({errorName:'syntaxerror',offset:0,command:expect.objectContaining({kind:'string',length:4})}));
    expect(() => scanner('(bad', {maxPostScriptOperations:7}).next()).toThrowError(expect.objectContaining({limit:'maxPostScriptOperations',allowed:7,reached:8,detail:'string initialization'}));
    expect(() => scanner('(bad', {maxContainerItems:3}).next()).toThrowError(expect.objectContaining({limit:'maxContainerItems',allowed:3,reached:4}));
  });
  it.each(['(abc', '(a\\', '<0', '<GG>', '<~!!', '<~!~>', '<~!z~>', '<~uuuuu~>', '<~!v~>', '<~!!~x', '{1', '}', ')', '>'])('rejects malformed source %j with its starting offset', source => {
    expect(() => scanner('  ' + source).next()).toThrowError(expect.objectContaining({errorName:'syntaxerror',offset:2}));
  });
  it('bounds source bytes before scanning and token bytes during reads', () => {
    expect(() => scanner('1234', {maxFileBytes:3})).toThrowError(expect.objectContaining({limit:'maxFileBytes'}));
    expect(scanner('abc',{maxObjectBytes:3}).next()).toEqual({kind:'name',text:'abc',executable:true});
    for (const source of ['abcd', '(abcd)', '<414243>', '<~!!!!!~>', '{1 2 3}']) {
      expect(() => scanner(source, {maxObjectBytes:3}).next()).toThrowError(expect.objectContaining({limit:'maxObjectBytes'}));
    }
  });
  it('bounds procedure item growth and combined procedure/string nesting', () => {
    expect(() => scanner('{1 2}', {maxContainerItems:1}).next()).toThrowError(expect.objectContaining({limit:'maxContainerItems'}));
    expect(() => scanner('{{1}}', {maxNestingDepth:1}).next()).toThrowError(expect.objectContaining({limit:'maxNestingDepth'}));
    expect(() => scanner('{(a(b))}', {maxNestingDepth:2}).next()).toThrowError(expect.objectContaining({limit:'maxNestingDepth'}));
    expect(() => scanner('{'.repeat(20000) + '}'.repeat(20000), {maxNestingDepth:20000,maxPostScriptVmBytes:10000000}).next()).not.toThrow();
  });
  it('charges cumulative scanning work even for whitespace and repeated source scans', () => {
    expect(() => scanner(' '.repeat(11), {maxPostScriptOperations:10}).next()).toThrowError(expect.objectContaining({limit:'maxPostScriptOperations'}));
    const memory = new PsMemory(new PsBudget(LoadLimits.defaults.with({maxPostScriptOperations:5})));
    new PsScanner(bytes('1'),memory).next();
    expect(() => new PsScanner(bytes('1'),memory).next()).toThrowError(expect.objectContaining({limit:'maxPostScriptOperations'}));
  });
  it('refuses scanner builders, name text and decoded storage before large allocation', () => {
    for (const source of ['{', 'a'.repeat(1000), '('+'a'.repeat(1000)+')', '<'+'00'.repeat(1000)+'>', '<~'+'z'.repeat(1000)+'~>']) {
      expect(() => scanner(source,{maxPostScriptVmBytes:63}).next()).toThrowError(expect.objectContaining({limit:'maxPostScriptVmBytes'}));
    }
    const memory = new PsMemory(new PsBudget(LoadLimits.defaults.with({maxPostScriptVmBytes:400})));
    new PsScanner(bytes('/abc'),memory).next();
    new PsScanner(bytes('/abc'),memory).next();
    expect(() => new PsScanner(bytes('/abc'),memory).next()).toThrowError(expect.objectContaining({limit:'maxPostScriptVmBytes'}));
  });
});


it('constructs procedures with current packing and rejects packed writes', () => {
  const memory = new PsMemory(new PsBudget());
  let packing = true;
  const scan = new PsScanner(bytes('{1} {2}'), memory, undefined, () => packing);
  const packed = scan.next();
  expect(packed).toMatchObject({kind:'array',executable:true,body:{packed:true}});
  if (packed?.kind !== 'array') throw new Error('expected procedure');
  expect(() => memory.put(packed,0,{kind:'integer',value:9,executable:false})).toThrowError(expect.objectContaining({errorName:'invalidaccess'}));
  packing = false;
  expect(scan.next()).toMatchObject({kind:'array',executable:true,body:{packed:false}});
});

it('counts hexadecimal and ASCII85 strings in combined nesting depth', () => {
  for (const source of ['{<>}', '{<~~>}']) {
    expect(() => scanner(source,{maxNestingDepth:1}).next()).toThrowError(expect.objectContaining({limit:'maxNestingDepth'}));
  }
});

it('interprets unsigned radix bit patterns as signed integers and bounds radix overflow', () => {
  expect(all(scanner('16#ffffffff 16#80000000'))).toEqual([
    {kind:'integer',value:-1,executable:false}, {kind:'integer',value:-2147483648,executable:false},
  ]);
  expect(() => scanner('16#100000000').next()).toThrowError(expect.objectContaining({errorName:'limitcheck',offset:0}));
});


it('allows exact source, token, nesting and item boundaries', () => {
  expect(scanner('123',{maxFileBytes:3}).next()).toEqual({kind:'integer',value:123,executable:false});
  expect(scanner('()',{maxObjectBytes:2,maxNestingDepth:1}).next()).toMatchObject({kind:'string',length:0});
  expect(scanner('{1}',{maxObjectBytes:3,maxContainerItems:1,maxNestingDepth:1}).next()).toMatchObject({kind:'array',length:1});
  expect(scanner('{{}}',{maxNestingDepth:2}).next()).toMatchObject({kind:'array',length:1});
  expect(scanner('(a)',{maxContainerItems:1}).next()).toMatchObject({kind:'string',length:1});
  expect(() => scanner('(ab)',{maxContainerItems:1}).next()).toThrowError(expect.objectContaining({limit:'maxContainerItems'}));
});

it('allows exact cumulative work and allocation, refusing the next charge', () => {
  const workMemory = new PsMemory(new PsBudget(LoadLimits.defaults.with({maxPostScriptOperations:3})));
  expect(new PsScanner(bytes('1'),workMemory).next()).toEqual({kind:'integer',value:1,executable:false});
  expect(() => new PsScanner(bytes(' '),workMemory).next()).toThrowError(expect.objectContaining({limit:'maxPostScriptOperations',allowed:3,reached:4}));
  const byteMemory = new PsMemory(new PsBudget(LoadLimits.defaults.with({maxPostScriptVmBytes:128})));
  expect(new PsScanner(bytes('{}'),byteMemory).next()).toMatchObject({kind:'array',length:0});
  expect(() => new PsScanner(bytes('{}'),byteMemory).next()).toThrowError(expect.objectContaining({limit:'maxPostScriptVmBytes',allowed:128,reached:192}));
  expect(() => scanner('{}',{maxPostScriptVmBytes:127}).next()).toThrowError(expect.objectContaining({limit:'maxPostScriptVmBytes',allowed:127,reached:128}));
});

it('preserves immediate object identity and named faults from real lookup', () => {
  const memory = new PsMemory(new PsBudget());
  const dict = memory.dictionary();
  const key = memory.name('x');
  const value = memory.arrayFrom([{kind:'integer',value:7,executable:false}],true);
  memory.put(dict,key,value);
  const scan = new PsScanner(bytes('//x //absent'),memory,text => memory.get(dict,memory.name(text)));
  expect(scan.next()).toBe(value);
  expect(() => scan.next()).toThrowError(expect.objectContaining({errorName:'undefined'}));
});
