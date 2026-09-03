/** What encoding a sequence of HTML bytes is in — the part of HTML Standard
 *  §13.2.3 that a whole-buffer parser needs.
 *
 *  Invariant: a pure leaf importing NOTHING — no `Document`, no PDF object, no
 *  `node:` module, not even `htmldom.js`. Bytes and an attribute map in, an
 *  encoding name out, so every rule here is testable from byte arrays with no
 *  HTML tree and no PDF built. The split `colornames.ts`, `preformat.ts` and
 *  `datauri.ts` already make.
 *
 *  Invariant: nothing here throws. `parseHtml` never throws, and a bytes entry
 *  point in front of it must not become the one way to make it.
 *
 *  Invariant, and it is the reason this module is 80 lines rather than 800:
 *  THE ENCODING STANDARD'S LABEL TABLE IS NOT TRANSCRIBED HERE. `TextDecoder`
 *  already implements it — all ~230 labels over ~40 encodings, whitespace
 *  stripped and case folded — so `new TextDecoder(label)` is both the "get an
 *  encoding" step and the decoder, and `.encoding` is the canonical name. That
 *  is measured rather than assumed: `cp1251` and `x-cp1251` resolve to
 *  `windows-1251`, `ms_kanji` to `shift_jis`, and `iso-8859-1`/`us-ascii` to
 *  `windows-1252` — the standard's deliberate legacy aliases, not
 *  approximations. A second table here would be a second answer to "what does
 *  `cp1251` mean".
 *
 *  Note what that borrows: `TextDecoder`'s legacy coverage is ICU-dependent.
 *  On a `small-icu` Node build almost every legacy label is rejected, which
 *  `encodingFromLabel` reports as an unknown label — so the declaration is
 *  ignored and the current encoding stands. A degrade, never a throw.
 *
 *  Note the `replacement` encoding is unreachable through `TextDecoder`, which
 *  rejects its labels (`iso-2022-kr`, `hz-gb-2312`, `iso-2022-cn`) outright.
 *  Declining them leaves the current encoding standing, where the standard
 *  would decode the whole stream to one U+FFFD. The safer of two wrong
 *  answers, and no real document reaches it.
 */

/** HTML's ASCII whitespace (§2.4.1), which is not JavaScript's `\s`. */
const WS = '\t\n\f\r ';

/** §13.2.3.1 step 2: the byte order marks that settle the encoding outright.
 *
 *  A BOM is honoured AS IT STANDS. The UTF-16 -> UTF-8 rewrite below belongs
 *  to the `<meta>` path alone: applied here it would decode a BOM-led UTF-16
 *  document as mojibake. */
export function bomEncoding(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF)
    return 'utf-8';
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) return 'utf-16be';
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) return 'utf-16le';
  return undefined;
}

/** The Encoding Standard's "get an encoding" step: a label to its canonical
 *  name, or `undefined` for a label no encoding claims. */
export function encodingFromLabel(label: string): string | undefined {
  try {
    return new TextDecoder(label).encoding;
  } catch {
    return undefined;
  }
}

/** What a `<meta>` element declares its document's encoding to be, with the
 *  two rewrites §13.2.3.3 applies to a meta-derived answer.
 *
 *  A `charset` attribute wins, but only when it names an encoding we have:
 *  the in-head rule reads "charset, and getting an encoding returns an
 *  encoding, OTHERWISE http-equiv", so a junk `charset` must not shadow a good
 *  declaration sitting beside it. */
export function metaEncoding(attrs: Map<string, string>): string | undefined {
  let enc = encodingFromLabelOrUndefined(attrs.get('charset'));
  if (enc === undefined) {
    const httpEquiv = attrs.get('http-equiv');
    const content = attrs.get('content');
    if (httpEquiv !== undefined && content !== undefined
      && httpEquiv.toLowerCase() === 'content-type')
      enc = encodingFromLabelOrUndefined(charsetFromContent(content));
  }
  if (enc === undefined) return undefined;
  // A document that reached tree construction as ASCII-compatible bytes cannot
  // actually be UTF-16, so the declaration is a mistake to correct rather than
  // obey — obeying it decodes the page to nothing.
  if (enc === 'utf-16be' || enc === 'utf-16le') return 'utf-8';
  if (enc === 'x-user-defined') return 'windows-1252';
  return enc;
}

/** Decode with the encoding named, falling back to UTF-8 for one this runtime
 *  cannot supply. Non-fatal, so damaged bytes become U+FFFD rather than an
 *  exception — which is also what lets a legacy document survive its first
 *  pass as UTF-8 with its ASCII tags intact. The BOM is stripped rather than
 *  left to reach the tokenizer as a character token. */
export function decodeHtmlBytes(bytes: Uint8Array, encoding: string): string {
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function encodingFromLabelOrUndefined(label: string | undefined): string | undefined {
  return label === undefined ? undefined : encodingFromLabel(label);
}

/** §13.2.3.3's "extracting a character encoding from a meta element": find a
 *  `charset` followed by `=` and read its value, quoted or bare.
 *
 *  The search RESTARTS one character on rather than giving up when what
 *  follows is not `=`, so a decoy (`charsetish; charset=koi8-r`) does not hide
 *  the real declaration behind it. */
function charsetFromContent(content: string): string | undefined {
  const lower = content.toLowerCase();
  let from = 0;
  for (;;) {
    const at = lower.indexOf('charset', from);
    if (at < 0) return undefined;
    let p = at + 'charset'.length;
    while (p < content.length && WS.includes(content[p])) p++;
    if (content[p] !== '=') { from = p > at ? p : at + 1; continue; }
    p++;
    while (p < content.length && WS.includes(content[p])) p++;
    if (p >= content.length) return undefined;
    const quote = content[p];
    if (quote === '"' || quote === "'") {
      const end = content.indexOf(quote, p + 1);
      return end < 0 ? undefined : content.slice(p + 1, end);
    }
    let end = p;
    while (end < content.length && !WS.includes(content[end]) && content[end] !== ';') end++;
    return content.slice(p, end);
  }
}
