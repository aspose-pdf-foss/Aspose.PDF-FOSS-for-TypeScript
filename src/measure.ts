import type { Document } from './document.js';
import { decodePdfText, encodePdfText } from './metadata.js';
import { isArray, isDict, isName, isString, name, type PdfDict, type PdfObject, type PdfString } from './types.js';

/** A single unit in a PDF number-format array (PDF 32000-1 Table 263). */
export interface MeasureNumberFormat {
  unit: string;
  conversionFactor: number;
  /** Decimal (D), fraction (F), round (R), or truncate (T). */
  fractionFormat?: 'D' | 'F' | 'R' | 'T';
  /** Display precision for decimals (100 means hundredths), or the fraction denominator. */
  precision?: number;
  /** Retain trailing decimal zeros or the specified fraction denominator. */
  fixedDenominator?: boolean;
  thousandsSeparator?: string;
  decimalSeparator?: string;
  unitPrefix?: string;
  unitSuffix?: string;
  /** Position of the unit label relative to the value. Suffix (S) or prefix (P). */
  unitPosition?: 'S' | 'P';
}

/** Rectilinear measurement metadata (PDF 32000-1 Tables 261–262). */
export interface RectilinearMeasure {
  /** Human-readable scale ratio, independent of the numeric conversion factors. */
  scaleRatio: string;
  /** The first factor converts default user space units to the largest X unit. */
  xAxis: readonly MeasureNumberFormat[];
  /** The Y calibration when it differs from X. */
  yAxis?: readonly MeasureNumberFormat[];
  /** The first factor converts the largest X unit to the largest distance unit. */
  distance: readonly MeasureNumberFormat[];
  /** The first factor converts squared X units to the largest area unit. */
  area: readonly MeasureNumberFormat[];
  angle?: readonly MeasureNumberFormat[];
  slope?: readonly MeasureNumberFormat[];
  origin?: readonly [number, number];
  /** Factor converting the largest Y unit to the largest X unit. */
  yToX?: number;
}

const FORMAT_TEXT = [
  ['thousandsSeparator', 'RT'], ['decimalSeparator', 'RD'],
  ['unitPrefix', 'PS'], ['unitSuffix', 'SS'],
] as const;
const OPTIONAL_FORMATS = [['yAxis', 'Y'], ['angle', 'T'], ['slope', 'S']] as const;

function pdfText(value: string): PdfString {
  return { kind: 'string', bytes: encodePdfText(value) };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isFractionFormat(value: unknown): value is NonNullable<MeasureNumberFormat['fractionFormat']> {
  return value === 'D' || value === 'F' || value === 'R' || value === 'T';
}

function isUnitPosition(value: unknown): value is NonNullable<MeasureNumberFormat['unitPosition']> {
  return value === 'S' || value === 'P';
}

function isPrecision(value: unknown, format: MeasureNumberFormat['fractionFormat']): value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return false;
  return (format ?? 'D') !== 'D' || value % 10 === 0;
}

function readFormat(doc: Document, input: PdfObject): MeasureNumberFormat | undefined {
  const dict = doc.resolve(input);
  if (!isDict(dict)) return undefined;
  const type = doc.resolve(dict.get('Type'));
  if (type !== null && (!isName(type) || type.name !== 'NumberFormat')) return undefined;
  const unit = doc.resolve(dict.get('U'));
  const conversionFactor = doc.resolve(dict.get('C'));
  if (!isString(unit) || !isFiniteNumber(conversionFactor)) return undefined;
  const format: MeasureNumberFormat = { unit: decodePdfText(unit.bytes), conversionFactor };

  const fraction = doc.resolve(dict.get('F'));
  if (fraction !== null) {
    if (!isName(fraction) || !isFractionFormat(fraction.name)) return undefined;
    format.fractionFormat = fraction.name;
  }
  const precision = doc.resolve(dict.get('D'));
  if (precision !== null) {
    if (!isPrecision(precision, format.fractionFormat)) return undefined;
    format.precision = precision;
  }
  const fixed = doc.resolve(dict.get('FD'));
  if (fixed !== null) {
    if (typeof fixed !== 'boolean') return undefined;
    format.fixedDenominator = fixed;
  }
  for (const [field, key] of FORMAT_TEXT) {
    const value = doc.resolve(dict.get(key));
    if (value === null) continue;
    if (!isString(value)) return undefined;
    format[field] = decodePdfText(value.bytes);
  }
  const position = doc.resolve(dict.get('O'));
  if (position !== null) {
    if (!isName(position) || !isUnitPosition(position.name)) return undefined;
    format.unitPosition = position.name;
  }
  return format;
}

function readFormats(doc: Document, value: PdfObject): MeasureNumberFormat[] | undefined {
  if (!isArray(value) || value.length === 0) return undefined;
  const formats: MeasureNumberFormat[] = [];
  for (const entry of value) {
    const format = readFormat(doc, entry);
    if (format === undefined) return undefined;
    formats.push(format);
  }
  return formats;
}

export function readRectilinearMeasure(doc: Document, input: PdfObject | undefined): RectilinearMeasure | undefined {
  const dict = doc.resolve(input);
  if (!isDict(dict)) return undefined;
  const type = doc.resolve(dict.get('Type'));
  if (type !== null && (!isName(type) || type.name !== 'Measure')) return undefined;
  const subtype = doc.resolve(dict.get('Subtype'));
  if (subtype !== null && (!isName(subtype) || subtype.name !== 'RL')) return undefined;

  const ratio = doc.resolve(dict.get('R'));
  if (!isString(ratio)) return undefined;
  const xAxis = readFormats(doc, doc.resolve(dict.get('X')));
  const distance = readFormats(doc, doc.resolve(dict.get('D')));
  const area = readFormats(doc, doc.resolve(dict.get('A')));
  if (xAxis === undefined || distance === undefined || area === undefined) return undefined;
  const measure: RectilinearMeasure = {
    scaleRatio: decodePdfText(ratio.bytes), xAxis, distance, area,
  };

  for (const [field, key] of OPTIONAL_FORMATS) {
    const value = doc.resolve(dict.get(key));
    if (value === null) continue;
    const formats = readFormats(doc, value);
    if (formats === undefined) return undefined;
    measure[field] = formats;
  }
  const origin = doc.resolve(dict.get('O'));
  if (origin !== null) {
    if (!isArray(origin) || origin.length !== 2) return undefined;
    const x = doc.resolve(origin[0]);
    const y = doc.resolve(origin[1]);
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) return undefined;
    measure.origin = [x, y];
  }
  const yToX = doc.resolve(dict.get('CYX'));
  if (yToX !== null) {
    if (!isFiniteNumber(yToX)) return undefined;
    measure.yToX = yToX;
  }
  return measure;
}

function buildFormats(formats: readonly MeasureNumberFormat[], field: string): PdfDict[] {
  if (!Array.isArray(formats) || formats.length === 0) throw new TypeError(`${field} must be a non-empty array`);
  const result: PdfDict[] = [];
  for (const format of formats) {
    if (format === null || typeof format !== 'object') throw new TypeError(`${field} must contain number formats`);
    result.push(buildFormat(format));
  }
  return result;
}

function buildFormat(format: MeasureNumberFormat): PdfDict {
  const { unit, conversionFactor, fractionFormat, precision, fixedDenominator, unitPosition } = format;
  if (typeof unit !== 'string') throw new TypeError('number format unit must be a string');
  if (!isFiniteNumber(conversionFactor)) throw new TypeError('number format conversionFactor must be finite');
  const dict = new Map<string, PdfObject>([['Type', name('NumberFormat')], ['U', pdfText(unit)], ['C', conversionFactor]]);
  if (fractionFormat !== undefined) {
    if (!isFractionFormat(fractionFormat)) throw new TypeError('number format fractionFormat must be D, F, R, or T');
    dict.set('F', name(fractionFormat));
  }
  if (precision !== undefined) {
    if (!isPrecision(precision, fractionFormat)) throw new TypeError('invalid number format precision');
    dict.set('D', precision);
  }
  if (fixedDenominator !== undefined) {
    if (typeof fixedDenominator !== 'boolean') throw new TypeError('number format fixedDenominator must be boolean');
    dict.set('FD', fixedDenominator);
  }
  for (const [field, key] of FORMAT_TEXT) {
    const value = format[field];
    if (value === undefined) continue;
    if (typeof value !== 'string') throw new TypeError(`number format ${field} must be a string`);
    dict.set(key, pdfText(value));
  }
  if (unitPosition !== undefined) {
    if (!isUnitPosition(unitPosition)) throw new TypeError('number format unitPosition must be S or P');
    dict.set('O', name(unitPosition));
  }
  return dict;
}

export function buildRectilinearMeasure(measure: RectilinearMeasure | undefined): PdfDict | undefined {
  if (measure === undefined) return undefined;
  if (measure === null || typeof measure !== 'object' || typeof measure.scaleRatio !== 'string') {
    throw new TypeError('measure must have a scaleRatio string');
  }
  const dict = new Map<string, PdfObject>([
    ['Type', name('Measure')], ['Subtype', name('RL')], ['R', pdfText(measure.scaleRatio)],
    ['X', buildFormats(measure.xAxis, 'xAxis')],
    ['D', buildFormats(measure.distance, 'distance')],
    ['A', buildFormats(measure.area, 'area')],
  ]);
  for (const [field, key] of OPTIONAL_FORMATS) {
    const formats = measure[field];
    if (formats !== undefined) dict.set(key, buildFormats(formats, field));
  }
  const { origin, yToX } = measure;
  if (origin !== undefined) {
    if (!Array.isArray(origin) || origin.length !== 2 || !isFiniteNumber(origin[0]) || !isFiniteNumber(origin[1])) {
      throw new TypeError('measure origin must contain two finite numbers');
    }
    dict.set('O', [origin[0], origin[1]]);
  }
  if (yToX !== undefined) {
    if (!isFiniteNumber(yToX)) throw new TypeError('measure yToX must be finite');
    dict.set('CYX', yToX);
  }
  return dict;
}
