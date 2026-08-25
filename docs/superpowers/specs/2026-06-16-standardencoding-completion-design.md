# Complete StandardEncoding High-Range Table — Design

**Issue:** aspose-pdf-foss-for-ts-4m2 (P3, task)
**Date:** 2026-06-16
**Discovered from:** aspose-pdf-foss-for-ts-e37 (Page text extraction)

## Goal

Fill the `0xB0..0xFF` entries of `standardEncoding` in `src/encoding.ts` from
Adobe StandardEncoding (ISO 32000-1:2008 Annex D, Table D.2, "STD" column), which
currently carry a `TODO(transcribe)` (only `0xA1..0xAF` are populated). Add
pinning tests. This is pure reference-data completion — values are fixed by the
standard; no behavioral latitude.

Impact: improves decoding only for PDFs that use a StandardEncoding simple font
**and** reference codes in `0xB0..0xFF` **and** have no `/ToUnicode`. The common
WinAnsi / `/ToUnicode` / Type0 paths are unaffected.

## Approach (settled)

Extend the existing `over` code→Unicode map inside the `standardEncoding` IIFE —
consistent with the already-populated `0xA1..0xAF` and with `macRoman`. Genuinely
undefined StandardEncoding slots are simply omitted from the map (they remain
`undefined`). No glyph-name-driven refactor; no other file touched.

## Data to add (defined slots only)

| Code | Glyph | Unicode | Code | Glyph | Unicode |
|------|-------|---------|------|-------|---------|
| 0xB1 | endash | 2013 | 0xCA | ring | 02DA |
| 0xB2 | dagger | 2020 | 0xCB | cedilla | 00B8 |
| 0xB3 | daggerdbl | 2021 | 0xCD | hungarumlaut | 02DD |
| 0xB4 | periodcentered | 00B7 | 0xCE | ogonek | 02DB |
| 0xB6 | paragraph | 00B6 | 0xCF | caron | 02C7 |
| 0xB7 | bullet | 2022 | 0xD0 | emdash | 2014 |
| 0xB8 | quotesinglbase | 201A | 0xE1 | AE | 00C6 |
| 0xB9 | quotedblbase | 201E | 0xE3 | ordfeminine | 00AA |
| 0xBA | quotedblright | 201D | 0xE8 | Lslash | 0141 |
| 0xBB | guillemotright | 00BB | 0xE9 | Oslash | 00D8 |
| 0xBC | ellipsis | 2026 | 0xEA | OE | 0152 |
| 0xBD | perthousand | 2030 | 0xEB | ordmasculine | 00BA |
| 0xBF | questiondown | 00BF | 0xF1 | ae | 00E6 |
| 0xC1 | grave | 0060 | 0xF5 | dotlessi | 0131 |
| 0xC2 | acute | 00B4 | 0xF8 | lslash | 0142 |
| 0xC3 | circumflex | 02C6 | 0xF9 | oslash | 00F8 |
| 0xC4 | tilde | 02DC | 0xFA | oe | 0153 |
| 0xC5 | macron | 00AF | 0xFB | germandbls | 00DF |
| 0xC6 | breve | 02D8 | | | |
| 0xC7 | dotaccent | 02D9 | | | |
| 0xC8 | dieresis | 00A8 | | | |

**Intentionally left `undefined`** (not in StandardEncoding): `0xB0, 0xB5, 0xBE,
0xC0, 0xC9, 0xCC, 0xD1–0xE0, 0xE2, 0xE4–0xE7, 0xEC–0xF0, 0xF2–0xF4, 0xF6, 0xF7,
0xFC–0xFF`.

Also drop the `TODO(transcribe)` line in the `over` map and the
"(transcribe below)" phrase from the `standardEncoding` doc comment.

## Testing

Extend the existing `base encodings > StandardEncoding` test in
`test/encoding.test.ts` with pins for a representative subset of the newly added
values and one undefined-slot assertion:

- `standardEncoding[0xD0] === '—'` (emdash)
- `standardEncoding[0xE1] === 'Æ'` (AE)
- `standardEncoding[0xE9] === 'Ø'` (Oslash)
- `standardEncoding[0xFB] === 'ß'` (germandbls)
- `standardEncoding[0xB7] === '•'` (bullet)
- `standardEncoding[0xB0] === undefined` (undefined slot stays undefined)

Run `npm run typecheck` and `npm test` green before closing.

## Out of scope

- Glyph-name-driven encoding refactor.
- Symbol / ZapfDingbats encodings, AFM width tables (separate concerns).
