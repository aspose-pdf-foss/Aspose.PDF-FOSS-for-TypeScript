import { describe, expect, it } from 'vitest';
import {
  buildTabScript, encodePmd, joinTabDelimited, parseBarcodeScript, readPmd, type PaperMetadata,
} from '../src/pmd.js';
import { name, type PdfObject } from '../src/types.js';

const id = (o: PdfObject | undefined) => o ?? null;

/** Acrobat's generated script as users paste it on the Adobe community forum
 *  (threads td-p/8664920 and pdf-form-barcode-generator-variable-order), with
 *  the paste's own indentation. */
const FORUM = `function bMemberOf(strName, aStrNames)
{
    for (var nMembIdx in aStrNames)
    {
        if (strName == aStrNames[nMembIdx])
            return true;
    }
    return false;
}
function strTabDelimited(oParam)
{
    var bNeedTab = false;
    var strNames = "";
    var strValues = "";
    for (var i = 0; i < oParam.oDoc.numFields; ++i)
    {
        var strFieldName = oParam.oDoc.getNthFieldName(i);
        if ((null == oParam.aFields || bMemberOf(strFieldName, oParam.aFields))
            && (null == oParam.strXclField || strFieldName != oParam.strXclField)
            && (oParam.oDoc.getField(strFieldName).type != "button"))
        {
            if (bNeedTab)
            {
                if (oParam.bFieldNames)
                    strNames += "\\t";
                strValues += "\\t";
            }
            if (oParam.bFieldNames)
                strNames += strFieldName;
            strValues += oParam.oDoc.getField(strFieldName).value;
            bNeedTab = true;
        }
    }
    if (oParam.bFieldNames)
        return strNames + "\\n" + strValues;
    else
        return strValues;
}


try
{
    if ( app.viewerVersion >= ADBE.PMD_Need_Version )
        event.value = strTabDelimited({oDoc: this, aFields: ["Applicant Name", "City", "Date of Application", "Position 1", "Position 2", "Position 3", "Posting Number", "Print & Clear Form", "Substitute"], bFieldNames: false});
    else event.value = " ";
}
catch (e)
{
    event.value = " ";
}`;

describe('Acrobat tab-delimited barcode script', () => {
  it('reads the forum paste of Acrobat\'s generated script', () => {
    expect(parseBarcodeScript(FORUM)).toEqual({
      encoding: 'tab',
      params: {
        fields: ['Applicant Name', 'City', 'Date of Application', 'Position 1', 'Position 2',
          'Position 3', 'Posting Number', 'Print & Clear Form', 'Substitute'],
        fieldNames: false,
      },
    });
  });

  for (const params of [
    { fields: ['a', 'b "q"', 'back\\slash'], fieldNames: false },
    { fields: null, fieldNames: true },
    { fields: ['x'], fieldNames: false, exclude: 'bc' },
  ]) {
    it(`round-trips ${JSON.stringify(params)}`, () => {
      expect(parseBarcodeScript(buildTabScript(params))).toEqual({ encoding: 'tab', params });
    });
  }

  it('builds the forum text exactly, up to whitespace', () => {
    const p = parseBarcodeScript(FORUM);
    if (p?.encoding !== 'tab') throw new Error('not tab');
    expect(buildTabScript(p.params).replace(/\s+/g, ' ')).toBe(FORUM.replace(/\s+/g, ' '));
  });

  it('refuses a script that could compute something else', () => {
    expect(parseBarcodeScript(FORUM.replace('strValues += "\\t";', 'strValues += "|";'))).toBeUndefined();
    expect(parseBarcodeScript(FORUM.replace('!= "button"', '!= "text"'))).toBeUndefined();
    expect(parseBarcodeScript(FORUM.replace('bFieldNames: false', 'bFieldNames: x'))).toBeUndefined();
    expect(parseBarcodeScript(FORUM.replace('"City"', 'city'))).toBeUndefined();
    expect(parseBarcodeScript(`${FORUM}\nevent.value += "!";`)).toBeUndefined();
    expect(parseBarcodeScript('')).toBeUndefined();
  });

  it('recognises Acrobat\'s XML encoding without recomputing it', () => {
    expect(parseBarcodeScript('function strXMLData(oParam) { return ""; }\nevent.value = strXMLData({oDoc: this});'))
      .toEqual({ encoding: 'xml' });
  });

  it('joins as the template does', () => {
    expect(joinTabDelimited([{ name: 'a', value: '1' }, { name: 'b', value: '' }], true)).toBe('a\tb\n1\t');
    expect(joinTabDelimited([{ name: 'a', value: '1' }, { name: 'b', value: '2' }], false)).toBe('1\t2');
    expect(joinTabDelimited([], false)).toBe('');
    expect(joinTabDelimited([], true)).toBe('\n');
  });
});

describe('/PMD', () => {
  it('round-trips every key', () => {
    const p: PaperMetadata = {
      symbology: 'PDF417', ecc: 5, xSymWidth: 3, xSymHeight: 9, ySymHeight: 9,
      nCodeWordRow: 10, nCodeWordCol: 6, resolution: 300, dataPrep: 1, caption: 'Scan me',
    };
    expect(readPmd(encodePmd(p), id)).toEqual(p);
    expect(readPmd(encodePmd({ symbology: 'QRCode' }), id)).toEqual({ symbology: 'QRCode' });
  });

  it('writes Acrobat\'s key names', () => {
    const d = encodePmd({ symbology: 'DataMatrix', ecc: 0, xSymWidth: 4, dataPrep: 0 });
    expect([...d.keys()].sort()).toEqual(['DataPrep', 'ECC', 'Symbology', 'XSymWidth']);
    expect(d.get('Symbology')).toEqual(name('DataMatrix'));
  });

  it('refuses what it cannot write', () => {
    expect(() => encodePmd({ symbology: 'Code39' as never })).toThrow(RangeError);
    expect(() => encodePmd({ symbology: 'PDF417', ecc: 9 })).toThrow(RangeError);
    expect(() => encodePmd({ symbology: 'QRCode', ecc: 4 })).toThrow(RangeError);
    expect(() => encodePmd({ symbology: 'PDF417', xSymWidth: 0 })).toThrow(RangeError);
    expect(() => encodePmd({ symbology: 'PDF417', dataPrep: 2 as never })).toThrow(RangeError);
    expect(() => encodePmd({ symbology: 'PDF417', caption: 7 as never })).toThrow(TypeError);
  });

  it('reads leniently', () => {
    const d = new Map<string, PdfObject>([['Symbology', name('Code39')]]);
    expect(readPmd(d, id)).toBeUndefined();
    const e = new Map<string, PdfObject>([['Symbology', name('PDF417')], ['ECC', name('x')], ['XSymWidth', -1]]);
    expect(readPmd(e, id)).toEqual({ symbology: 'PDF417' });
    expect(readPmd(undefined, id)).toBeUndefined();
  });
});
