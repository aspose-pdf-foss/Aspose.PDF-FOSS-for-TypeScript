import { deflateSync } from 'node:zlib';

/** A 2x2 opaque PNG, assembled here so tests carry no binary fixture. */
export function makePng(): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const be32 = (n: number) =>
    Uint8Array.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const chunk = (type: string, data: Uint8Array) => {
    const body = Uint8Array.from([...new TextEncoder().encode(type), ...data]);
    return Uint8Array.from([...be32(data.length), ...body, ...be32(crc(body))]);
  };
  const ihdr = Uint8Array.from([...be32(2), ...be32(2), 8, 2, 0, 0, 0]); // 2x2, 8-bit RGB
  // Two rows, each prefixed with filter byte 0: red, red / red, blue.
  const raw = Uint8Array.from([0, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255, 0, 0]);
  return Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10,
    ...chunk('IHDR', ihdr),
    ...chunk('IDAT', new Uint8Array(deflateSync(raw))),
    ...chunk('IEND', new Uint8Array(0)),
  ]);
}
