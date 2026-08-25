// FlateDecode + predictor now live in the generalized filter pipeline.
// Kept as a named re-export so existing callers (xref/objstm/XMP/content/
// embedded-file) transparently gain LZW + ASCII filter support.
export { decodeStream as inflateStream } from './filters.js';
export type { DecodeOptions } from './filters.js';
