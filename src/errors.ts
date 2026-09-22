import type { LimitField } from './loadlimits.js';
import type { SeedRequirement } from './sigseed.js';

export class PdfParseError extends Error {
  constructor(message: string, readonly offset?: number) {
    super(offset === undefined ? message : `${message} (at byte ${offset})`);
    this.name = 'PdfParseError';
  }
}
export class UnsupportedFeatureError extends Error {
  constructor(message: string) { super(message); this.name = 'UnsupportedFeatureError'; }
}
/** A document exceeded a {@link LoadLimits} bound (`ibzo`).
 *
 *  **Invariant:** a SIBLING of {@link PdfParseError}, never a subclass. "This
 *  file is too big" is categorically not "this file is broken", and the
 *  difference is load-bearing rather than cosmetic: a caller who branches on
 *  `PdfParseError` to run the recovery ladder must NOT catch this, since a
 *  brute-force sweep over a hostile file is exactly the scan the bound refused.
 *
 *  `limit` names the field, so a caller raises a bound by name rather than by
 *  parsing a message. */
export class ResourceLimitError extends Error {
  constructor(
    readonly limit: LimitField,
    readonly allowed: number,
    readonly reached: number,
    readonly detail?: string,
  ) {
    super(`${limit} exceeded: allowed ${allowed}, reached ${reached}`
      + (detail === undefined ? '' : ` (${detail})`));
    this.name = 'ResourceLimitError';
  }
}
/** Rethrow `e` when it is a {@link ResourceLimitError}; return otherwise.
 *
 *  For every `catch` on a path that treats a failure as DAMAGE — the recovery
 *  ladder, a per-object parse, a salvage attempt. Those catches exist to keep
 *  going past a broken object, and a bound reached is not a broken object:
 *  swallowed there, the ladder sweeps precisely the file the bound refused, and
 *  the limit refuses nothing. One helper rather than an `instanceof` at each
 *  site, so a new catch has one thing to remember. */
export function rethrowLimit(e: unknown): void {
  if (e instanceof ResourceLimitError) throw e;
}
/** A signature field's seed value (`/SV`) makes a demand this signing call
 *  cannot meet (`puep.3`). A REFUSAL, not damage: signing around a constraint
 *  the document states is worse than declining. `entry` names the seed-value
 *  entry at fault, so a caller reacts by name rather than by parsing a message. */
export class SeedValueError extends Error {
  constructor(readonly entry: SeedRequirement | 'mdp' | 'timestamp', message: string) {
    super(message); this.name = 'SeedValueError';
  }
}
export class InvalidPasswordError extends Error {
  constructor(message = 'PDF is password-protected: wrong or missing password') {
    super(message); this.name = 'InvalidPasswordError';
  }
}
