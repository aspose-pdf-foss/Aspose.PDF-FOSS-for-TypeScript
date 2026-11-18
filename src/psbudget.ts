import { LoadLimits } from './loadlimits.js';

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
  private trusted = 0;
  constructor(readonly limits = LoadLimits.defaults) {}
  private count(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('PostScript budget charges must be nonnegative safe integers');
  }
  work(count = 1, detail?: string): void {
    this.count(count);
    if (this.trusted) return;
    this.limits.enforce('maxPostScriptOperations', this.operations + count, detail);
    this.operations += count;
  }
  allocate(bytes: number, detail?: string): void {
    this.count(bytes);
    if (this.trusted) return;
    this.limits.enforce('maxPostScriptVmBytes', this.bytes + bytes, detail);
    this.bytes += bytes;
  }
  depth(reached: number, detail?: string): void { this.count(reached); if (!this.trusted) this.limits.enforce('maxNestingDepth', reached, detail); }
  items(reached: number, detail?: string): void { this.count(reached); if (!this.trusted) this.limits.enforce('maxContainerItems', reached, detail); }
  /** Only for fixed host initialization, never while executing source. */
  bootstrap<T>(callback: () => T): T { this.trusted++; try { return callback(); } finally { this.trusted--; } }
}
