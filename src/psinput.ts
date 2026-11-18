import type { PsBudget } from './psbudget.js';
import { PsFault } from './psvalue.js';

/** Peeks never commit a cursor. Pull adapters own and meter any lookahead cache. */
export interface PsByteInput {
  position: number;
  readonly closed: boolean;
  peekLineFeed?(): boolean;
  byteAt(index: number): number | undefined;
  span(start: number, end: number): Uint8Array;
  available(): number;
  close(): void;
}

export function byteInput(bytes: Uint8Array, budget: PsBudget): PsByteInput {
  budget.limits.enforce('maxFileBytes', bytes.length, 'PostScript source');
  budget.allocate(64, 'PostScript input');
  let closed = false;
  return {
    position: 0, get closed() { return closed; },
    byteAt(index) { return bytes[index]; },
    span(start, end) {
      if (start < 0 || end < start || end > bytes.length) throw new PsFault('rangecheck');
      return bytes.subarray(start, end);
    },
    available() { return this.closed ? 0 : bytes.length - this.position; },
    close() { closed = true; },
  };
}
