# PostScript Text Implementation Plan

Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`
after the user reviews this plan and selects the execution method. Track task
progress, verification and rulings in Beads. Repository instructions prohibit
Markdown task-progress ledgers and checkbox task lists.

**Goal:** Execute the approved bounded PostScript font/text inventory and save
correctly positioned PDF text with reusable font and glyph resources.

**Architecture:** Extend the existing scanner/readers with pull-based inputs,
then add protected font identity/registries and metered program adapters. Glyph
capture and character iteration run on the existing VM pump. A PDF font bank
owns detached output resources; the language/value/memory layers own no PDF data.

**Tech Stack:** TypeScript NodeNext ESM, Node built-ins, vitest, zero runtime deps.

**Spec:** `docs/superpowers/specs/2026-11-18-postscript-text-design.md`, approved
by the user on 2026-11-18. Starting branch `feat/lw8w.3-postscript-text`.

## Global Constraints

- All entry points remain internal. A public PS/EPS import API and EPS framing
  are left to `lw8w.4`; the broad producer/oracle corpus remains `lw8w.5`.
- Initial font: Courier at 12 user units. Exact Standard-14 names only; explicit
  supplied font names can add aliases. Missing faces: `invalidfont`.
- Standard-14 uses native PDF Type 1 text. Program/procedure glyphs use PDF Type
  3 resources; original hinting is lost. Known names get ToUnicode; do not invent
  text for unknown glyph names.
- Support horizontal Type 0 FMapTypes 2/3. CID/CMap/composefont, vertical writing,
  other FMapTypes, Multiple Master, custom OtherSubrs, GlyphDirectory, procedure
  CharStrings overrides and CDevProc fail explicitly.
- Use existing LoadLimits, cumulative PsBudget, graphics DecodeBudget and output
  counters. Check and charge before growth, including reused font engines.
- Source can access supplied bytes only. No machine-font search or host paths.
- Every src catch starts with rethrowLimit. Cleanup is nonthrowing and allocation
  free. Never pump a nested `run`; callbacks use `invoke` and private work frames.
- Use `.js` relative imports. New modules earn CLAUDE architecture entries in
  their landing commit. Preserve existing PDF font-reader defaults and tests.
- `k421` owns the broader initgraphics preservation defect. This issue preserves
  font selection across initialization/pages/devices without absorbing that fix.

## Review Focus

- A cached font or output glyph used after VM restore must not retain invalid
  source objects, revive a removed definition or corrupt an earlier PDF page.
- An encrypted source containing binary readstring data, a nested filter and a
  clear-text suffix must consume exactly the bytes its readers actually use.
- Returning language handlers resume nested glyph/cshow callbacks; escaping
  exit/stop/quit or a resource failure restores every exited font/output scope.
- Re-encoding, unencoded glyphshow and rotated/nonzero-y metrics must use actual
  glyph identity and full matrices, never a code-index or horizontal-only guess.
- Font caches and glyph reuse must retain cumulative work/allocation accounting
  across measurement, page changes, discarded captures and repeated runs.

Each condition has explicit regressions in its owning tasks below. The final
review also inspects combinations that the individual witnesses do not cover.

## Files and contracts

Create `psinput.ts` (byte inputs), `pseexec.ts` (encrypted execution/PFB),
`fontwork.ts` (parser accounting interface), `psfonttypes.ts` (non-PDF font types),
`psfontprogram.ts` (program adapters), `psfont.ts` (registry/selection),
`psfontpdf.ts` (font resources), `psglyph.ts` (glyph invocation), `pstext.ts`
(text execution), `psnumbers.ts` (number sequences) and `pscomposite.ts`
(character mapping). Modify the existing PS modules only for their named
integration boundaries. Reuse `glyphoutline.ts`, `type1charstring.ts`, `type1.ts`,
`sfnt.ts`, `encoding.ts`, `metrics.ts` and `std14fonts.ts` where their contracts fit.
The existing glyphoutline flattener is a semantic reference for TrueType contour
ordering, not an emitter of cubic paths; Task 4 supplies the exact conversion.

Shared non-PDF types live in `psfonttypes.ts`:

```ts
type PsVector = [number, number];
interface PsProgramGlyph {
  name: string;
  advance: PsVector;             // glyph-space width, translation excluded
  sidebearing: PsVector;
  path: PsPathData;              // native glyph coordinates
  box: PsBox;
  unicode?: string;
}
interface PsFontProgram {
  readonly names: readonly string[];
  glyph(name: string): PsProgramGlyph; // missing name -> .notdef
}
interface PsFontDefinition {
  readonly dictionary: PsDictionary;
  readonly identity: PsFontId;
  readonly type: 0 | 1 | 3 | 42;
  readonly matrix: Matrix;       // complete FontMatrix, including derivation
  readonly box: PsBox;
  readonly encoding: readonly (string | number)[];
  readonly paintType: 0 | 2;
  readonly strokeWidth: number;
  readonly standard?: StdFont;
  readonly program?: PsFontProgram;
  readonly builder?: { procedure: PsArray; byName: boolean };
  readonly composite?: {
    mapType: 2 | 3; escape: number; descendants: readonly PsDictionary[];
  };
}
interface PsCharacter {
  font: PsFontDefinition;
  root: PsDictionary;
  code: number;
  name: string;
  matrix: Matrix;               // effective glyph -> current user space
}
```

Numeric/string helpers validate VM access, validity and finite values. The
definition compiler snapshots Encoding/program/metric descriptors; it retains
the actual executable procedure references for Type 3. Internal stored Metrics
overrides may be added to these types in Task 4; their public consumer remains
`PsFontProgram.glyph`, so later tasks do not inspect raw Metrics dictionaries.

## Task 1 — Pull-byte input without changing existing source semantics

**Files.** Create `src/psinput.ts`, `test/psinput.test.ts`; modify `psscan.ts`,
`pssource.ts`, `psvm.ts`, affected `psdata.ts` scanner uses and CLAUDE entries.

**Interfaces.** `PsByteInput` has `position: number`,
`byteAt(index: number): number | undefined`,
`span(start: number, end: number): Uint8Array`, `available(): number`,
`close(): void`, and `readonly closed: boolean`.
`byteAt`/span can fill a bounded lookahead cache but do not commit the cursor.
`available` returns -1 when the remaining length is unknown; it must not drain
input. `byteInput(bytes, budget): PsByteInput` adapts supplied arrays.
PsScanner and `vm.scanner` accept `Uint8Array | PsByteInput`; scanner.position
delegates to input.position. Expose scanner.input. PsReader exposes input and
scanner instead of assuming a complete source array. Keep readByte/available/
position/close and all existing file behavior. No source-controlled seeking API
is introduced. Extend `vm.run(source: Uint8Array | PsByteInput): void` accordingly
so Task 2's framed font input can execute on the same pump.

**Step 1.** Write tests with a counting one-byte input. Pin lazy token scanning,
CRLF separator handling, literal strings/procedures, error-token bytes/offsets,
token inspection and readstring sharing one cursor. The following is a witness:

```ts
const scanner = vm.scanner(countingInput('12 34', vm.budget));
expect(scanner.next()).toMatchObject({ kind: 'integer', value: 12 });
expect(scanner.position).toBe(3);
expect(scanner.next()).toMatchObject({ kind: 'integer', value: 34 });
```

Add assertions that peeking does not move the parent position and that enormous
tokens/diagnostic buffers hit maxObjectBytes/VM bounds before growing.

**Step 2.** Run `npx vitest run test/psinput.test.ts`. Expect RED for missing
input support, not an unrelated parser error.

**Step 3.** Implement the input adapter and scanner refactor. Retain bounded token
scratch for diagnostics rather than requiring all prior bytes. Update reader
token/readline/image paths to use the shared input. Adapt filter byte windows
to peek first and commit only the codec's consumed prefix. In a pull reader,
lookahead must not advance an underlying source's committed cursor. Preserve
the existing conservative native-input reservation policy, including its fuel
charges, rather than silently making native calls unmetered.

**Step 4.** Run input/scanner/source/filter/image and VM tests plus typecheck:
`npx vitest run test/psinput.test.ts test/psscan.test.ts test/pssource.test.ts test/psfilter.test.ts test/psimage.test.ts test/psvm.test.ts`;
`npm run typecheck`. Expect GREEN, including exact existing inline sentinels.

**Step 5.** Commit `feat(ps): support bounded pull-byte scanner inputs`.

## Task 2 — Streaming eexec and supplied PFB execution

**Files.** Create `src/pseexec.ts`, `test/pseexec.test.ts`,
`test/helpers/ps-font-program.ts`; modify `psvm.ts` for dictionary scopes and
CLAUDE entries. Extend the existing Type 1 fixture helper only if shared cipher
test construction belongs there.

**Interfaces.** Export `installPsEexec(vm: PsInterpreter, decode: DecodeBudget): void` and
`psFontSource(bytes: Uint8Array, budget: PsBudget): PsByteInput`. The latter
validates/removes PFB framing while preserving logical segment types; PFA uses
the ordinary byte adapter. Export `eexecInput(vm, source: PsFile | PsString,
decode: DecodeBudget): PsByteInput` for the installed operator.
Add `vm.withDictionaryScope(dictionary: PsDictionary): PsInvocation`; it retains
the existing dictionary-stack roots and restores that prefix on completion or
escape. It is composed with `invoke` around encrypted file execution, not a
second pump. Scope cleanup must not spend fuel.

**Step 1.** Add executable encrypted-source fixtures, not merely parser-shaped
PFA buffers. Pin binary/hex mode detection, four discarded random bytes, cipher
state across explicit readstring, closefile, nested ASCIIHex/Flate readers, clear
suffix execution, PFB boundaries and malformed/truncated input. A fixture for
plaintext `mark currentfile closefile` followed by clear `cleartomark 7 8 add`
must leave the sole operand 15. Shadow add in userdict to prove the implicit
systemdict scope takes precedence during eexec and disappears afterward.
Test returning handlers and stop/exit/quit/limit failure with an extra begin in
the encrypted scope; a later run must see the original dictionary stack.
The test helper `encryptedPs(plain, { hex?, suffix?, pfb? }?)` constructs the
currentfile/eexec prefix, encrypted body and supplied suffix independently.

```ts
const vm = new PsInterpreter();
const graphics = installPsGraphics(vm);
installPsEexec(vm, graphics.decode);
vm.run(encryptedPs('mark currentfile closefile', { suffix: 'cleartomark 7 8 add' }));
expect(vm.stack).toMatchObject([{ value: 15 }]);
```

**Step 2.** Run `npx vitest run test/pseexec.test.ts`, observe RED for absent
eexec/scope behavior. Invalid fixture syntax is not a valid witness.

**Step 3.** Implement lazy decryption using Task 1 inputs. Hex whitespace and
binary bytes share exact consumed-position accounting; lookahead cannot consume
the clear suffix. The decrypted file is currentfile and executes with systemdict
on top. PFB adapters expose only supplied bytes. Meter framing/decryption and
decoded totals before cache growth. Restore closes newer local readers normally.

**Step 4.** Run `npx vitest run test/pseexec.test.ts test/psinput.test.ts test/pssource.test.ts test/psfilter.test.ts test/psscan.test.ts test/psvm-scopes.test.ts`
and `npm run typecheck`; expect GREEN. Check the nested-filter suffix explicitly,
not just decoded bytes.

**Step 5.** Commit `feat(ps): execute bounded encrypted font sources`.

## Task 3 — Protected font identity, system bindings and readonly registries

**Files.** Modify `psvalue.ts`, `psmemory.ts`, `psdata.ts`, `psvm.ts`, `psstate.ts`,
`psgraphics.ts`; create `test/psfont-vm.test.ts`; update CLAUDE invariants.

**Interfaces.** Add `PsFontId` with kind `fontid`, backed identity/access and
language type `fonttype`, and `memory.fontId(): PsFontId`. Add `font?: PsDictionary`
to PsState and its root walker; graphics-only state can omit it.
`vm.registerStandardValue(name: string, value: PsValue): void` installs fixed
values; `vm.registerStandardBinding(name: string, resolve: () => PsValue,
roots: readonly PsValue[]): void` installs a host-only dynamic binding.
Both reject execution/open saves and use ordinary accounting, not bootstrap.
`memory.readonlyRegistry(parent?: PsDictionary): { dictionary: PsDictionary;
put(key: PsValue, value: PsValue): void; remove(key: PsValue): void }` returns
a capability for that exact readonly dictionary; its writes journal normally.
The optional parent supplies a readonly logical overlay:
lookup is local-first, and enumeration/count/copy include unshadowed parent keys.
Add `memory.dictionarySize(dict: PsDictionary): number` and use it for dictionary
length rather than reading the backing entries array in source operators.

**Step 1.** Test FID type/equality/global/access/invalidrestore, readonly registry
writes versus rejected source put/undef, local registry restoration, prospective
font roots in gstates and scopes, and installation rejection before mutation.
Test overlay length/copy/forall/known after parent additions/removals and local
shadow removal; actual parent edges must participate in restore root validation.
Test dynamic bindings through lookup, load, systemdict get and forall, including
user shadows. Direct dictionary inspection must match the current global view.

```ts
vm.registerStandardValue('probe', integer(7));
vm.run(bytes('systemdict /probe get /probe load eq'));
expect(vm.stack).toMatchObject([{ value: true }]);
```

**Step 2.** Run `npx vitest run test/psfont-vm.test.ts`; observe RED for missing
identity/capability/binding interfaces.

**Step 3.** Implement explicit binding resolution in systemdict get/lookup/entries
and retain binding roots in VM restore validation. Fixed global values obey
global barriers. The local FontDirectory root is an explicit VM-owned system
binding, analogous to the existing fixed userdict root, not a general permission
for global objects to retain local children. Registry capabilities cannot be
represented as source PsValues. Preserve font selection in graphics reset/page/
device transitions and include it in every copy/restore path.

**Step 4.** Run `npx vitest run test/psfont-vm.test.ts test/pscore.test.ts test/psdata.test.ts test/psmemory.test.ts test/psgraphics.test.ts test/pspages.test.ts test/psvm-scopes.test.ts`
and `npm run typecheck`; expect GREEN. Existing language-only systemdict
protections must remain green.

**Step 5.** Commit `feat(ps): add protected font identities and resource registries`.

## Task 4 — Metered font engines and strict program adapters

**Files.** Create `src/fontwork.ts`, `src/psfonttypes.ts`,
`src/psfontprogram.ts`, `test/psfontprogram.test.ts`, `test/fontwork.test.ts`;
modify `type1.ts`, `type1charstring.ts`, `sfnt.ts`, `std14fonts.ts`, and reusable
glyph conversion helpers where needed; update CLAUDE entries. Name-based
Standard-14 metrics/encoding helpers needed here land in this task, not Task 5.

**Interfaces.** `FontWork` structurally exposes work/allocate/items/depth with
the same signatures as PsBudget. Type1Env gains optional work/strict settings;
Type1Glyph gains optional widthY (zero when absent). Type1Font takes an optional
third `{ work?: FontWork; strict?: boolean }` argument and exposes
`glyphAdvance(gid: number): [number, number]`. Preserve glyphWidth as x advance.
parseSfnt gains optional fourth `{ work?: FontWork; strict?: boolean }` argument,
propagated to table/contour work and damage handling. This lets strict PS callers
distinguish a malformed glyph from a genuinely empty one, while legacy PDF
callers still salvage damage. Use `getStd14Sfnt(face: StdFont, options?: { limits?: LoadLimits;
work?: FontWork; decode?: DecodeBudget }): SfntFont | undefined` for the optional
job-accounted path.
Legacy calls keep their defaults and salvage behavior.
Export `compilePsProgram(vm, dict: PsDictionary, decode: DecodeBudget): PsFontProgram`,
`suppliedPsProgram(vm, bytes: Uint8Array, decode: DecodeBudget): PsFontProgram` and
`standardPsProgram(vm, face: StdFont, decode: DecodeBudget): PsFontProgram`.
Task 5 passes graphics.decode into all three; no font-only decode budget exists.
Export name-based `standardPsEncoding(face: StdFont): readonly string[]` and
`standardPsWidth(face: StdFont, name: string): number` from psfontprogram for
Task 5, backed by the existing encoding/metrics data rather than a second table.
Export `quadraticPsPath(contours: readonly (readonly GlyphPoint[])[],
matrix: Matrix, work: FontWork): PsPathData` from psfontprogram. Standard-14
programs use 1000-unit glyph space, their original AFM name-based advances and
bundled outlines normalized to that space. Initialize program wrappers lazily;
installing fonts must not eagerly decode all fourteen bundled faces.

**Step 1.** Write literal glyph tests: plaintext/encrypted Type 1 charstrings,
lenIV -1, hsbw/sbw including y advance, nonzero sidebearing, seac, standard flex,
missing glyph and unsupported OtherSubrs. Test readonly/noaccess Private and
CharStrings without giving source read access. For Type 42 wrap buildMinimalTtf
with code 65 -> a different named GID than its cmap would select, split sfnts into
multiple odd padded chunks, and assert the selected outline and normalized width.
Metrics forms number, `[sbx wx]`, `[sbx sby wx wy]` must override widths and move
the outline by the changed sidebearing; e.g. `[10 20 600 30]` gives width [600,30].
Pin malformed tables, invalid GIDs, invalid lengths, CDevProc/procedure overrides
and GlyphDirectory to their explicit errors. Add exact pre-growth work/VM/item
boundary tests on table maps, Type 1 subrs/charstrings and composite contours.
For a quadratic from [0,0] through [3,6] to [6,0], pin cubic control points [2,4]
and [4,4], endpoint [6,0], plus implied on-curve points and off-curve starts.
Use a local `type1MetricsFixture(vm)` with plaintext hsbw width 500 and the
four-number Metrics override given above:

```ts
const glyph = compilePsProgram(vm, type1MetricsFixture(vm), graphics.decode).glyph('A');
expect(glyph.advance).toEqual([600, 30]);
expect(glyph.sidebearing).toEqual([10, 20]);
```

**Step 2.** Run `npx vitest run test/fontwork.test.ts test/psfontprogram.test.ts`;
expect RED for absent accounting/adapters, not accidental raw parser exceptions.

**Step 3.** Implement per-job snapshots and strict adapters. Type 42 glyph-space
coordinates are sfnt units divided by unitsPerEm; its usual FontMatrix is identity.
Type 1 keeps charstring coordinates and applies its actual FontMatrix later.
Strip the compatibility padding byte from odd sfnts chunks, retain even chunks,
then validate the complete sfnt range. Reject non-TrueType host sfnt inputs.
Convert each quadratic to its exact cubic using two-thirds control offsets,
without raster flattening; normalize implied points/closed contour ordering.
Meter loops and storage before they run/grow; strict PS use rejects malformed
glyphs while ordinary PDF callers preserve recovery. A bundled-font process-cache
hit must not remove this job's accounting: use a metered job-owned parse/snapshot
path. Strict parser errors are PdfParseError, converted to PsFault('invalidfont')
by the PS adapter after rethrowLimit; UnsupportedFeatureError must propagate
instead of being swallowed as an empty glyph. Trusted bundled-data inflation is
capped/reserved before native allocation, with the job's shared decode policy.
Do not route Type 1 through eager whole-font Type1-to-CFF conversion.

**Step 4.** Run `npx vitest run type1 sfnt std14 fontwork psfontprogram limits-fonts glyphoutline`
and `npm run typecheck`. These are Vitest substring filters, not shell globs.
Expect GREEN for all affected callers, including cache-warm/cold identical
budget outcomes.

**Step 5.** Commit `feat(ps): compile bounded Type1 and Type42 font programs`.

## Task 5 — Font definitions, derivation and Font/Encoding resources

**Files.** Create `src/psfont.ts`, `test/psfont.test.ts`,
`test/helpers/ps-text.ts`; consume Task 4's name-based metrics/encodings and
update CLAUDE entries.

**Interfaces.** `PsFontOptions` has `fonts?: readonly { name: string;
bytes: Uint8Array }[]`. `installPsFonts(vm, graphics, options?): PsFonts` installs
font/resource selection. PsFonts provides `find(key: PsName | PsString): PsDictionary`,
`define(key: PsValue, dict: PsDictionary): PsDictionary`,
`derive(font: PsDictionary, by: Matrix): PsDictionary`,
`definition(font: PsDictionary): PsFontDefinition`,
`current(): PsFontDefinition`, `visitRoots(visit): void`, and
`withCharacter(character: PsCharacter, scope: PsInvocation): PsInvocation`.
The last method roots and temporarily selects the effective leaf/root font,
restoring the enclosing selection on normal completion or unwind. Currentfont
must expose the effective leaf FontMatrix during composite callbacks.
Compiled metadata is private and keyed by VM-valid dictionary/FID identity.
The test helper `runPsFonts(source, { limits?, fonts? }?)` returns vm/graphics/fonts.

**Step 1.** Test all selection operators/encoding constants and native Standard-14
glyph widths. Courier12 `(AA)` has [14.4,0] user advance; use tolerance for reals.
Test initial currentfont, readonly FID, forged/copied FIDs, deriving without
mutating the original matrix, renamed/re-encoded copies excluding FID, unsupported
FontTypes, missing host names and unknown encodings. Pin local/global directory
views, registry lookup priority, undefinefont, definitions surviving global restore
and local definitions disappearing. Font/Encoding resource lookup/status/
definition/removal/enumeration must agree; unknown categories fail explicitly.
Verify selected fonts survive initgraphics/showpage/nulldevice/PageSize changes
and restore correctly through gsave/gstate/VM restore. Test interrupted definition
does not publish a font or make its input readonly prematurely.

```ts
const { vm } = runPsFonts('currentfont /FontName get currentfont /FontMatrix get 0 get');
expect(vm.peek(1)).toMatchObject({ kind: 'name', text: 'Courier' });
expect(vm.number().value).toBeCloseTo(0.012, 12);
```

**Step 2.** Run `npx vitest run test/psfont.test.ts`; expect RED for absent fonts.

**Step 3.** Compile before publishing a definition/FID. Install Courier12 and
readonly standard vectors with ordinary budgets. Preserve builtin face lineage
through a private map keyed by its trusted program-bearing CharStrings body,
so normal copied/re-encoded fonts work without a forgeable face-name key.
Use a local readonly registry overlay over the global registry for FontDirectory;
in global allocation mode its binding returns GlobalFontDirectory itself.
Store complete derived FontMatrix and immutable descriptor snapshots. Validate
Type 3 builders and Type 0 descriptor shapes now; their execution comes later.
resourceforall uses the language iteration semantics and rooted bounded snapshots;
unsupported composefont/cache-control mechanisms throw UnsupportedFeatureError.

**Step 4.** Run `npx vitest run test/ps` and `npm run typecheck`; expect GREEN,
including existing graphics, systemdict feature probes and readonly checks.

**Step 5.** Commit `feat(ps): define select and derive VM-owned fonts`.

## Task 6 — PDF text and reusable glyph banks

**Files.** Create `src/psfontpdf.ts`, `test/psfontpdf.test.ts`; modify `pspdf.ts`
and CLAUDE entries. Do not couple the language VM to Document.

**Interfaces.** `PsPdfGlyph` contains `font: PdfDict`, `code: number`,
`fontMatrix: Matrix`. `PsGlyphPaint` contains `content: Uint8Array`,
`resources: PdfDict`, `colored: boolean`. `PsFontPdfBank(vm, graphics)` provides
`glyph(font: PsFontDefinition, glyph: PsProgramGlyph,
paint?: PsGlyphPaint): PsPdfGlyph`. Add
`writer.drawText(glyph: PsPdfGlyph, glyphToDevice: Matrix, state: PsState): void`.
GlyphToDevice maps native glyph coordinates to device space; writer removes the
PDF font's intrinsic FontMatrix and its owner's basis, emits size-1 text with
explicit per-glyph placement, and does not rely on PDF's text advance for PS state.

**Step 1.** Write saved/reopened tests for Standard-14 encodings, native CMYK,
clipping/overprint, anisotropic/sheared matrices and program Type 3 resources.
Pin CharProcs/Widths/ToUnicode, unknown names without invented Unicode, uncolored
versus colored glyphs, image/font resources nested inside a CharProc, identical
font streams shared across pages and transformed form owners, and 257 distinct
named glyphs spanning banks. A reused code must retain its earlier meaning after
another glyphshow/bank allocation. Interrupt text emission at exact byte/token
limits and assert no incomplete text block/resource is published.

```ts
const { vm, graphics, fonts } = runPsFonts('/Courier 10 selectfont');
const font = fonts.current();
const glyph = new PsFontPdfBank(vm, graphics).glyph(font, font.program!.glyph('A'));
graphics.writer.drawText(glyph, [0.01, 0, 0, 0.01, 10, 20], graphics.state);
expect(parseContentStream(graphics.finish()[0]!.content)).toContainEqual({
  operator: 'Tm', operands: [10, 0, 0, 10, 10, 20],
});
```

**Step 2.** Run `npx vitest run test/psfontpdf.test.ts`; expect RED for missing
text/bank APIs.

**Step 3.** Implement job-owned banks, native Standard-14 dictionaries and detached
Type 3 dictionaries/CharProcs. Program CharProc coordinates use an identity PDF
FontMatrix; Standard-14 uses its intrinsic .001 matrix. PDF d0/d1 use horizontal
wx and zero wy; PS's separate two-dimensional advance determines subsequent
explicit placements. Fingerprint geometry/metrics/encoding/paint semantics with
metered comparisons. Never publish a partially built bank or mutate a code's
meaning in a bank already referenced by output. Cache pure program glyphs; reuse
dynamic captures only if their completed immutable content/resources match.

**Step 4.** Run `npx vitest run test/psfontpdf.test.ts test/pspdf.test.ts test/pspages.test.ts test/psform.test.ts test/pspattern.test.ts test/type3-render.test.ts`
and `npm run typecheck`. Expect GREEN; qpdf checks a generated sample if
available, while extraction and literal geometry remain separate evidence.

**Step 5.** Commit `feat(ps): emit reusable bounded PDF text and glyph resources`.

## Task 7 — Procedure glyph contexts, metrics and capture modes

**Files.** Create `src/psglyph.ts`, `test/psglyph.test.ts`; modify graphics/writer
capture interfaces and `pspath.ts` stroke helper exports as required; update CLAUDE.

**Interfaces.** `PsGlyphResult` is `{ glyph: PsProgramGlyph; paint?: PsGlyphPaint }`.
`PsGlyphRunner(vm, graphics, fonts)` provides
`run(character: PsCharacter, mode: 'show' | 'measure' | 'path',
complete: (result: PsGlyphResult) => void): void`.
For pure program glyphs it can complete synchronously; procedure glyphs schedule
invoke. Extend `beginCapture` with optional
`PsCaptureOptions` with `{ mode?: 'paint' | 'measure' | 'path';
requireMetrics?: boolean; clip?: 'bbox' | 'inherit' }` as the fourth argument:
`beginCapture(box: PsBox, matrix: Matrix, uncolored: boolean,
options?: PsCaptureOptions): PsCapture`. Existing three-argument calls retain
their contract.
The default clip remains bbox for existing forms/patterns. Glyph captures inherit
their caller's clip instead of treating FontBBox as a clipping rectangle;
cachedevice declarations can establish their own checked cache bounds.
Capture exposes `declareGlyphMetrics(advance, box?, uncolored?): void`,
`collectedPath(): PsPathData`, complete/abort. Font/root/glyph contexts are scoped
inside the runner and their source references are invocation roots.

**Step 1.** Test BuildGlyph precedence/operands and BuildChar fallback; nested
glyphs with different declared advances, currentfont/rootfont, nonzero width y,
both metric sets of setcachedevice2, missing/duplicate/late metric declarations,
and forbidden color changes after cachedevice. An example builder
`{ pop pop 600 30 setcharwidth 0 0 100 200 rectfill }` produces advance [600,30]
and exactly the captured rectangle. Test grestore/grestoreall retain the glyph's
transformed boundary. Measure mode publishes nothing but preserves dictionary
side effects. Path mode collects fill/stroke paths and omits images/masks while
retaining the vector part of a mixed glyph. Test images/text/forms/patterns inside
show-mode glyphs and their nested resources. Exercise returning handlers and
stop/exit/quit/terminal errors, followed by another run and intact parent state.
Include a setcharwidth glyph painting beyond a deliberately small FontBBox:
ordinary caller clipping still applies, but FontBBox must not cut off its marks.
The PDF bank's bounding box must enclose its completed glyph content.
Extend the test helper with `runGlyph(builder: string, mode)` that defines a
one-glyph Type 3 font and invokes PsGlyphRunner through a registered host operator
inside vm.run; it returns the completed result rather than starting another pump.

```ts
const { result } = runGlyph('{ pop pop 600 30 setcharwidth 0 0 100 200 rectfill }', 'show');
expect(result.glyph.advance).toEqual([600, 30]);
expect(parseContentStream(result.paint!.content).some(op => op.operator === 'f')).toBe(true);
```

**Step 2.** Run `npx vitest run test/psglyph.test.ts`; expect RED for missing
glyph contexts and capture policies.

**Step 3.** Implement scoped metrics and capture policies. Metrics precede any
glyph marking; installing cachedevice changes the capture's color policy before
later paint, without rewriting earlier output. Measurement discards publication
but still runs callbacks and meters all work. Path mode intercepts painting to
collect correct device geometry/stroke outlines, including nested glyph vector
content; non-path images contribute nothing. A source Type 3 builder runs on
every request, including repeated measurement, regardless of output deduplication.

**Step 4.** Run `npx vitest run test/ps` and `npm run typecheck`; expect GREEN.
Metric operators outside a glyph give the chosen named
language fault (`undefined`), with operands restored by the existing undo path.

**Step 5.** Commit `feat(ps): capture procedure glyphs with scoped metrics`.

## Task 8 — Base show, stringwidth, glyphshow and character outlines

**Files.** Create `src/pstext.ts`, `src/pscomposite.ts` (base cursor),
`test/pstext.test.ts`, `test/pscharpath.test.ts`; extend helper and CLAUDE entries.

**Interfaces.** `installPsText(vm, graphics, options?: PsFontOptions): PsTextSession`
installs Tasks 2/5/7/8 and later groups exactly once. Preflight session/VM/idle/
open-save checks precede mutation. PsTextSession owns fonts, glyphs and font-bank
instances. `psCharacters(fonts, root: PsDictionary, text: PsString): PsCharacterCursor`
returns `{ next(): PsCharacter | undefined; visitRoots(visit): void }`.
Start with base fonts, extending the same cursor in Task 10. PsTextSession exposes
`show(text: PsString, complete?: () => void): void` and
`measure(text: PsString, complete: (advance: PsVector) => void): void`.
It installs eexec with graphics.decode, the same DecodeBudget used by images and
filters. No recursive run or independent decoding budget is introduced.
Add `runPsText(source: string, options?: PsFontOptions & { limits?: LoadLimits })`
to the test helper, returning `{ vm, graphics, text: PsTextSession }`.
Duplicate/late/wrong-VM installation must be mutation-free. A resource failure
during actual budgeted host installation is terminal for that installation, as
with the existing graphics installer; source-operator publication and callback
cleanup still have the stronger transactional contracts described elsewhere.

**Step 1.** Write source-driven show/stringwidth/glyphshow and charpath tests.
Courier12 `(AA)` measures [14.4,0] without a current point or marks. Showing at
[10,20] ends at [24.4,20]. A rotated FontMatrix must give a y advance; changing
CTM after moveto must retain the original device origin. Test unencoded glyphshow,
.notdef, Metrics sidebearing/width vectors, existing path preservation, actual
cubic charpath coordinates, stroke-flag/PaintType2 differences, and eocharpath
without painting. A pure program glyph's source dictionary becomes invalid after
restore, while its already emitted PDF still saves/reopens correctly.

```ts
const { vm } = runPsText('/Courier 10 selectfont 10 20 moveto (AA) show currentpoint');
expect(vm.number(1).value).toBeCloseTo(22, 10);
expect(vm.number().value).toBeCloseTo(20, 10);
```

**Step 2.** Run `npx vitest run test/pstext.test.ts test/pscharpath.test.ts`;
expect RED for absent text operators.

**Step 3.** Implement the private work-frame text loop, rooted input/font state
and explicit glyph placement. Reuse appendPsSegments/currentPsPoint and complete
matrices, separating origin translation from delta advances. Move the current
point without discarding older segments. Charpath applies strokepath only when
the selected glyph is stroke-designed and bool requires its filled outline.
Measurement invokes the same glyph/metric path on a nonpublishing device. Keep
earlier completed glyphs if later callbacks escape or fail.

**Step 4.** Run `npx vitest run test/ps` and `npm run typecheck`; expect GREEN.
Save/reopen and extract the emitted text, not just the
source operand stack.

**Step 5.** Commit `feat(ps): show measure and outline base-font text`.

## Task 9 — Adjusted shows, encoded numbers and text callbacks

**Files.** Create `src/psnumbers.ts`, `test/psnumbers.test.ts`,
`test/psshow.test.ts`, `test/pstext-callbacks.test.ts`; modify pstext/glyph context
helpers and CLAUDE entries.

**Interfaces.** `psNumberSequence(vm, value: PsArray | PsString):
{ length: number; get(index: number): number }` validates the header/access and
reads values lazily. Implement the approved variants through PsTextSession's
same character/glyph loop. Invocation scopes temporarily select leaf/root fonts
for cshow and restore them on completion/escape. No text work frame is exitable.

**Step 1.** Pin the numeric sequence witnesses
`<95200002000a0014>` and `<95a002000a001400>` to [10,20], plus fixed-point,
IEEE/native-real representations, malformed lengths and nonfinite payloads.
Test ashow, widthshow, awidthshow with literal endpoints; Courier10 `(AB)` with
`[20 30] xshow` ends at [50,0], and `[1 2 3 4] xyshow` ends at [4,6]. Short
arrays/strings give rangecheck rather than zero displacement. kshow passes codes
65/66 exactly once for `(AB)` and a font/CTM/color change in its callback applies
to later glyphs. cshow supplies code and dx/dy, paints/advances nothing itself,
allows its callback to show text, and restores temporary font selection.
Test returning handlers, nested cshow, and `exit` reaching the surrounding repeat
without executing its later operand or publishing an unfinished glyph.

```ts
const { vm } = runPsText('/Courier 10 selectfont 0 0 moveto (AB) [1 2 3 4] xyshow currentpoint');
expect(vm.number(1).value).toBe(4);
expect(vm.number().value).toBe(6);
```

**Step 2.** Run `npx vitest run test/psnumbers.test.ts test/psshow.test.ts test/pstext-callbacks.test.ts`;
expect RED for missing variants/decoder.

**Step 3.** Implement fixed-point 16/32-bit and IEEE32 forms with header-endian
lengths and signed values. Define the VM's native real representation as IEEE32
in native byte order and document it. Consume numbers without expanding a whole
encoded array. Additional user displacements and width-replacing displacements
must remain distinct. kshow re-reads current font/CTM for subsequent glyphs;
cshow uses the mapped leaf for each callback and restores its enclosing font.

**Step 4.** Run `npx vitest run test/ps` and `npm run typecheck`.
Expect GREEN, including exact final-point witnesses and callback cleanup.

**Step 5.** Commit `feat(ps): implement positioned shows and text callbacks`.

## Task 10 — Composite character mapping and effective fonts

**Files.** Extend `src/pscomposite.ts`, `psfont.ts`, `pstext.ts`;
create `test/pscomposite.test.ts`; update CLAUDE invariants.

**Interfaces.** Extend Task 8's PsCharacterCursor for validated Type 0 FontType,
FMapType2/3, Encoding selector indices, FDepVector and EscChar. It produces the
same PsCharacter with mapped base code, original root and effective matrix;
all show/measurement/path/callback consumers continue to use that interface.
No composite-specific alternate show or width implementation is introduced.

**Step 1.** Test 8/8 pairs selecting two descendants with widths 500 and 700,
escape switching/doubled escape, malformed/truncated input and invalid selectors.
Test a nested modal/nonmodal hierarchy with different ancestor matrices against
literal Adobe-derived device coordinates, not a product of the implementation's
own helper. In a descendant BuildGlyph/cshow callback, currentfont is the leaf
and rootfont is the root; explicit setfont inside the callback updates what both
queries observe until the enclosing scope restores selection. Test dictionary
cycles -> invalidfont, more than five composite levels -> limitcheck, configured
smaller depth -> ResourceLimitError, unsupported WMode/FMap/CID -> explicit
UnsupportedFeatureError. Include show/stringwidth/charpath parity and one escape
through nested procedure descendants.
For the ancestor-matrix witness, define a base font with .001 FontMatrix and
width [500,0], its Type0 parent with matrix [2,0,0,3,0,0], and an outer Type0
with matrix [5,0,0,7,0,0]. Both composites use FMapType2 and selector zero. After
outer definefont, its stored Type0 descendant matrix is [10,0,0,21,0,0], while
the base font matrix stays .001. Showing one mapped glyph advances [5,0], not
[25,0]; glyph point [100,200] maps to [1,4.2] at user origin zero. Assert those
literals and the visible FDepVector matrix, not only a final multiplied matrix.
Define `pairFontSource()` in the test helper: it installs `/Pair` with identity
root FontMatrix, FMapType2, two Type3 descendants with .001 matrices and glyph
widths 500/700, and Encoding [0 1].

```ts
const { vm } = runPsText(pairFontSource() + ' /Pair 10 selectfont <00410142> stringwidth');
expect(vm.number(1).value).toBeCloseTo(12, 10);
expect(vm.number().value).toBeCloseTo(0, 10);
```

**Step 2.** Run `npx vitest run test/pscomposite.test.ts`; expect RED for missing
mapping, not guessed fallback to descendant zero.

**Step 3.** Implement Adobe modal/nonmodal mapping with explicit bounded traversal
frames. At definefont, a nonidentity composite FontMatrix derives its Type0
descendants; makefont/scalefont/selectfont propagate their transforms through
descendant Type0 fonts, leaving base fonts unchanged. Drawing consults only the
selected base and its immediate parent, whose matrix already includes ancestors.
Apply the PLRM repeated-EscChar rules. Validate at definition and recheck
VM validity at invocation. Reset modal selection at the specified show boundary;
mapping-selector bytes do not become glyphs or callback invocations.

**Step 4.** Run `npx vitest run test/ps` and `npm run typecheck`;
expect GREEN without per-consumer metric/mapping discrepancies.

**Step 5.** Commit `feat(ps): map bounded composite-font text`.

## Task 11 — Inventory, hostile integration, provenance and delivery

**Files.** Create `test/pstext-inventory.test.ts`, `test/pstext-limits.test.ts`,
`test/pstext-integration.test.ts`, fixtures under
`test/fixtures/postscript-text/` and PROVENANCE.md; update CLAUDE/README policy
scope and CHANGELOG only when its user-visible-change rule applies.

**Interfaces.** Final installPsText installs each group once, shares its VM,
graphics DecodeBudget/output counters and supplies psFontSource for PFB host
execution. appendPsPages remains the only Document installation adapter.

**Step 1.** Add systemdict/source witnesses covering every inventory row below.
Build a small source fixture combining Standard-14 re-encoding, source Type1,
padded Type42, Type3, a nested composite, glyphshow and text inside forms/patterns.
Reuse `test/fixtures/fonts/NimbusSans-Regular.t1` and its AFM/provenance, plus
`fonts/LiberationSans-Regular.ttf` with `fonts/LICENSE-OFL.txt`;
identify newly authored wrappers separately. Assert literal widths/geometry and
known extracted Unicode, plus stable saved glyphs across page/VM transitions.
Hostile cases include font/encoding dictionaries, SFNT/charstring expansion,
recursive/empty glyph builders, repeated stringwidth, composite cycles, bank and
output-only growth, discarded captures, failed installation/definition/capture,
and repeated runs. Assert exact small limit fields/reached/allowed/detail.

```ts
const vm = new PsInterpreter({ limits: LoadLimits.defaults.with({ maxPostScriptOperations: 1_000_000 }) });
const graphics = installPsGraphics(vm);
installPsText(vm, graphics);
expect(() => vm.run(bytes('{ (AA) stringwidth pop pop } loop')))
  .toThrowError(expect.objectContaining({ limit: 'maxPostScriptOperations', allowed: 1_000_000 }));
```

**Step 2.** Run `npx vitest run test/pstext-inventory.test.ts test/pstext-integration.test.ts test/pstext-limits.test.ts`
and observe RED for any remaining gaps. For each gap retain a named RED/GREEN
regression.

**Step 3.** Resolve those gaps. Independently check a saved fixture using installed
qpdf and record its version. Distinguish structural checks, literal expected
values, this library's rendering and any actually run visual oracle. No external
visual agreement can be claimed without an executed independent renderer.

**Step 4.** Run `npx vitest run test/ps type1 sfnt std14 fontwork limits-fonts test/import-cycles.test.ts test/limits-catch.test.ts test/readme-api.test.ts`,
`npm run typecheck` and `git diff --check`. Expect GREEN; the PS filter includes
the existing PDF type-4 calculator tests. Obtain the selected workflow's whole-branch
review and fix material findings with RED/GREEN tests. No Markdown ledger.

**Step 5.** Run both full gates (`npm run typecheck`, `npm test`), integrate the
verified branch into main under the repository workflow, rerun both gates there,
then close lw8w.3. Commit generated Beads bookkeeping, push main and bd dolt push.
Keep user files intact and verify the branch is up to date with origin. File
remaining work as Beads issues rather than silently expanding this issue.

## Inventory ownership

| Inventory | Owner |
| --- | --- |
| findfont/definefont/undefinefont, makefont/scalefont, setfont/currentfont/rootfont/selectfont | Task 5; callback-sensitive queries in 7/9/10 |
| StandardEncoding, ISOLatin1Encoding, Symbol/Dingbats vectors, findencoding, FontDirectory/GlobalFontDirectory | Task 5 using Task 3 bindings |
| Font/Encoding findresource/defineresource/undefineresource/resourcestatus/resourceforall | Task 5 |
| Type1 programs, lenIV, standard subrs/flex/seac, Metrics | Task 4; executable source in 2/11 |
| Type42 sfnts/CharStrings GIDs/padding and normalized metrics | Task 4/11 |
| Type3 BuildGlyph/BuildChar and setcharwidth/setcachedevice/setcachedevice2 | Task 7 |
| eexec and PFA/PFB source execution | Tasks 1/2/11 |
| show/stringwidth/glyphshow/charpath/eocharpath | Task 8 |
| ashow/widthshow/awidthshow/xshow/yshow/xyshow/kshow/cshow | Task 9 |
| Type0 FMap2/3, nested mapping and root/leaf selection | Task 10 |
| composefont, CID/CMap/vertical/other FMap, Multiple Master, custom OtherSubrs, GlyphDirectory, procedure CharStrings, CDevProc, unsupported font/cache mechanisms | Explicit UnsupportedFeatureError, Tasks 4/5/10; inventory probes in 11 |

## Self-review record

Before committing this plan, compare every spec section with the task ownership
above, check all shared types/signatures against their consumers, and verify each
Review Focus condition has a named regression. Record the result and any ruling
in lw8w.3. This paragraph is an instruction to the planner, not a progress ledger.
