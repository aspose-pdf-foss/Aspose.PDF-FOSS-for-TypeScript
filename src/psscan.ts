import type { PsByteInput } from './psinput.js';
import type { PsMemory } from './psmemory.js';
import { integer, real, PsFault, type PsValue, type PsString } from './psvalue.js';

const whitespace = (c: number): boolean => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const delimiter = (c: number): boolean => whitespace(c) || c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
const hex = (c: number): number => c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
type Builder = { start: number; values: PsValue[] };

/** Lazy byte scanner. The source is retained by reference; position is the next
 * unread byte and may be advanced by host inline-data operators. Callers using
 * executable VM strings must retain their original PsString as a restore root.
 * Names/numbers consume one following whitespace separator (CRLF is one);
 * other terminating delimiters remain unread. All scratch storage is charged
 * cumulatively, including discarded buffers and malformed-token diagnostics. */
export class PsScanner implements PsByteInput {
  readonly input: PsByteInput;
  private readonly arraySource?: Uint8Array;
  private index = 0;
  private finished = false;
  get position(): number { return this.input === this ? this.index : this.input.position; }
  set position(value: number) { if (this.input === this) this.index = value; else this.input.position = value; }
  get closed(): boolean { return this.input === this ? this.finished : this.input.closed; }
  /** Legacy direct-byte access remains available for array-backed host scanners. */
  get source(): Uint8Array {
    if (!this.arraySource) throw new PsFault('invalidaccess');
    return this.arraySource;
  }
  byteAt(index: number): number | undefined { return this.input === this ? this.arraySource![index] : this.input.byteAt(index); }
  span(start: number, end: number): Uint8Array {
    return this.input === this ? this.arraySource!.subarray(start, end) : this.input.span(start, end);
  }
  available(): number { return this.input === this ? this.finished ? 0 : this.arraySource!.length - this.index : this.input.available(); }
  close(): void { if (this.input === this) this.finished = true; else this.input.close(); }
  /** Start of the current/last lexical token, including an immediate name. */
  lastTokenOffset = 0;
  private procedureStart: number | undefined;
  constructor(
    source: Uint8Array | PsByteInput,
    readonly memory: PsMemory,
    readonly resolveImmediate?: (text: string) => PsValue,
    readonly currentPacking?: () => boolean,
  ) {
    if (source instanceof Uint8Array) {
      memory.budget.limits.enforce('maxFileBytes', source.length, 'PostScript source');
      this.arraySource = source; this.input = this;
    } else this.input = source;
  }

  private fault(start: number): never {
    this.memory.budget.allocate(64, 'PostScript error-token view');
    const command = this.memory.string(this.input.span(start, this.position));
    throw new PsFault('syntaxerror', start, command);
  }
  private read(start?: number): number {
    if (this.input.byteAt(this.position) === undefined) this.fault(start ?? this.position);
    this.memory.budget.limits.enforce('maxFileBytes', this.position + 1, 'PostScript source');
    if (start !== undefined) this.memory.budget.limits.enforce('maxObjectBytes', this.position + 1 - start, 'PostScript token');
    if (this.procedureStart !== undefined) this.memory.budget.limits.enforce('maxObjectBytes', this.position + 1 - this.procedureStart, 'PostScript procedure');
    this.memory.budget.work(1, 'PostScript source byte');
    return this.input.byteAt(this.position++)!;
  }
  private skip(): void {
    while (this.input.byteAt(this.position) !== undefined) {
      const c = this.input.byteAt(this.position)!;
      if (whitespace(c)) this.read();
      else if (c === 37) {
        do { this.read(); } while (this.input.byteAt(this.position) !== undefined && this.input.byteAt(this.position) !== 10 && this.input.byteAt(this.position) !== 13 && this.input.byteAt(this.position) !== 12);
      } else break;
    }
  }
  next(): PsValue | undefined {
    if (!Number.isSafeInteger(this.position) || this.position < 0 || (this.position > 0 && this.input.byteAt(this.position - 1) === undefined)) throw new PsFault('rangecheck', this.position);
    if (this.input.closed) return undefined;
    this.procedureStart = undefined;
    const builders: Builder[] = [];
    let outerStart = this.position;
    while (true) {
      this.skip();
      if (this.input.byteAt(this.position) === undefined) {
        if (builders.length) this.fault(builders[0]!.start);
        return undefined;
      }
      const start = this.position;
      if (builders.length === 0) outerStart = start;
      this.lastTokenOffset = start;
      const c = this.read(start);
      if (c === 123) {
        this.memory.budget.depth(builders.length + 1, 'PostScript procedure');
        this.memory.budget.allocate(64, 'PostScript procedure builder');
        builders.push({ start, values: [] });
        this.procedureStart ??= start;
        continue;
      }
      let value: PsValue;
      if (c === 125) {
        const builder = builders.pop();
        if (!builder) this.fault(start);
        value = this.memory.arrayFrom(builder.values, true, this.currentPacking?.() ?? false);
        if (builders.length === 0) this.procedureStart = undefined;
      } else if (c === 40) value = this.literalString(start, builders.length);
      else if (c === 60) {
        if (this.input.byteAt(this.position) === 60) { this.read(start); value = this.memory.name('<<', true); }
        else if (this.input.byteAt(this.position) === 126) { this.read(start); value = this.encodedString(start, true, builders.length); }
        else value = this.encodedString(start, false, builders.length);
      } else if (c === 62) {
        if (this.input.byteAt(this.position) !== 62) this.fault(start);
        this.read(start); value = this.memory.name('>>', true);
      } else if (c === 41) this.fault(start);
      else if (c === 91 || c === 93) value = this.memory.name(String.fromCharCode(c), true);
      else value = this.word(start, c === 47);
      if (builders.length === 0) {
        if (c === 125) this.lastTokenOffset = outerStart;
        return value;
      }
      const builder = builders[builders.length - 1]!;
      this.memory.budget.items(builder.values.length + 1, 'PostScript procedure');
      this.memory.budget.allocate(16, 'PostScript procedure builder slot');
      builder.values.push(value);
    }
  }
  private word(start: number, literal: boolean): PsValue {
    let immediate = false;
    if (literal && this.input.byteAt(this.position) === 47) { this.read(start); immediate = true; }
    const textStart = literal ? this.position : start;
    while (this.input.byteAt(this.position) !== undefined && !delimiter(this.input.byteAt(this.position)!)) this.read(start);
    const length = this.position - textStart;
    this.memory.budget.allocate(64 + length * 2, 'PostScript token text');
    this.memory.budget.work(length, 'PostScript token text');
    let text = '';
    for (let i = textStart; i < this.position; i++) text += String.fromCharCode(this.input.byteAt(i)!);
    // PLRM token: consume only the first whitespace separator, treating CRLF
    // as one newline. It is source work, outside the word's object span.
    if (this.input.byteAt(this.position) !== undefined && whitespace(this.input.byteAt(this.position)!)) {
      if (this.read() === 13 && (this.input.peekLineFeed?.() ?? (this.input.byteAt(this.position) === 10))) this.read();
    }
    if (immediate) {
      if (!this.resolveImmediate) throw new PsFault('undefined', start);
      return this.resolveImmediate(text);
    }
    if (!literal) {
      this.memory.budget.work(length, 'PostScript number recognition');
      if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) {
        const n = Number(text);
        if (!Number.isFinite(n)) throw new PsFault('limitcheck', start);
        this.memory.budget.allocate(16, 'PostScript number');
        return /^[+-]?\d+$/.test(text) && n >= -2147483648 && n <= 2147483647 ? integer(n) : real(n);
      }
      // Parse radix text without source-sized regexp capture strings. The
      // decimal regexp above has disjoint digit runs to avoid quadratic
      // backtracking on a long numeric-looking executable name.
      let separator = 0, base = 0;
      while (separator < length && text.charCodeAt(separator) >= 48 && text.charCodeAt(separator) <= 57) {
        base = base * 10 + text.charCodeAt(separator++) - 48;
      }
      if (base >= 2 && base <= 36 && text[separator] === '#' && separator + 1 < length) {
        let n = 0, valid = true;
        for (let i = separator + 1; i < length; i++) {
          const c = text.charCodeAt(i);
          const digit = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 90 ? c - 55 : c >= 97 && c <= 122 ? c - 87 : -1;
          if (digit < 0 || digit >= base) { valid = false; break; }
          n = n * base + digit;
        }
        if (valid) {
          if (n > 4294967295) throw new PsFault('limitcheck', start);
          this.memory.budget.allocate(16, 'PostScript number');
          return integer(n > 2147483647 ? n - 4294967296 : n);
        }
      }
    }
    return this.memory.name(text, !literal);
  }
  /** Typed scratch grows only after accounting. No source-sized number[] is
   * constructed. Memory owns the final string copy and its backing allocation. */
  private byteBuilder(): { push: (byte: number) => void; finish: () => PsString } {
    this.memory.budget.allocate(64, 'PostScript byte builder');
    let buffer = new Uint8Array(0), length = 0;
    return {
      push: byte => {
        this.memory.budget.items(length + 1, 'PostScript string');
        if (length === buffer.length) {
          const capacity = buffer.length === 0 ? 16 : buffer.length * 2;
          this.memory.budget.allocate(64 + capacity, 'PostScript byte scratch');
          this.memory.budget.work(length, 'PostScript byte scratch copy');
          const grown = new Uint8Array(capacity); grown.set(buffer); buffer = grown;
        }
        buffer[length++] = byte;
      },
      finish: () => {
        this.memory.budget.allocate(64, 'PostScript byte view');
        return this.memory.string(buffer.subarray(0, length));
      },
    };
  }
  private literalString(start: number, procedureDepth: number): PsString {
    this.memory.budget.depth(procedureDepth + 1, 'PostScript string');
    const out = this.byteBuilder();
    let depth = 1;
    while (true) {
      let c = this.read(start);
      if (c === 40) { this.memory.budget.depth(procedureDepth + depth + 1, 'PostScript string'); depth++; }
      else if (c === 41) { if (--depth === 0) return out.finish(); }
      else if (c === 92) {
        c = this.read(start);
        if (c === 10 || c === 13) {
          if (c === 13 && this.input.byteAt(this.position) === 10) this.read(start);
          continue;
        }
        if (c >= 48 && c <= 55) {
          let value = c - 48;
          for (let i = 1; i < 3; i++) {
            const next = this.input.byteAt(this.position);
            if (next === undefined || next < 48 || next > 55) break;
            value = value * 8 + this.read(start) - 48;
          }
          out.push(value & 255); continue;
        }
        c = c === 110 ? 10 : c === 114 ? 13 : c === 116 ? 9 : c === 98 ? 8 : c === 102 ? 12 : c;
      } else if (c === 13) {
        if (this.input.byteAt(this.position) === 10) this.read(start);
        c = 10;
      }
      out.push(c);
    }
  }
  private encodedString(start: number, ascii85: boolean, procedureDepth: number): PsString {
    this.memory.budget.depth(procedureDepth + 1, 'PostScript string');
    const out = this.byteBuilder();
    let count = 0, value = 0;
    while (true) {
      const c = this.read(start);
      if (whitespace(c)) continue;
      if (!ascii85) {
        if (c === 62) { if (count) out.push(value * 16); return out.finish(); }
        const digit = hex(c);
        if (digit < 0) this.fault(start);
        if (count === 0) { count = 1; value = digit; }
        else { out.push(value * 16 + digit); count = 0; }
      } else {
        if (c === 126) {
          if (this.read(start) !== 62 || count === 1) this.fault(start);
          if (count) {
            const bytes = count - 1;
            while (count++ < 5) value = value * 85 + 84;
            if (value > 4294967295) this.fault(start);
            for (let i = 0; i < bytes; i++) out.push((value >>> (24 - i * 8)) & 255);
          }
          return out.finish();
        }
        if (c === 122) {
          if (count) this.fault(start);
          for (let i = 0; i < 4; i++) out.push(0);
        } else {
          if (c < 33 || c > 117) this.fault(start);
          value = value * 85 + c - 33;
          if (++count === 5) {
            if (value > 4294967295) this.fault(start);
            for (let i = 0; i < 4; i++) out.push((value >>> (24 - i * 8)) & 255);
            value = 0; count = 0;
          }
        }
      }
    }
  }
}
