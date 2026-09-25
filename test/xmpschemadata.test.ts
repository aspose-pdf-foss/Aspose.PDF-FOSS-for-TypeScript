import { describe, it, expect } from 'vitest';
import {
  PROPERTY_TYPES_2004, PROPERTY_TYPES_2005, STRUCT_TYPES_2004, STRUCT_TYPES_2005,
  SIMPLE_PATTERNS_2004, SIMPLE_PATTERNS_2005, PREDEFINED_2004, PREDEFINED_2005, VALUE_TYPES_2004, VALUE_TYPES_2005,
} from '../src/xmpschemadata.js';
import { isKnownValueType } from '../src/xmpschemas.js';

const DC = 'http://purl.org/dc/elements/1.1/';
const XMP = 'http://ns.adobe.com/xap/1.0/';
const PDFAID = 'http://www.aiim.org/pdfa/ns/id/';
const TIFF = 'http://ns.adobe.com/tiff/1.0/';

describe('generated type tables', () => {
  it('carry veraPDF\'s property types', () => {
    for (const t of [PROPERTY_TYPES_2004, PROPERTY_TYPES_2005]) {
      expect(t[DC].title).toBe('lang alt');
      expect(t[DC].creator).toBe('seq propername');
      expect(t[DC].contributor).toBe('bag propername');
      expect(t[XMP].CreateDate).toBe('date');
      expect(t[XMP].Thumbnails).toBe('alt thumbnail');
      expect(t[PDFAID].part).toBe('integer');
      expect(t[PDFAID].conformance).toBe('text');       // closed choice OFF: the open type
      expect(t[TIFF].Compression).toBe('integer');
      expect(t[TIFF].YCbCrSubSampling).toBe('seq integer');
    }
    expect(PROPERTY_TYPES_2004[PDFAID].corr).toBeUndefined();
    expect(PROPERTY_TYPES_2005[PDFAID].corr).toBe('text');
  });

  it('name exactly the predefined properties, every one with a known type', () => {
    for (const [types, names, known] of [[PROPERTY_TYPES_2004, PREDEFINED_2004, VALUE_TYPES_2004],
      [PROPERTY_TYPES_2005, PREDEFINED_2005, VALUE_TYPES_2005]] as const) {
      expect(Object.keys(types).sort()).toEqual(Object.keys(names).sort());
      for (const ns of Object.keys(names)) expect(Object.keys(types[ns]).sort()).toEqual([...names[ns]].sort());
      const set = new Set(known);
      for (const ns of Object.keys(types))
        for (const type of Object.values(types[ns])) expect(isKnownValueType(type, set), type).toBe(true);
    }
  });

  it('carry the structured types, restricted fields merged under their open types', () => {
    const dims = STRUCT_TYPES_2004.dimensions;
    expect(dims.ns).toMatch(/Dimensions#$/);
    expect(dims.fields).toEqual({ w: 'real', h: 'real', unit: 'text' });
    expect(STRUCT_TYPES_2005.thumbnail.fields).toEqual({ height: 'integer', width: 'integer', image: 'text', format: 'text' });
    expect(STRUCT_TYPES_2004.colorant).toBeUndefined();
    expect(STRUCT_TYPES_2005.colorant).toBeDefined();
  });

  it('carry the simple patterns, GPSCoordinate differing by era', () => {
    expect(SIMPLE_PATTERNS_2004.boolean).toBe('^True$|^False$');
    expect(SIMPLE_PATTERNS_2004.integer).toBe('^[+-]?\\d+$');
    expect(SIMPLE_PATTERNS_2004.text).toBe('(?s)(^.*$)');
    expect(SIMPLE_PATTERNS_2004.gpscoordinate).not.toBe(SIMPLE_PATTERNS_2005.gpscoordinate);
    expect(SIMPLE_PATTERNS_2005.locale).toBe('(?s)(^.*$)');
  });
});
