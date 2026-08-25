export type PdfNull = null;
export type PdfBool = boolean;
export type PdfNumber = number;
export interface PdfName { readonly kind: 'name'; readonly name: string }
export interface PdfString { readonly kind: 'string'; readonly bytes: Uint8Array }
export interface PdfRef { readonly kind: 'ref'; readonly num: number; readonly gen: number }
export type PdfArray = PdfObject[];
export type PdfDict = Map<string, PdfObject>; // keys are name strings without leading '/'
export interface PdfStream { readonly kind: 'stream'; readonly dict: PdfDict; readonly raw: Uint8Array }
export type PdfObject =
  | PdfNull | PdfBool | PdfNumber
  | PdfName | PdfString | PdfRef
  | PdfArray | PdfDict | PdfStream;

export type MaybeObj = PdfObject | undefined;
export const name = (n: string): PdfName => ({ kind: 'name', name: n });
export const ref = (num: number, gen = 0): PdfRef => ({ kind: 'ref', num, gen });
export const isRef = (o: MaybeObj): o is PdfRef => !!o && typeof o === 'object' && (o as any).kind === 'ref';
export const isName = (o: MaybeObj): o is PdfName => !!o && typeof o === 'object' && (o as any).kind === 'name';
export const isDict = (o: MaybeObj): o is PdfDict => o instanceof Map;
export const isStream = (o: MaybeObj): o is PdfStream => !!o && typeof o === 'object' && (o as any).kind === 'stream';
export const isString = (o: MaybeObj): o is PdfString => !!o && typeof o === 'object' && (o as any).kind === 'string';
export const isArray = (o: MaybeObj): o is PdfArray => Array.isArray(o);
