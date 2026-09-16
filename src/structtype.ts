/** What may be a structure type, and what a custom one resolves to.
 *
 *  **Invariant:** a pure LEAF importing NOTHING — a set, a map and a string —
 *  so every rule here is testable with no PDF built. It is a module rather
 *  than part of `struct.ts` because TWO consumers need it and neither may
 *  reach the other: `struct.ts` imports `structwrite.ts` by VALUE while
 *  `structwrite.ts` imports `StructElement` as a TYPE only, so a value import
 *  back would close the first `struct.ts` <-> `structwrite.ts` 2-cycle, which
 *  `test/import-cycles.test.ts` fences as a red build. The extraction
 *  `colornames.ts`, `preformat.ts`, `bordersides.ts`, `datauri.ts` and
 *  `langmatch.ts` each already made. */

/** The PDF 1.7 standard structure types (grouping, block-level, inline-level,
 *  and illustration). Used by IsStandardType and to terminate RoleMap chains. */
export const STANDARD_STRUCTURE_TYPES: ReadonlySet<string> = new Set([
  // Grouping
  'Document', 'Part', 'Art', 'Sect', 'Div', 'BlockQuote', 'Caption', 'TOC',
  'TOCI', 'Index', 'NonStruct', 'Private',
  // Block-level
  'P', 'H', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'L', 'LI', 'Lbl', 'LBody',
  'Table', 'TR', 'TH', 'TD', 'THead', 'TBody', 'TFoot',
  // Inline-level
  'Span', 'Quote', 'Note', 'Reference', 'BibEntry', 'Code', 'Link', 'Annot',
  'Ruby', 'RB', 'RT', 'RP', 'Warichu', 'WT', 'WP',
  // Illustration
  'Figure', 'Formula', 'Form',
]);

/** The PDF 2.0 standard structure types (ISO 32000-2 14.8.6).
 *
 *  **TRANSCRIBED, not written from memory**, from veraPDF-parser@integration
 *  `src/main/java/org/verapdf/tools/TaggedPDFHelper.java`
 *  (`PDF_2_0_STANDARD_ROLE_TYPES`), fetched 2026-09-15.
 *
 *  **Note it is a SET PLUS A PATTERN.** `H1`..`H6` are ABSENT here and standard
 *  anyway, through `HN_PATTERN` — PDF 2.0 puts no ceiling on a heading level, so
 *  `H7` and `H42` are standard too. A set-only reading rejects every heading in
 *  every PDF 2.0 document.
 *
 *  **Note `H` is here although ISO 14289-2 8.2.5.12-1 forbids a conforming file
 *  from using it:** a standard type the conformance level prohibits. That is a
 *  different rule and belongs to `q7hc.4.1`. */
export const PDF20_STRUCTURE_TYPES: ReadonlySet<string> = new Set([
  // Shared with PDF 1.7
  'Document', 'Part', 'Div', 'Caption', 'Sect', 'NonStruct',
  'H', 'P', 'L', 'LI', 'Lbl', 'LBody',
  'Table', 'TR', 'TH', 'TD', 'THead', 'TBody', 'TFoot',
  'Span', 'Link', 'Annot', 'Figure', 'Formula', 'Form',
  'Ruby', 'RB', 'RT', 'RP', 'Warichu', 'WT', 'WP',
  // Added by PDF 2.0
  'DocumentFragment', 'Aside', 'Title', 'FENote', 'Sub', 'Em', 'Strong', 'Artifact',
]);

/** A PDF 2.0 heading of any level (`H1`, `H7`, `H42`). */
export const HN_PATTERN = /^H[1-9][0-9]*$/;

/** Is `type` a standard structure type in the namespace `nsUri`?
 *
 *  **TRANSCRIBED VERBATIM** from `TaggedPDFHelper.isStandardType` rather than
 *  paraphrased. Two arms read wrong and are right: the MathML namespace makes
 *  ANY type standard (there is no MathML type list), and an UNRECOGNISED
 *  namespace makes NOTHING standard — which is what stops an invented namespace
 *  from laundering an arbitrary type. An element stating NO namespace is in the
 *  PDF 1.7 namespace (ISO 32000-2 14.8.6), which is the `undefined` arm. */
export function isStandardTypeIn(type: string, nsUri: string | undefined): boolean {
  switch (nsUri) {
    case undefined:
    case 'http://iso.org/pdf/ssn':
      return STANDARD_STRUCTURE_TYPES.has(type);
    case 'http://iso.org/pdf2/ssn':
      return PDF20_STRUCTURE_TYPES.has(type) || HN_PATTERN.test(type);
    case 'http://www.w3.org/1998/Math/MathML':
      return true;
    default:
      return false;
  }
}

/** Follow the RoleMap chain from `role` to a standard structure type.
 *  Stops at the first standard type, at an unmapped name, or on a cycle.
 *
 *  **Invariant:** the standard set is tested BEFORE the map, so a file whose
 *  /RoleMap shadows a standard type cannot change what that type means. */
export function resolveRole(role: string, roleMap: ReadonlyMap<string, string>): string {
  let cur = role;
  const seen = new Set<string>();
  while (!STANDARD_STRUCTURE_TYPES.has(cur) && roleMap.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    cur = roleMap.get(cur)!;
  }
  return cur;
}

/** Throw unless `type` is a standard structure type or the /RoleMap resolves it
 *  to one; returns it unchanged so a caller can write `name(checkStructType(…))`.
 *
 *  **Invariant:** this is `IsStandardType`'s question asked BEFORE the write
 *  instead of reported after it. Writing an arbitrary name is how a tree comes
 *  to fail PDF/UA in a way the author cannot see, and `RegisterRole` already
 *  exists for the case where a custom type is meant. */
export function checkStructType(
  type: unknown, roleMap: ReadonlyMap<string, string>, nsUri?: string,
): string {
  if (typeof type !== 'string' || type.length === 0)
    throw new TypeError('structure type must be a non-empty string');
  if (!isStandardTypeIn(resolveRole(type, roleMap), nsUri))
    throw new RangeError(
      `structure type '${type}' is not a standard type and is not mapped by the `
      + '/RoleMap; map it first with StructTreeRoot.RegisterRole(custom, standard)');
  return type;
}
