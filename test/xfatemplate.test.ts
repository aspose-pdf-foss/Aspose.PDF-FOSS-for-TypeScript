import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/xml.js';
import { parseXfaTemplate, somName, type XfaField } from '../src/xfatemplate.js';
import { parseXfaDataGroups } from '../src/xfadata.js';
import type { LayoutNode } from '../src/xfaflow.js';

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
  // fdq3: an unnamed container is IN the SOM name, spelled by class, and
  // transparent to the data path. Measured against USCIS I-130 and I-765.
  it('names an unnamed container by class and leaves it out of the data path', () => {
    const t = tpl(`<subform name="form1"><subform>
      <field name="f"><ui><textEdit/></ui></field></subform></subform>`);
    expect(t.fields.map((f) => [f.name, f.dataPath]))
      .toEqual([['form1[0].#subform[0].f[0]', 'form1[0].f[0]']]);
  });

  it('counts a class index over named elements of that type too', () => {
    const t = tpl(`<subform name="form1"><area name="a"/><area>
      <field name="f"><ui><textEdit/></ui></field></area></subform>`);
    expect(t.fields[0].name).toBe('form1[0].#area[1].f[0]');
  });

  it('shares one numbering across unnamed containers under a named one', () => {
    const t = tpl(`<subform name="form1">
      <subform><field name="f"><ui><textEdit/></ui></field></subform>
      <subform><area><field name="f"><ui><textEdit/></ui></field></area><area/></subform>
      <subform><area/></subform></subform>`);
    expect(t.fields.map((f) => [f.name, f.dataPath])).toEqual([
      ['form1[0].#subform[0].f[0]', 'form1[0].f[0]'],
      ['form1[0].#subform[1].#area[0].f[1]', 'form1[0].f[1]'],
    ]);
  });

  it('counts a nested unnamed area in the same numbering as its siblings', () => {
    const t = tpl(`<subform name="form1"><area><area/></area><area>
      <field name="f"><ui><textEdit/></ui></field></area></subform>`);
    expect(t.fields[0].name).toBe('form1[0].#area[2].f[0]');
  });

  it('opens a fresh numbering at every NAMED container', () => {
    const t = tpl(`<subform name="form1">
      <subform name="A"><area/><field name="f"><ui><textEdit/></ui></field></subform>
      <subform name="B"><area><field name="f"><ui><textEdit/></ui></field></area></subform>
    </subform>`);
    expect(t.fields.map((f) => f.name))
      .toEqual(['form1[0].A[0].f[0]', 'form1[0].B[0].#area[0].f[0]']);
  });

  it('binds a radio group under an unnamed container by its data path', () => {
    const t = tpl(`<subform name="form1"><subform><exclGroup name="g">
      <field name="r"><ui><checkButton/></ui></field></exclGroup></subform></subform>`);
    expect([t.fields[0].group, t.fields[0].groupDataPath])
      .toEqual(['form1[0].#subform[0].g[0]', 'form1[0].g[0]']);
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
  const PAGE = `<subform name="form1" layout="tb"><pageSet><pageArea/></pageSet>`;
  const leafOf = (t: ReturnType<typeof tpl>) => t.roots[0].node.children[0].children[0];

  it('carries the field own geometry attributes verbatim on its layout node', () => {
    const t = tpl(`${PAGE}<subform name="f" layout="position">
      <field name="a" x="1in" y="2in" w="3in" h="0.25in"
             anchorType="middleCenter" rotate="90"><ui><textEdit/></ui></field>
      </subform></subform>`);
    expect(leafOf(t).geom).toEqual({
      x: '1in', y: '2in', w: '3in', h: '0.25in',
      anchorType: 'middleCenter', rotate: '90',
    });
  });

  it('omits an absent attribute rather than storing an empty string', () => {
    const t = tpl(`${PAGE}<subform name="f" layout="position">
      <field name="a" x="1in"><ui><textEdit/></ui></field></subform></subform>`);
    expect(leafOf(t).geom).toEqual({ x: '1in' });
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
    expect(t.roots[0].node.children[0].geom).toEqual({ x: '0in', y: '0in' });
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
    const P = t.roots[0].node.children[0];
    expect(P.geom).toEqual({ x: '1in', y: '2in' });
    expect(P.children[0].geom).toEqual({ x: '3pt' });
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

  // 164g.2: there is no synthetic occur layout any more. P is a PAGE subform,
  // so its repetition is refused for 164g.3, and its chain carries its real layout.
  it('carries a repeating page subform\'s REAL layout in the chain', () => {
    const t = tpl(`<subform name="form1" layout="tb"><pageSet><pageArea/></pageSet>
      <subform name="P" layout="position"><occur max="5"/>
        <field name="a" x="0" y="0" w="1in" h="1in"><ui><textEdit/></ui></field>
      </subform></subform>`);
    expect(by(t.fields, 'form1[0].P[0].a[0]').layouts).toEqual(['position']);
  });

  it('leaves occur max="1" alone', () => {
    const t = tpl(`<subform name="form1" layout="tb"><pageSet><pageArea/></pageSet>
      <subform name="P" layout="position"><occur max="1" min="1"/>
        <field name="a" x="0" y="0" w="1in" h="1in"><ui><textEdit/></ui></field>
      </subform></subform>`);
    expect(by(t.fields, 'form1[0].P[0].a[0]').layouts).toEqual(['position']);
  });

  // A <contentArea> shifts the page origin, so its own x/y joins the chain.
  it('roots the chain at the contentArea and records it as position', () => {
    const t = tpl(`<subform name="form1" layout="tb">
      <pageSet><pageArea name="P1">
        <contentArea x="0.25in" y="0.5in" w="8in" h="10in"/>
        <medium short="8.5in" long="11in"/></pageArea></pageSet>
      <subform name="Page1" layout="position">
        <field name="a" x="1in" y="1in" w="1in" h="1in"><ui><textEdit/></ui></field>
      </subform></subform>`);
    const a = by(t.fields, 'form1[0].Page1[0].a[0]');
    expect(t.roots[0].node.geom).toMatchObject({ x: '0.25in', y: '0.5in' });
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

describe('parseXfaTemplate: the layout tree', () => {
  const PAGE = `<subform name="form1" layout="tb">
    <pageSet><pageArea name="P1">
      <contentArea x="0.25in" y="0.5in" w="8in" h="10in"/>
      <medium short="8.5in" long="11in"/></pageArea></pageSet>`;

  it('roots each resolved page at its contentArea, with the page subform as its child', () => {
    const t = tpl(`${PAGE}<subform name="Page1" layout="position" x="1pt">
      <field name="a" x="0" y="0" w="1in" h="1in"><ui><textEdit/></ui></field>
      </subform></subform>`);
    expect(t.roots).toHaveLength(1);
    const r = t.roots[0];
    expect(r.pageIndex).toBe(0);
    expect(r.node).toMatchObject({
      kind: 'page', label: 'contentArea', layout: 'position',
      geom: { x: '0.25in', y: '0.5in', w: '8in', h: '10in' },
    });
    expect(r.node.children).toHaveLength(1);
    expect(r.node.children[0]).toMatchObject({
      kind: 'subform', label: 'Page1[0]', layout: 'position', geom: { x: '1pt' },
    });
    expect(r.node.children[0].children[0]).toMatchObject({
      kind: 'field', label: 'a[0]', field: 'form1[0].Page1[0].a[0]',
      geom: { x: '0', y: '0', w: '1in', h: '1in' },
    });
  });

  // Draws take up space in a flow, so they are in the tree, in document order.
  // Review Focus 2: an unnamed field is there too, with no SOM name.
  it('keeps draws and unnamed fields in document order', () => {
    const t = tpl(`${PAGE}<subform name="Page1" layout="tb">
      <draw name="d" h="5pt" w="1in"/>
      <field h="10pt" w="1in"><ui><textEdit/></ui></field>
      <field name="b" h="10pt" w="1in"><ui><textEdit/></ui></field>
      </subform></subform>`);
    const kids = t.roots[0].node.children[0].children;
    expect(kids.map((k) => [k.kind, k.label, k.field])).toEqual([
      ['draw', 'd', undefined],
      ['field', '<field>', undefined],
      ['field', 'b[0]', 'form1[0].Page1[0].b[0]'],
    ]);
  });

  it('carries the layout attributes a container states', () => {
    const t = tpl(`${PAGE}<subform name="Page1" layout="position">
      <subform name="T" layout="table" columnWidths="1in -1" minH="2in" maxW="3in"
               presence="invisible" hAlign="left">
        <margin leftInset="1pt" topInset="2pt"/>
        <subform name="R" layout="row">
          <field name="c" colSpan="2" h="10pt"><ui><textEdit/></ui>
            <margin leftInset="9pt"/></field>
        </subform></subform></subform></subform>`);
    const T = t.roots[0].node.children[0].children[0];
    expect(T).toMatchObject({
      kind: 'subform', layout: 'table', columnWidths: '1in -1',
      minMax: { minH: '2in', maxW: '3in' }, presence: 'invisible', hAlign: 'left',
      margin: { leftInset: '1pt', topInset: '2pt' },
    });
    const c = T.children[0].children[0];
    expect(c).toMatchObject({ kind: 'field', colSpan: '2' });
    // A FIELD's margin is its edit-region inset, applied by xfageom, not a
    // container inset: it stays off the layout node.
    expect(c.margin).toBeUndefined();
  });

  it('gives a repeating subform its real layout, and an exclGroup its own kind', () => {
    const t = tpl(`${PAGE}<subform name="Page1" layout="position">
      <subform name="R"><occur max="3"/></subform>
      <exclGroup name="G"><field name="o" w="1pt" h="1pt"><ui><checkButton/></ui></field></exclGroup>
      </subform></subform>`);
    const kids = t.roots[0].node.children[0].children;
    expect(kids[0]).toMatchObject({ kind: 'subform', layout: 'position' });
    expect(kids[0].refusal).toBeUndefined();
    expect(kids[1]).toMatchObject({ kind: 'exclGroup', layout: 'position' });
    expect(kids[1].children[0].field).toBe('form1[0].Page1[0].G[0].o[0]');
  });

  it('roots no page whose pageArea cannot be resolved', () => {
    const t = tpl(`<subform name="form1" layout="tb"><pageSet><pageArea name="P1"/></pageSet>
      <subform name="Page1"><breakBefore target="Nowhere"/></subform></subform>`);
    expect(t.roots).toEqual([]);
  });

  it('gives a pageArea with no contentArea an empty root geometry', () => {
    const t = tpl(`<subform name="form1" layout="tb"><pageSet><pageArea name="P1"/></pageSet>
      <subform name="Page1"/></subform>`);
    expect(t.roots[0].node.geom).toEqual({});
  });
});

// d3mq (part 1): fields on a MASTER page. They are named as LiveCycle writes
// them and kept OUT of `fields`, so nothing that lays out or binds fields sees
// them. Only the first instance is modelled; one per page waits on 164g.3.
describe('parseXfaTemplate: master-page fields', () => {
  const MASTER = `<subform name="form1">
    <pageSet><pageArea name="P1"><contentArea w="8in" h="10in"/>
      <field name="code"><ui><barcode type="pdf417"/></ui></field>
      <subform name="hdr"><field name="who"><ui><textEdit/></ui></field></subform>
    </pageArea><pageArea name="P2"><field name="code"><ui><textEdit/></ui></field></pageArea></pageSet>
    <subform name="P1"><field name="body"><ui><textEdit/></ui></field></subform></subform>`;

  it('names them as LiveCycle does, in a scope of the pageSet\'s own', () => {
    // I-765 has a body subform AND a pageArea both named Page1, and Adobe writes
    // the pageArea's first instance `#pageSet[0].Page1[0]`: the pageSet does not
    // share its parent's numbering the way an unnamed subform does.
    expect(tpl(MASTER).masterPageFields.map((f) => f.name)).toEqual([
      'form1[0].#pageSet[0].P1[0].code[0]',
      'form1[0].#pageSet[0].P1[0].hdr[0].who[0]',
      'form1[0].#pageSet[0].P2[0].code[0]',
    ]);
  });

  it('keeps them out of fields, so layout and binding never see them', () => {
    const t = tpl(MASTER);
    expect(t.fields.map((f) => f.name)).toEqual(['form1[0].P1[0].body[0]']);
    expect(t.pages).toHaveLength(2);
  });

  it('counts the pageSet in its parent\'s class numbering', () => {
    const t = tpl(`<subform name="form1"><pageSet/><pageSet><pageArea name="A">
      <field name="f"><ui><textEdit/></ui></field></pageArea></pageSet></subform>`);
    expect(t.masterPageFields.map((f) => f.name)).toEqual(['form1[0].#pageSet[1].A[0].f[0]']);
  });
});

const tplWith = (inner: string, data?: string) => parseXfaTemplate(
  parseXml(new TextEncoder().encode(
    `<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">${inner}</template>`,
  )),
  data === undefined ? undefined : parseXfaDataGroups(parseXml(new TextEncoder().encode(
    `<datasets><data>${data}</data></datasets>`,
  ))),
);
const names = (t: ReturnType<typeof tplWith>) => t.fields.map((f) => f.name);

// 164g.2: XFA 3.3 p. 263, 339-345. A repeating subform is walked once per
// instance; a shape the rule cannot answer is walked ONCE and refused.
describe('parseXfaTemplate: <occur> instantiation', () => {
  const T = (occur: string, extra = '') => `<subform name="form1"><subform name="S" layout="tb">
    <subform name="R" layout="tb">${occur}${extra}<field name="a"><ui><textEdit/></ui></field></subform>
    </subform></subform>`;

  it('makes initial instances in an EMPTY merge (no groups argument)', () => {
    expect(names(tplWith(T('<occur initial="3" max="-1"/>')))).toEqual([
      'form1[0].S[0].R[0].a[0]', 'form1[0].S[0].R[1].a[0]', 'form1[0].S[0].R[2].a[0]',
    ]);
  });

  it('defaults initial to min, and min to 1', () => {
    expect(names(tplWith(T('<occur min="2" max="-1"/>')))).toHaveLength(2);
    expect(names(tplWith(T('<occur max="-1"/>')))).toHaveLength(1);
  });

  it('treats an empty <xfa:data> as an empty merge', () => {
    expect(names(tplWith(T('<occur initial="2" max="-1"/>'), ''))).toHaveLength(2);
  });

  it('makes one instance per same-named data group, binding each to its own', () => {
    const t = tplWith(T('<occur max="-1"/>'), '<form1><S><R><a>x</a></R><R/><R><a>z</a></R></S></form1>');
    expect(t.fields.map((f) => [f.name, f.dataPath])).toEqual([
      ['form1[0].S[0].R[0].a[0]', 'form1[0].S[0].R[0].a[0]'],
      ['form1[0].S[0].R[1].a[0]', 'form1[0].S[0].R[1].a[0]'],
      ['form1[0].S[0].R[2].a[0]', 'form1[0].S[0].R[2].a[0]'],
    ]);
  });

  it('raises the count to min and caps it at max', () => {
    expect(names(tplWith(T('<occur min="2" max="-1"/>'), '<form1><S/></form1>'))).toHaveLength(2);
    expect(names(tplWith(T('<occur max="2"/>'), '<form1><S><R/><R/><R/><R/></S></form1>'))).toHaveLength(2);
    expect(names(tplWith(T('<occur max="-1"/>'), '<form1><S><R/><R/><R/><R/></S></form1>'))).toHaveLength(4);
  });

  it('makes nothing for min="0" with no data, and consumes no index', () => {
    const t = tplWith(`<subform name="form1"><subform layout="tb"><occur min="0" max="-1"/>
      <field name="gone"><ui><textEdit/></ui></field></subform>
      <subform layout="tb"><field name="kept"><ui><textEdit/></ui></field></subform></subform>`);
    expect(names(t)).toEqual(['form1[0].#subform[0].kept[0]']);
  });

  it('gives a later same-named sibling the next index after the instances', () => {
    const t = tplWith(`<subform name="form1"><subform name="S" layout="tb">
      <subform name="R" layout="tb"><occur initial="3" max="-1"/><field name="a"><ui><textEdit/></ui></field></subform>
      <subform name="R" layout="tb"><field name="b"><ui><textEdit/></ui></field></subform>
      </subform></subform>`);
    expect(names(t).at(-1)).toBe('form1[0].S[0].R[3].b[0]');
  });

  it('counts a nested repeating subform under its own parent instance', () => {
    const t = tplWith(`<subform name="form1"><subform name="S" layout="tb">
      <subform name="R" layout="tb"><occur max="-1"/>
        <subform name="Q" layout="tb"><occur max="-1"/><field name="a"><ui><textEdit/></ui></field></subform>
      </subform></subform></subform>`,
    '<form1><S><R><Q/></R><R><Q/><Q/><Q/></R></S></form1>');
    expect(names(t)).toEqual([
      'form1[0].S[0].R[0].Q[0].a[0]',
      'form1[0].S[0].R[1].Q[0].a[0]', 'form1[0].S[0].R[1].Q[1].a[0]', 'form1[0].S[0].R[1].Q[2].a[0]',
    ]);
  });

  it('gives each instance its own layout node with its REAL layout', () => {
    const t = tplWith(`<subform name="form1"><pageSet><pageArea name="P"><contentArea w="8in" h="10in"/></pageArea></pageSet>
      <subform name="Page1" layout="tb"><subform name="R" layout="row"><occur initial="2" max="-1"/>
      <field name="a" w="1in" h="1in"><ui><textEdit/></ui></field></subform></subform></subform>`);
    const kids = t.roots[0].node.children[0].children;
    expect(kids.map((k) => [k.label, k.layout, k.refusal])).toEqual([
      ['R[0]', 'row', undefined], ['R[1]', 'row', undefined],
    ]);
  });

  it('reads whitespace around a number, and -1 for max only', () => {
    expect(names(tplWith(T('<occur initial=" 2 " max=" -1 "/>')))).toHaveLength(2);
  });

  // Each refusal: walked ONCE (one field, today's name) with the reason on the node.
  const refused = (inner: string, data?: string) => {
    const t = tplWith(`<subform name="form1"><pageSet><pageArea name="P"><contentArea w="8in" h="10in"/></pageArea></pageSet>
      ${inner}</subform>`, data);
    const all: LayoutNode[] = [];
    const visit = (n: LayoutNode) => { all.push(n); n.children.forEach(visit); };
    t.roots.forEach((r) => visit(r.node));
    return { names: names(t), refusals: all.map((n) => n.refusal).filter((r) => r !== undefined) };
  };

  it('refuses an unreadable occur attribute', () => {
    for (const occ of ['<occur max="two"/>', '<occur max="-2"/>', '<occur min="-1"/>', '<occur initial="1.5"/>']) {
      const r = refused(`<subform name="Page1" layout="tb"><subform name="R" layout="tb">${occ}
        <field name="a"><ui><textEdit/></ui></field></subform></subform>`);
      expect(r.names, occ).toEqual(['form1[0].Page1[0].R[0].a[0]']);
      expect(r.refusals, occ).toEqual([expect.stringMatching(/^R\[0\]: occur \w+=".*" could not be read$/)]);
    }
  });

  it('refuses max below min', () => {
    const r = refused(`<subform name="Page1" layout="tb"><subform name="R" layout="tb"><occur min="3" max="2"/>
      <field name="a"><ui><textEdit/></ui></field></subform></subform>`);
    expect(r.refusals).toEqual(['R[0]: occur max="2" is below min="3"']);
  });

  it('refuses a repeating subform bound by ref or match="none" in a non-empty merge', () => {
    for (const bind of ['<bind ref="$.X"/>', '<bind match="none"/>']) {
      const r = refused(`<subform name="Page1" layout="tb"><subform name="R" layout="tb"><occur max="-1"/>${bind}
        <field name="a"><ui><textEdit/></ui></field></subform></subform>`,
      '<form1><Page1><R/><R/></Page1></form1>');
      expect(r.names, bind).toHaveLength(1);
      expect(r.refusals, bind).toEqual(['R[0]: a repeating subform bound by ref or match="none" is not instantiated']);
    }
  });

  it('refuses an unnamed repeating subform in a non-empty merge', () => {
    const r = refused(`<subform name="Page1" layout="tb"><subform layout="tb"><occur max="-1"/>
      <field name="a"><ui><textEdit/></ui></field></subform></subform>`, '<form1><Page1/></form1>');
    expect(r.names).toEqual(['form1[0].Page1[0].#subform[0].a[0]']);
    expect(r.refusals).toEqual(['<subform>: an unnamed repeating subform has no data groups to count']);
  });

  it('refuses more than one instance in a positioned parent', () => {
    const r = refused(`<subform name="Page1"><subform name="R" layout="tb"><occur initial="2" max="-1"/>
      <field name="a" w="1in" h="1in"><ui><textEdit/></ui></field></subform></subform>`);
    expect(r.names).toEqual(['form1[0].Page1[0].R[0].a[0]']);
    expect(r.refusals).toEqual(['R[0]: 2 instances of a repeating subform in a positioned container would overlap']);
  });

  it('allows ONE instance of a repeating subform in a positioned parent', () => {
    const r = refused(`<subform name="Page1"><subform name="R" layout="tb"><occur max="-1"/>
      <field name="a" w="1in" h="1in"><ui><textEdit/></ui></field></subform></subform>`);
    expect(r.refusals).toEqual([]);
  });

  it('refuses a repeating PAGE subform (164g.3)', () => {
    const r = refused(`<subform name="Page1" layout="tb"><occur max="-1"/>
      <field name="a"><ui><textEdit/></ui></field></subform>`, '<form1><Page1/><Page1/></form1>');
    expect(r.names).toEqual(['form1[0].Page1[0].a[0]']);
    expect(r.refusals).toEqual(['Page1[0]: a repeating page subform needs page breaking (164g.3)']);
  });
});

// 164g.2, found by the mutation sweep: two rules every case above left
// unmeasured, because every template above names all its containers and
// states max wherever it states min.
describe('parseXfaTemplate: <occur> rules the obvious fixtures cannot see', () => {
  it('defaults max to min (p. 263, 341), not to 1 (p. 339)', () => {
    // Under the p. 339 reading max is 1, below min, and the subform refuses.
    const t = tplWith(`<subform name="form1"><subform name="S" layout="tb">
      <subform name="R" layout="tb"><occur min="2"/><field name="a"><ui><textEdit/></ui></field></subform>
      </subform></subform>`);
    expect(names(t)).toEqual(['form1[0].S[0].R[0].a[0]', 'form1[0].S[0].R[1].a[0]']);
  });

  it('counts the data groups at the DATA path, through an unnamed container', () => {
    // The SOM path is form1[0].#subform[0]; the data has no element for the
    // unnamed level, so R's groups sit directly under form1[0].
    const t = tplWith(`<subform name="form1"><subform layout="tb">
      <subform name="R" layout="tb"><occur max="-1"/><field name="a"><ui><textEdit/></ui></field></subform>
      </subform></subform>`, '<form1><R/><R/><R/></form1>');
    expect(t.fields.map((f) => [f.name, f.dataPath])).toEqual([
      ['form1[0].#subform[0].R[0].a[0]', 'form1[0].R[0].a[0]'],
      ['form1[0].#subform[0].R[1].a[0]', 'form1[0].R[1].a[0]'],
      ['form1[0].#subform[0].R[2].a[0]', 'form1[0].R[2].a[0]'],
    ]);
  });
});
