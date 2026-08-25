// Hand-built single-segment JBIG2 streams (embedded organization), for tests of
// segment types whose case in decodeJbig2 refuses — or skips — before reading a
// body. Layout matches the short-form header in test/jbig2-segments.test.ts.

/** A stream whose sole segment is of `type`, with a zero-length body. */
export function segmentStream(type: number): Uint8Array {
  return Uint8Array.from([
    0, 0, 0, 0,  // segment number
    type & 0x3f, // flags (1-byte page association, count 0)
    0x00,        // referred-to count/retain (0)
    0x01,        // page association
    0, 0, 0, 0,  // data length 0
  ]);
}

/** A stream whose sole segment is an immediate halftone region (type 22). */
export function halftoneStream(): Uint8Array { return segmentStream(22); }

/** A well-formed custom Huffman table segment (type 53): HTLOW 0, HTHIGH 8,
 *  HTPS 3, HTRS 3, no OOB, two lines of four values each. It carries no ink, so
 *  a page holding only this must decode blank rather than refusing. */
export function customTableSegment(): Uint8Array {
  const body = [
    0x24,             // flags: HTOOB 0, HTPS-1 = 2, HTRS-1 = 2
    0, 0, 0, 0,       // HTLOW 0
    0, 0, 0, 8,       // HTHIGH 8
    // 010 010 | 010 010 | 011 | 011  -> two normal lines, then lower and upper
    0b01001001, 0b00100110, 0b11000000,
  ];
  return Uint8Array.from([
    0, 0, 0, 0,           // segment number
    53,                   // flags: type 53
    0x00,                 // referred-to count/retain (0)
    0x01,                 // page association
    0, 0, 0, body.length, // data length
    ...body,
  ]);
}

/** An immediate text region (type 6) whose SBHUFF flag is set: the last coding
 *  feature that still refuses by name. Its body is a 17-byte region info plus
 *  the two flag bytes, so the refusal comes from the flag rather than from a
 *  length guard. */
export function huffmanTextStream(): Uint8Array {
  const body = [
    0, 0, 0, 8, 0, 0, 0, 8,  // width, height
    0, 0, 0, 0, 0, 0, 0, 0,  // x, y
    0,                       // external combination operator
    0x00, 0x01,              // text region flags: SBHUFF
  ];
  return Uint8Array.from([
    0, 0, 0, 0,              // segment number
    6,                       // flags: type 6 (immediate text region)
    0x00,                    // referred-to count/retain (0)
    0x01,                    // page association
    0, 0, 0, body.length,    // data length
    ...body,
  ]);
}

/** A stream whose sole segment is an intermediate generic refinement region (type 40). */
export function refinementStream(): Uint8Array { return segmentStream(40); }
