import { deflateSync } from 'node:zlib';

export const psBytes = (text: string): Uint8Array => new TextEncoder().encode(text);
export function joinPs(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
export function pfbSegment(type: number, bytes: Uint8Array): Uint8Array {
  const header = new Uint8Array(6); header.set([128, type]);
  new DataView(header.buffer).setUint32(2, bytes.length, true);
  return joinPs(header, bytes);
}
export function encryptedPs(plain: string | Uint8Array,
  options: { hex?: boolean; suffix?: string; pfb?: boolean; newline?: string } = {}): Uint8Array {
  const bytes = joinPs(new Uint8Array([91, 72, 13, 244]), typeof plain === 'string' ? psBytes(plain) : plain, psBytes(options.newline ?? '\n'));
  let state = 55665;
  const cipher = bytes.map(byte => {
    const encoded = byte ^ (state >> 8);
    state = ((encoded + state) * 52845 + 22719) & 65535;
    return encoded;
  });
  const encoded = options.hex ? psBytes(Buffer.from(cipher).toString('hex')) : cipher;
  const prefix = psBytes('currentfile eexec\n'), suffix = psBytes(options.suffix ?? '');
  return options.pfb
    ? joinPs(pfbSegment(1, prefix), pfbSegment(options.hex ? 1 : 2, encoded), pfbSegment(1, suffix), new Uint8Array([128, 3]))
    : joinPs(prefix, encoded, suffix);
}
export function flatePs(text: string): Uint8Array { return deflateSync(psBytes(text)); }
