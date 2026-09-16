# PDF/UA-2: the part selector, namespaces and type vocabularies (`q7hc.4`)

## The gap this closes

`ValidatePdfUa` and `ConvertToPdfUa` stop at part 1. `pdfuaconvert.ts` writes
`pdfuaid:part 1` and nothing else, and `structvalidate.ts` has no notion of a
part at all. PDF/UA-2 (ISO 14289-2:2024) is the PDF 2.0 sibling, and the
PDF/A-4 work (`72nc.1`, `72nc.2`, `pjy7`) is the template for adding a part
without disturbing the one that ships.

This issue is the **core**: the part selector, the namespace model, the two
structure-type vocabularies, and the 18 identification / metadata / tree-basics
rules those make answerable. The other 72 rules are `q7hc.4.1` (per-type
structure shape), `.2` (annotations and forms), `.3` (fonts and CMaps) and `.4`
(PUA, language, optional content, destinations, embedded files). This one comes
first because every other child needs the part selector and the namespace model
it lands.

## The anchor, and what it is not

veraPDF's published validation profiles, the source `72nc.1` already used for
PDF/A-4:

- `veraPDF/veraPDF-validation-profiles`, branch `integration`, `PDF_UA/2/**`
  — 90 rules across 91 files, fetched **2026-09-15**.
- `veraPDF/veraPDF-parser`, branch `integration`,
  `src/main/java/org/verapdf/tools/TaggedPDFHelper.java` and
  `TaggedPDFConstants.java` — the two structure-type vocabularies and the
  algorithm that selects between them.

**This is a TRANSCRIPTION and NOT a runnable oracle.** veraPDF is not installed
here and a profile is a rule list rather than bytes, so unlike
`test/fixtures/pdfx/` there is nothing to run our answer against. The suite will
prove that the implementation agrees with our reading of the profile. It proves
nothing about whether either matches ISO 14289-2. Do not read a green suite as
conformance evidence — the same ceiling `72nc.1` records for PDF/A-4.

## Three corrections to the issue's premise, all measured against the anchor

The issue was filed on a reading of PDF/UA-2 that is wrong in three places. Each
is recorded because acting on any of them would have produced a validator that
rejects conformant documents.

**1. The PDF 2.0 namespace is NOT named by every element's `/NS`.** The issue
says the standard structure namespace must be "declared in the struct root's
`/Namespaces` AND NAMED BY EVERY ELEMENT'S `/NS`". §8.2.4-1 says otherwise:

> All structure elements shall belong to, or be role mapped to, at least one of
> the following namespaces specified in ISO 32000-2:2020, 14.8.6: — the PDF 1.7
> namespace; — the PDF 2.0 namespace; — the MathML namespace

Three namespaces are permitted, and an element with **no** `/NS` is in the PDF
1.7 namespace by default — `TaggedPDFHelper.isStandardType`'s `else` branch,
transcribed below. So a UA-1 tree carried over whole, with no `/NS` anywhere,
**passes** §8.2.4. Requiring per-element `/NS` would fail documents the standard
permits.

**2. The PDF 2.0 namespace IS required, on exactly ONE element.** §8.2.5.2-1
requires the structure tree root to hold a single `Document` element as its only
child; §8.2.5.2-2 then requires that element's namespace to be the PDF 2.0 one
(`kidsStandardTypes != 'Document' || firstChildStandardTypeNamespaceURL ==
'http://iso.org/pdf2/ssn'`). The issue's acceptance criterion — "a tree with
only the root declaration fails validation" — therefore reaches the right
outcome by the wrong route, and the remedy is one `/NS` rather than a tree-wide
rewrite.

**3. There is no 2.0-header rule anywhere in the 90.** The issue lists "a 2.0
header" as a part-2 requirement. PDF/UA-2 is *based on* PDF 2.0, but the anchor
never encodes a version test. Conversion still sets catalog `/Version 2.0` —
`serializer.ts`'s `headerVersion()` reads it (invariant `909q`), so that is the
whole of writing a 2.0 header — but there is deliberately **no validator rule**
for it. See *Deliberate divergences* below.

## Design

### The part selector

```ts
export type PdfUaPart = 1 | 2;                       // structvalidate.ts

doc.ValidatePdfUa(part: PdfUaPart = 1): ValidationReport
doc.ConvertToPdfUa(opts?: PdfUaConvertOptions)       // opts.part?: PdfUaPart = 1
```

Positional on validate, matching `ValidatePdfA(level)`. In the bag on convert,
because `ConvertToPdfUa` already has a bag and a leading optional positional
beside an optional bag is ambiguous at the call site. Both default to 1, so
every existing caller is untouched.

**Invariant:** `pdfavalidate.ts` folds the UA rules in at level `a`, and PDF/A
level `a` means PDF/UA-**1** tagging. That call stays at the default forever.
Pinned by a test rather than by a comment, because widening it is silent — a
PDF/A-2a document would start being asked for a PDF 2.0 namespace.

### `structns.ts` — the namespace model

A new near-leaf taking `Document` as a **type** only and working over raw dicts:
`numbertree.ts`'s arrangement, and forced by the same thing. `struct.ts` will
import it by value, so a value import back closes a `struct.ts` ↔ `structns.ts`
2-cycle that `test/import-cycles.test.ts` fences as a red build.

```
/StructTreeRoot /Namespaces  -> [ ns-dict, … ]   (each indirect)
  ns-dict: /Type /Namespace  /NS (string URI)  /RoleMapNS?  /Schema?
/StructElem /NS              -> ns-dict         (a ref)
```

**Invariant, and the whole reason the module exists:** `/NS` is TWO DIFFERENT
KEYS. On a structure element it is a *reference to a namespace dictionary*;
inside that dictionary it is *the URI string itself*. One owner, or two readers
will disagree about which of the two they are holding — and both readings
produce a plausible answer.

Exports: the three URI constants, `namespaceUriOf(doc, elemDict)`,
`namespacesOf(doc, rootDict)`, `ensureNamespace(doc, rootDict, uri)` (find or
declare, idempotent), `roleMapNsOf(doc, nsDict)`.

### The two vocabularies

They go in `structtype.ts`, beside `STANDARD_STRUCTURE_TYPES` — the same leaf,
the same kind of constant, and `resolveRole` already lives there. It stays a
pure leaf: strings only, no dicts.

```ts
export const PDF20_STRUCTURE_TYPES: ReadonlySet<string>;   // 40 entries
export const HN_PATTERN = /^H[1-9][0-9]*$/;
```

The PDF 2.0 set is the PDF 1.7 set minus `Art`, `BlockQuote`, `TOC`, `TOCI`,
`Index`, `Private`, `Quote`, `Note`, `Reference`, `BibEntry`, `Code` and
`H1`–`H6`, plus `DocumentFragment`, `Aside`, `Title`, `FENote`, `Sub`, `Em`,
`Strong` and `Artifact`. A namespace-aware `StandardType` is therefore real
work, not a relabelling.

**Measured 2026-09-15, and it is a free corroboration worth recording:** our
existing `STANDARD_STRUCTURE_TYPES` is EXACTLY veraPDF's
`PDF_1_7_STANDARD_ROLE_TYPES` — 49 entries, no difference in either direction.
That set has shipped since the PDF/UA-1 work with no external anchor at all;
fetching the PDF 2.0 vocabulary incidentally anchored the 1.7 one. The check is
cheap to repeat and belongs in the suite beside the size assertions.

**Note the vocabulary is a SET PLUS A PATTERN.** `H1`–`H6` are absent from the
PDF 2.0 set and standard anyway, through `HN_PATTERN` — which also admits `H7`
and `H42`, PDF 2.0 having no ceiling on the level. A set-only reading rejects
every heading in every PDF 2.0 document.

**Note two rows that read wrong and are right.** The MathML namespace makes
**any** type standard, unconditionally — there is no MathML type list. And `H`
IS in the PDF 2.0 set even though §8.2.5.12-1 forbids conforming files from
using it: a standard type the conformance level prohibits, which is a different
rule and belongs to `q7hc.4.1`.

**Invariant:** the selection algorithm is transcribed from
`TaggedPDFHelper.isStandardType` verbatim rather than paraphrased:

```
no /NS                      -> PDF 1.7 set
http://iso.org/pdf/ssn      -> PDF 1.7 set
http://iso.org/pdf2/ssn     -> PDF 2.0 set OR HN_PATTERN
http://www.w3.org/1998/Math/MathML -> true, unconditionally
anything else               -> false
```

The `default -> false` arm matters: an element in a namespace nobody recognises
is NOT standard, which is the opposite of the lenient reading and is what stops
an invented namespace from laundering an arbitrary type.

### Public surface on the tree

Per the maintainer's decision the namespace model is full read/write, not
internal-only:

```ts
el.Namespace: string | undefined        // get: resolves /NS -> its URI
el.Namespace = PDF20_NS                 // set: find-or-declare, then point /NS
root.Namespaces: readonly string[]      // declared URIs
root.DeclareNamespace(uri): void        // idempotent
root.Append('Aside', { ns: PDF20_NS })  // ElemOpts gains ns?: string
```

**Invariant:** `/NS` cannot ride `ElemOpts`' `OPT_KEYS` table, which writes PDF
**text strings**, where this is a **ref**. It gets its own step in
`createElement`, after the type check and before any allocation, so a rejected
call still leaves the document byte-identical.

**Invariant:** `checkStructType` gains an optional namespace parameter
defaulting to PDF 1.7. Without it `Append('Aside')` throws `RangeError` and
authoring a PDF 2.0 tree is impossible. It is a strict WIDENING — nothing
previously accepted becomes rejected — and the default keeps every existing call
site byte-identical.

**Invariant:** `IsStandardType` keeps its present meaning and its present name.
Its doc comment already reads "a known PDF 1.7 standard structure type", so it
is honest as it stands; the namespace-aware question is a different question and
the part-2 validator asks it directly. Redefining it is how part-1 behaviour
moves silently.

### The 18 rules

Five already exist and only gain a part-2 clause citation, through a
`partClause` helper mirroring `pdfavalidate.ts`'s:

| ours | UA-2 |
|---|---|
| `Tagged` | 6.2-1, 8.2.1-1 |
| `DocumentTitle` | 8.11.1-1 |
| `DisplayDocTitle` | 8.11.2-1 |
| `UntaggedContent` | 8.2.2-1 |
| `StandardType` | 8.2.4-1 — same rule id, different question |

Thirteen are new: identification 5-1…5-5; `/P` present on every element
(8.2.1-2); the four namespace and role-map rules (8.2.4-1…4); the single
`Document` child and its namespace (8.2.5.2-1/-2); catalog `/Metadata`
(8.11.1-2).

### The refactor, and the fence it needs

`structvalidate.ts` is a flat 186-line function. Thirteen rules land now and 72
more arrive across the four children; that shape does not survive it. It becomes
`pdfavalidate.ts`'s proven shape — a `Rule[]` over a ctx carrying `part` — which
is the targeted improvement this work should make in the code it is already
touching.

**Invariant:** the report's ISSUE ORDER is observable through
`ValidationReport.Issues`, so the refactor must preserve part-1 order exactly.
It is fenced by a snapshot of part-1 output over the existing fixtures, taken
and committed BEFORE the refactor lands — a reordering is otherwise invisible to
every existing assertion, which checks membership rather than sequence.

### Conversion

`identificationPass` becomes part-aware: `pdfuaid:part` = the part, plus
`pdfuaid:rev 2024` at part 2, which needs a new `pdfuaRev` field on
`XmpMetadata` and a second attribute in `xmp.ts`'s `pdfuaDesc`.

Three new passes, all part-2 only:

- `versionPass` — catalog `/Version 2.0`.
- `parentPass` — `/P` written from the walk the converter already makes.
- `documentElementPass` — ensure a single `Document` child in the PDF 2.0
  namespace. Where the root already has exactly one `Document` child this is one
  `/NS` write. Where it has several children, or one that is not a `Document`,
  it creates the `Document` and re-parents every existing top-level child under
  it **with `StructElement.MoveTo`**, which `q7hc.3` shipped. Order is preserved
  by moving them in order, and `MoveTo` materializes an inherited `/Pg` first, so
  the re-parenting cannot re-point anyone's marked content.

**Invariant:** role-map defects (8.2.4-2 circular mapping, 8.2.4-3 same-namespace
mapping, 8.2.4-4 a remapped standard type) are REPORTED and never fixed.
Choosing a mapping is authoring, and `roleMapPass` already exists for the case
where the caller supplies one.

**Invariant:** conversion re-runs `validatePdfUa` at the SAME part, so
`unresolved`/`passed` mirror the validator exactly — `convertToPdfUa`'s existing
contract, which must not silently become part-1 for a part-2 conversion.

## Deliberate divergences

**`versionPass` writes a 2.0 header that no rule validates.** There is no
version rule in the anchor's 90. Writing `/Version 2.0` is right — UA-2 is
defined over PDF 2.0 — but adding a validator rule the anchor does not carry
would make our report disagree with veraPDF's on a conformant file. Recorded the
way `72nc.1` records `psXObjectRule`, which fires at part 4 though the profile
has no such rule.

**Identification is gated to part 2 although UA-1's profile carries clause 5
too.** `PDF_UA/1/` has 106 rule files including Version identification, and our
part-1 validator implements about eight of them and checks no identification at
all. Gating here is NOT because part 1 lacks the rule — it is because widening
part 1 changes shipped behaviour, and the acceptance criterion for this issue is
that part 1 is byte-identical. Filed as its own follow-up rather than allowed to
ride along.

## Testing

- `test/structns.test.ts` — the namespace model from hand-built dicts, with no
  PDF built: the two meanings of `/NS`, `ensureNamespace` idempotence, and the
  five arms of the selection algorithm including `default -> false`.
- `test/pdfua2-validate.test.ts` — each of the 13 new rules reports at part 2
  and is SILENT at part 1. A cross-part PAIR per rule, `72nc.1`'s shape: a
  single-part assertion provably cannot tell a rule that correctly went quiet
  from one that was never wired up.
- `test/pdfua2-convert.test.ts` — a UA-1 tree converted at part 2 reaches
  `passed`, and the `documentElementPass` wrap is asserted on tree SHAPE and on
  reading order, not only on element count.
- `test/pdfua-part1-identity.test.ts` — the refactor fence: part-1 report order
  and content over the existing fixtures, committed before the refactor.
- Both vocabularies carry ASSERTED SIZES (49 and 40), so a half-pasted table is
  a red build — the rule `htmlforeign.ts` sets for its five tables.
- `npm run typecheck`, `npm test` and `test/import-cycles.test.ts` green, the
  last with the same 15 pairs.

**A fixture trap, recorded in advance.** `buildTaggedPdf` declares `/Lang en-US`
and produces a `/Document` root, so it is already close to part-2 shape and
cannot exercise `documentElementPass`'s wrapping branch at all. That branch needs
a tree whose root holds SEVERAL top-level children, hand-built.

## Acceptance

- `ValidatePdfUa(2)` on a UA-1 tree reports the missing PDF 2.0 namespace on its
  `Document` element and the part-1 identification; `ConvertToPdfUa({ part: 2 })`
  resolves both and re-validates clean.
- A tree whose elements carry no `/NS` does NOT report under 8.2.4-1 — the
  correction above, asserted directly so it reads as a decision.
- `ValidatePdfUa()` and `ConvertToPdfUa()` are byte-identical at part 1, and
  every existing UA test passes UNEDITED.
- `ValidatePdfA('2a')` still folds in part-1 UA rules.

## Out of scope

- The other 72 anchor rules — `q7hc.4.1`–`.4`.
- Translating structure types between the 1.7 and 2.0 vocabularies. A tree stays
  in the namespace it is in; conversion moves the `Document` element alone.
- `/RoleMapNS` AUTHORING. It is read for 8.2.4-3 and never written; a
  namespace-scoped role map is a mapping decision, which is authoring.
- Widening any rule to part 1.
