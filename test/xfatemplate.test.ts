import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/xml.js';
import { parseXfaTemplate, somName, type XfaField } from '../src/xfatemplate.js';

const tpl = (inner: string) => parseXfaTemplate(parseXml(
  new TextEncoder().encode(
    `<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">${inner}</template>`,
  ),
));
const by = (fs: XfaField[], n: string) => fs.find((f) => f.name === n)!;

describe('somName', () => {
  it('joins parts with dots', () => {
    expect(somName(['form1[0]', 'Page1[0]', 'f1[0]'])).toBe('form1[0].Page1[0].f1[0]');
  });
});

describe('parseXfaTemplate: naming', () => {
  // The synthesized name is the SOM expression, occurrence indices included --
  // exactly what LiveCycle writes into a hybrid's /AcroForm, so reconciling the
  // two halves is name equality rather than a heuristic.
  it('names a field by its SOM path with occurrence indices', () => {
    const t = tpl(`<subform name="form1"><subform name="Page1">
      <field name="f1_01"><ui><textEdit/></ui></field></subform></subform>`);
    expect(t.fields.map((f) => f.name)).toEqual(['form1[0].Page1[0].f1_01[0]']);
  });

  it('indexes same-named siblings from zero, independently per name', () => {
    const t = tpl(`<subform name="form1">
      <field name="a"><ui><textEdit/></ui></field>
      <field name="b"><ui><textEdit/></ui></field>
      <field name="a"><ui><textEdit/></ui></field></subform>`);
    expect(t.fields.map((f) => f.name)).toEqual([
      'form1[0].a[0]', 'form1[0].b[0]', 'form1[0].a[1]',
    ]);
  });

  // SOM defines an unnamed container as transparent to the path. Wrong, every
  // field under one gets an extra level and NO name matches the AcroForm half.
  it('makes an anonymous container transparent to the path', () => {
    const t = tpl(`<subform name="form1"><subform>
      <field name="f"><ui><textEdit/></ui></field></subform></subform>`);
    expect(t.fields.map((f) => f.name)).toEqual(['form1[0].f[0]']);
  });

  it('skips a field with no name rather than inventing one', () => {
    const t = tpl(`<subform name="form1"><field><ui><textEdit/></ui></field></subform>`);
    expect(t.fields).toEqual([]);
  });
});

describe('parseXfaTemplate: UI kinds', () => {
  it('maps every <ui> child this feature knows', () => {
    const t = tpl(`<subform name="f">
      <field name="a"><ui><textEdit/></ui></field>
      <field name="b"><ui><numericEdit/></ui></field>
      <field name="c"><ui><dateTimeEdit/></ui></field>
      <field name="d"><ui><passwordEdit/></ui></field>
      <field name="e"><ui><checkButton/></ui></field>
      <field name="g"><ui><choiceList/></ui></field>
      <field name="h"><ui><button/></ui></field>
      <field name="i"><ui><signature/></ui></field>
      <field name="j"><ui><imageEdit/></ui></field>
      <field name="k"><ui><barcode/></ui></field>
      <field name="l"><ui><somethingElse/></ui></field>
      <field name="m"/></subform>`);
    const kinds = Object.fromEntries(t.fields.map((f) => [f.name.split('.')[1], f.ui]));
    expect(kinds).toEqual({
      'a[0]': 'text', 'b[0]': 'numeric', 'c[0]': 'dateTime', 'd[0]': 'password',
      'e[0]': 'checkButton', 'g[0]': 'choiceList', 'h[0]': 'button',
      'i[0]': 'signature', 'j[0]': 'imageEdit', 'k[0]': 'barcode',
      'l[0]': 'unknown', 'm[0]': 'unknown',
    });
  });

  it('carries choiceList open= through untouched for the caller to map', () => {
    const t = tpl(`<subform name="f">
      <field name="a"><ui><choiceList open="userControl"/></ui></field>
      <field name="b"><ui><choiceList open="multiSelect"/></ui></field>
      <field name="c"><ui><choiceList/></ui></field></subform>`);
    expect(by(t.fields, 'f[0].a[0]').open).toBe('userControl');
    expect(by(t.fields, 'f[0].b[0]').open).toBe('multiSelect');
    expect(by(t.fields, 'f[0].c[0]').open).toBeUndefined();
  });
});

describe('parseXfaTemplate: flags, defaults and tooltips', () => {
  it('reads readOnly from both access spellings and nowhere else', () => {
    const t = tpl(`<subform name="f">
      <field name="a" access="readOnly"><ui><textEdit/></ui></field>
      <field name="b" access="protected"><ui><textEdit/></ui></field>
      <field name="c" access="open"><ui><textEdit/></ui></field>
      <field name="d"><ui><textEdit/></ui></field></subform>`);
    expect(t.fields.map((f) => f.readOnly)).toEqual([true, true, false, false]);
  });

  it('reads required from <validate nullTest="error"> only', () => {
    const t = tpl(`<subform name="f">
      <field name="a"><ui><textEdit/></ui><validate nullTest="error"/></field>
      <field name="b"><ui><textEdit/></ui><validate nullTest="warning"/></field>
      <field name="c"><ui><textEdit/></ui><validate/></field>
      <field name="d"><ui><textEdit/></ui></field></subform>`);
    expect(t.fields.map((f) => f.required)).toEqual([true, false, false, false]);
  });

  it('reads multiLine and maxChars off the text sub-elements', () => {
    const t = tpl(`<subform name="f">
      <field name="a"><ui><textEdit multiLine="1"/></ui>
        <value><text maxChars="40">seed</text></value>
        <assist><toolTip>Your name</toolTip></assist></field>
      <field name="b"><ui><textEdit/></ui></field></subform>`);
    const a = by(t.fields, 'f[0].a[0]');
    expect(a.multiLine).toBe(true);
    expect(a.maxChars).toBe(40);
    expect(a.tooltip).toBe('Your name');
    // The template <value> is the DEFAULT (-> /DV), never the value (-> /V).
    expect(a.defaultValue).toBe('seed');
    const b = by(t.fields, 'f[0].b[0]');
    expect(b.multiLine).toBe(false);
    expect(b.maxChars).toBeUndefined();
    expect(b.tooltip).toBeUndefined();
    expect(b.defaultValue).toBeUndefined();
  });

  it('ignores a maxChars that is not a positive integer', () => {
    const t = tpl(`<subform name="f"><field name="a"><ui><textEdit/></ui>
      <value><text maxChars="-1"/></value></field></subform>`);
    expect(by(t.fields, 'f[0].a[0]').maxChars).toBeUndefined();
  });

  it('carries an explicit <bind> ref and match', () => {
    const t = tpl(`<subform name="f"><field name="a"><ui><textEdit/></ui>
      <bind ref="$record.other" match="dataRef"/></field>
      <field name="b"><ui><textEdit/></ui></field></subform>`);
    const a = by(t.fields, 'f[0].a[0]');
    expect(a.bindRef).toBe('$record.other');
    expect(a.bindMatch).toBe('dataRef');
    expect(by(t.fields, 'f[0].b[0]').bindRef).toBeUndefined();
  });
});

describe('parseXfaTemplate: <items>', () => {
  // XFA spells the export/display pair as two parallel <items> lists, the one
  // carrying save="1" being the EXPORT side. Swap them and a list box
  // highlights nothing and a combo draws the export value -- the defect
  // choiceopt.ts exists to prevent.
  // Note the DISPLAY list is written FIRST here, and that is the whole point:
  // with save="1" on lists[0] the fixture cannot discriminate, because
  // "the save list" and "the first list" are then the same list and the
  // mutation reddens nothing. Measured -- this case had exactly that shape
  // first and passed with the halves hard-coded by position.
  it('pairs the save="1" list as export with the other as display', () => {
    const t = tpl(`<subform name="f"><field name="a"><ui><choiceList/></ui>
      <items><text>United States</text><text>Canada</text></items>
      <items save="1"><text>US</text><text>CA</text></items>
      </field></subform>`);
    expect(by(t.fields, 'f[0].a[0]').items).toEqual([
      { export: 'US', display: 'United States' },
      { export: 'CA', display: 'Canada' },
    ]);
  });

  it('takes a single <items> list as both halves', () => {
    const t = tpl(`<subform name="f"><field name="a"><ui><choiceList/></ui>
      <items><text>S</text><text>M</text></items></field></subform>`);
    expect(by(t.fields, 'f[0].a[0]').items).toEqual([{ export: 'S' }, { export: 'M' }]);
  });

  it('pairs only as far as the shorter list and keeps the rest export-only', () => {
    const t = tpl(`<subform name="f"><field name="a"><ui><choiceList/></ui>
      <items save="1"><text>a</text><text>b</text></items>
      <items><text>Alpha</text></items></field></subform>`);
    expect(by(t.fields, 'f[0].a[0]').items)
      .toEqual([{ export: 'a', display: 'Alpha' }, { export: 'b' }]);
  });

  it('reads a checkbox on-state from its items and defaults it to 1', () => {
    const t = tpl(`<subform name="f">
      <field name="a"><ui><checkButton/></ui>
        <items><text>Y</text><text>N</text></items></field>
      <field name="b"><ui><checkButton/></ui></field></subform>`);
    expect(by(t.fields, 'f[0].a[0]').onState).toBe('Y');
    expect(by(t.fields, 'f[0].b[0]').onState).toBe('1');
  });
});

describe('parseXfaTemplate: exclGroup', () => {
  it('records each member field and names the group on every one', () => {
    const t = tpl(`<subform name="f"><exclGroup name="colour">
      <field name="red"><ui><checkButton/></ui><items><text>R</text></items></field>
      <field name="green"><ui><checkButton/></ui><items><text>G</text></items></field>
      </exclGroup></subform>`);
    expect(t.fields.map((f) => f.name))
      .toEqual(['f[0].colour[0].red[0]', 'f[0].colour[0].green[0]']);
    expect(t.fields.every((f) => f.group === 'f[0].colour[0]')).toBe(true);
    expect(t.fields.map((f) => f.onState)).toEqual(['R', 'G']);
  });
});

describe('parseXfaTemplate: pageAreas', () => {
  it('lists pageAreas in document order with their media', () => {
    const t = tpl(`<subform name="f"><pageSet>
      <pageArea name="P1"><medium short="8.5in" long="11in"/></pageArea>
      <pageArea name="P2"><medium short="8.5in" long="11in" orientation="landscape"/></pageArea>
      </pageSet></subform>`);
    expect(t.pages).toEqual([
      { name: 'P1', medium: { short: '8.5in', long: '11in' } },
      { name: 'P2', medium: { short: '8.5in', long: '11in', orientation: 'landscape' } },
    ]);
  });

  it('records a pageArea with no medium rather than dropping it', () => {
    const t = tpl(`<subform name="f"><pageSet><pageArea/></pageSet></subform>`);
    expect(t.pages).toHaveLength(1);
    expect(t.pages[0].medium).toBeUndefined();
  });
});

describe('parseXfaTemplate: geometry', () => {
  it('carries the field own geometry attributes verbatim', () => {
    const t = tpl(`<subform name="f" layout="position">
      <field name="a" x="1in" y="2in" w="3in" h="0.25in"
             anchorType="middleCenter" rotate="90"><ui><textEdit/></ui></field>
      </subform>`);
    expect(by(t.fields, 'f[0].a[0]').geom).toEqual({
      x: '1in', y: '2in', w: '3in', h: '0.25in',
      anchorType: 'middleCenter', rotate: '90',
    });
  });

  it('omits an absent attribute rather than storing an empty string', () => {
    const t = tpl(`<subform name="f" layout="position">
      <field name="a" x="1in"><ui><textEdit/></ui></field></subform>`);
    expect(by(t.fields, 'f[0].a[0]').geom).toEqual({ x: '1in' });
  });
});

describe('parseXfaTemplate: the layout chain', () => {
  // Interpretation 2. The chain starts BELOW the subform carrying the
  // <pageSet>: that container's layout breaks pages, it does not place fields.
  // Read from the document root instead and every LiveCycle form -- whose root
  // is routinely layout="tb" -- degrades entirely.
  it('excludes the pageSet-carrying subform from the chain', () => {
    const t = tpl(`<subform name="form1" layout="tb">
      <pageSet><pageArea name="P1"><medium short="8.5in" long="11in"/></pageArea></pageSet>
      <subform name="Page1" layout="position" x="0in" y="0in">
        <field name="a" x="1in" y="1in" w="1in" h="1in"><ui><textEdit/></ui></field>
      </subform></subform>`);
    const a = by(t.fields, 'form1[0].Page1[0].a[0]');
    expect(a.layouts).toEqual(['position']);
    expect(a.offsets).toEqual([{ x: '0in', y: '0in' }]);
  });

  it('records every container below the page origin, outermost first', () => {
    const t = tpl(`<subform name="form1" layout="tb">
      <pageSet><pageArea/></pageSet>
      <subform name="P" layout="position" x="1in" y="2in">
        <subform name="Q" layout="position" x="3pt">
          <field name="a" w="1in" h="1in" x="0" y="0"><ui><textEdit/></ui></field>
        </subform></subform></subform>`);
    const a = by(t.fields, 'form1[0].P[0].Q[0].a[0]');
    expect(a.layouts).toEqual(['position', 'position']);
    expect(a.offsets).toEqual([{ x: '1in', y: '2in' }, { x: '3pt' }]);
  });

  it('defaults a stated-nothing subform layout to position', () => {
    const t = tpl(`<subform name="form1" layout="tb"><pageSet><pageArea/></pageSet>
      <subform name="P"><field name="a" x="0" y="0" w="1in" h="1in">
      <ui><textEdit/></ui></field></subform></subform>`);
    expect(by(t.fields, 'form1[0].P[0].a[0]').layouts).toEqual(['position']);
  });

  it('records a flow layout so the caller degrades the field', () => {
    const t = tpl(`<subform name="form1" layout="tb"><pageSet><pageArea/></pageSet>
      <subform name="P" layout="position"><subform name="Q" layout="tb">
        <field name="a" x="0" y="0" w="1in" h="1in"><ui><textEdit/></ui></field>
      </subform></subform></subform>`);
    expect(by(t.fields, 'form1[0].P[0].Q[0].a[0]').layouts)
      .toEqual(['position', 'tb']);
  });

  // Interpretation 3: the occurrence COUNT is knowable from <occur initial>,
  // but the repeat DIRECTION is not, so a repeating subform is flow-laid.
  it('marks a repeating subform with the synthetic occur layout', () => {
    const t = tpl(`<subform name="form1" layout="tb"><pageSet><pageArea/></pageSet>
      <subform name="P" layout="position"><occur max="5"/>
        <field name="a" x="0" y="0" w="1in" h="1in"><ui><textEdit/></ui></field>
      </subform></subform>`);
    expect(by(t.fields, 'form1[0].P[0].a[0]').layouts).toEqual(['occur']);
  });

  it('leaves occur max="1" alone', () => {
    const t = tpl(`<subform name="form1" layout="tb"><pageSet><pageArea/></pageSet>
      <subform name="P" layout="position"><occur max="1" min="1"/>
        <field name="a" x="0" y="0" w="1in" h="1in"><ui><textEdit/></ui></field>
      </subform></subform>`);
    expect(by(t.fields, 'form1[0].P[0].a[0]').layouts).toEqual(['position']);
  });

  // A <contentArea> shifts the page origin, so its own x/y joins the chain.
  it('adds a contentArea origin when the chain passes through one', () => {
    const t = tpl(`<subform name="form1" layout="tb">
      <pageSet><pageArea name="P1">
        <contentArea x="0.25in" y="0.5in" w="8in" h="10in"/>
        <medium short="8.5in" long="11in"/></pageArea></pageSet>
      <subform name="Page1" layout="position">
        <field name="a" x="1in" y="1in" w="1in" h="1in"><ui><textEdit/></ui></field>
      </subform></subform>`);
    const a = by(t.fields, 'form1[0].Page1[0].a[0]');
    expect(a.offsets[0]).toEqual({ x: '0.25in', y: '0.5in' });
    expect(a.layouts[0]).toBe('position');
  });
});

describe('parseXfaTemplate: page identity', () => {
  it('maps each page subform to its pageArea by order', () => {
    const t = tpl(`<subform name="form1" layout="tb">
      <pageSet><pageArea name="P1"/><pageArea name="P2"/></pageSet>
      <subform name="Page1" layout="position">
        <field name="a" x="0" y="0" w="1in" h="1in"><ui><textEdit/></ui></field></subform>
      <subform name="Page2" layout="position">
        <field name="b" x="0" y="0" w="1in" h="1in"><ui><textEdit/></ui></field></subform>
      </subform>`);
    expect(by(t.fields, 'form1[0].Page1[0].a[0]').pageIndex).toBe(0);
    expect(by(t.fields, 'form1[0].Page2[0].b[0]').pageIndex).toBe(1);
  });

  it('honours an explicit break to a named pageArea', () => {
    const t = tpl(`<subform name="form1" layout="tb">
      <pageSet><pageArea name="P1"/><pageArea name="P2"/></pageSet>
      <subform name="S1" layout="position"><breakBefore target="P2"/>
        <field name="a" x="0" y="0" w="1in" h="1in"><ui><textEdit/></ui></field></subform>
      </subform>`);
    expect(by(t.fields, 'form1[0].S1[0].a[0]').pageIndex).toBe(1);
  });

  it('leaves pageIndex undefined when the break names a pageArea that is not there', () => {
    const t = tpl(`<subform name="form1" layout="tb">
      <pageSet><pageArea name="P1"/></pageSet>
      <subform name="S1" layout="position"><breakBefore target="Nowhere"/>
        <field name="a" x="0" y="0" w="1in" h="1in"><ui><textEdit/></ui></field></subform>
      </subform>`);
    expect(by(t.fields, 'form1[0].S1[0].a[0]').pageIndex).toBeUndefined();
  });

  it('leaves pageIndex undefined when the template declares no pageArea at all', () => {
    const t = tpl(`<subform name="form1"><subform name="P" layout="position">
      <field name="a" x="0" y="0" w="1in" h="1in"><ui><textEdit/></ui></field>
      </subform></subform>`);
    expect(by(t.fields, 'form1[0].P[0].a[0]').pageIndex).toBeUndefined();
    expect(t.pages).toEqual([]);
  });
});

describe('parseXfaTemplate: the margin insets', () => {
  it('carries the four insets through verbatim', () => {
    const t = tpl(`<subform name="f"><field name="a"><ui><textEdit/></ui>
      <margin leftInset="1pt" rightInset="1.4111mm" topInset="0.1764mm"
              bottomInset="0.1764mm"/></field></subform>`);
    expect(by(t.fields, 'f[0].a[0]').margin).toEqual({
      leftInset: '1pt', rightInset: '1.4111mm',
      topInset: '0.1764mm', bottomInset: '0.1764mm',
    });
  });

  it('omits an absent margin and an absent inset', () => {
    const t = tpl(`<subform name="f">
      <field name="a"><ui><textEdit/></ui></field>
      <field name="b"><ui><textEdit/></ui><margin topInset="2pt"/></field></subform>`);
    expect(by(t.fields, 'f[0].a[0]').margin).toBeUndefined();
    expect(by(t.fields, 'f[0].b[0]').margin).toEqual({ topInset: '2pt' });
  });

  // A real LiveCycle field carries a SECOND <margin> inside <ui><textEdit>, and
  // f1040's f1_03 carries both -- the nested one empty and the field's own
  // stating the insets Adobe honoured. Reading the nested one, or the first
  // <margin> anywhere in the subtree, silently drops every inset in the form.
  it('reads the field own margin, never one nested in the ui', () => {
    const t = tpl(`<subform name="f"><field name="a">
      <ui><textEdit><margin leftInset="99pt"/><border presence="hidden"/></textEdit></ui>
      <margin rightInset="4pt"/></field></subform>`);
    expect(by(t.fields, 'f[0].a[0]').margin).toEqual({ rightInset: '4pt' });
  });
});

describe('parseXfaTemplate: the checkButton size and the para alignment', () => {
  it('carries the checkButton size through verbatim', () => {
    const t = tpl(`<subform name="f"><field name="a">
      <ui><checkButton size="2.8222mm" mark="check"/></ui></field></subform>`);
    expect(by(t.fields, 'f[0].a[0]').buttonSize).toBe('2.8222mm');
  });

  // The size belongs to the checkButton and to no other ui. The attribute has
  // to be PRESENT on the other element for this to measure anything: with a
  // bare <textEdit/> the read returns undefined whether or not the kind is
  // checked, and the guard is then held only by the convert-side kind test --
  // measured, that version of this case left the mutation green.
  it('omits it for a field that is not a checkButton', () => {
    const t = tpl(`<subform name="f"><field name="a">
      <ui><textEdit size="8pt"/></ui></field></subform>`);
    expect(by(t.fields, 'f[0].a[0]').buttonSize).toBeUndefined();
  });

  // The FIELD's own <para>, never the one nested in <caption> -- f1040's c1_1
  // carries both, and they are free to disagree.
  it('reads the field own para, never the caption one', () => {
    const t = tpl(`<subform name="f"><field name="a"><ui><checkButton size="8pt"/></ui>
      <caption reserve="10pt"><para vAlign="top" hAlign="center"/></caption>
      <para vAlign="middle"/></field></subform>`);
    expect(by(t.fields, 'f[0].a[0]').para).toEqual({ vAlign: 'middle' });
  });

  it('omits an absent para and an absent alignment', () => {
    const t = tpl(`<subform name="f">
      <field name="a"><ui><checkButton size="8pt"/></ui></field>
      <field name="b"><ui><checkButton size="8pt"/></ui>
        <para hAlign="right"/></field></subform>`);
    expect(by(t.fields, 'f[0].a[0]').para).toBeUndefined();
    expect(by(t.fields, 'f[0].b[0]').para).toEqual({ hAlign: 'right' });
  });
});
