// Minimal binary PNM reader for test fixtures: P6 (RGB) and P5 (grayscale).
// Parses the ASCII header -- magic, width, height, maxval -- and returns the raw
// sample payload. Only 8-bit (maxval <= 255) is supported; that is what the
// vendored fixtures use.

export interface Pnm {
  magic: 'P5' | 'P6';
  width: number;
  height: number;
  max: number;
  /** Interleaved samples: 3 bytes/px for P6, 1 byte/px for P5. */
  data: Uint8Array;
}

const isWs = (b: number) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;

export function readPnm(buf: Uint8Array): Pnm {
  let pos = 0;
  // Next header token, skipping whitespace runs and '#' comments-to-end-of-line.
  const token = (): string => {
    for (;;) {
      while (pos < buf.length && isWs(buf[pos])) pos++;
      if (buf[pos] === 0x23) { while (pos < buf.length && buf[pos] !== 0x0a) pos++; continue; }
      break;
    }
    const start = pos;
    while (pos < buf.length && !isWs(buf[pos])) pos++;
    return String.fromCharCode(...buf.subarray(start, pos));
  };

  const magic = token();
  if (magic !== 'P5' && magic !== 'P6') throw new Error(`readPnm: unsupported magic ${magic}`);
  const width = Number(token());
  const height = Number(token());
  const max = Number(token());
  if (max > 255) throw new Error(`readPnm: 16-bit PNM unsupported (maxval ${max})`);
  pos++; // exactly one whitespace byte separates the header from the payload

  const need = width * height * (magic === 'P6' ? 3 : 1);
  const data = buf.subarray(pos, pos + need);
  if (data.length !== need) throw new Error(`readPnm: short payload: got ${data.length}, want ${need}`);
  return { magic, width, height, max, data };
}
