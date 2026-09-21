/** Bounds on what one document may cost to open (`ibzo`).
 *
 *  Every parse path in this library is otherwise unbounded — input size, object
 *  count, `/Prev` chain length, nesting depth, decoded stream size, filter
 *  expansion ratio, image pixels, content tokens — and this library's own
 *  invariants record what that costs: one stray byte in a still-encrypted
 *  content stream once grew `parseContentStream`'s op list until the heap died.
 *  The defence was per-site and ad hoc; this is the policy object.
 *
 *  **Invariant:** a LEAF importing `errors.js` alone, so every rule is drivable
 *  from plain numbers with no PDF built. `errors.ts` imports `LimitField` from
 *  here as a TYPE only, which is why the pair closes no value cycle.
 *
 *  **Invariant:** the defaults are BOUNDED and opting out is EXPLICIT. A caller
 *  who says nothing gets limits; {@link LoadLimits.unlimited} is how trusted
 *  input asks for none, and a `null` field disables THAT FIELD ALONE. A silent
 *  opt-out is the posture this exists to replace.
 *
 *  **Invariant:** each boundary is wired by its own issue, beside the code that
 *  reads its fields, and every field below names that issue. {@link
 *  LoadLimits.enforce} is the ONE place a bound is compared, so "reached" means
 *  the same thing at every site: strictly MORE than allowed.
 */
import { ResourceLimitError } from './errors.js';

/** The field set, in boundary order. Exported so the enforcement issues can
 *  iterate it, and asserted by SIZE in `test/loadlimits.test.ts` — the rule
 *  `htmlforeign.ts` sets for its five tables, since a half-pasted field set
 *  would otherwise be a limit that silently does nothing. */
export const LIMIT_FIELDS = [
  'maxFileBytes', 'maxObjects', 'maxXrefSections',
  'maxObjectBytes', 'maxNestingDepth', 'maxContainerItems',
  'maxDecodedStreamBytes', 'maxTotalDecodedBytes', 'maxExpansionRatio',
  'maxFilterChain', 'maxImagePixels', 'maxFunctionSamples', 'maxSalvageProbes',
  'maxContentBytes', 'maxContentTokens', 'maxCanvasPixels',
  'maxGlyphOperations',
] as const;

/** One bounded quantity. `null` disables that field alone. */
export type LimitField = (typeof LIMIT_FIELDS)[number];

/** The complete policy. Every field is a positive integer or `null`. */
export interface LoadLimitValues {
  // ---- ibzo.2, the parse boundary ----
  /** Input bytes accepted from a path, buffer or stream. */
  readonly maxFileBytes: number | null;
  /** Objects in one document, counted as they are PRODUCED: cross-reference
   *  rows across every section, object-stream header pairs, and the headers the
   *  recovery sweep finds. Deliberately not what a `/Size` or a subsection
   *  header DECLARES — nothing is allocated from a declared count, and a count
   *  that overstates what follows is damage the recovery ladder already opens. */
  readonly maxObjects: number | null;
  /** Cross-reference sections read, `/XRefStm` included. A CYCLE in the
   *  `/Prev` chain is not this bound's business: it is damage, a
   *  `PdfParseError` the recovery ladder answers. */
  readonly maxXrefSections: number | null;
  /** One indirect object's ENCODED size — its span, a stream's payload, and
   *  any single string or name token, which is refused while it is still being
   *  read rather than after it has been allocated. */
  readonly maxObjectBytes: number | null;
  /** Nesting depth, in the COS grammar and in the recursive page, outline, form,
   *  annotation, resource and function graphs alike. */
  readonly maxNestingDepth: number | null;
  /** Items in one parsed array or dictionary. */
  readonly maxContainerItems: number | null;

  // ---- ibzo.3, the filter and codec boundary ----
  /** Decoded bytes from one stream. */
  readonly maxDecodedStreamBytes: number | null;
  /** Decoded bytes across one document — a cumulative budget, so many small
   *  streams cannot do what one large one may not. */
  readonly maxTotalDecodedBytes: number | null;
  /** Decoded size as a multiple of encoded size, over a whole filter chain. */
  readonly maxExpansionRatio: number | null;
  /** Filters in one chain. */
  readonly maxFilterChain: number | null;
  /** Pixels an image DECLARES, checked before allocation and from the declared
   *  geometry — DCT and JPX headers, CCITT and JBIG2 bitmap dimensions. */
  readonly maxImagePixels: number | null;
  /** Entries a sampled (type 0) function declares. */
  readonly maxFunctionSamples: number | null;
  /** Prefixes `filters.ts`'s `inflateSalvage` may try before giving up. Its
   *  search for a prefix that still decodes is otherwise unbounded. */
  readonly maxSalvageProbes: number | null;

  // ---- ibzo.4, the content and render boundary ----
  /** Combined decoded page-content bytes, including a `/Contents` array. */
  readonly maxContentBytes: number | null;
  /** Content tokens — operators and operands — one page walk may parse: the
   *  page and every form, pattern and appearance it draws. Document-wide
   *  rewrites, which parse each stream once, count per stream. */
  readonly maxContentTokens: number | null;
  /** Pixels in a working canvas, before allocation. `ToImage`'s width, height
   *  and scale are the caller's own to get wrong; this bounds geometry the
   *  DOCUMENT declares. */
  readonly maxCanvasPixels: number | null;

  // ---- ibzo.12, embedded and added font programs ----
  /** Work to produce ONE glyph: charstring operators executed (subroutine calls
   *  included) in a CFF or Type 1 program, or components visited expanding a
   *  TrueType composite. Depth alone does not bound either — ten calls a level
   *  across the ten levels a charstring may nest is 10^10. */
  readonly maxGlyphOperations: number | null;
}

/** A partial policy for {@link LoadLimits.with}. `undefined` leaves a field
 *  alone and `null` disables it — `viewerprefs.ts`'s convention, borrowed
 *  rather than re-invented. */
export type LoadLimitPatch = Partial<LoadLimitValues>;

/** `LIMIT_FIELDS` names exactly the keys of `LoadLimitValues`, checked by the
 *  COMPILER in both directions — a field added to one and not the other is a
 *  red build rather than a bound nobody can reach. */
type FieldsMatchKeys =
  [LimitField] extends [keyof LoadLimitValues]
    ? ([keyof LoadLimitValues] extends [LimitField] ? true : never)
    : never;
const _fieldsMatchKeys: FieldsMatchKeys = true;
void _fieldsMatchKeys;

const KiB = 1024, MiB = 1024 * KiB, GiB = 1024 * MiB;

const DEFAULTS: LoadLimitValues = {
  // Under the 2 GB `ibzo.2` must refuse, over any real file.
  maxFileBytes: 1 * GiB,
  // ~50,000 pages at 20 objects each.
  maxObjects: 2_000_000,
  // A heavily revised, repeatedly signed document is tens of sections.
  maxXrefSections: 1_000,
  // One encoded object — an embedded file or a full-page scan.
  maxObjectBytes: 256 * MiB,
  // The ad-hoc depths already in `src/` run 8 to 64.
  maxNestingDepth: 256,
  maxContainerItems: 1_000_000,

  maxDecodedStreamBytes: 512 * MiB,
  maxTotalDecodedBytes: 2 * GiB,
  // MEASURED rather than cited, and the round number is WRONG: zlib deflates a
  // 16 MiB run of zeros to 1028.3:1 and approaches DEFLATE's own 1032:1 ceiling
  // asymptotically, so a limit of 1000 refuses a legitimately compressed
  // stream. This must stay above 1032.
  maxExpansionRatio: 2_000,
  // Real chains are one or two; `/ASCII85Decode` then `/FlateDecode` is two.
  maxFilterChain: 8,
  // MEASURED (ibzo.10): rendering an image costs 7.6-9.7 bytes a pixel — the
  // decoded samples AND the RGBA the rasterizer composites from — not the 4 the
  // first comment here assumed, so 2^28 was ~2.4 GB for ONE picture. 2^27 is
  // ~1.2 GB and still admits a 100-megapixel photograph or an A1 scan at 300
  // dpi (~70 Mpx); a 150-megapixel back or an A0 scan needs the limit raised. `bmp.ts` and `tiff.ts` read this number rather than
  // keeping their own: one owner for "how many pixels is too many".
  maxImagePixels: 1 << 27,
  maxFunctionSamples: 1 << 24,
  maxSalvageProbes: 64,

  maxContentBytes: 256 * MiB,
  // MEASURED rather than guessed, and the first figure was no bound at all: a
  // parsed content token costs ~97 heap bytes for a bare operator (~42 inside a
  // long operand list), so 50 million — what ibzo.1 shipped — is ~4.8 GB. Ten
  // million is under a gigabyte in the worst case and several times a dense
  // real page.
  maxContentTokens: 10_000_000,
  // MEASURED (ibzo.10): a page canvas is a Float32Array of straight-alpha RGBA,
  // 16 bytes a pixel before encoding and ~25 through a PNG encode — so 2^28 was
  // a ~6 GB render, half of everything the defaults together admitted. 2^26 is
  // ~1.6 GB, and admits Letter and A4 at 600 dpi (~35 Mpx) with room to spare.
  maxCanvasPixels: 1 << 26,

  // MEASURED (ibzo.12) over every glyph of 283 real faces — the vendored fonts
  // and all of C:/Windows/Fonts, CJK collections included: the most any glyph
  // needed was 274 CFF operators, 105 Type 1 and 27 composite components. A
  // tenfold subroutine fan-out across the ten levels a charstring may nest is
  // 10^9, and exhausted the heap. 100,000 is ~365 times the real maximum and
  // refuses the fan-outs probed in milliseconds for charstrings, ~2.5 s for a
  // composite (each visit copies its contours).
  maxGlyphOperations: 100_000,
};

const UNLIMITED: LoadLimitValues =
  Object.fromEntries(LIMIT_FIELDS.map(f => [f, null])) as unknown as LoadLimitValues;

/** Reject anything that is not a positive integer or `null`, with the split
 *  `formcreate.ts` records: `TypeError` for the wrong KIND of thing,
 *  `RangeError` for outside the allowed SET. */
function check(field: string, v: unknown): number | null {
  if (v === null) return null;
  if (typeof v !== 'number')
    throw new TypeError(`LoadLimits.${field}: expected a positive integer or null`);
  if (!Number.isFinite(v))
    throw new RangeError(`LoadLimits.${field}: must be finite, got ${v}`);
  if (!Number.isInteger(v))
    throw new TypeError(`LoadLimits.${field}: must be an integer, got ${v}`);
  if (v <= 0)
    throw new RangeError(`LoadLimits.${field}: must be greater than zero, got ${v}`);
  return v;
}

/** An immutable resource policy, read back from a document as `doc.loadLimits`.
 *
 *  ```ts
 *  Document.Open(buf, { limits: LoadLimits.defaults.with({ maxFileBytes: null }) });
 *  Document.Open(trusted, { limits: LoadLimits.unlimited() });
 *  ```
 *
 *  `PageFormat`'s shape — a private constructor, `readonly` fields and static
 *  factories — so every instance in existence has been through {@link check}. */
export class LoadLimits implements LoadLimitValues {
  readonly maxFileBytes!: number | null;
  readonly maxObjects!: number | null;
  readonly maxXrefSections!: number | null;
  readonly maxObjectBytes!: number | null;
  readonly maxNestingDepth!: number | null;
  readonly maxContainerItems!: number | null;
  readonly maxDecodedStreamBytes!: number | null;
  readonly maxTotalDecodedBytes!: number | null;
  readonly maxExpansionRatio!: number | null;
  readonly maxFilterChain!: number | null;
  readonly maxImagePixels!: number | null;
  readonly maxFunctionSamples!: number | null;
  readonly maxSalvageProbes!: number | null;
  readonly maxContentBytes!: number | null;
  readonly maxContentTokens!: number | null;
  readonly maxCanvasPixels!: number | null;
  readonly maxGlyphOperations!: number | null;

  private constructor(v: LoadLimitValues) {
    for (const f of LIMIT_FIELDS) (this as unknown as Record<string, number | null>)[f] = v[f];
    Object.freeze(this);
  }

  /** The bounded defaults. What a caller who says nothing gets. */
  static readonly defaults: LoadLimits = new LoadLimits(DEFAULTS);

  /** Every field disabled — the EXPLICIT opt-out for input you trust. */
  static unlimited(): LoadLimits { return new LoadLimits(UNLIMITED); }

  /** This policy with `patch` applied, as a new frozen instance; the receiver
   *  is untouched. The whole patch is validated BEFORE anything is assigned, so
   *  a rejected call leaves the receiver byte-identical — `formcreate.ts`'s
   *  rule, and what stops the good half of a bad patch from landing.
   *
   *  An unknown field name is a `TypeError` rather than a no-op: a typo that
   *  quietly fails to disable a limit is precisely the failure this type exists
   *  to prevent. */
  with(patch: LoadLimitPatch): LoadLimits {
    const next: Record<string, number | null> = {};
    for (const f of LIMIT_FIELDS) next[f] = this[f];
    for (const [k, v] of Object.entries(patch)) {
      if (!(LIMIT_FIELDS as readonly string[]).includes(k))
        throw new TypeError(`LoadLimits.with: unknown limit '${k}'`);
      if (v === undefined) continue;          // leaves; null disables
      next[k] = check(k, v);
    }
    return new LoadLimits(next as unknown as LoadLimitValues);
  }

  /** Throw {@link ResourceLimitError} when `reached` exceeds `field`; a
   *  disabled (`null`) field never throws. `reached` equal to the bound is
   *  allowed — a limit of 10 admits ten. */
  enforce(field: LimitField, reached: number, detail?: string): void {
    const allowed = this[field];
    if (allowed !== null && reached > allowed)
      throw new ResourceLimitError(field, allowed, reached, detail);
  }
}
