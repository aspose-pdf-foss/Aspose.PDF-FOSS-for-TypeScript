// test/xfatemplate-text.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isDict } from '../src/types.js';
import { decodeStream } from '../src/filters.js';
import { decodeXfaPackets } from '../src/xfapacket.js';
import { parseXfaTemplate } from '../src/xfatemplate.js';
import type { LayoutNode } from '../src/xfaflow.js';
import { loadDynamicPdf } from './helpers/xfa-dynamic.js';

function find(n: LayoutNode, path: string[]): LayoutNode | undefined {
  if (path.length === 0) return n;
  const c = n.children.find((k) => k.label === path[0]);
  return c ? find(c, path.slice(1)) : undefined;
}

describe('xfatemplate: leaves carry their LeafText', () => {
  it('gives OPM 1644 Q1 its rich text, in Arial', () => {
    const doc = Document.Open(loadDynamicPdf());
    const acro = doc.resolve(doc.catalog().get('AcroForm'));
    const p = decodeXfaPackets(isDict(acro) ? acro : undefined, (o) => doc.resolve(o), (s) => decodeStream(s));
    if ('reason' in p) throw new Error(p.reason);
    const tpl = parseXfaTemplate(p.packets.get('template')!);
    const q1 = find(tpl.roots[0].node, ['Page1[0]', 'SectionII[0]', 'Row1[0]', 'Q1']);
    expect(q1?.kind).toBe('draw');
    expect(q1?.text?.paras[0].runs[0]).toMatchObject({ family: ['Arial'], size: 10 });
    const field = find(tpl.roots[0].node, ['Page1[0]', 'SectionI[0]', 'Row2[0]', 'FieldQ1Name[0]']);
    expect(field?.text?.kind).toBe('text');
    expect(find(tpl.roots[0].node, ['Page1[0]', 'SectionI[0]'])?.text).toBeUndefined();
  });
});
