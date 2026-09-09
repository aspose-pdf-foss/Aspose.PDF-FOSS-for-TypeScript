import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { buildSigner } from './helpers/build-signer.js';
import { buildXfaPlan, convertXfaToAcroForm } from '../src/xfaconvert.js';
import {
  buildXfaPdf, POSITIONED_TEMPLATE, FLOWED_TEMPLATE, WRONG_MEDIUM_TEMPLATE,
  GROUP_TEMPLATE, Y_FLIP_TEMPLATE, DIFFERING_DEFAULT_TEMPLATE, THREE_DEEP_TEMPLATE,
  PAIRED_ITEMS_TEMPLATE, NESTED_FLOW_TEMPLATE, FLAGS_TEMPLATE,
} from './helpers/build-xfa-pdf.js';

const planOf = (bytes: Uint8Array) => buildXfaPlan(Document.Open(bytes), {});

describe('buildXfaPlan: classification', () => {
  it('routes a positioned field to a widget with a rect on its page', () => {
    const p = planOf(buildXfaPdf({ template: POSITIONED_TEMPLATE }));
    expect(p.report.fields).toEqual([{
      name: 'form1[0].Page1[0].f1_01[0]', type: 'text', route: 'positioned', page: 1,
    }]);
    expect(p.report.skipped).toEqual([]);
    expect(p.report.dataOnly).toBe(false);
    // x=1in y=2in w=3in h=20pt on US Letter, y-flipped against the CropBox top.
    expect(p.entries[0].rect).toEqual([72, 628, 288, 648]);
  });

  it('degrades a flow-laid field to bare and says why', () => {
    const p = planOf(buildXfaPdf({ template: FLOWED_TEMPLATE }));
    expect(p.report.fields[0].route).toBe('bare');
    expect(p.report.fields[0].page).toBeUndefined();
    expect(p.report.skipped).toEqual([{
      what: 'field', name: 'form1[0].Page1[0].f1_01[0]',
      reason: expect.stringMatching(/layout/i) as unknown as string,
    }]);
    // At least one field converted and NONE got geometry.
    expect(p.report.dataOnly).toBe(true);
  });

  // The correctness anchor: one comparison against a number we did not compute.
  it('degrades EVERY field on a page whose medium disagrees, and reports the page', () => {
    const p = planOf(buildXfaPdf({ template: WRONG_MEDIUM_TEMPLATE }));
    expect(p.report.fields.every((f) => f.route === 'bare')).toBe(true);
    expect(p.report.skipped.filter((s) => s.what === 'page')).toHaveLength(1);
    // One PAGE entry, not one per field: the page is what failed.
    expect(p.report.skipped.filter((s) => s.what === 'field')).toHaveLength(0);
  });

  it('degrades the whole document when the pageArea count disagrees with the pages', () => {
    const p = planOf(buildXfaPdf({ template: POSITIONED_TEMPLATE, pages: 2 }));
    expect(p.report.fields.every((f) => f.route === 'bare')).toBe(true);
    expect(p.report.skipped.some(
      (s) => s.what === 'document' && /pageArea/i.test(s.reason),
    )).toBe(true);
  });

  // "Converted to data and renders nothing" and "converted nothing at all" are
  // different answers and must not read as the same one.
  it('reports dataOnly false for a document that converted nothing at all', () => {
    const p = planOf(buildXfaPdf({ template: '<template/>' }));
    expect(p.report.fields).toEqual([]);
    expect(p.report.dataOnly).toBe(false);
  });
});

describe('buildXfaPlan: types, values and options', () => {
  it('maps each UI kind to its /FT and flags', () => {
    const p = planOf(buildXfaPdf({ template: `<template><subform name="f" layout="tb">
      <pageSet><pageArea name="P"><medium short="8.5in" long="11in"/></pageArea></pageSet>
      <subform name="P1" layout="position">
        <field name="t" x="0" y="0" w="1in" h="20pt"><ui><textEdit multiLine="1"/></ui></field>
        <field name="p" x="0" y="1in" w="1in" h="20pt"><ui><passwordEdit/></ui></field>
        <field name="c" x="0" y="2in" w="20pt" h="20pt"><ui><checkButton/></ui></field>
        <field name="l" x="0" y="3in" w="1in" h="20pt"><ui><choiceList/></ui>
          <items save="1"><text>S</text></items><items><text>Small</text></items></field>
        <field name="e" x="0" y="4in" w="1in" h="20pt">
          <ui><choiceList open="userControl"/></ui><items><text>A</text></items></field>
        <field name="m" x="0" y="5in" w="1in" h="20pt">
          <ui><choiceList open="multiSelect"/></ui><items><text>A</text></items></field>
        <field name="b" x="0" y="6in" w="1in" h="20pt"><ui><button/></ui></field>
      </subform></subform></template>` }));
    const by = (n: string) => p.entries.find((e) => e.name === `f[0].P1[0].${n}[0]`)!;
    expect(by('t').ft).toBe('Tx');
    expect(by('t').ff & 0x1000).toBeTruthy();   // FF_MULTILINE
    expect(by('p').ff & 0x2000).toBeTruthy();   // FF_PASSWORD
    expect(by('c').ft).toBe('Btn');
    expect(by('l').ft).toBe('Ch');
    expect(by('l').options).toEqual([{ export: 'S', display: 'Small' }]);
    expect(by('e').ff & 0x20000).toBeTruthy();  // FF_COMBO
    expect(by('e').ff & 0x40000).toBeTruthy();  // FF_EDIT
    expect(by('m').ff & 0x200000).toBeTruthy(); // FF_MULTISELECT
    expect(by('b').ff & 0x10000).toBeTruthy();  // FF_PUSHBUTTON
  });

  it('carries readOnly and required into /Ff', () => {
    const p = planOf(buildXfaPdf({ template: `<template><subform name="f" layout="tb">
      <pageSet><pageArea name="P"><medium short="8.5in" long="11in"/></pageArea></pageSet>
      <subform name="P1" layout="position">
        <field name="ro" access="readOnly" x="0" y="0" w="1in" h="20pt">
          <ui><textEdit/></ui></field>
        <field name="req" x="0" y="1in" w="1in" h="20pt"><ui><textEdit/></ui>
          <validate nullTest="error"/></field>
      </subform></subform></template>` }));
    const by = (n: string) => p.entries.find((e) => e.name === `f[0].P1[0].${n}[0]`)!;
    expect(by('ro').ff & 1).toBeTruthy();
    expect(by('ro').ff & 2).toBeFalsy();
    expect(by('req').ff & 2).toBeTruthy();
    expect(by('req').ff & 1).toBeFalsy();
  });

  it('refuses signature, imageEdit and barcode by name and creates nothing', () => {
    const p = planOf(buildXfaPdf({ template: `<template><subform name="f" layout="tb">
      <pageSet><pageArea name="P"><medium short="8.5in" long="11in"/></pageArea></pageSet>
      <subform name="P1" layout="position">
        <field name="s" x="0" y="0" w="1in" h="20pt"><ui><signature/></ui></field>
        <field name="i" x="0" y="1in" w="1in" h="20pt"><ui><imageEdit/></ui></field>
        <field name="k" x="0" y="2in" w="1in" h="20pt"><ui><barcode/></ui></field>
      </subform></subform></template>` }));
    expect(p.report.fields).toEqual([]);
    expect(p.report.skipped.map((s) => s.name).sort())
      .toEqual(['f[0].P1[0].i[0]', 'f[0].P1[0].k[0]', 'f[0].P1[0].s[0]']);
  });

  // The design's invariant: values come from datasets, the template <value> is
  // /DV. A datum that DIFFERS from the default is what measures it.
  it('takes /V from datasets and /DV from the template default', () => {
    const p = planOf(buildXfaPdf({
      template: `<template><subform name="form1" layout="tb">
        <pageSet><pageArea name="P"><medium short="8.5in" long="11in"/></pageArea></pageSet>
        <subform name="Page1" layout="position">
          <field name="f1_01" x="1in" y="2in" w="3in" h="20pt"><ui><textEdit/></ui>
            <value><text>AUTHORED</text></value></field>
        </subform></subform></template>`,
      datasets: `<xfa:datasets><xfa:data><form1><Page1><f1_01>ENTERED</f1_01>
        </Page1></form1></xfa:data></xfa:datasets>`,
    }));
    expect(p.entries[0].value).toBe('ENTERED');
    expect(p.entries[0].defaultValue).toBe('AUTHORED');
  });

  it('lists the packets the document holds', () => {
    const p = planOf(buildXfaPdf({
      template: POSITIONED_TEMPLATE,
      datasets: '<xfa:datasets><xfa:data/></xfa:datasets>',
      extra: { config: '<config/>' },
    }));
    expect(p.report.packets).toEqual(['template', 'datasets', 'config']);
  });

  it('refuses the document with a packet skip when there is no template', () => {
    const p = planOf(buildXfaPdf({ template: '', extra: { config: '<config/>' } }));
    expect(p.entries).toEqual([]);
    expect(p.report.skipped.some((s) => s.what === 'packet')).toBe(true);
  });

  it('reads a single-stream XDP as readily as the array', () => {
    const p = planOf(buildXfaPdf({
      template: POSITIONED_TEMPLATE, singleStream: true,
    }));
    expect(p.report.fields[0].route).toBe('positioned');
  });
});

describe('buildXfaPlan: exclGroup and reconciliation', () => {
  it('plans one radio group carrying one option per member', () => {
    const p = planOf(buildXfaPdf({ template: GROUP_TEMPLATE }));
    expect(p.groups).toHaveLength(1);
    expect(p.groups[0].name).toBe('form1[0].Page1[0].colour[0]');
    expect(p.groups[0].options.map((o) => o.export)).toEqual(['Red', 'Green']);
    expect(p.report.fields.map((f) => f.name))
      .toEqual(['form1[0].Page1[0].colour[0]']);
  });

  // Interpretation 5: all-or-nothing. A group with some widgets placed and some
  // not is not a degraded control, it is a broken one.
  it('sends the WHOLE group bare when any member lacks geometry', () => {
    const p = planOf(buildXfaPdf({
      template: GROUP_TEMPLATE.replace('name="g" x="1in" y="2in"', 'name="g" x="1px" y="2in"'),
    }));
    expect(p.groups).toEqual([]);
    expect(p.report.fields).toEqual([
      { name: 'form1[0].Page1[0].colour[0]', type: 'radio', route: 'bare' },
    ]);
  });

  it('reconciles a field the AcroForm already has instead of creating one', () => {
    const p = planOf(buildXfaPdf({
      template: POSITIONED_TEMPLATE,
      datasets: `<xfa:datasets><xfa:data><form1><Page1><f1_01>ENTERED</f1_01>
        </Page1></form1></xfa:data></xfa:datasets>`,
      acroFieldObjects: ['{HYBRID}'],
    }));
    expect(p.report.fields[0].route).toBe('reconciled');
    expect(p.report.fields[0].page).toBeUndefined();
    expect(p.entries[0].value).toBe('ENTERED');
  });
});

describe('buildXfaPlan: it allocates nothing', () => {
  it('leaves the document byte-identical', () => {
    const bytes = buildXfaPdf({ template: POSITIONED_TEMPLATE });
    const a = Document.Open(bytes);
    const before = a.Save();
    buildXfaPlan(a, {});
    expect(a.Save()).toEqual(before);
  });
});

describe('convertXfaToAcroForm: bare fields', () => {
  const bare = () => {
    const doc = Document.Open(buildXfaPdf({
      template: FLOWED_TEMPLATE,
      datasets: `<xfa:datasets><xfa:data><form1><Page1><f1_01>ENTERED</f1_01>
        </Page1></form1></xfa:data></xfa:datasets>`,
    }));
    const report = convertXfaToAcroForm(doc, { removeXfa: false });
    return { doc, report };
  };

  it('creates a field the Form walk finds, at its full SOM name', () => {
    const { doc } = bare();
    const f = doc.Form.Get('form1[0].Page1[0].f1_01[0]');
    expect(f).toBeDefined();
    expect(f!.Type).toBe('text');
    expect(f!.Value).toBe('ENTERED');
  });

  // A bare field is a FIELD, not an annotation. A /Subtype /Widget with no
  // /Rect is a malformed annotation; no widget at all is a perfectly legal
  // geometry-less field.
  it('gives it no /Subtype, no /Rect, no /P and no page /Annots entry', () => {
    const { doc } = bare();
    const d = doc.Form.Get('form1[0].Page1[0].f1_01[0]')!.Dict;
    expect(d.has('Subtype')).toBe(false);
    expect(d.has('Rect')).toBe(false);
    expect(d.has('P')).toBe(false);
    const annots = doc.resolve(doc.Pages[0].Dict.get('Annots'));
    expect(Array.isArray(annots) ? annots.length : 0).toBe(0);
  });

  // A SOM path is always hierarchical, so appendField -- which appends to
  // /AcroForm /Fields directly -- would flatten it onto the root.
  it('builds the intermediate nodes the SOM path names', () => {
    const { doc } = bare();
    const acro = doc.resolve(doc.catalog().get('AcroForm')) as Map<string, unknown>;
    const roots = doc.resolve(acro.get('Fields') as never) as unknown[];
    expect(roots).toHaveLength(1);
    expect(doc.Form.Fields).toHaveLength(1);
    expect(doc.Form.Fields[0].FullName).toBe('form1[0].Page1[0].f1_01[0]');
  });

  it('survives a save and reopen', () => {
    const { doc } = bare();
    const again = Document.Open(doc.Save());
    expect(again.Form.Get('form1[0].Page1[0].f1_01[0]')!.Value).toBe('ENTERED');
  });

  it('writes /DV from the template default and /V from the data', () => {
    const doc = Document.Open(buildXfaPdf({
      template: FLOWED_TEMPLATE.replace('<ui><textEdit/></ui>',
        '<ui><textEdit/></ui><value><text>AUTHORED</text></value>'),
      datasets: `<xfa:datasets><xfa:data><form1><Page1><f1_01>ENTERED</f1_01>
        </Page1></form1></xfa:data></xfa:datasets>`,
    }));
    convertXfaToAcroForm(doc, { removeXfa: false });
    const d = doc.Form.Get('form1[0].Page1[0].f1_01[0]')!.Dict;
    const str = (o: unknown) => new TextDecoder().decode((o as { bytes: Uint8Array }).bytes);
    expect(str(doc.resolve(d.get('V') as never))).toBe('ENTERED');
    expect(str(doc.resolve(d.get('DV') as never))).toBe('AUTHORED');
  });

  it('writes /Opt through choiceopt so both halves of a pair survive', () => {
    const doc = Document.Open(buildXfaPdf({ template: `<template><subform name="f" layout="tb">
      <pageSet><pageArea name="P"><medium short="8.5in" long="11in"/></pageArea></pageSet>
      <subform name="P" layout="tb"><field name="c"><ui><choiceList/></ui>
        <items><text>Small</text></items>
        <items save="1"><text>S</text></items></field></subform></subform></template>` }));
    convertXfaToAcroForm(doc, { removeXfa: false });
    const opt = doc.resolve(doc.Form.Get('f[0].P[0].c[0]')!.Dict.get('Opt') as never);
    expect(Array.isArray(opt)).toBe(true);
    expect(opt as unknown[]).toHaveLength(1);
    // An [export, display] pair, not a bare string.
    expect(Array.isArray(doc.resolve((opt as unknown[])[0] as never))).toBe(true);
  });

  it('carries maxChars and the tooltip through', () => {
    const doc = Document.Open(buildXfaPdf({
      template: FLOWED_TEMPLATE.replace('<ui><textEdit/></ui>',
        '<ui><textEdit/></ui><value><text maxChars="40"/></value>'
        + '<assist><toolTip>Your name</toolTip></assist>'),
    }));
    convertXfaToAcroForm(doc, { removeXfa: false });
    const d = doc.Form.Get('form1[0].Page1[0].f1_01[0]')!.Dict;
    expect(doc.resolve(d.get('MaxLen') as never)).toBe(40);
    expect(d.has('TU')).toBe(true);
  });
});

describe('convertXfaToAcroForm: reconciliation', () => {
  it('updates an existing field /V and creates nothing', () => {
    const doc = Document.Open(buildXfaPdf({
      template: POSITIONED_TEMPLATE,
      datasets: `<xfa:datasets><xfa:data><form1><Page1><f1_01>ENTERED</f1_01>
        </Page1></form1></xfa:data></xfa:datasets>`,
      acroFieldObjects: ['{HYBRID}'],
    }));
    const before = doc.Form.Fields.length;
    const rect = [...(doc.resolve(
      doc.Form.Get('form1[0].Page1[0].f1_01[0]')!.Dict.get('Rect') as never,
    ) as number[])];
    const report = convertXfaToAcroForm(doc, { removeXfa: false });
    expect(report.fields[0].route).toBe('reconciled');
    expect(doc.Form.Fields).toHaveLength(before);
    expect(doc.Form.Get('form1[0].Page1[0].f1_01[0]')!.Value).toBe('ENTERED');
    // Its geometry is LEFT ALONE -- the AcroForm half is already authoritative.
    expect(doc.resolve(
      doc.Form.Get('form1[0].Page1[0].f1_01[0]')!.Dict.get('Rect') as never,
    )).toEqual(rect);
  });

  it('leaves an existing field with no matching datum untouched', () => {
    const doc = Document.Open(buildXfaPdf({
      template: POSITIONED_TEMPLATE, acroFieldObjects: ['{HYBRID}'],
    }));
    const before = doc.Save();
    convertXfaToAcroForm(doc, { removeXfa: false });
    expect(doc.Save()).toEqual(before);
  });
});

describe('convertXfaToAcroForm: refusals', () => {
  it('returns a report rather than throwing for a document with no /XFA', () => {
    const doc = Document.New();
    doc.AddPage(PageFormat.A4);
    const before = doc.Save();
    const report = convertXfaToAcroForm(doc);
    expect(report.fields).toEqual([]);
    expect(report.skipped[0].what).toBe('document');
    expect(report.xfaRemoved).toBe(false);
    // The byte-identity fence: a call that converts nothing changes nothing.
    expect(doc.Save()).toEqual(before);
  });

  // docmdp.ts permits /AcroForm /Fields to change for FILLING, and adding two
  // hundred fields is not filling -- a certification would read as violated.
  it('throws UnsupportedFeatureError on a signed document', async () => {
    const doc = Document.Open(buildXfaPdf({ template: POSITIONED_TEMPLATE }));
    const s = buildSigner();
    await doc.Sign({ certificate: s.certificate, privateKey: s.privateKey }, {});
    const signed = Document.Open(doc.Save());
    expect(() => convertXfaToAcroForm(signed)).toThrow(UnsupportedFeatureError);
  });
});

describe('convertXfaToAcroForm: positioned widgets', () => {
  const placed = () => {
    const doc = Document.Open(buildXfaPdf({
      template: POSITIONED_TEMPLATE,
      datasets: `<xfa:datasets><xfa:data><form1><Page1><f1_01>ENTERED</f1_01>
        </Page1></form1></xfa:data></xfa:datasets>`,
    }));
    const report = convertXfaToAcroForm(doc, { removeXfa: false });
    return { doc, report };
  };

  it('creates a widget with the rect the template states', () => {
    const { doc, report } = placed();
    expect(report.fields[0]).toEqual({
      name: 'form1[0].Page1[0].f1_01[0]', type: 'text', route: 'positioned', page: 1,
    });
    const d = doc.Form.Get('form1[0].Page1[0].f1_01[0]')!.Dict;
    expect(doc.resolve(d.get('Rect'))).toEqual([72, 628, 288, 648]);
    expect((doc.resolve(d.get('Subtype')) as { name: string }).name).toBe('Widget');
  });

  it('wires the widget into the page /Annots and generates an /AP', () => {
    const { doc } = placed();
    const annots = doc.resolve(doc.Pages[0].Dict.get('Annots')) as unknown[];
    expect(annots).toHaveLength(1);
    expect(doc.Form.Get('form1[0].Page1[0].f1_01[0]')!.Dict.has('AP')).toBe(true);
  });

  it('draws the datasets value, not the template default', () => {
    const doc = Document.Open(buildXfaPdf({
      template: POSITIONED_TEMPLATE.replace('<ui><textEdit/></ui>',
        '<ui><textEdit/></ui><value><text>AUTHORED</text></value>'),
      datasets: `<xfa:datasets><xfa:data><form1><Page1><f1_01>ENTERED</f1_01>
        </Page1></form1></xfa:data></xfa:datasets>`,
    }));
    convertXfaToAcroForm(doc, { removeXfa: false });
    const svg = doc.Pages[0].ToSvg();
    expect(svg).toContain('ENTERED');
    expect(svg).not.toContain('AUTHORED');
  });

  it('a rejected field costs itself and the rest still convert', () => {
    const doc = Document.Open(buildXfaPdf({ template: `<template><subform name="form1" layout="tb">
      <pageSet><pageArea name="P"><medium short="8.5in" long="11in"/></pageArea></pageSet>
      <subform name="Page1" layout="position">
        <field name="ok" x="1in" y="1in" w="1in" h="20pt"><ui><textEdit/></ui></field>
        <field name="bad" x="1px" y="1in" w="1in" h="20pt"><ui><textEdit/></ui></field>
      </subform></subform></template>` }));
    const report = convertXfaToAcroForm(doc, { removeXfa: false });
    expect(report.fields.find((f) => f.name.endsWith('ok[0]'))!.route).toBe('positioned');
    expect(report.fields.find((f) => f.name.endsWith('bad[0]'))!.route).toBe('bare');
    expect(report.skipped.some((s) => /measurement/i.test(s.reason))).toBe(true);
  });
});

describe('convertXfaToAcroForm: radio groups', () => {
  it('creates one radio field with one kid widget per option', () => {
    const doc = Document.Open(buildXfaPdf({ template: GROUP_TEMPLATE }));
    const report = convertXfaToAcroForm(doc, { removeXfa: false });
    expect(report.fields).toEqual([{
      name: 'form1[0].Page1[0].colour[0]', type: 'radio', route: 'positioned', page: 1,
    }]);
    const f = doc.Form.Get('form1[0].Page1[0].colour[0]')!;
    expect(f.Type).toBe('radio');
    expect(f.Options).toEqual(['Red', 'Green']);
    const annots = doc.resolve(doc.Pages[0].Dict.get('Annots')) as unknown[];
    expect(annots).toHaveLength(2);
  });

  it('selects the option the data names', () => {
    const doc = Document.Open(buildXfaPdf({
      template: GROUP_TEMPLATE,
      datasets: `<xfa:datasets><xfa:data><form1><Page1><colour>Green</colour>
        </Page1></form1></xfa:data></xfa:datasets>`,
    }));
    convertXfaToAcroForm(doc, { removeXfa: false });
    expect(doc.Form.Get('form1[0].Page1[0].colour[0]')!.Value).toBe('Green');
  });

  // addRadioGroup throws RangeError for a selection naming no option, and
  // losing the whole control over one stale datum is the worse answer.
  it('drops a selection the group does not offer, reports it, and keeps the group', () => {
    const doc = Document.Open(buildXfaPdf({
      template: GROUP_TEMPLATE,
      datasets: `<xfa:datasets><xfa:data><form1><Page1><colour>Purple</colour>
        </Page1></form1></xfa:data></xfa:datasets>`,
    }));
    const report = convertXfaToAcroForm(doc, { removeXfa: false });
    expect(report.fields[0].route).toBe('positioned');
    expect(doc.Form.Get('form1[0].Page1[0].colour[0]')!.Value).toBe('Off');
    expect(report.skipped.some((s) => /Purple/.test(s.reason))).toBe(true);
  });
});

describe('convertXfaToAcroForm: /XFA removal', () => {
  it('removes /XFA and /NeedsRendering by default and says so', () => {
    const doc = Document.Open(buildXfaPdf({
      template: POSITIONED_TEMPLATE, needsRendering: true,
    }));
    const report = convertXfaToAcroForm(doc);
    expect(report.xfaRemoved).toBe(true);
    const acro = doc.resolve(doc.catalog().get('AcroForm')) as Map<string, unknown>;
    expect(acro.has('XFA')).toBe(false);
    expect(doc.catalog().has('NeedsRendering')).toBe(false);
    // Save()'s mark-sweep is what actually drops the packet streams.
    expect(new TextDecoder().decode(doc.Save())).not.toContain('<template');
  });

  it('keeps both under removeXfa: false', () => {
    const doc = Document.Open(buildXfaPdf({
      template: POSITIONED_TEMPLATE, needsRendering: true,
    }));
    const report = convertXfaToAcroForm(doc, { removeXfa: false });
    expect(report.xfaRemoved).toBe(false);
    const acro = doc.resolve(doc.catalog().get('AcroForm')) as Map<string, unknown>;
    expect(acro.has('XFA')).toBe(true);
    expect(doc.catalog().has('NeedsRendering')).toBe(true);
  });

  // Removal is one-way and discards the only description of anything refused,
  // so a conversion that converted nothing must not throw the packet away.
  it('does not remove /XFA when nothing converted', () => {
    const doc = Document.Open(buildXfaPdf({ template: '<template/>' }));
    const report = convertXfaToAcroForm(doc);
    expect(report.xfaRemoved).toBe(false);
    const acro = doc.resolve(doc.catalog().get('AcroForm')) as Map<string, unknown>;
    expect(acro.has('XFA')).toBe(true);
  });
});

describe('convertXfaToAcroForm: /XFA survives a conversion that achieved nothing', () => {
  // The "nothing converted" case above returns EARLY, before the removal is
  // reached, so it cannot see the `created > 0` guard at all -- measured, the
  // mutation that removes /XFA unconditionally left it green. This template
  // yields a real entry whose SOM path descends THROUGH the existing terminal
  // field f1_01[0], so resolvePath refuses it and nothing is created.
  const COLLIDING = `<template><subform name="form1" layout="tb">
    <pageSet><pageArea name="P1"><medium short="8.5in" long="11in"/></pageArea></pageSet>
    <subform name="Page1" layout="position"><subform name="f1_01" layout="position">
      <field name="sub" x="1in" y="1in" w="1in" h="20pt"><ui><textEdit/></ui></field>
    </subform></subform></subform></template>`;

  it('keeps /XFA when every field it planned failed to apply', () => {
    const doc = Document.Open(buildXfaPdf({
      template: COLLIDING, acroFieldObjects: ['{HYBRID}'],
    }));
    const report = convertXfaToAcroForm(doc);
    expect(report.fields).toEqual([]);
    expect(report.skipped.some((s) => /conflicts/.test(s.reason))).toBe(true);
    expect(report.xfaRemoved).toBe(false);
    const acro = doc.resolve(doc.catalog().get('AcroForm')) as Map<string, unknown>;
    expect(acro.has('XFA')).toBe(true);
  });
});

describe('mutation fences', () => {
  const convert = (spec: Parameters<typeof buildXfaPdf>[0]) => {
    const doc = Document.Open(buildXfaPdf(spec));
    return { doc, report: doc.ConvertXfaToAcroForm({ removeXfa: false }) };
  };
  const rectOf = (doc: Document, n: string) =>
    doc.resolve(doc.Form.Get(n)!.Dict.get('Rect')) as number[];

  // 1. Y_FLIP_TEMPLATE places its field 0.5in from the page TOP on a page whose
  //    CropBox origin is (10, 20). Under a flipped sign it lands near the
  //    BOTTOM, which no centre-of-page fixture could show.
  it('places a top-of-page field near the top of the CropBox', () => {
    const { doc } = convert({
      template: Y_FLIP_TEMPLATE, mediaBox: [10, 20, 622, 812],
    });
    const [llx, lly, , ury] = rectOf(doc, 'form1[0].Page1[0].f[0]');
    expect(llx).toBeCloseTo(46, 6);   // cropLeft 10 + 0.5in
    expect(ury).toBeCloseTo(776, 6);  // cropTop 812 - 0.5in
    expect(lly).toBeCloseTo(758, 6);  // ury - 18pt
  });

  // 2. The default and the datum DIFFER, so /V and /DV cannot both be right.
  it('draws the entered value and keeps the authored one as /DV', () => {
    const { doc } = convert({
      template: DIFFERING_DEFAULT_TEMPLATE,
      datasets: `<xfa:datasets><xfa:data><form1><Page1><f>ENTERED</f>
        </Page1></form1></xfa:data></xfa:datasets>`,
    });
    expect(doc.Form.Get('form1[0].Page1[0].f[0]')!.Value).toBe('ENTERED');
    expect(doc.Pages[0].ToSvg()).not.toContain('AUTHORED');
  });

  // 3. Three levels, each with a non-zero offset: 0.25in + 1in + 10pt = 100pt.
  it('sums every level of the offset chain', () => {
    const { doc } = convert({ template: THREE_DEEP_TEMPLATE });
    expect(rectOf(doc, 'form1[0].Page1[0].A[0].B[0].f[0]')[0]).toBeCloseTo(100, 6);
  });

  // 4. The EXPORT half is what /V carries. Asserting only that /Opt exists is
  //    green under the swap.
  it('accepts the export half as a value and rejects the display half', () => {
    const { doc } = convert({ template: PAIRED_ITEMS_TEMPLATE });
    const f = doc.Form.Get('form1[0].Page1[0].c[0]')!;
    expect(() => { f.Value = 'US'; }).not.toThrow();
    expect(() => { f.Value = 'United States'; }).toThrow();
  });

  // 5. A4 declared on a US Letter page.
  it('degrades every field on a page whose medium disagrees', () => {
    const { report } = convert({ template: WRONG_MEDIUM_TEMPLATE });
    expect(report.fields).toHaveLength(1);
    expect(report.fields.every((f) => f.route === 'bare')).toBe(true);
  });

  // 6. A positioned subform INSIDE a flowed one: the immediate parent says
  //    position and the chain says no.
  it('degrades a positioned subform nested inside a flowed one', () => {
    const { report } = convert({ template: NESTED_FLOW_TEMPLATE });
    expect(report.fields).toHaveLength(1);
    expect(report.fields[0].route).toBe('bare');
  });

  // 7. Each flag on its own field, each bit asserted alone.
  it('carries readOnly and required through to /Ff', () => {
    const { doc } = convert({ template: FLAGS_TEMPLATE });
    const ff = (n: string) => doc.resolve(
      doc.Form.Get(`form1[0].Page1[0].${n}[0]`)!.Dict.get('Ff'),
    ) as number;
    expect(ff('ro') & 1).toBeTruthy();
    expect(ff('ro') & 2).toBeFalsy();
    expect(ff('req') & 2).toBeTruthy();
    expect(ff('req') & 1).toBeFalsy();
  });
});
