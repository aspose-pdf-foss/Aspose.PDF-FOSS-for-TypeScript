# Content-stream tokenizer (operator parser) — Design

Issue: `aspose-pdf-foss-for-ts-6lc` (P2, feature)
Date: 2026-06-11

## Purpose

A foundational subsystem that tokenizes the decoded content-stream bytes
`Page.Contents` already produces into a faithful, re-serializable stream of
`(operands, operator)` tuples. It does **not** interpret semantics — it only
produces the op stream. It is the building block for text extraction
(`aspose-pdf-foss-for-ts-e37`, `Page.getText()`) and content stamping
(`aspose-pdf-foss-for-ts-b3y`).

New module: `src/content.ts`. Tests: `test/content.test.ts`.

## Existing building blocks reused

- `src/lexer.ts` `Lexer` already tokenizes content-stream syntax: numbers,
  names, strings (literal + hex), `[` `]` `<<` `>>` delimiters, and `kw`
  keyword tokens (operators land here). Comments (`%`) are skipped.
- `src/serialize.ts` `serializeValue` already re-emits every operand type
  (numbers, names, strings, arrays, dicts).
- `src/types.ts` `PdfObject` is reused directly as the operand type.

We deliberately do **not** reuse `ObjectParser`: its `maybeRef` collapses
`num num R` into an indirect reference. Content streams contain no indirect
references, and `R` is not a content operator, so a dedicated operand reader
keeps semantics correct and avoids needless lookahead.

## Data model

```ts
export interface ContentOp {
  readonly operator: string;        // 'BT', 'Tf', 'Tj', 'TJ', 'Do', 'cm', 'q', ...
  readonly operands: PdfObject[];   // numbers/names/strings/arrays/dicts
  /** Present only when operator === 'BI' (inline image). */
  readonly inlineImage?: { readonly dict: PdfDict; readonly data: Uint8Array };
}
```

An op stream is `ContentOp[]`. Operators with no operands (`BT`, `ET`, `q`,
`Q`, `n`, `W`, `h`, ...) get `operands: []`.

## Parsing — `parseContentStream(buf: Uint8Array): ContentOp[]`

Drive a `Lexer` over `buf`. Maintain a pending operand list; flush it when an
operator keyword is reached.

- `num` / `name` / `str` token → push the operand value onto the pending list.
- `[` → parse a nested array of operand values (recursively; operands only, no
  ref detection). `<<` → parse a nested dict of operand values.
- `kw` equal to `true` / `false` / `null` → operand value (these are operands,
  not operators), pushed onto the pending list.
- `kw` equal to `BI` → inline-image mode (below).
- any other `kw` → emit `{ operator: kw, operands: pending }`; reset pending.
- `eof` → stop. Trailing operands with no terminating operator (malformed
  input) are dropped.

Unknown operators are preserved verbatim — no semantic validation.

### Inline images (`BI` ... `ID` <data> `EI`)

After the `BI` keyword:

1. Read `/Key value` pairs into a `PdfDict` until the `ID` keyword is reached.
   Keys are name tokens; values are ordinary operand values.
2. Skip exactly one whitespace byte after `ID` (the spec-mandated single
   separator). The raw image data begins there.
3. Capture raw bytes until the terminating `EI`. If the dict carries `/L` (or
   `/Length`), use it directly for the data length. Otherwise scan for an `EI`
   that is preceded by a PDF whitespace byte and followed by whitespace or EOF.
   This is heuristic because raw image bytes can contain `EI`; it is the
   standard approach and is documented in the code.

Emit `{ operator: 'BI', operands: [], inlineImage: { dict, data } }`.

## Serializing — `serializeContentStream(ops: ContentOp[]): Uint8Array`

Reuse `serializeValue`. For each op:

- Regular op: operands joined by a single space, then the operator. Ops are
  separated by `\n`.
- Inline-image op: `BI`, then each `/Key value` pair, then `\nID ` + raw data
  bytes + `\nEI`.

Output is **not** required to be byte-identical to the source. The round-trip
guarantee is: `parseContentStream(serializeContentStream(ops))` yields the same
operators and operands as `ops`.

## API surface

`src/content.ts` exposes pure functions only:

- `parseContentStream(buf: Uint8Array): ContentOp[]`
- `serializeContentStream(ops: ContentOp[]): Uint8Array`
- the `ContentOp` interface.

No `Page` accessor is added here; the consuming issues (`e37` getText, `b3y`
stamping) wire it into `Page`.

## Testing — `test/content.test.ts`

- Text block: `BT /F1 24 Tf 100 700 Td (Hello World) Tj ET` → correct
  operators and operands.
- `TJ` array `[(A) -250 (B)] TJ`.
- Color `0.5 0.5 0.5 rg`; matrix `q 1 0 0 1 50 50 cm ... Q`; XObject `/Im0 Do`.
- Marked content with nested dict: `/Span <</MCID 0>> BDC ... EMC`.
- Hex string operand.
- Inline image BI/ID/EI round-trip, including data bytes that do **not** form a
  whitespace-delimited `EI`.
- Round-trip property: `parse → serialize → parse` preserves operators and
  operands.
- A real page's `Page.Contents` (from an existing fixture) parses without error
  and round-trips.

## Out of scope

- Any semantic interpretation (text positioning, color state, transforms).
- Wiring into `Page` (deferred to consuming issues).
- Writing modified content back into a page's `/Contents` (deferred to the
  stamping issue).
