/** AcroForm field flags (`/Ff`), PDF 32000-1 §12.7.4.
 *
 *  Each constant is commented with the specification's **1-based** bit number,
 *  because that is the number the tables use and the one that is easy to get
 *  wrong: spec bit N is `1 << (N - 1)`. An off-by-one here produces a flag that
 *  is silently the wrong flag rather than an obvious break. */

// Table 226 — common to every field type.
export const FF_READONLY = 1 << 0;      // bit 1
export const FF_REQUIRED = 1 << 1;      // bit 2

// Table 228 — text fields.
export const FF_MULTILINE = 1 << 12;    // bit 13
export const FF_PASSWORD = 1 << 13;     // bit 14
export const FF_FILESELECT = 1 << 20;   // bit 21
export const FF_DONOTSPELLCHECK = 1 << 22; // bit 23
export const FF_DONOTSCROLL = 1 << 23;  // bit 24
export const FF_COMB = 1 << 24;         // bit 25
export const FF_RICHTEXT = 1 << 25;     // bit 26

// Table 229 — button fields.
export const FF_RADIO = 1 << 15;        // bit 16
export const FF_PUSHBUTTON = 1 << 16;   // bit 17

// Table 230 — choice fields.
export const FF_COMBO = 1 << 17;        // bit 18
export const FF_EDIT = 1 << 18;         // bit 19
export const FF_MULTISELECT = 1 << 21;  // bit 22
