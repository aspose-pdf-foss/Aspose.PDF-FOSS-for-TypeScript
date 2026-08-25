/** CRC-32 with the `0xEDB88320` polynomial — the one PNG, zlib and ZIP all use.
 *
 *  **Invariant:** one owner. A second copy is a second chance to get the
 *  initial or final XOR wrong, and a wrong CRC in a ZIP is not a crash: it is
 *  an archive some readers accept and others reject, which is the worst failure
 *  mode to debug. */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
