import type { PsByteInput } from './psinput.js';
import type { PsBudget } from './psbudget.js';
import type { DecodeBudget } from './decodebudget.js';
import { PsFault } from './psvalue.js';

/** Find a native codec's end without reading any following PostScript source.
 * This framing pass retains no decoded data; the normal decoder validates the
 * payload and checksum. Its bit reads and Huffman storage share the VM budget. */
export function psEncodedLength(input: PsByteInput, start: number, filter: string,
  early: number, budget: PsBudget, decode: DecodeBudget): number {
  let at = start, buffer = 0, count = 0;
  const byte = (): number => {
    budget.work(1, 'encoded stream framing');
    budget.limits.enforce('maxFileBytes', at - start + 1, 'encoded stream');
    const value = input.byteAt(at++); if (value === undefined) throw new PsFault('ioerror'); return value;
  };
  const bits = (n: number): number => {
    while (count < n) { buffer |= byte() << count; count += 8; }
    const value = buffer & ((1 << n) - 1); buffer >>>= n; count -= n; return value;
  };
  if (filter === 'LZWDecode') {
    let width = 9, next = 258, previous = false;
    // LZW codes are MSB first, unlike Deflate's byte packing.
    for (;;) {
      budget.work(1, 'LZW framing code');
      while (count < width) { buffer = (buffer << 8) | byte(); count += 8; }
      count -= width;
      const code = (buffer >>> count) & ((1 << width) - 1);
      buffer &= (1 << count) - 1;
      if (code === 257) return at - start;
      if (code === 256) { width = 9; next = 258; previous = false; continue; }
      if (code > next || code === next && !previous) throw new PsFault('ioerror');
      if (previous && next < 4096) { next++; if (next === (1 << width) - early && width < 12) width++; }
      previous = true;
    }
  }
  const cmf = byte(), flags = byte();
  if ((cmf & 15) !== 8 || cmf >> 4 > 7 || ((cmf << 8) + flags) % 31 || flags & 32) throw new PsFault('ioerror');
  type Tree = Map<number, number>;
  const tree = (lengths: readonly number[]): Tree => {
    budget.allocate(128 + lengths.length * 48, 'Deflate framing tree'); budget.work(lengths.length, 'Deflate framing tree');
    const counts = new Array<number>(16).fill(0), next = new Array<number>(16).fill(0), result = new Map<number, number>();
    for (const length of lengths) { if (length < 0 || length > 15) throw new PsFault('ioerror'); counts[length] = counts[length]! + 1; }
    let code = 0;
    for (let length = 1; length <= 15; length++) {
      code = (code + (length === 1 ? 0 : counts[length - 1]!)) * 2;
      if (code + counts[length]! > 1 << length) throw new PsFault('ioerror');
      next[length] = code;
    }
    for (let symbol = 0; symbol < lengths.length; symbol++) {
      const length = lengths[symbol]!;
      if (length) { const value = next[length]!; next[length] = value + 1; result.set((1 << length) + value, symbol); }
    }
    return result;
  };
  const symbol = (codes: Tree): number => {
    let code = 0;
    for (let length = 1; length <= 15; length++) {
      budget.work(1, 'Deflate framing symbol'); code = code * 2 + bits(1);
      const value = codes.get((1 << length) + code); if (value !== undefined) return value;
    }
    throw new PsFault('ioerror');
  };
  // RFC 1951 length/distance tables, fixed-size host constants.
  const lengthBase = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const lengthExtra = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const distanceExtra = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  let final = 0, output = 0;
  do {
    final = bits(1); const kind = bits(2);
    if (kind === 0) {
      buffer = 0; count = 0;
      const size = byte() + byte() * 256, inverse = byte() + byte() * 256;
      if ((size ^ inverse) !== 65535) throw new PsFault('ioerror');
      output += size; decode.check(output, at - start, undefined, 'Deflate framing');
      for (let i = 0; i < size; i++) byte();
      continue;
    }
    let literals: Tree, distances: Tree;
    if (kind === 1) {
      budget.allocate(320 * 8, 'Deflate framing lengths');
      literals = tree(Array.from({ length: 288 }, (_, i) => i <= 143 ? 8 : i <= 255 ? 9 : i <= 279 ? 7 : 8));
      distances = tree(new Array<number>(32).fill(5));
    } else if (kind === 2) {
      const nl = bits(5) + 257, nd = bits(5) + 1, nc = bits(4) + 4;
      if (nl > 286) throw new PsFault('ioerror');
      budget.allocate((19 + nl + nd) * 16, 'Deflate framing lengths');
      const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
      const lengths = new Array<number>(19).fill(0);
      for (let i = 0; i < nc; i++) lengths[order[i]!] = bits(3);
      const codes = tree(lengths), values: number[] = [];
      while (values.length < nl + nd) {
        const code = symbol(codes);
        if (code <= 15) values.push(code);
        else {
          if (code === 16 && !values.length) throw new PsFault('ioerror');
          const repeat = code === 16 ? bits(2) + 3 : code === 17 ? bits(3) + 3 : bits(7) + 11;
          const value = code === 16 ? values[values.length - 1]! : 0;
          if (values.length + repeat > nl + nd) throw new PsFault('ioerror');
          budget.work(repeat, 'Deflate framing repeat'); for (let i = 0; i < repeat; i++) values.push(value);
        }
      }
      if (!values[256]) throw new PsFault('ioerror');
      literals = tree(values.slice(0, nl)); distances = tree(values.slice(nl));
    } else throw new PsFault('ioerror');
    for (;;) {
      const code = symbol(literals);
      if (code === 256) break;
      if (code < 256) output++;
      else {
        if (code > 285) throw new PsFault('ioerror');
        output += lengthBase[code - 257]! + bits(lengthExtra[code - 257]!);
        const distance = symbol(distances); if (distance > 29) throw new PsFault('ioerror'); bits(distanceExtra[distance]!);
      }
      decode.check(output, at - start, undefined, 'Deflate framing');
    }
  } while (!final);
  // The Adler checksum starts at the next byte boundary.
  for (let i = 0; i < 4; i++) byte();
  return at - start;
}
