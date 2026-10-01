/** Byte-level access to a `writeZip` archive, for tests that patch one field.
 *  `writeZip` writes no archive comment, so its end record is the last 22 bytes. */
export const u16 = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8);
export const u32 = (b: Uint8Array, at: number): number =>
  (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
export function put16(b: Uint8Array, at: number, v: number): void {
  b[at] = v & 0xff; b[at + 1] = (v >>> 8) & 0xff;
}
export function put32(b: Uint8Array, at: number, v: number): void {
  b[at] = v & 0xff; b[at + 1] = (v >>> 8) & 0xff;
  b[at + 2] = (v >>> 16) & 0xff; b[at + 3] = (v >>> 24) & 0xff;
}
export const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
export const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

/** Where the end record, each central record and each local header sit. */
export function layout(zip: Uint8Array): { eocd: number; central: number[]; local: number[] } {
  const eocd = zip.length - 22;
  const central: number[] = [];
  let at = u32(zip, eocd + 16);
  for (let i = 0; i < u16(zip, eocd + 10); i++) {
    central.push(at);
    at += 46 + u16(zip, at + 28) + u16(zip, at + 30) + u16(zip, at + 32);
  }
  return { eocd, central, local: central.map((c) => u32(zip, c + 42)) };
}
