# Paper-Barcode Form Field Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A text field that draws as a PDF417 / Data Matrix / QR barcode of the form's data, authored here or opened from Acrobat, kept current automatically, and checked byte for byte against what Adobe Reader computes.

**Architecture:** A pure leaf (`src/pmd.ts`) owns the `/PMD` dictionary and Acrobat's tab-delimited calculation script (recognise, build, join). A `Document`-holding module (`src/paperbarcode.ts`) creates barcode fields, maps fields to the value Acrobat's `field.value` gives, draws appearances through the existing encoders, and runs a refresh pass from the same places `finalizeEmbeddedFonts` runs. The oracle is Adobe Reader on this machine: probe PDFs it recalculates and draws, captured from the window and decoded by ZXing.

**Tech Stack:** TypeScript (ESM, NodeNext, `.js` specifiers), vitest; oracle tooling needs a JDK, PowerShell and Adobe Acrobat Reader 26.1 (not run by `npm test`).

**Spec:** `docs/superpowers/specs/2026-10-22-paper-barcode-field-design.md`

## Global Constraints

- Zero runtime dependencies; `node:` built-ins only.
- Never execute document JavaScript — a script is recognised by shape or it is not; `test/aform-noexec.test.ts` stays green.
- Every `catch` in `src/` calls `rethrowLimit(e)` first (`test/limits-catch.test.ts`).
- Creation validates every argument before allocating — a rejected call leaves the document byte-identical.
- A document whose barcode content did not change is untouched: no write, no `markModified()`.
- The public string signatures of `makePdf417`, `makeDataMatrix`, `makeQr` and their output do not change; the 2srz.3 ZXing goldens (`test/barcode-zxing.test.ts`) are the fence.
- `/V` holds the plain content; `/DataPrep 1` compression happens only inside the symbol; byte-identical zlib output with Acrobat is not claimed.
- Only value shapes with a Reader-probe golden are reproduced; anything else is reported, not guessed.
- CHANGELOG `[Unreleased]` entry, README rows (`test/readme-api.test.ts`) and CLAUDE.md module entries land in the same commit as the user-visible change.

## Review Focus

1. **A carried field that no longer exists** (renamed or removed after the script was written): Acrobat's `getNthFieldName` loop simply never meets it — the barcode must carry the remaining fields, not throw or report. Test in Task 6.
2. **Content past the symbology's capacity**, which surfaces at `Save`: the save must not throw; the barcode keeps its old `/V` and appearance and is reported `too-large`. Test in Task 6.
3. **A value containing a tab or a newline**: Acrobat joins it raw, so the reproduction must too, even though it corrupts the delimited layout. Test in Task 6 (and a probe case in Task 5).
4. **A barcode field with several widgets** (a field with `/Kids`): every widget gets the new appearance. Test in Task 4.
5. **An opened document saved with no edits** whose barcode `/V` already matches: byte-identical output and an incremental `Sign`. Test in Task 6, through the sign path.

---

### Task 1: Go/no-go spike — does Reader draw an AcroForm barcode we authored, and does its capture decode?

**Files:**
- Create: `scripts/gen-paper-barcode-probes.ts`
- Create: `scripts/run-paper-barcode-probe.ps1`
- Modify: `scripts/BarcodeOracle.java` (add an `image` kind)
- Create: `test/fixtures/paper-barcode/` (probe `p1.pdf`, capture `p1.png`)

**Interfaces:**
- Produces: `BarcodeOracle` stdin line `name TAB image TAB <absolute png path>` → `name TAB OK TAB <symbology> TAB base64(raw bytes)` or `name TAB FAIL TAB message`; it tries PDF417, Data Matrix and QR readers with `TRY_HARDER` on an image read through `javax.imageio` (own `LuminanceSource`, as `BitMatrixSource` is — the zxing `javase` jar is not fetched). Raw bytes come from `ResultMetadataType.BYTE_SEGMENTS` when present, else the text as UTF-8.
- Produces: `gen-paper-barcode-probes.ts <name>` writes `test/fixtures/paper-barcode/<name>.pdf`; `run-paper-barcode-probe.ps1 -Name <name>` opens it in Reader (the `run-xfa-adobe-probe.ps1` recipe: kill Reader, start, wait, `PrintWindow`) and writes `<name>.png`.

- [ ] **Step 1:** Build probe `p1` by hand: `AddTextField` for `name` ("Ann") and `zip` ("007"), and a third text field `bc` whose dict gets `/PMD << /Symbology /PDF417 /ECC 2 /XSymWidth 3 /XSymHeight 9 /Resolution 300 /DataPrep 0 >>`, a `/AA /C` JavaScript action holding the spec's tab-delimited script verbatim with `aFields: ["name", "zip"]`, the helper `bMemberOf` (see Step 2) and `bFieldNames: false`, and `bc` appended to `/AcroForm /CO`. Values are set by a document-level `/OpenAction` JavaScript (`this.getField("name").value = "Ann"; ...; this.calculateNow();`) because Reader will not save typed data. Make the `bc` rect large (e.g. 400x150pt) and set `/OpenAction` zoom or a page size so the capture is at least 2 px per module.
- [ ] **Step 2:** `bMemberOf`'s text is not in the spec's source. Write the minimal correct version (`for (var i = 0; i < aStrNames.length; ++i) if (strName == aStrNames[i]) return true; return false;`) and mark it in the generator as OURS, not Acrobat's; Task 3's recogniser must accept any body for it only after Task 5 captures Acrobat's (if a real one is found) — until then it accepts exactly this one and the verbatim forum text.
- [ ] **Step 3:** Run `npx tsx scripts/gen-paper-barcode-probes.ts p1` then `powershell -File scripts/run-paper-barcode-probe.ps1 -Name p1`. Expected: `p1.png` shows a PDF417 symbol drawn by Reader in `bc`.
- [ ] **Step 4:** Decode: pipe `p1 TAB image TAB <path>` into `BarcodeOracle`. Expected: `OK PDF417` and bytes `Ann\t007` — or `Ann\t7`, which is itself the first finding.
- [ ] **Step 5 (gate):** If Reader draws no barcode, or the capture will not decode at any zoom, STOP and report to the user before any further task: the oracle and the "current in Reader" goal both rest on this. Record what was tried.
- [ ] **Step 6:** Record in the issue (`bd note 2srz.4 ...`) which `/PMD` keys Reader needed (drop each in turn and re-run if time allows) and the decoded bytes. Commit scripts and `p1.*`.

```bash
git add scripts/gen-paper-barcode-probes.ts scripts/run-paper-barcode-probe.ps1 scripts/BarcodeOracle.java test/fixtures/paper-barcode/
git commit -m "test(2srz.4): Reader paper-barcode probe spike"
```

### Task 2: Byte-input encoder paths

**Files:**
- Modify: `src/pdf417.ts`, `src/datamatrix.ts`, `src/qr.ts`
- Test: `test/barcode-bytes.test.ts`

**Interfaces:**
- Produces (internal, NOT exported from `index.ts`):
  - `makePdf417Bytes(bytes: Uint8Array, eci: number | undefined, opts?: Pdf417Options): MatrixBarcode`
  - `makeDataMatrixBytes(bytes: Uint8Array, eci: number | undefined, opts?: DataMatrixOptions): MatrixBarcode`
  - `makeQrBytes(bytes: Uint8Array, opts?: QrOptions): MatrixBarcode` (byte mode; QR's ECI is out of scope unless Task 5 shows Reader writes one)
- The public `makePdf417(data)` / `makeDataMatrix(data)` become `pdf417Bytes`/`dataMatrixBytes` + the byte path; `makeQr` keeps its current mode selection for strings.

- [ ] **Step 1: Failing tests** — `makePdf417Bytes(pdf417Bytes(s).bytes, pdf417Bytes(s).eci)` equals `makePdf417(s)` module for module for `'HELLO'`, `'Grüße Привет'`, `'1234567890123'`; same for Data Matrix; `makeQrBytes(new TextEncoder().encode('a\tb'))` decodes in byte mode (assert the model equals `makeQr('a\tb')` when that string selects byte mode); arbitrary bytes `[0, 255, 10, 9]` encode without throwing in all three.
- [ ] **Step 2:** Run `npx vitest run test/barcode-bytes.test.ts` — FAIL, functions undefined.
- [ ] **Step 3:** Thread a `Uint8Array` + ECI through `pdf417Codewords`/`dataMatrixCodewords` (split each into a bytes core and the existing string wrapper); add QR's byte entry.
- [ ] **Step 4:** Run the new test and `npx vitest run test/barcode-zxing.test.ts test/barcode.test.ts test/barcode-2d-place.test.ts` — all PASS, ZXing hashes unchanged.
- [ ] **Step 5:** Commit `feat(2srz.4): byte-input paths for the 2D encoders`.

### Task 3: `src/pmd.ts` — `/PMD` and Acrobat's tab-delimited script

**Files:**
- Create: `src/pmd.ts`
- Test: `test/pmd.test.ts`

**Interfaces:**
- Produces:
  - `type PmdSymbology = 'PDF417' | 'QRCode' | 'DataMatrix'`
  - `interface PaperMetadata { symbology: PmdSymbology; ecc?: number; xSymWidth?: number; xSymHeight?: number; ySymHeight?: number; nCodeWordRow?: number; nCodeWordCol?: number; resolution?: number; dataPrep?: 0 | 1; caption?: string }` — trim to the keys Task 1 recorded.
  - `readPmd(dict: PdfDict | undefined, resolve): PaperMetadata | undefined` — lenient: unknown symbology → `undefined`; wrong-typed entry dropped.
  - `encodePmd(pmd: PaperMetadata): PdfDict` — strict, `TypeError`/`RangeError`.
  - `interface TabScript { fields: readonly string[] | null; fieldNames: boolean; exclude?: string }`
  - `parseBarcodeScript(script: string): { encoding: 'tab'; params: TabScript } | { encoding: 'xml' } | undefined` — never throws; `'xml'` when the script calls a function named like Acrobat's XML helper (`strXMLData`/`strXmlData`) and does not match the tab template.
  - `buildTabScript(params: TabScript): string` — the spec's verbatim template plus `bMemberOf`, with `aFields` as JS string literals (escape `\`, `"`, control characters) or `null`.
  - `joinTabDelimited(entries: readonly { name: string; value: string }[], fieldNames: boolean): string` — the template's arithmetic: tabs between, `names + "\n" + values` when `fieldNames`.
- Imports: `types.js`, `metadata.js` (text decode) only.

- [ ] **Step 1: Failing tests:** `parseBarcodeScript(buildTabScript(p))` round-trips `p` for `fields: ['a','b "q"']`, `null`, `fieldNames: true`, `exclude: 'bc'`; the spec's verbatim forum script (copied into the test as a fixture string) parses to `{ fields: ["Applicant Name", ..., "Substitute"], fieldNames: false }`; a script with one altered statement (e.g. `"\t"` → `"|"`) returns `undefined`; a script calling `strXMLData(` returns `{ encoding: 'xml' }`; `joinTabDelimited([{name:'a',value:'1'},{name:'b',value:''}], true)` is `'a\tb\n1\t'`; `readPmd(encodePmd(x))` deep-equals `x`; `encodePmd({ symbology: 'PDF417', ecc: 9 })` throws `RangeError`; `readPmd` of `/Symbology /Code39` is `undefined`.
- [ ] **Step 2:** Run `npx vitest run test/pmd.test.ts` — FAIL.
- [ ] **Step 3:** Implement. Recognition compares the script with whitespace normalised (collapse runs, ignore around punctuation) against the template with the three blanks captured; the blanks must be literal (string array or `null`, boolean, optional string). Anything else → `undefined`.
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `feat(2srz.4): /PMD and Acrobat's tab-delimited barcode script`.

### Task 4: `Form.AddBarcodeField` and the barcode appearance

**Files:**
- Create: `src/paperbarcode.ts`
- Modify: `src/form.ts` (`AddBarcodeField`), `src/page.ts` (forwarder), `src/formcreate.ts` (export `createField` if not already, and nothing else), `src/barcodeplace.ts` (export `matrixRects` for reuse, unchanged)
- Test: `test/barcode-field.test.ts`

**Interfaces:**
- Consumes: Task 2 byte encoders; Task 3 `encodePmd`, `buildTabScript`.
- Produces:
  - `interface BarcodeFieldInit extends FieldInit { symbology?: 'pdf417' | 'datamatrix' | 'qr'; ecLevel?: number; columns?: number; shape?: 'square' | 'rectangle' | 'any'; ecc?: QrEcc; encoding?: 'tab' | 'json' | 'value'; fields?: readonly string[]; fieldNames?: boolean; compress?: boolean; value?: string }`
  - `Form.AddBarcodeField(init: BarcodeFieldInit): TextField`, `Page.AddBarcodeField(init: Omit<BarcodeFieldInit, 'page'>): TextField`
  - `drawBarcodeAppearance(doc: Document, widget: PdfDict, pmd: PaperMetadata, content: Uint8Array, eci?: number): void` — builds `/AP /N` (vector rects via `matrixRects`, fit to the widget `/Rect`, quiet zone on) through `buildAppearanceXObject`; empty content → an empty appearance.
  - Initial content: `value` draws its `init.value`; `tab` and `json` are created with `/V ''` and an empty appearance, and get their first real content from Task 6's refresh pass (so there is ONE content computation, not one at creation and one at save). The `json` content is `doc.ExportJson` of the carried fields, compact, also computed in Task 6.

- [ ] **Step 1: Failing tests:**
  - defaults: `AddBarcodeField({ name: 'bc', page: 1, rect })` on a form with fields `a`, `b` writes `/FT /Tx`, `/PMD /Symbology /PDF417`, a calculate JS that `parseBarcodeScript` reads as `{ encoding: 'tab', params: { fields: ['a','b'], fieldNames: false, exclude: undefined } }` (explicit list of fields existing now, the barcode itself excluded), and `bc` in `/AcroForm /CO`.
  - `encoding: 'json'` and `'value'` write no `/AA /C` and no `/CO` entry.
  - `symbology: 'qr'` writes `/QRCode`; `'datamatrix'` writes `/DataMatrix`.
  - `encoding: 'value', value: 'ID-42'`: the drawn appearance reads back module for module (render the page and sample, as `test/barcode-2d-place.test.ts`'s `readBack` does) as `makePdf417('ID-42')`.
  - `drawBarcodeAppearance` on a field with two widgets (`/Kids`) gives both the appearance (Review Focus 4).
  - rejected calls throw and leave `doc.Save()` byte-identical: `symbology: 'code39'` (RangeError), `ecLevel: 9` (RangeError), `fields: ['nope']` naming no existing field (RangeError), `fieldNames: true` with `encoding: 'json'` (RangeError), `value` with `encoding: 'tab'` (RangeError).
- [ ] **Step 2:** Run `npx vitest run test/barcode-field.test.ts` — FAIL.
- [ ] **Step 3:** Implement through `createField(doc, init, { ft: 'Tx', entries, buildAP })`, appending to `/CO` (create it if absent). Validate all options before `createField`.
- [ ] **Step 4:** Run — PASS. Run `npx vitest run test/readme-api.test.ts` after adding the README rows for `BarcodeFieldInit` and `AddBarcodeField` (update counts as the test reports).
- [ ] **Step 5:** Re-point Task 1's generator at `AddBarcodeField` (keeping its `/OpenAction`), regenerate `p1`, rerun the probe; the decoded bytes must be unchanged. Commit `feat(2srz.4): AddBarcodeField`.

### Task 5: Reader probe set and goldens

**Files:**
- Modify: `scripts/gen-paper-barcode-probes.ts`
- Create: `scripts/gen-paper-barcode-goldens.ts` (decodes every capture through `BarcodeOracle` and writes the goldens)
- Create: `test/fixtures/paper-barcode/goldens.json`, `PROVENANCE.md`, probe `pN.pdf` + `pN.png`

**Interfaces:**
- Produces `goldens.json`: `{ reader: string; probes: { name: string; symbology: PmdSymbology; fieldNames: boolean; bytesBase64: string; values: Record<string, string | boolean | string[]>; order: string[] }[] }`, where `values` is what the probe set and `order` the field creation order.

- [ ] **Step 1:** Probes (each its own PDF, values set by `/OpenAction`), chosen to settle the spec's open questions:
  - `order`: fields created `zeta`, `alpha`, `mid.b`, `mid.a`, carried in the list order `alpha, zeta, mid.a, mid.b` — settles `getNthFieldName` order.
  - `numbers`: text `007`, `1.50`, `1e3`, `-0`, ` 42 `, `0x1F` — settles numeric coercion.
  - `buttons`: checkbox on (export `Yes`), checkbox off, checkbox custom export `Si`, radio selected / none, a push button (must be skipped).
  - `choices`: combo, single list, multi-select list with two selected.
  - `empty`: one empty text field; and all fields empty.
  - `header`: `bFieldNames: true`.
  - `text`: `é`, `Ж`, a value containing `\t`, one containing `\n`.
  - `format`: a text field with an `AFNumber_Format(2, ...)` format script and value `3` — raw or formatted?
  - `symbologies`: the same values under `QRCode` and `DataMatrix`.
  - `compress`: `/DataPrep 1`.
- [ ] **Step 2:** Generate, run each through `run-paper-barcode-probe.ps1`, then `npx tsx scripts/gen-paper-barcode-goldens.ts`. Expected: every probe decodes; the script refuses to write a golden for one that does not.
- [ ] **Step 3:** Write `PROVENANCE.md` in the repo's style (`test/fixtures/xfa-adobe/PROVENANCE.md`): Reader version, the screen channel, how to re-run, hashes, the ceiling (one producer, one version, Reader not Acrobat Pro, our `bMemberOf`), and one line per probe stating what Reader answered. Add the `fixtures/paper-barcode/` row to CLAUDE.md's fixture table.
- [ ] **Step 4:** Commit `test(2srz.4): Reader paper-barcode goldens`.

### Task 6: Acrobat's `field.value`, and the refresh pass

**Files:**
- Modify: `src/paperbarcode.ts`, `src/document.ts` (call the pass beside each `finalizeEmbeddedFonts()` — `Save`, `saveIncremental`, `Sign`/`Certify`, `AddDocumentTimestamp`), `src/form.ts` (`RefreshBarcodes`), `src/afform.ts` (skip a field whose calculate script `parseBarcodeScript` recognises, so `Recalculate` stops reporting it unrecognised)
- Test: `test/paper-barcode-oracle.test.ts`, `test/paper-barcode-refresh.test.ts`

**Interfaces:**
- Consumes: Task 3, Task 4, Task 5 goldens.
- Produces:
  - `acrobatFieldValue(field: Field): string | undefined` — what `+=` of Acrobat's `field.value` yields for this field, by the rules Task 5 settled, each rule commented with its probe; `undefined` for an unprobed shape (signature field, rich text, a format script Task 5 did not settle, anything else).
  - `interface BarcodeRefreshReport { updated: readonly string[]; notRecomputed: readonly { field: string; reason: 'xml-encoding' | 'unrecognised-script' | 'locked' | 'unprobed-value' | 'too-large'; detail?: string }[] }`
  - `refreshBarcodeFields(doc: Document): BarcodeRefreshReport`; `Form.RefreshBarcodes(): BarcodeRefreshReport` (public, so a caller can see the report; `Save` discards it).

- [ ] **Step 1: Oracle test** — for every golden, rebuild the probe document with `gen-paper-barcode-probes.ts`'s builder (export it as `test/helpers/build-paper-barcode-probe.ts` so test and generator share it), run `refreshBarcodeFields`, and require the barcode field's `/V` bytes (after `/DataPrep`) to equal `bytesBase64`. Also require that the drawn appearance's model equals `makePdf417Bytes`/... of those bytes.
- [ ] **Step 2: Refresh tests:**
  - a value change through `Field.Value` then `Save()` → reopened `/V` reflects it; `RefreshBarcodes().updated` names the field.
  - Review Focus 5: open a saved document, `Save()` again with no edit → byte-identical; `Sign()` on it appends incrementally (base bytes a prefix of the result), as `test/page-mode.test.ts` checks.
  - Review Focus 1: a carried name with no field → content from the remaining fields, nothing reported.
  - Review Focus 2: content past capacity (`'x'.repeat(5000)` under PDF417 ECC 8) → `Save()` does not throw; `/V` and `/AP` unchanged; reported `too-large`.
  - Review Focus 3: a value with `\t` and `\n` is joined raw.
  - an `xml` script → reported `xml-encoding`, `/V` kept, appearance redrawn from `/V` only if absent.
  - an unrecognised script → `unrecognised-script`; a carried signature field → `unprobed-value`.
  - a barcode field under a signed FieldMDP lock (`Sign` with `lock: { action: 'Include', fields: ['bc'] }` via `AddSignatureField`), then a value change and `Save()` → `/V` unchanged, reported `locked`; certified at `no-changes` → same.
  - `json` and `value` encodings refresh too.
  - `Recalculate()` no longer lists a barcode field in `unrecognised`.
- [ ] **Step 3:** Run both files — FAIL.
- [ ] **Step 4:** Implement. Field order = `doc.Form.Fields` order if Task 5 shows it matches `getNthFieldName`, else the order Task 5 found (comment the probe). Push buttons and the barcode field itself skipped. Lock check through `doc.Signatures` (signed ones) → `readFieldMdpLock` + `isLocked`, and the certification's `readDocMdpLevel === 1`. The pass compares the computed content with `/V` and touches nothing when equal and every widget has an `/AP`. Every `catch` → `rethrowLimit` first.
- [ ] **Step 5:** Run both files and `npx vitest run test/sign test/afform test/form` — PASS.
- [ ] **Step 6:** Commit `feat(2srz.4): reproduce Acrobat's tab-delimited barcode and refresh it on save`.

### Task 7: Docs, mutation sweep, close

**Files:**
- Modify: `README.md` (Key Capabilities barcode line, a "Barcode form fields" example, API rows for `RefreshBarcodes`/`BarcodeRefreshReport`, a Scope and Limitations line: XML encoding recognised not recomputed, `json` current only through this library), `CHANGELOG.md`, `CLAUDE.md` (entries for `pmd.ts` and `paperbarcode.ts` with their invariants and measured notes)

- [ ] **Step 1:** Mutation sweep (node harness as in 2srz.3; report TIMEOUT/LOAD-ERROR distinctly): the tab separator, the header `\n`, button skipping, self-exclusion, field order, each `acrobatFieldValue` rule, the no-op comparison, the lock check, the too-large catch, `/CO` append, the `Recalculate` skip. Any GREEN mutation gets a case or a recorded note.
- [ ] **Step 2:** `npm run typecheck` and `npm test` — both green; the CLAUDE.md module sweep prints nothing.
- [ ] **Step 3:** Commit docs; `bd close 2srz.4`; `git pull --rebase && git push`.
