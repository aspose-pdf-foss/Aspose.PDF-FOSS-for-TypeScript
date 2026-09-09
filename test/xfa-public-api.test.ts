import { describe, it, expect } from 'vitest';
import * as api from '../src/index.js';
import type {
  XfaConvertOptions, XfaConvertReport, XfaFieldResult, XfaSkipped,
} from '../src/index.js';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { buildXfaPdf, POSITIONED_TEMPLATE } from './helpers/build-xfa-pdf.js';

// A compile-time assertion: these four must be exported as TYPES from index.ts.
// `not.toHaveProperty` provably cannot see them, since types are erased.
const _opts: XfaConvertOptions = { removeXfa: true };
const _skip: XfaSkipped = { what: 'field', reason: 'x' };
const _res: XfaFieldResult = { name: 'a', type: 'text', route: 'bare' };
const _rep: XfaConvertReport = {
  packets: [], fields: [], skipped: [], xfaRemoved: false, dataOnly: false,
};
void _opts; void _skip; void _res; void _rep;

describe('the XFA public surface', () => {
  it('is reachable from the Document facade', () => {
    const doc = Document.Open(buildXfaPdf({ template: POSITIONED_TEMPLATE }));
    const report = doc.ConvertXfaToAcroForm();
    expect(report.fields).toHaveLength(1);
    expect(report.xfaRemoved).toBe(true);
  });

  it('defaults removeXfa to true and honours false', () => {
    const keep = Document.Open(buildXfaPdf({ template: POSITIONED_TEMPLATE }));
    expect(keep.ConvertXfaToAcroForm({ removeXfa: false }).xfaRemoved).toBe(false);
  });

  // The packet, template and data models stay INTERNAL until a caller asks for
  // them -- the posture parseHtmlFragment takes. Asserted by name so the
  // absence is a decision the suite enforces rather than an oversight: adding
  // an export is the natural reflex when a later feature wants one.
  it('exports the entry point types and none of the internals', () => {
    for (const absent of [
      'parseXfaTemplate', 'parseXfaDatasets', 'decodeXfaPackets', 'buildXfaPlan',
      'convertXfaToAcroForm', 'measureToPt', 'rectFromBox', 'chainIsPositioned',
      'mediumAgrees', 'boxFor', 'somName', 'bindFieldValue', 'anchorShift',
      'accumulateOrigin', 'mediumSizePt', 'XFA_ANCHORS', 'XFA_FLOW_LAYOUTS',
      'MEDIUM_TOLERANCE_PT',
    ]) expect(api).not.toHaveProperty(absent);
  });

  // The byte-identity fence: a document with no /XFA is unchanged by the call.
  it('leaves a document with no /XFA byte-identical', () => {
    const doc = Document.New();
    doc.AddPage(PageFormat.A4);
    doc.Pages[0].AddText('hello', 72, 72);
    const before = doc.Save();
    const report = doc.ConvertXfaToAcroForm();
    expect(report.fields).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(doc.Save()).toEqual(before);
  });
});
