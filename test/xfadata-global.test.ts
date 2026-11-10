// test/xfadata-global.test.ts
import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/xml.js';
import { parseXfaDatasets, parseXfaGlobals, bindFieldValue } from '../src/xfadata.js';
import type { XfaField } from '../src/xfatemplate.js';

const root = (inner: string) => parseXml(new TextEncoder().encode(`<datasets><data>${inner}</data></datasets>`));
const both = (inner: string) => { const r = root(inner); return { v: parseXfaDatasets(r), g: parseXfaGlobals(r) }; };
const global = (dataPath: string, dataName: string, extra: Partial<XfaField> = {}): XfaField => ({
  name: dataPath, dataPath, dataName, ui: 'text', readOnly: false, required: false, multiLine: false,
  layouts: [], bindMatch: 'global', ...extra,
});

// XFA 3.3 p. 246-247: "If a global field ... can not be matched directly, a
// match is sought among global data values ... as though [the Data DOM] was
// completely flattened." Designer writes the datum under the outermost group.
describe('bind match="global" (yy09)', () => {
  it('binds a datum stored at the record root, whatever the field depth', () => {
    const { v, g } = both('<top><c1_8>2</c1_8><Page1><Box/></Page1></top>');
    expect(bindFieldValue(global('top[0].Page1[0].Box[0].c1_8[0]', 'c1_8'), v, g)).toBe('2');
  });

  it('prefers the ordinary match at its own data path', () => {
    const { v, g } = both('<top><c1>root</c1><P><c1>own</c1></P></top>');
    expect(bindFieldValue(global('top[0].P[0].c1[0]', 'c1'), v, g)).toBe('own');
  });

  // Review Focus 2: an empty datum is a datum.
  it('takes an EMPTY datum at its own path over a filled one elsewhere', () => {
    const { v, g } = both('<top><c1>root</c1><P><c1/></P></top>');
    expect(bindFieldValue(global('top[0].P[0].c1[0]', 'c1'), v, g)).toBe('');
  });

  // Review Focus 1: the record-0 pick, p. 247.
  it('takes the FIRST same-named value in document order, depth ignored', () => {
    const { v, g } = both('<top><row><c1>a</c1></row><row><c1>b</c1></row><c1>c</c1></top>');
    expect(bindFieldValue(global('top[0].X[0].c1[0]', 'c1'), v, g)).toBe('a');
  });

  // Review Focus 3: a data group is not a value.
  it('never binds a data GROUP of that name', () => {
    const { v, g } = both('<top><c1><x>1</x></c1></top>');
    expect(bindFieldValue(global('top[0].X[0].c1[0]', 'c1'), v, g)).toBeUndefined();
  });

  // p. 247: "Attributes of global data elements can not bind to fields."
  it('never binds an attribute of that name', () => {
    const { v, g } = both('<top c1="attr"><other/></top>');
    expect(bindFieldValue(global('top[0].X[0].c1[0]', 'c1'), v, g)).toBeUndefined();
  });

  it('gives every global field of a name the same value', () => {
    const { v, g } = both('<top><cui>2</cui></top>');
    const a = bindFieldValue(global('A[0].cui[0]', 'cui'), v, g);
    const b = bindFieldValue(global('B[0].C[0].cui[0]', 'cui'), v, g);
    expect([a, b]).toEqual(['2', '2']);
  });

  it('does nothing for a field that is not global', () => {
    const { v, g } = both('<top><c1>root</c1></top>');
    expect(bindFieldValue(global('top[0].X[0].c1[0]', 'c1', { bindMatch: undefined }), v, g)).toBeUndefined();
  });

  it('binds as before when no index is passed', () => {
    const { v } = both('<top><c1>root</c1></top>');
    expect(bindFieldValue(global('top[0].X[0].c1[0]', 'c1'), v)).toBeUndefined();
  });

  it('carries a multi-select value whole', () => {
    const { v, g } = both('<top><ls><value>a</value><value>b</value></ls></top>');
    expect(bindFieldValue(global('top[0].X[0].ls[0]', 'ls'), v, g)).toEqual(['a', 'b']);
  });
});

describe('xfa:dataNode="dataGroup" and bind ref (b8h8)', () => {
  const XFA = 'xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"';
  it('reads an empty dataGroup as a group, not a blank value that shadows a real datum', () => {
    const r = parseXml(new TextEncoder().encode(`<datasets ${XFA}><data><top><g xfa:dataNode="dataGroup"/><P><g>real</g></P></top></data></datasets>`));
    expect(parseXfaDatasets(r).has('top[0].g[0]')).toBe(false);
    expect(parseXfaGlobals(r).get('g')).toBe('real');
  });

  it('still reads an empty element with no dataNode as a blank value', () => {
    const { v, g } = both('<top><g/><P><g>real</g></P></top>');
    expect(v.get('top[0].g[0]')).toBe('');
    expect(g.get('g')).toBe('');
  });

  it('consults a ref only under match="dataRef", so a global field still searches', () => {
    const { v, g } = both('<top><who>Ada</who><P/></top>');
    const f = global('top[0].P[0].who[0]', 'who', { bindRef: '$.nowhere' });
    expect(bindFieldValue(f, v, g)).toBe('Ada');
    expect(bindFieldValue({ ...f, bindMatch: 'dataRef' }, v, g)).toBeUndefined();
  });
});
