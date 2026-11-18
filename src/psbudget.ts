import { LoadLimits } from './loadlimits.js';

export interface PsReservation {
  commit(bytes: number, operations: number): void;
  cancel(): void;
}

/** Deterministic conservative charges: 64 bytes per body, 16 per array slot,
 *  64 per dictionary entry, one per string byte, two per name character;
 *  snapshots use the same slot/entry charges. Execution and scanner-error byte
 *  views cost 64; scanner-error strings also pay normal string copy/work costs.
 *  Restore scratch uses 16 bytes per pending value and 64 per visited body. Copies and journals charge work
 *  per slot/entry/byte before bulk operations. Charges are cumulative, including
 *  discarded scratch and restored VM; they are not a JavaScript heap measure.
 *  Callers charge execution-frame and stack storage. */
export class PsBudget {
  private operations = 0;
  private bytes = 0;
  private reservedBytes = 0;
  private reservedOperations = 0;
  private trusted = 0;
  constructor(readonly limits = LoadLimits.defaults) {}
  get remainingBytes(): number {
    return this.limits.maxPostScriptVmBytes === null ? Infinity
      : this.limits.maxPostScriptVmBytes - this.bytes - this.reservedBytes;
  }
  get remainingOperations(): number {
    return this.limits.maxPostScriptOperations === null ? Infinity
      : this.limits.maxPostScriptOperations - this.operations - this.reservedOperations;
  }
  private count(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('PostScript budget charges must be nonnegative safe integers');
  }
  work(count = 1, detail?: string): void {
    this.count(count);
    if (this.trusted) return;
    this.limits.enforce('maxPostScriptOperations', this.operations + this.reservedOperations + count, detail);
    this.operations += count;
  }
  allocate(bytes: number, detail?: string): void {
    this.count(bytes);
    if (this.trusted) return;
    this.limits.enforce('maxPostScriptVmBytes', this.bytes + this.reservedBytes + bytes, detail);
    this.bytes += bytes;
  }
  /** Hold capacity before a bounded native operation allocates. Only committed
   * actual costs enter the cumulative totals. Cleanup releases unused capacity. */
  reserve(bytes: number, operations: number): PsReservation {
    this.count(bytes);
    this.count(operations);
    const trusted = this.trusted > 0;
    if (!trusted) {
      this.limits.enforce('maxPostScriptVmBytes', this.bytes + this.reservedBytes + bytes, 'reservation');
      this.limits.enforce('maxPostScriptOperations', this.operations + this.reservedOperations + operations, 'reservation');
      this.reservedBytes += bytes;
      this.reservedOperations += operations;
    }
    let active = true;
    const finish = (actualBytes: number, actualOperations: number): void => {
      this.count(actualBytes);
      this.count(actualOperations);
      if (!active || actualBytes > bytes || actualOperations > operations)
        throw new RangeError('Invalid PostScript reservation finalization');
      active = false;
      if (!trusted) {
        this.reservedBytes -= bytes;
        this.reservedOperations -= operations;
        this.bytes += actualBytes;
        this.operations += actualOperations;
      }
    };
    return { commit: finish, cancel: () => finish(0, 0) };
  }
  depth(reached: number, detail?: string): void { this.count(reached); if (!this.trusted) this.limits.enforce('maxNestingDepth', reached, detail); }
  items(reached: number, detail?: string): void { this.count(reached); if (!this.trusted) this.limits.enforce('maxContainerItems', reached, detail); }
  /** Only for fixed host initialization, never while executing source. */
  bootstrap<T>(callback: () => T): T { this.trusted++; try { return callback(); } finally { this.trusted--; } }
}
