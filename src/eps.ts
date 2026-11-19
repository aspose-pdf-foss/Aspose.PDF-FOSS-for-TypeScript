import type { PsBudget } from './psbudget.js';
import { PdfParseError, UnsupportedFeatureError } from './errors.js';

export interface PsSourceFrame { source: Uint8Array; kind: 'ps' | 'eps' }

/** Select executable bytes without copying, decoding or executing previews. */
export function framePostScript(bytes: Uint8Array, format: 'auto' | 'ps' | 'eps', budget: PsBudget): PsSourceFrame {
  budget.limits.enforce('maxFileBytes', bytes.length, 'PostScript input');
  const match = (at: number, text: string): boolean => {
    for (let i = 0; i < text.length; i++) {
      budget.work();
      if (bytes[at + i] !== text.charCodeAt(i)) return false;
    }
    return true;
  };
  let source = bytes;
  const binary = bytes[0] === 197 && bytes[1] === 208 && bytes[2] === 211 && bytes[3] === 198;
  if (binary) {
    if (format === 'ps') throw new PdfParseError('Binary EPS contradicts ps format');
    if (bytes.length < 30) throw new PdfParseError('Truncated DOS EPS header');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const spans: { start: number; end: number }[] = [];
    budget.allocate(256, 'EPS header'); budget.work(30, 'EPS header');
    for (const at of [4, 12, 20]) {
      const start = view.getUint32(at, true), length = view.getUint32(at + 4, true);
      if (at !== 4 && start === 0 && length === 0) continue;
      if (start < 30 || length === 0 || start > bytes.length || length > bytes.length - start)
        throw new PdfParseError('Invalid DOS EPS section range');
      const end = start + length;
      if (spans.some(s => start < s.end && s.start < end)) throw new PdfParseError('Overlapping DOS EPS sections');
      spans.push({ start, end });
    }
    const checksum = view.getUint16(28, true);
    if (checksum !== 65535) {
      let actual = 0;
      for (let i = 0; i < 28; i++) actual ^= bytes[i]!;
      if (checksum !== actual) throw new PdfParseError('Invalid DOS EPS checksum');
    }
    source = bytes.subarray(spans[0]!.start, spans[0]!.end);
  } else if (bytes.length >= 4) {
    const magic = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    // MacBinary is a 128-byte header with reserved zero bytes and a bounded
    // filename, not an arbitrary occurrence of its signature in ASCII source.
    // Header fields: Microsoft [MS-OXCMAIL] 2.2.3.4.2.2.
    const macBinary = bytes.length >= 128 && bytes[0] === 0 && bytes[1]! >= 1 && bytes[1]! <= 63
      && bytes[74] === 0 && bytes[82] === 0 && match(102, 'mBIN');
    if (magic === 0x00051600 || magic === 0x00051607 || macBinary)
      throw new UnsupportedFeatureError('Macintosh EPS envelopes are unsupported; supply the data fork');
  }
  let eps = false;
  // Identity belongs to the first physical line, never a later comment/preview.
  if (source[0] === 37 && source[1] === 33) {
    let end = 0;
    while (end < source.length && source[end] !== 10 && source[end] !== 13) {
      budget.work();
      budget.limits.enforce('maxObjectBytes', ++end, 'PostScript version header');
    }
    budget.allocate(64 + end * 2, 'PostScript version header');
    let header = '';
    for (let i = 0; i < end; i++) header += String.fromCharCode(source[i]!);
    eps = /^%!PS-Adobe-\d+(?:\.\d+)?[ \t]+EPSF-\d+(?:\.\d+)?(?:[ \t]|$)/.test(header);
  } else budget.work(2, 'PostScript format');
  if ((binary || format === 'eps') && !eps || format === 'ps' && eps)
    throw new PdfParseError('PostScript/EPS format contradicts header');
  return { source, kind: eps ? 'eps' : 'ps' };
}
