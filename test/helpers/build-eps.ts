import { psBytes, joinPs } from './ps-font-program.js';
export function epsSource(body = '', comments = '%%BoundingBox: -10 20 90 70', eol = '\n'): Uint8Array {
  return psBytes(['%!PS-Adobe-3.0 EPSF-3.0', comments, '%%EndComments', body].join(eol));
}
export function dosEps(source: Uint8Array, preview: Uint8Array = new Uint8Array(), kind: 'tiff' | 'wmf' = 'tiff'): Uint8Array {
  const header = new Uint8Array(30), v = new DataView(header.buffer);
  header.set([0xc5, 0xd0, 0xd3, 0xc6]); v.setUint32(4, 30, true); v.setUint32(8, source.length, true);
  if (preview.length) { const at = kind === 'wmf' ? 12 : 20; v.setUint32(at, 30 + source.length, true); v.setUint32(at + 4, preview.length, true); }
  v.setUint16(28, 65535, true); return joinPs(header, source, preview);
}
