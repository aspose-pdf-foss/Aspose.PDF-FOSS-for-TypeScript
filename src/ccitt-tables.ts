// ITU-T Recommendation T.4 modified-Huffman run-length codes, plus the T.6
// (Group 4) two-dimensional mode codes. Bit strings are MSB-first. Run lengths
// 0..63 are terminating codes; 64..1728 are makeup codes; 1792..2560 are the
// extended makeup codes shared by both colours.

export interface RunCode { bits: string; run: number; }

/** White terminating (0..63) + makeup (64..1728) codes — T.4 Tables 2 & 4. */
export const WHITE_CODES: RunCode[] = [
  { run: 0, bits: '00110101' }, { run: 1, bits: '000111' }, { run: 2, bits: '0111' },
  { run: 3, bits: '1000' }, { run: 4, bits: '1011' }, { run: 5, bits: '1100' },
  { run: 6, bits: '1110' }, { run: 7, bits: '1111' }, { run: 8, bits: '10011' },
  { run: 9, bits: '10100' }, { run: 10, bits: '00111' }, { run: 11, bits: '01000' },
  { run: 12, bits: '001000' }, { run: 13, bits: '000011' }, { run: 14, bits: '110100' },
  { run: 15, bits: '110101' }, { run: 16, bits: '101010' }, { run: 17, bits: '101011' },
  { run: 18, bits: '0100111' }, { run: 19, bits: '0001100' }, { run: 20, bits: '0001000' },
  { run: 21, bits: '0010111' }, { run: 22, bits: '0000011' }, { run: 23, bits: '0000100' },
  { run: 24, bits: '0101000' }, { run: 25, bits: '0101011' }, { run: 26, bits: '0010011' },
  { run: 27, bits: '0100100' }, { run: 28, bits: '0011000' }, { run: 29, bits: '00000010' },
  { run: 30, bits: '00000011' }, { run: 31, bits: '00011010' }, { run: 32, bits: '00011011' },
  { run: 33, bits: '00010010' }, { run: 34, bits: '00010011' }, { run: 35, bits: '00010100' },
  { run: 36, bits: '00010101' }, { run: 37, bits: '00010110' }, { run: 38, bits: '00010111' },
  { run: 39, bits: '00101000' }, { run: 40, bits: '00101001' }, { run: 41, bits: '00101010' },
  { run: 42, bits: '00101011' }, { run: 43, bits: '00101100' }, { run: 44, bits: '00101101' },
  { run: 45, bits: '00000100' }, { run: 46, bits: '00000101' }, { run: 47, bits: '00001010' },
  { run: 48, bits: '00001011' }, { run: 49, bits: '01010010' }, { run: 50, bits: '01010011' },
  { run: 51, bits: '01010100' }, { run: 52, bits: '01010101' }, { run: 53, bits: '00100100' },
  { run: 54, bits: '00100101' }, { run: 55, bits: '01011000' }, { run: 56, bits: '01011001' },
  { run: 57, bits: '01011010' }, { run: 58, bits: '01011011' }, { run: 59, bits: '01001010' },
  { run: 60, bits: '01001011' }, { run: 61, bits: '00110010' }, { run: 62, bits: '00110011' },
  { run: 63, bits: '00110100' },
  // makeup
  { run: 64, bits: '11011' }, { run: 128, bits: '10010' }, { run: 192, bits: '010111' },
  { run: 256, bits: '0110111' }, { run: 320, bits: '00110110' }, { run: 384, bits: '00110111' },
  { run: 448, bits: '01100100' }, { run: 512, bits: '01100101' }, { run: 576, bits: '01101000' },
  { run: 640, bits: '01100111' }, { run: 704, bits: '011001100' }, { run: 768, bits: '011001101' },
  { run: 832, bits: '011010010' }, { run: 896, bits: '011010011' }, { run: 960, bits: '011010100' },
  { run: 1024, bits: '011010101' }, { run: 1088, bits: '011010110' }, { run: 1152, bits: '011010111' },
  { run: 1216, bits: '011011000' }, { run: 1280, bits: '011011001' }, { run: 1344, bits: '011011010' },
  { run: 1408, bits: '011011011' }, { run: 1472, bits: '010011000' }, { run: 1536, bits: '010011001' },
  { run: 1600, bits: '010011010' }, { run: 1664, bits: '011000' }, { run: 1728, bits: '010011011' },
];

/** Black terminating (0..63) + makeup (64..1728) codes — T.4 Tables 2 & 4. */
export const BLACK_CODES: RunCode[] = [
  { run: 0, bits: '0000110111' }, { run: 1, bits: '010' }, { run: 2, bits: '11' },
  { run: 3, bits: '10' }, { run: 4, bits: '011' }, { run: 5, bits: '0011' },
  { run: 6, bits: '0010' }, { run: 7, bits: '00011' }, { run: 8, bits: '000101' },
  { run: 9, bits: '000100' }, { run: 10, bits: '0000100' }, { run: 11, bits: '0000101' },
  { run: 12, bits: '0000111' }, { run: 13, bits: '00000100' }, { run: 14, bits: '00000111' },
  { run: 15, bits: '000011000' }, { run: 16, bits: '0000010111' }, { run: 17, bits: '0000011000' },
  { run: 18, bits: '0000001000' }, { run: 19, bits: '00001100111' }, { run: 20, bits: '00001101000' },
  { run: 21, bits: '00001101100' }, { run: 22, bits: '00000110111' }, { run: 23, bits: '00000101000' },
  { run: 24, bits: '00000010111' }, { run: 25, bits: '00000011000' }, { run: 26, bits: '000011001010' },
  { run: 27, bits: '000011001011' }, { run: 28, bits: '000011001100' }, { run: 29, bits: '000011001101' },
  { run: 30, bits: '000001101000' }, { run: 31, bits: '000001101001' }, { run: 32, bits: '000001101010' },
  { run: 33, bits: '000001101011' }, { run: 34, bits: '000011010010' }, { run: 35, bits: '000011010011' },
  { run: 36, bits: '000011010100' }, { run: 37, bits: '000011010101' }, { run: 38, bits: '000011010110' },
  { run: 39, bits: '000011010111' }, { run: 40, bits: '000001101100' }, { run: 41, bits: '000001101101' },
  { run: 42, bits: '000011011010' }, { run: 43, bits: '000011011011' }, { run: 44, bits: '000001010100' },
  { run: 45, bits: '000001010101' }, { run: 46, bits: '000001010110' }, { run: 47, bits: '000001010111' },
  { run: 48, bits: '000001100100' }, { run: 49, bits: '000001100101' }, { run: 50, bits: '000001010010' },
  { run: 51, bits: '000001010011' }, { run: 52, bits: '000000100100' }, { run: 53, bits: '000000110111' },
  { run: 54, bits: '000000111000' }, { run: 55, bits: '000000100111' }, { run: 56, bits: '000000101000' },
  { run: 57, bits: '000001011000' }, { run: 58, bits: '000001011001' }, { run: 59, bits: '000000101011' },
  { run: 60, bits: '000000101100' }, { run: 61, bits: '000001011010' }, { run: 62, bits: '000001100110' },
  { run: 63, bits: '000001100111' },
  // makeup
  { run: 64, bits: '0000001111' }, { run: 128, bits: '000011001000' }, { run: 192, bits: '000011001001' },
  { run: 256, bits: '000001011011' }, { run: 320, bits: '000000110011' }, { run: 384, bits: '000000110100' },
  { run: 448, bits: '000000110101' }, { run: 512, bits: '0000001101100' }, { run: 576, bits: '0000001101101' },
  { run: 640, bits: '0000001001010' }, { run: 704, bits: '0000001001011' }, { run: 768, bits: '0000001001100' },
  { run: 832, bits: '0000001001101' }, { run: 896, bits: '0000001110010' }, { run: 960, bits: '0000001110011' },
  { run: 1024, bits: '0000001110100' }, { run: 1088, bits: '0000001110101' }, { run: 1152, bits: '0000001110110' },
  { run: 1216, bits: '0000001110111' }, { run: 1280, bits: '0000001010010' }, { run: 1344, bits: '0000001010011' },
  { run: 1408, bits: '0000001010100' }, { run: 1472, bits: '0000001010101' }, { run: 1536, bits: '0000001011010' },
  { run: 1600, bits: '0000001011011' }, { run: 1664, bits: '0000001100100' }, { run: 1728, bits: '0000001100101' },
];

/** Extended makeup codes (1792..2560), shared by both colours — T.4 Table 1. */
export const EXT_MAKEUP: RunCode[] = [
  { run: 1792, bits: '00000001000' }, { run: 1856, bits: '00000001100' }, { run: 1920, bits: '00000001101' },
  { run: 1984, bits: '000000010010' }, { run: 2048, bits: '000000010011' }, { run: 2112, bits: '000000010100' },
  { run: 2176, bits: '000000010101' }, { run: 2240, bits: '000000010110' }, { run: 2304, bits: '000000010111' },
  { run: 2368, bits: '000000011100' }, { run: 2432, bits: '000000011101' }, { run: 2496, bits: '000000011110' },
  { run: 2560, bits: '000000011111' },
];

/** T.6 two-dimensional mode codes (MSB-first). */
export const MODE_CODES = {
  P: '0001',   // pass
  H: '001',    // horizontal
  V0: '1',
  VR1: '011', VR2: '000011', VR3: '0000011',
  VL1: '010', VL2: '000010', VL3: '0000010',
} as const;
