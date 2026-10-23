# Adobe Reader paper-barcode probes (2srz.4)

**Producer of the answers:** Adobe Acrobat Reader 26.1.21691.0
(`app.viewerVersion` 26.00121691; Acrobat DC in Reader mode, Protected Mode
on), Windows 11, 2026-10-22.

**What they are:** 12 AcroForms built by OUR code,
`test/helpers/build-paper-barcode-probe.ts` in `'oracle'` mode (written by
`scripts/gen-paper-barcode-probes.ts`). Each holds fields with values in `/V`
and a barcode field carrying Acrobat's tab-delimited calculation script over
every field. On open, Reader runs the script and writes
`JSON.stringify(value)` of the barcode, and of each field (with its type and
`typeof`), into a visible `dbg` field. `<name>.png` is the Reader window
(`scripts/run-paper-barcode-probe.ps1`), and `goldens.json` is the barcode
line of each capture, **transcribed by hand**. `test/paper-barcode-oracle.test.ts`
rebuilds every probe in `'ours'` mode and requires our recomputed content to
equal it.

**The script.** It is Acrobat's own, verbatim from users' pastes on the Adobe
community forum (`bMemberOf` from the "barcode generator variable order"
thread, `strTabDelimited` and the call from td-p/8664920), as
`src/pmd.ts`'s `buildTabScript` writes it. One change for the oracle: the
`app.viewerVersion >= ADBE.PMD_Need_Version` guard is removed.

## What Reader showed that the design did not expect

- **Reader cannot run Acrobat's script as written.** `ADBE` is undefined in
  Reader, so the guard throws and the script's `catch` sets the value to
  `" "`. In plain Reader an Acrobat paper barcode never updates.
- **Reader draws no symbol.** A `/PMD` field is painted as a grey box, so
  Reader is an oracle for the barcode's CONTENT only. The drawn symbol is
  checked by our own ZXing tooling (`test/fixtures/barcode-zxing/`).

## What each probe settled

| Probe | Reader's answer | Rule |
|---|---|---|
| `order` | `B u 10 9 a ma mb m z e` | `getNthFieldName` is sorted by UTF-16 code unit of the full name (`Beta` < `_u` < `a10` < `a9` < `alpha` < `mid.a` < `midx` < `zeta` < `été`), not creation order. Terminal fields only. |
| `numbers` | `7 1.5 1e3 0 ␣42␣ 0x1F 12345678901234567000 0.5` | A value that is an optional sign, digits, and an optional fraction with digits after the point is a JavaScript NUMBER and prints as one. Otherwise it is a string. |
| `numbers2` | `5 1. -0.5 1,5 0 -7 1.2.3 - 1␣000 Infinity 0.1 1e-7 1e-7 1.2345678901234569e+23 7 007,1.50` | `+5`, `-.5`, `00`, `-007`, `0.1000` and `0.0000001` are numbers; `1.`, `1,5`, `1e-7`, `Infinity` and `1 000` are not. A combo `007` is `7`, but a multi-select list's items stay as written (`007,1.50`). |
| `buttons` | `Yes Off Si b Off` | A checkbox gives its export or `Off`, and a radio group its selected export or `Off`. A push button is skipped. |
| `choices` | `Two B A,C` | A multi-select list joins its selection with commas (`Array.toString`). |
| `empty` | `\t` | Empty values are empty strings. |
| `header` | `a\tb x\ty` | With `bFieldNames`, the header's `\n` becomes a SPACE, because the barcode field is single-line. |
| `text` | `é Ж a\tb a␣b` | Text is passed through as written; a tab inside a value is kept. |
| `linebreaks` | `c d\te f` | In a single-line barcode field each line break (`\r\n`, `\r`, `\n`) becomes one space. |
| `multiline` | `m1\tm2\tm3\ra\rb\tc\rd\te\rf` | In a multiline barcode field each line break becomes `\r`, including the header separator. |
| `misc` | `7 7 7 secret 42` | The number rule applies to every single value: a single-select list, a checkbox export, a radio export and a comb field all turn `007` into `7`. A PASSWORD field contributes its plaintext. |
| `format` | `3` | A format script does not change the value: it is the raw `/V`, not the formatted `3.00`. |

(Spaces in the table stand for tabs except where `␣` marks a real space.)

## How to re-run

Reader installed, then `npx tsx scripts/gen-paper-barcode-probes.ts [name]`
and `powershell -File scripts/run-paper-barcode-probe.ps1 -Name <name>`.
Regenerating writes byte-identical PDFs (checked 2026-10-22).

## Ceiling

One producer, one version, Reader rather than Acrobat Pro, and hand
transcription. These goldens are evidence for how Acrobat's own script
computes a value, and say nothing about:

- how Acrobat Pro turns that text into symbol bytes (encoding, ECI);
- what `/DataPrep 1` compression produces;
- which `/PMD` keys Acrobat needs;
- shapes no probe built: a rich-text field, a signature field, a file-select
  field, a multi-select list with exactly one item selected, or a choice whose
  export and display differ. `src/paperbarcode.ts` reports those rather than
  guessing.

## Files

| File | SHA-256 |
|---|---|
| `buttons.pdf` | `05f25dac1a61d286000b8645738a2d26e1de30edb6fab37342e23c930d7b3a16` |
| `choices.pdf` | `e765f8511205324fd38630720156e2af13fe02c5a0f450e66e7880701af9de63` |
| `empty.pdf` | `788d49ea931e04d406773d0eadb2fe9305e423bfebcc309afb7373e88493b62e` |
| `format.pdf` | `148eb920f3a0a0a5c24c11e294c1285abfee070a10c8c77efa22965bcf0a5994` |
| `header.pdf` | `1d39f873a5502958afb73b86d1c9ac2648967a1aa48749e9bd8650faa3e9ecb6` |
| `linebreaks.pdf` | `3f9fd9122bc30628daa3846178fd5f51aa749af3b0601cbc603ff44cc28317e7` |
| `misc.pdf` | `9a0a4ae0268a7642f64088f38aef0f243dbb9f18a6a721be9dbeb8430865b209` |
| `multiline.pdf` | `de6cf4b7a1052268994a81f5634cc23744bdf36b35bd4b0e0a6ca29b92b6f284` |
| `numbers.pdf` | `5a35e8483351219769b3cd6ab4b43531146e84e3e47bdcb4e118af4195bfa64a` |
| `numbers2.pdf` | `cfde4f17919a5852ee8286b493673f4e745deec16742e61d4e8dc571444c2c3b` |
| `order.pdf` | `8b64c0c49eb408a9e926e00c4f494e4fd917c154dc27301b89d6582b2b752e4e` |
| `text.pdf` | `9fddce85122b5f75bb5eff2da33bab3f42148e07592fa95e3131df9f976788b8` |
