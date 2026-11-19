import type { PsBudget } from './psbudget.js';
import type { PsBox } from './psstate.js';
import { PdfParseError } from './errors.js';

type BoxDeclaration = PsBox | 'atend';
const RELEVANT = /^(?:BoundingBox|HiResBoundingBox|Trailer|EOF|EndComments|Begin(?:Document|File|Resource|Font|ProcSet|Prolog|Setup|Preview|Binary|Data)|End(?:Document|File|Resource|Font|ProcSet|Prolog|Setup|Preview))$/;

/** Read structural metadata only. Never rewrite source or allocate executable
 * values: currentfile and counted byte offsets must survive this pass exactly. */
export function readEpsBox(source: Uint8Array, budget: PsBudget): PsBox {
  let at = 0, bol = true, literal = 0;
  let lexical: 'code' | 'hex' | 'ascii85' = 'code';
  let region: 'header' | 'body' | 'trailer' = 'header';
  const stack: string[] = [];
  const declarations = new Map<string, BoxDeclaration>(), resolved = new Map<string, PsBox>();
  const fail = (message: string): never => { throw new PdfParseError(`EPS: ${message}`, at); };
  const read = (): number => {
    budget.work();
    const c = source[at++]!;
    bol = c === 10 || c === 13;
    return c;
  };
  const endLine = (): void => {
    if (at < source.length) {
      const c = read();
      if (c === 13 && source[at] === 10) read();
    }
  };
  const skipLine = (): void => {
    while (at < source.length && source[at] !== 10 && source[at] !== 13) read();
  };
  const skipComment = (): void => {
    // Form feed terminates a PS comment, but is not a physical DSC line start.
    while (at < source.length && source[at] !== 10 && source[at] !== 13 && source[at] !== 12) read();
  };
  const line = (): string => {
    const start = at;
    skipComment();
    const size = at - start;
    budget.limits.enforce('maxObjectBytes', size, 'EPS DSC line');
    budget.allocate(64 + size * 2, 'EPS DSC line');
    let text = '';
    for (let i = start; i < at; i++) text += String.fromCharCode(source[i]!);
    endLine();
    return text;
  };
  const box = (args: string, hi: boolean): PsBox => {
    budget.allocate(128, 'EPS box token scratch');
    const values = args.trim().split(/[ \t]+/, 5);
    if (values.length !== 4) fail('invalid bounding box');
    const grammar = hi ? /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/ : /^[+-]?\d+$/;
    const nums = values.map(s => {
      if (!grammar.test(s)) fail('invalid bounding coordinate');
      const n = Number(s);
      if (!Number.isFinite(n) || !hi && !Number.isSafeInteger(n)) fail('invalid bounding coordinate');
      return n;
    }) as PsBox;
    if (nums[2] <= nums[0] || nums[3] <= nums[1]
      || !Number.isFinite(nums[2] - nums[0]) || !Number.isFinite(nums[3] - nums[1]))
      fail('empty or reversed bounding box');
    return nums;
  };
  const same = (a: BoxDeclaration, b: BoxDeclaration): boolean =>
    a === 'atend' || b === 'atend' ? a === b : a.every((v, i) => v === b[i]);
  const counted = (kind: string, args: string): void => {
    budget.allocate(128, 'EPS counted token scratch');
    const parts = args.trim().split(/[ \t]+/, 4), count = Number(parts[0]);
    if (!/^\d+$/.test(parts[0] ?? '') || !Number.isSafeInteger(count)) fail('invalid data count');
    let unit = 'Bytes';
    if (kind === 'Data') {
      if (parts.length > 3 || parts[1] && !['Binary', 'Hex', 'ASCII'].includes(parts[1])) fail('invalid data type');
      if (parts[2] && !['Bytes', 'Lines'].includes(parts[2])) fail('invalid data unit');
      unit = parts[2] ?? 'Bytes';
    } else if (parts.length !== 1) fail('invalid binary count');
    if (unit === 'Bytes') {
      if (count > source.length - at) fail('truncated counted data');
      budget.work(count, 'EPS data span');
      at += count;
      bol = at === 0 || source[at - 1] === 10 || source[at - 1] === 13;
    } else {
      for (let n = 0; n < count; n++) {
        if (at >= source.length) fail('truncated counted data');
        skipLine(); endLine();
      }
    }
    if (!bol && at < source.length && (source[at] === 10 || source[at] === 13)) endLine();
    if (!bol || at >= source.length || line().trim() !== `%%End${kind}`) fail('missing counted data end');
  };

  while (at < source.length) {
    const c = source[at]!;
    if (stack.at(-1) === 'Preview') {
      // Preview rows are opaque, including apparent strings or nested DSC.
      const start = at;
      skipLine();
      const marker = '%%EndPreview';
      let matches = at - start >= marker.length;
      for (let i = 0; matches && i < marker.length; i++) matches = source[start + i] === marker.charCodeAt(i);
      for (let i = start + marker.length; matches && i < at; i++) matches = source[i] === 32 || source[i] === 9;
      if (matches) stack.pop();
      endLine();
      continue;
    }
    if (literal) {
      read();
      if (c === 92 && at < source.length) {
        const escaped = read();
        if (escaped === 13 && source[at] === 10) read();
      } else if (c === 40) budget.depth(++literal, 'EPS string');
      else if (c === 41) literal--;
      continue;
    }
    if (lexical !== 'code') {
      read();
      if (lexical === 'hex' && c === 62) lexical = 'code';
      else if (lexical === 'ascii85' && c === 126 && source[at] === 62) { read(); lexical = 'code'; }
      continue;
    }
    if (bol && c === 37 && source[at + 1] === 37) {
      // Retain arguments only for the small DSC vocabulary we interpret.
      const start = at;
      let end = at + 2;
      while (end < source.length && end - start < 32 && ![58, 32, 9, 10, 13, 12].includes(source[end]!)) end++;
      budget.work(end - start);
      let key = '';
      for (let i = at + 2; i < end; i++) key += String.fromCharCode(source[i]!);
      if (!RELEVANT.test(key)) { skipComment(); continue; }
      const text = line(), colon = text.indexOf(':'), args = colon < 0 ? '' : text.slice(colon + 1).trim();
      if (key === 'BeginBinary' || key === 'BeginData') { counted(key.slice(5), args); continue; }
      if (key.startsWith('Begin')) {
        const type = key.slice(5);
        budget.items(stack.length + 1, 'EPS DSC regions');
        budget.depth(stack.length + 1, 'EPS DSC regions');
        budget.allocate(64, 'EPS DSC region');
        stack.push(type);
        if (region === 'header' && type !== 'Preview') region = 'body';
        continue;
      }
      if (key.startsWith('End') && key !== 'EndComments') {
        if (stack.pop() !== key.slice(3)) fail('mismatched DSC region');
        continue;
      }
      if (stack.length) continue;
      if (key === 'EOF') break;
      if (key === 'EndComments') { region = 'body'; continue; }
      if (key === 'Trailer') {
        if (region === 'trailer') fail('duplicate trailer');
        region = 'trailer'; continue;
      }
      if ((key === 'BoundingBox' || key === 'HiResBoundingBox') && region !== 'body') {
        const value = args === '(atend)' ? 'atend' : box(args, key === 'HiResBoundingBox');
        budget.allocate(96, 'EPS bounding metadata');
        if (region === 'header') {
          const prior = declarations.get(key);
          if (prior !== undefined && !same(prior, value)) fail('conflicting bounding boxes');
          declarations.set(key, value);
        } else {
          if (value === 'atend') return fail('deferred trailer box');
          const prior = resolved.get(key);
          if (prior && !same(prior, value)) fail('conflicting trailer boxes');
          const header = declarations.get(key);
          if (header && header !== 'atend' && !same(header, value)) fail('conflicting trailer box');
          if (header === undefined) fail('undeclared trailer box');
          resolved.set(key, value);
        }
      }
      continue;
    }
    if (c === 37) { skipComment(); continue; }
    read();
    if ([10, 13, 32, 9, 12, 0].includes(c)) continue;
    if (region === 'header') region = 'body';
    if (c === 40) { literal = 1; budget.depth(1, 'EPS string'); }
    else if (c === 60) {
      if (source[at] === 60) read();
      else if (source[at] === 126) { read(); lexical = 'ascii85'; }
      else lexical = 'hex';
    }
  }
  if (literal || lexical !== 'code' || stack.length) fail('unterminated lexical or DSC region');
  const result = (key: string): PsBox | undefined => {
    const value = declarations.get(key);
    if (value === 'atend') {
      const found = resolved.get(key);
      if (!found) fail('unresolved deferred box');
      return found;
    }
    return value;
  };
  const base = result('BoundingBox');
  if (!base) return fail('missing BoundingBox');
  const hi = result('HiResBoundingBox');
  if (hi && (hi[0] < base[0] - 1e-7 || hi[1] < base[1] - 1e-7 || hi[2] > base[2] + 1e-7 || hi[3] > base[3] + 1e-7))
    fail('HiResBoundingBox outside BoundingBox');
  return [...(hi ?? base)] as PsBox;
}
