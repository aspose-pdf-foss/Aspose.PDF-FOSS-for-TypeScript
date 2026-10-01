import { describe, it, expect } from 'vitest';
import { parseNumbering, levelOf, formatNumber, ListCounter, type WmlNumbering } from '../src/wmlnumbering.js';
import { parseStyles, emptyStyles, EMPTY_THEME, type WmlStyles } from '../src/wmlstyles.js';
import { LoadLimits } from '../src/loadlimits.js';
import { ResourceLimitError } from '../src/errors.js';
import { numberingXml, stylesXml, style, lvl } from './helpers/wml.js';

const NO_STYLES = emptyStyles(EMPTY_THEME);
const TWO_LEVEL = `<w:abstractNum w:abstractNumId="0">${lvl(0, 'decimal', '%1.')}${lvl(1, 'lowerLetter', '%1.%2)')}</w:abstractNum>`;
const labels = (n: WmlNumbering, seq: [number, number][], styles: WmlStyles = NO_STYLES) => {
  const c = new ListCounter(n, styles);
  return seq.map(([id, l]) => c.next(id, l)?.label);
};

describe('ListCounter', () => {
  const n = parseNumbering(numberingXml(`${TWO_LEVEL}<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`));

  it('counts a level and composes the label from every level it names', () => {
    expect(labels(n, [[1, 0], [1, 1], [1, 1], [1, 0], [1, 1]])).toEqual(['1.', '1.a)', '1.b)', '2.', '2.a)']);
  });

  it('keeps counting across calls for other lists — an interruption resets nothing', () => {
    const both = parseNumbering(numberingXml(`${TWO_LEVEL}<w:abstractNum w:abstractNumId="9">${lvl(0, 'decimal', '%1.')}</w:abstractNum>`
      + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="7"><w:abstractNumId w:val="9"/></w:num>'));
    expect(labels(both, [[1, 0], [7, 0], [1, 0]])).toEqual(['1.', '1.', '2.']);
  });

  it('starts a level at its w:start', () => {
    const s = parseNumbering(numberingXml(`<w:abstractNum w:abstractNumId="0">${lvl(0, 'decimal', '%1.', 4)}</w:abstractNum>`
      + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'));
    expect(labels(s, [[1, 0], [1, 0]])).toEqual(['4.', '5.']);
  });

  it('continues two nums that share one abstract num', () => {
    const s = parseNumbering(numberingXml(`${TWO_LEVEL}<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`
      + '<w:num w:numId="2"><w:abstractNumId w:val="0"/></w:num>'));
    expect(labels(s, [[1, 0], [1, 0], [2, 0]])).toEqual(['1.', '2.', '3.']);
  });

  it('restarts at a startOverride on a num\'s first use, then continues', () => {
    const s = parseNumbering(numberingXml(`${TWO_LEVEL}<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`
      + '<w:num w:numId="4"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/></w:lvlOverride></w:num>'));
    expect(labels(s, [[1, 0], [1, 0], [4, 0], [4, 0]])).toEqual(['1.', '2.', '5.', '6.']);
  });

  it('replaces a level wholesale through lvlOverride/lvl', () => {
    const s = parseNumbering(numberingXml(`${TWO_LEVEL}<w:num w:numId="1"><w:abstractNumId w:val="0"/>`
      + `<w:lvlOverride w:ilvl="0">${lvl(0, 'upperRoman', '(%1)', 3)}</w:lvlOverride></w:num>`));
    expect(labels(s, [[1, 0], [1, 0]])).toEqual(['(III)', '(IV)']);
  });

  it('does not reset a deeper level whose lvlRestart is 0', () => {
    const s = parseNumbering(numberingXml(`<w:abstractNum w:abstractNumId="0">${lvl(0, 'decimal', '%1.')}`
      + `${lvl(1, 'decimal', '%1.%2', 1, '<w:lvlRestart w:val="0"/>')}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`));
    expect(labels(s, [[1, 0], [1, 1], [1, 0], [1, 1]])).toEqual(['1.', '1.1', '2.', '2.2']);
  });

  it('resets a deeper level only after a level at or above its lvlRestart (1-based)', () => {
    // Level 2 (ilvl 2) restarts only after level 1 (ilvl 0): visiting ilvl 1 leaves it.
    const s = parseNumbering(numberingXml(`<w:abstractNum w:abstractNumId="0">${lvl(0, 'decimal', '%1.')}`
      + `${lvl(1, 'decimal', '%1.%2.')}${lvl(2, 'lowerLetter', '%3)', 1, '<w:lvlRestart w:val="1"/>')}`
      + '</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'));
    expect(labels(s, [[1, 0], [1, 1], [1, 2], [1, 1], [1, 2], [1, 0], [1, 2]]))
      .toEqual(['1.', '1.1.', 'a)', '1.2.', 'b)', '2.', 'a)']);
  });

  it('reports a bullet verbatim', () => {
    const s = parseNumbering(numberingXml(`<w:abstractNum w:abstractNumId="0">${lvl(0, 'bullet', '•')}</w:abstractNum>`
      + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'));
    expect(new ListCounter(s, NO_STYLES).next(1, 0)).toEqual({ ordinal: 1, label: '•', bullet: true });
  });

  it('falls back to decimal for a format it does not know, and says so', () => {
    const s = parseNumbering(numberingXml(`<w:abstractNum w:abstractNumId="0">${lvl(0, 'chineseCounting', '%1.')}</w:abstractNum>`
      + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'));
    expect(new ListCounter(s, NO_STYLES).next(1, 0)).toEqual({ ordinal: 1, label: '1.', bullet: false, unmodelledFormat: 'w:numFmt=chineseCounting' });
  });

  it('answers undefined for an unknown num or level', () => {
    expect(new ListCounter(n, NO_STYLES).next(99, 0)).toBeUndefined();
    expect(new ListCounter(n, NO_STYLES).next(1, 5)).toBeUndefined();
  });

  it('follows numStyleLink to the abstract num carrying the matching styleLink', () => {
    const styles = parseStyles(stylesXml(style('numbering', 'MyList', '<w:pPr><w:numPr><w:numId w:val="2"/></w:numPr></w:pPr>')), EMPTY_THEME);
    const s = parseNumbering(numberingXml(`<w:abstractNum w:abstractNumId="0"><w:styleLink w:val="MyList"/>${lvl(0, 'upperLetter', '%1.')}</w:abstractNum>`
      + '<w:abstractNum w:abstractNumId="1"><w:numStyleLink w:val="MyList"/></w:abstractNum>'
      + '<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="0"/></w:num>'));
    expect(labels(s, [[1, 0], [1, 0]], styles)).toEqual(['A.', 'B.']);
  });

  it('never scans the abstract nums to follow a numStyleLink, however many paragraphs ask', () => {
    const styles = parseStyles(stylesXml(style('numbering', 'MyList', '<w:pPr><w:numPr><w:numId w:val="2"/></w:numPr></w:pPr>')), EMPTY_THEME);
    const s = parseNumbering(numberingXml(`<w:abstractNum w:abstractNumId="0"><w:styleLink w:val="MyList"/>${lvl(0, 'upperLetter', '%1.')}</w:abstractNum>`
      + '<w:abstractNum w:abstractNumId="1"><w:numStyleLink w:val="MyList"/></w:abstractNum>'
      + '<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="0"/></w:num>'));
    let scans = 0;
    class Counting<K, V> extends Map<K, V> {
      override [Symbol.iterator]() { scans++; return super[Symbol.iterator](); }
      override entries() { scans++; return super.entries(); }
      override values() { scans++; return super.values(); }
      override forEach(...a: Parameters<Map<K, V>['forEach']>) { scans++; super.forEach(...a); }
    }
    const counted: WmlNumbering = { ...s, abstracts: new Counting(s.abstracts) };
    scans = 0;
    const c = new ListCounter(counted, styles);
    for (let i = 0; i < 100; i++) c.next(1, 0);
    expect(c.next(1, 0)?.label).toBe('WWWW.');
    expect(scans).toBe(0);
  });

  it('follows a numStyleLink to the FIRST abstract num carrying the styleLink', () => {
    const styles = parseStyles(stylesXml(style('numbering', 'MyList', '<w:pPr><w:numPr><w:numId w:val="9"/></w:numPr></w:pPr>')), EMPTY_THEME);
    const s = parseNumbering(numberingXml(`<w:abstractNum w:abstractNumId="0"><w:styleLink w:val="MyList"/>${lvl(0, 'upperLetter', '%1.')}</w:abstractNum>`
      + `<w:abstractNum w:abstractNumId="2"><w:styleLink w:val="MyList"/>${lvl(0, 'lowerRoman', '%1.')}</w:abstractNum>`
      + '<w:abstractNum w:abstractNumId="1"><w:numStyleLink w:val="MyList"/></w:abstractNum>'
      + '<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>'));
    expect(labels(s, [[1, 0]], styles)).toEqual(['A.']);
  });

  it('survives a numStyleLink that leads back to itself', () => {
    const styles = parseStyles(stylesXml(style('numbering', 'Loop', '<w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr>')), EMPTY_THEME);
    const s = parseNumbering(numberingXml('<w:abstractNum w:abstractNumId="0"><w:numStyleLink w:val="Loop"/></w:abstractNum>'
      + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'));
    expect(new ListCounter(s, styles).next(1, 0)).toBeUndefined();
  });
});

describe('levelOf', () => {
  it('exposes a level\'s paragraph properties for resolution', () => {
    const s = parseNumbering(numberingXml(`<w:abstractNum w:abstractNumId="0">${lvl(0, 'decimal', '%1.', 1, '<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>')}</w:abstractNum>`
      + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'));
    expect(levelOf(s, NO_STYLES, 1, 0)?.ppr.indent).toEqual({ leftPt: 36, hangingPt: 18 });
  });
});

describe('formatNumber', () => {
  it('formats every modelled numFmt', () => {
    expect(formatNumber(7, 'decimal')).toBe('7');
    expect(formatNumber(7, 'decimalZero')).toBe('07');
    expect(formatNumber(12, 'decimalZero')).toBe('12');
    expect(formatNumber(1994, 'upperRoman')).toBe('MCMXCIV');
    expect(formatNumber(4, 'lowerRoman')).toBe('iv');
    expect(formatNumber(1, 'lowerLetter')).toBe('a');
    expect(formatNumber(26, 'upperLetter')).toBe('Z');
    expect(formatNumber(27, 'lowerLetter')).toBe('aa');
    expect(formatNumber(53, 'lowerLetter')).toBe('aaa');
    expect(formatNumber(3, 'none')).toBe('');
    expect(formatNumber(3, 'ordinal')).toBeUndefined();
  });

  it('writes a non-positive value in decimal for roman and letter formats', () => {
    expect(formatNumber(0, 'upperRoman')).toBe('0');
    expect(formatNumber(0, 'lowerLetter')).toBe('0');
  });
});

describe('parseNumbering limits', () => {
  it('counts abstract nums and nums together against maxContainerItems', () => {
    const xml = numberingXml(`${TWO_LEVEL}<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="0"/></w:num>`);
    expect(() => parseNumbering(xml, LoadLimits.defaults.with({ maxContainerItems: 2 }))).toThrow(ResourceLimitError);
    expect(() => parseNumbering(xml, LoadLimits.defaults.with({ maxContainerItems: 3 }))).not.toThrow();
  });
});
