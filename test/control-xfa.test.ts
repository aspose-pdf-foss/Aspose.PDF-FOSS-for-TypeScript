import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isDict } from '../src/types.js';
import type { OperationProgress } from '../src/checkpoint.js';
import { buildXfaPdf, POSITIONED_TEMPLATE, GROUP_TEMPLATE } from './helpers/build-xfa-pdf.js';
import { buildSignedGrayscalePdf } from './helpers/build-grayscale-pdf.js';

function hasXfa(doc: Document): boolean {
  const acro = doc.resolve(doc.catalog().get('AcroForm'));
  return isDict(acro) && acro.has('XFA');
}

describe('cooperative XFA conversion', () => {
  it.each([POSITIONED_TEMPLATE, GROUP_TEMPLATE])('preserves conversion results and checks pre-abort', async (template) => {
    const bytes = buildXfaPdf({ template }), doc = Document.Open(bytes), before = doc.Save(), reason = new Error('pre-abort');
    expect(() => doc.ConvertXfaToAcroForm({ signal: AbortSignal.abort(reason) })).toThrow(reason);
    await expect(doc.ConvertXfaToAcroFormAsync({ signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(doc.Save()).toEqual(before);
    const expected = Document.Open(bytes).ConvertXfaToAcroForm(), events: OperationProgress[] = [];
    expect(await doc.ConvertXfaToAcroFormAsync({ onProgress: (e) => events.push(e) })).toEqual(expected);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.operation === 'ConvertXfaToAcroForm')).toBe(true);
  });

  it('retains a completed field and XFA source after cancellation during a yield', async () => {
    const doc = Document.Open(buildXfaPdf({ template: POSITIONED_TEMPLATE })), controller = new AbortController(), reason = new Error('field');
    let handle: NodeJS.Immediate | undefined;
    try {
      await expect(doc.ConvertXfaToAcroFormAsync({ signal: controller.signal, onProgress: (e) => {
        if (e.phase === 'fields') handle = setImmediate(() => controller.abort(reason));
      } })).rejects.toBe(reason);
      expect(doc.Form.Fields).toHaveLength(1);
      expect(hasXfa(doc)).toBe(true);
      const reopened = Document.Open(doc.Save());
      expect(reopened.Form.Fields).toHaveLength(1);
      expect(reopened.Validate().Passed).toBe(true);
    } finally { if (handle) clearImmediate(handle); }
  });

  it('retains a reconciled value when cancellation stops later phases', async () => {
    const doc = Document.Open(buildXfaPdf({ template: POSITIONED_TEMPLATE, acroFieldObjects: ['{HYBRID}'],
      datasets: '<xfa:datasets><xfa:data><form1><Page1><f1_01>ENTERED</f1_01></Page1></form1></xfa:data></xfa:datasets>',
    }));
    const controller = new AbortController(), reason = new Error('reconcile');
    await expect(doc.ConvertXfaToAcroFormAsync({ signal: controller.signal, onProgress: (e) => {
      if (e.phase === 'reconcile') controller.abort(reason);
    } })).rejects.toBe(reason);
    expect(doc.Form.Get('form1[0].Page1[0].f1_01[0]')?.Value).toBe('ENTERED');
    expect(hasXfa(doc)).toBe(true);
    expect(doc.isModifiedInternal()).toBe(true);
  });

  it('keeps page replacement atomic before cancellation', async () => {
    const template = '<template><subform name="form1" layout="tb"><pageSet><pageArea name="P"><medium short="210mm" long="297mm"/><contentArea w="210mm" h="297mm"/></pageArea></pageSet>'
      + '<subform name="Page1" w="210mm" h="297mm"><field name="a" x="1in" y="1in" w="2in" h="20pt"><ui><textEdit/></ui></field></subform>'
      + '<subform name="Page2" w="210mm" h="297mm"><break before="pageArea" startNew="1"/><field name="b" x="1in" y="2in" w="2in" h="20pt"><ui><textEdit/></ui></field></subform></subform></template>';
    const doc = Document.Open(buildXfaPdf({ template, needsRendering: true })), controller = new AbortController(), reason = new Error('pages');
    await expect(doc.ConvertXfaToAcroFormAsync({ signal: controller.signal, onProgress: (e) => {
      if (e.phase === 'pages') controller.abort(reason);
    } })).rejects.toBe(reason);
    expect(doc.Pages).toHaveLength(2);
    expect(doc.Pages[0].MediaBox[2]).toBeCloseTo(595.276, 3);
    expect(doc.Pages[1].MediaBox[2]).toBeCloseTo(595.276, 3);
    expect(hasXfa(doc)).toBe(true);
    expect(Document.Open(doc.Save()).Validate().Passed).toBe(true);
  });

  it('preserves no-XFA no-op and signed refusal', async () => {
    const doc = Document.New(), before = doc.Save();
    await doc.ConvertXfaToAcroFormAsync();
    expect(doc.Save()).toEqual(before);
    await expect(Document.Open(buildSignedGrayscalePdf()).ConvertXfaToAcroFormAsync()).rejects.toThrow(/signed/);
  });
});
