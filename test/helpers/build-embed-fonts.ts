// Fixtures for @font-face embed tests, layered on build-optimize-pdf helpers.
import { buildSimpleTtfPdf } from './build-optimize-pdf.js';
import { buildOS2 } from './build-sfnt.js';

/** An OS/2 table whose fsType sets the Restricted-License bit (0x0002). */
export function buildRestrictedOS2(): Uint8Array {
  const os2 = buildOS2();
  new DataView(os2.buffer, os2.byteOffset, os2.byteLength).setUint16(8, 0x0002);
  return os2;
}

/** A simple-TrueType PDF whose embedded font is fsType-restricted. */
export function buildRestrictedTtfPdf(): Uint8Array {
  return buildSimpleTtfPdf({ os2: buildRestrictedOS2() });
}

/** A `/ToUnicode` CMap mapping char code 0x41 to the 3-char string "ffi", so the
 *  shown glyph has a multi-scalar Unicode value and must take a PUA codepoint. */
function ffiToUnicode(): Uint8Array {
  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin begincmap',
    '1 begincodespacerange <00> <ff> endcodespacerange',
    '1 beginbfchar <41> <006600660069> endbfchar',
    'endcmap CMapName currentdict /CMap defineresource pop end end',
  ].join('\n');
  return new TextEncoder().encode(cmap);
}

/** A TrueType PDF whose single shown glyph decodes (via ToUnicode) to "ffi". */
export function buildLigatureTtfPdf(): Uint8Array {
  return buildSimpleTtfPdf({ toUnicode: ffiToUnicode() });
}

/** A TrueType PDF that shows two runs of the SAME font dict (/F1), for
 *  per-program `@font-face` dedup. */
export function buildTwoRunTtfPdf(): Uint8Array {
  return buildSimpleTtfPdf({
    body: 'BT /F1 24 Tf 50 700 Td (A) Tj ET BT /F1 24 Tf 50 650 Td (B) Tj ET',
  });
}
