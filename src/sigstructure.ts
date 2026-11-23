import { rethrowLimit } from './errors.js';
import { isPdfWhitespace } from './lexer.js';
import { signatureDictionarySources } from './object-parser.js';
import { signatureRevisionEnd, type SignatureField } from './signature.js';
import { isArray } from './types.js';
import { revisionFooterEnd, type PdfRevision } from './xref.js';

/** Structural evidence to review independently of the cryptographic verdict. */
export type SignatureStructureFinding =
  | { kind: 'invalid-byte-range' }
  | { kind: 'signature-dictionary-unavailable' }
  | { kind: 'duplicate-signature-keys' }
  | { kind: 'contents-gap-mismatch' }
  | { kind: 'signed-revision-unverified' }
  | { kind: 'final-revision-unverified' }
  | { kind: 'signature-dictionary-unbound' }
  /** The offset of the first unsigned non-whitespace byte after the last PDF revision. */
  | { kind: 'appended-data'; offset: number };

/** @internal Include malformed attempts while leaving empty fields out. */
export function hasSignatureData(sig: SignatureField): boolean {
  return sig.valueDict.has('Contents') || sig.valueDict.has('ByteRange');
}

/** @internal Prepare one lookup for all signatures on the current file. */
export function signatureStructureCheck(
  bytes: Uint8Array,
  revisions: readonly PdfRevision[],
  signedFieldAt: (end: number, name: string, xrefOffset: number) => SignatureField | undefined,
): (sig: SignatureField) => SignatureStructureFinding[] {
  const byFooter = new Map<number, PdfRevision>();
  for (const revision of revisions) {
    const footer = revisionFooterEnd(revision);
    if (footer !== undefined) byFooter.set(footer, revision);
  }
  const latest = revisions.at(-1);
  const lastFooter = latest && revisionFooterEnd(latest);

  return (sig) => {
    const findings: SignatureStructureFinding[] = [];
    const end = signatureRevisionEnd(sig.byteRange, bytes.length);
    const source = signatureDictionarySources.get(sig.valueDict);

    if (end === undefined || !isArray(sig.valueDict.get('ByteRange')))
      findings.push({ kind: 'invalid-byte-range' });
    if (!source) findings.push({ kind: 'signature-dictionary-unavailable' });
    else if (source.duplicateKeys) findings.push({ kind: 'duplicate-signature-keys' });
    else if (end !== undefined && sig.byteRange) {
      const { start, end: contentsEnd } = source.contents;
      const [, gapStart, gapEnd] = sig.byteRange;
      const wholeString = gapStart === start && gapEnd === contentsEnd;
      const hexDigits = gapStart === start + 1 && gapEnd === contentsEnd - 1 &&
        bytes[start] === 0x3c && bytes[contentsEnd - 1] === 0x3e;
      if (!wholeString && !hexDigits) findings.push({ kind: 'contents-gap-mismatch' });
    }

    if (end !== undefined) {
      let markerEnd = end;
      while (markerEnd > 0 && isPdfWhitespace(bytes[markerEnd - 1])) markerEnd--;
      const boundary = byFooter.get(markerEnd);
      if (!boundary) findings.push({ kind: 'signed-revision-unverified' });
      else if (source && source.end > end) findings.push({ kind: 'signature-dictionary-unbound' });
      else if (source && boundary !== latest) {
        try {
          const prior = signedFieldAt(end, sig.name, boundary.xrefOffset);
          const original = prior && signatureDictionarySources.get(prior.valueDict);
          if (original?.contents.start !== source.contents.start || original.contents.end !== source.contents.end)
            findings.push({ kind: 'signature-dictionary-unbound' });
        } catch (caught) {
          rethrowLimit(caught);
          findings.push({ kind: 'signed-revision-unverified' });
        }
      }
      if (boundary && lastFooter === undefined) findings.push({ kind: 'final-revision-unverified' });
    }

    if (lastFooter !== undefined) {
      let offset = Math.max(lastFooter, end ?? 0);
      while (offset < bytes.length && isPdfWhitespace(bytes[offset])) offset++;
      if (offset < bytes.length) findings.push({ kind: 'appended-data', offset });
    }
    return findings;
  };
}
