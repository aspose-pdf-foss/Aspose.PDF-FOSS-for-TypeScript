// Is this content hidden by the document's optional-content configuration?
//
// The ONE owner of that question, for THREE walkers that must not disagree:
// `pagerender.ts` (rendering), `text.ts`'s `visitContent` (text, images, paths)
// and `paths.ts`'s own focused walker. A second copy is how a renderer and an
// extractor come to differ about one page — which is the whole defect `q1g2.3`
// closes, one layer down.
//
// **Invariant:** a pure LEAF. `Document`, `LayerConfig` and `PdfDict` arrive as
// TYPES and as arguments; nothing here is value-imported from `document.js` or
// `ocg.js`, so the edge closes no cycle (`test/import-cycles.test.ts` is the
// fence) and every rule is drivable from a hand-built configuration.
import type { Document } from './document.js';
import type { LayerConfig } from './ocg.js';
import { PdfDict, PdfObject, isName, isRef } from './types.js';

/**
 * The default configuration plus a per-walk memo.
 *
 * The memo is not an optimization to shrug at: `LayerConfig.isRefVisible`
 * LINEARLY SCANS `/ON` and `/OFF` per call, so an unmemoized walk is
 * O(sections x layers) on exactly the CAD-style documents that have many of
 * both.
 */
export interface OcVisibility { config: LayerConfig; cache: Map<string, boolean>; }

/**
 * This document's optional-content visibility, or `undefined` when it declares
 * no `/OCProperties` — in which case every section is visible and no lookup is
 * made at all.
 *
 * **Read-only, and that is load-bearing.** It goes through
 * `defaultConfigIfPresent` rather than `Default`, which creates
 * `/OCProperties` and calls `markModified()`. `choosePath()` takes the
 * incremental append only for an UNMODIFIED base, so a walker reaching for
 * `Default` would silently turn a `Sign()` after a `GetText()` into a full
 * rewrite of bytes an earlier signature covered.
 */
export function ocVisibilityFor(doc: Document): OcVisibility | undefined {
  const config = doc.OptionalContent.defaultConfigIfPresent();
  return config ? { config, cache: new Map() } : undefined;
}

/**
 * Is an `/OC` operand visible under this configuration?
 *
 * **The raw operand is passed through UNRESOLVED**, because
 * `ResolveVisibility` decides an OCG's state by REF IDENTITY (`isRefVisible`
 * compares against `/ON` and `/OFF`); hand it a resolved dict and every layer
 * falls through to `BaseState`, so a switched-off layer reads as visible and
 * the whole feature silently does nothing.
 */
export function ocVisible(oc: OcVisibility | undefined, raw: PdfObject | undefined): boolean {
  if (!oc) return true;
  const key = isRef(raw) ? `${raw.num} ${raw.gen}` : undefined;
  if (key !== undefined) {
    const hit = oc.cache.get(key);
    if (hit !== undefined) return hit;
  }
  const v = oc.config.ResolveVisibility(raw);
  if (key !== undefined) oc.cache.set(key, v);
  return v;
}

/**
 * The marked-content bookkeeping behind "is the content here hidden" (32000-1
 * 14.6), shared by every walker.
 *
 * **One entry per open `BMC`/`BDC` recording whether IT hid**, so nesting pops
 * exactly and a visible section inside a hidden one stays hidden. Every tag
 * pushes, not just `/OC`, or an `EMC` pops the wrong section. An unbalanced
 * `EMC` is tolerated, as `text.ts`'s marked-content stack already tolerates one.
 *
 * It is a class rather than three lines copied into each walker because the
 * NESTING rule is exactly the kind that silently differs: a walker that pushed
 * only for `/OC` would still hide the right ops on every single-level fixture.
 */
export class OcStack {
  private depth = 0;
  private readonly stack: boolean[] = [];

  constructor(private readonly oc: OcVisibility | undefined) {}

  /** True when the ops here sit inside a hidden section. */
  get hidden(): boolean { return this.depth > 0; }

  /** A `BMC`: no properties, so it can never carry an `/OC`. */
  bmc(): void { this.stack.push(false); }

  /**
   * A `BDC`. `tag` and `props` are the two raw operands; `properties` is the
   * scope's `/Resources /Properties`.
   *
   * **An `/OC` operand that is an INLINE DICTIONARY rather than a name in
   * `/Properties` is left VISIBLE rather than guessed at**: hiding content on a
   * shape we did not resolve is the one error that loses ink.
   *
   * **Note, measured, and it covers NOTHING — the `raw !== undefined` test is
   * redundant and PROVABLY cannot be otherwise.** `ResolveVisibility` resolves
   * its operand and returns true for anything that is not a dict
   * (`ocg.ts`: "undefined / non-dict: unconditionally visible"), so an
   * unresolved name already reads as visible by that route and dropping the
   * test reddens not one case. It stays as the honest spelling of "we hide only
   * what we resolved", and because a future `ResolveVisibility` that answered
   * differently for `undefined` would otherwise hide content silently. Same
   * class as `pagemode.ts`'s `isName` note — do NOT cite the inline-dict
   * fixture in `test/optional-content-extract.test.ts` as covering it.
   */
  bdc(tag: PdfObject | undefined, props: PdfObject | undefined, properties: PdfDict | undefined): void {
    const raw = isName(props) ? properties?.get(props.name) : undefined;
    const hides = isName(tag) && tag.name === 'OC' && raw !== undefined
      && !ocVisible(this.oc, raw);
    this.stack.push(hides);
    if (hides) this.depth++;
  }

  /** An `EMC`, closing whichever section the matching open pushed. */
  emc(): void {
    if (this.stack.length && this.stack.pop()) this.depth--;
  }
}
