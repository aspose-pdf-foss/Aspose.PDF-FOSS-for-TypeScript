import { describe, it, expect } from 'vitest';
import {
  VERAPDF_COMMIT, PREDEFINED_2004, PREDEFINED_2005, BASE_VALUE_TYPES, VALUE_TYPES_2004, VALUE_TYPES_2005,
} from '../src/xmpschemadata.js';
import { eraOf, isPredefinedProperty, simplifyValueType, valueTypesFor, isKnownValueType } from '../src/xmpschemas.js';

const DC = 'http://purl.org/dc/elements/1.1/';
const MM = 'http://ns.adobe.com/xap/1.0/mm/';
const PDF = 'http://ns.adobe.com/pdf/1.3/';
const DM = 'http://ns.adobe.com/xmp/1.0/DynamicMedia/';
const TPG = 'http://ns.adobe.com/xap/1.0/t/pg/';
const PDFAID = 'http://www.aiim.org/pdfa/ns/id/';
const PDFUAID = 'http://www.aiim.org/pdfua/ns/id/';
const count = (t: Readonly<Record<string, readonly string[]>>) => Object.values(t).reduce((n, a) => n + a.length, 0);

describe('generated tables', () => {
  it('are pinned to veraPDF-library 60f8f1dc and have the generated sizes', () => {
    // A truncated or re-pinned generation is a red build rather than a
    // silently smaller predefined set.
    expect(VERAPDF_COMMIT).toBe('60f8f1dc236adb536c3a935488cd6a56a650c941');
    expect([count(PREDEFINED_2004), Object.keys(PREDEFINED_2004).length]).toEqual([172, 11]);
    expect([count(PREDEFINED_2005), Object.keys(PREDEFINED_2005).length]).toEqual([277, 14]);
    expect([BASE_VALUE_TYPES.length, VALUE_TYPES_2004.length, VALUE_TYPES_2005.length]).toEqual([14, 26, 36]);
  });

  it('holds facts checked by hand against XMPConstants.java', () => {
    expect(isPredefinedProperty(DC, 'title', '2004')).toBe(true);
    expect(isPredefinedProperty(DC, 'title', '2005')).toBe(true);
    expect(isPredefinedProperty(DM, 'album', '2005')).toBe(true);
    expect(isPredefinedProperty(DM, 'album', '2004')).toBe(false);
    expect(isPredefinedProperty(TPG, 'Fonts', '2005')).toBe(true);
    expect(isPredefinedProperty(TPG, 'Fonts', '2004')).toBe(false);
    expect(isPredefinedProperty(PDFAID, 'corr', '2005')).toBe(true);
    expect(isPredefinedProperty(PDFAID, 'corr', '2004')).toBe(false);
    // Not predefined in EITHER era — the two properties the Acrobat fixture
    // carries, and pdfuaid, which is why a PDF/A + PDF/UA file needs a description.
    for (const era of ['2004', '2005'] as const) {
      expect(isPredefinedProperty(MM, 'OriginalDocumentID', era)).toBe(false);
      expect(isPredefinedProperty(PDF, 'Trapped', era)).toBe(false);
      expect(isPredefinedProperty(PDFUAID, 'part', era)).toBe(false);
    }
  });

  it('knows structured types per era and only simple ones in the base container', () => {
    expect(VALUE_TYPES_2004).toContain('resourceref');
    expect(VALUE_TYPES_2005).toContain('colorant');
    expect(VALUE_TYPES_2004).not.toContain('colorant');
    expect(BASE_VALUE_TYPES).toContain('lang alt');
    expect(BASE_VALUE_TYPES).not.toContain('resourceref');
    expect(BASE_VALUE_TYPES).not.toContain('gpscoordinate');
  });
});

describe('eraOf', () => {
  it('is XMP 2004 for part 1 and 2005 for parts 2 and 3', () => {
    expect([eraOf(1), eraOf(2), eraOf(3)]).toEqual(['2004', '2005', '2005']);
  });
});

describe('value-type names (veraPDF getSimplifiedType + isKnownType)', () => {
  it('lowercases, strips choice wording, and makes a bare array an array of Text', () => {
    expect(simplifyValueType('ProperName')).toBe('propername');
    expect(simplifyValueType('Closed Choice of Text')).toBe('text');
    expect(simplifyValueType('Open Choice')).toBe('text');
    expect(simplifyValueType('')).toBe('text');
    expect(simplifyValueType('Seq')).toBe('seq text');
    expect(simplifyValueType('Lang Alt')).toBe('lang alt');
  });

  it('peels array prefixes before looking the name up', () => {
    const known = valueTypesFor('2005');
    expect(isKnownValueType('Bag ProperName', known)).toBe(true);
    expect(isKnownValueType('Seq Seq Date', known)).toBe(true);
    expect(isKnownValueType('Lang Alt', known)).toBe(true);
    expect(isKnownValueType('Seq', known)).toBe(true);
    expect(isKnownValueType('Widget', known)).toBe(false);
  });

  it('adds a schema\'s own types, simplified, and gives an unregistered schema the base set only', () => {
    expect(isKnownValueType('Seq Point', valueTypesFor('2005', ['Point']))).toBe(true);
    expect(isKnownValueType('ResourceRef', valueTypesFor(undefined))).toBe(false);
    expect(isKnownValueType('Text', valueTypesFor(undefined))).toBe(true);
    expect(isKnownValueType('GPSCoordinate', valueTypesFor('2004'))).toBe(true);
  });
});
