import { describe, it, expect } from 'vitest';
import {
  parseStyles, parseTheme, readParaLayer, readRunLayer, resolveParagraph, resolveRun, EMPTY_THEME,
  type WmlStyles, type ThemeFonts, type ParaLayer,
} from '../src/wmlstyles.js';
import { parseWml, W, wChild } from '../src/wmlns.js';
import { LoadLimits } from '../src/loadlimits.js';
import { ResourceLimitError } from '../src/errors.js';
import { stylesXml, themeXml, style, enc, W_NS } from './helpers/wml.js';

const S = (inner: string, defaults = '', theme: ThemeFonts = EMPTY_THEME): WmlStyles =>
  parseStyles(stylesXml(inner, defaults), theme);
const rPr = (inner: string) => readRunLayer(wChild(parseWml(enc(`<w:x xmlns:w="${W_NS}"><w:rPr>${inner}</w:rPr></w:x>`)), 'rPr'));
const pPr = (inner: string) => readParaLayer(wChild(parseWml(enc(`<w:x xmlns:w="${W_NS}"><w:pPr>${inner}</w:pPr></w:x>`)), 'pPr'));
const run = (s: WmlStyles, pStyle?: string, rStyle?: string, direct = '') =>
  resolveRun(s, resolveParagraph(s, pStyle, pPr('')).styleId, rStyle, rPr(direct)).props;

const NORMAL = style('paragraph', 'Normal', '<w:name w:val="Normal"/>', ' w:default="1"');

describe('resolution order', () => {
  it('starts from docDefaults', () => {
    const s = S(NORMAL, '<w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault>'
      + '<w:pPrDefault><w:pPr><w:spacing w:after="200"/></w:pPr></w:pPrDefault>');
    expect(run(s).sizePt).toBe(11);
    expect(resolveParagraph(s, undefined, pPr('')).props.spaceAfterPt).toBe(10);
  });

  it('defaults the size to 10pt when nothing states one', () => {
    expect(run(S(NORMAL)).sizePt).toBe(10);
  });

  it('lets the nearer style in a basedOn chain override the farther, and inherits the rest', () => {
    const s = S(NORMAL + style('paragraph', 'Base', '<w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="20"/><w:color w:val="FF0000"/></w:rPr>')
      + style('paragraph', 'Child', '<w:basedOn w:val="Base"/><w:rPr><w:sz w:val="28"/></w:rPr>'));
    const props = run(s, 'Child');
    expect(props.sizePt).toBe(14);
    expect(props.color).toEqual([1, 0, 0]);
  });

  it('uses the DEFAULT paragraph style when pStyle is absent, unknown, or not a paragraph style', () => {
    const s = S(style('paragraph', 'Body', '<w:rPr><w:sz w:val="30"/></w:rPr>', ' w:default="1"')
      + style('character', 'Char', '<w:rPr><w:sz w:val="40"/></w:rPr>'));
    expect(run(s).sizePt).toBe(15);
    expect(run(s, 'Nope').sizePt).toBe(15);
    expect(run(s, 'Char').sizePt).toBe(15);
    expect(resolveParagraph(s, 'Nope', pPr('')).styleId).toBe('Body');
  });

  it('lets the character style override the paragraph style for an ordinary property', () => {
    const s = S(NORMAL + style('paragraph', 'P', '<w:rPr><w:color w:val="FF0000"/></w:rPr>')
      + style('character', 'C', '<w:rPr><w:color w:val="0000FF"/></w:rPr>'));
    expect(run(s, 'P', 'C').color).toEqual([0, 0, 1]);
  });

  it('lets direct formatting override every style', () => {
    const s = S(NORMAL + style('character', 'C', '<w:rPr><w:sz w:val="40"/></w:rPr>'));
    expect(run(s, undefined, 'C', '<w:sz w:val="18"/>').sizePt).toBe(9);
  });

  it('applies the numbering level between the paragraph style and direct formatting', () => {
    const s = S(NORMAL + style('paragraph', 'P', '<w:pPr><w:ind w:left="100" w:right="100"/></w:pPr>'));
    const level: ParaLayer = pPr('<w:ind w:left="720" w:hanging="360"/>');
    const got = resolveParagraph(s, 'P', pPr('<w:ind w:hanging="200"/><w:numPr><w:numId w:val="3"/></w:numPr>'), () => level);
    expect(got.props.indent).toEqual({ leftPt: 36, rightPt: 5, hangingPt: 10 });
    expect(got.numId).toBe(3);
  });
});

describe('toggle properties', () => {
  const s = () => S(NORMAL + style('paragraph', 'PB', '<w:rPr><w:b/><w:i/></w:rPr>')
    + style('character', 'CB', '<w:rPr><w:b/></w:rPr>'), '<w:rPrDefault><w:rPr><w:strike/></w:rPr></w:rPrDefault>');

  it('XORs a toggle stated in both style layers', () => {
    expect(run(s(), 'PB', 'CB').bold).toBe(false);
  });

  it('keeps a toggle stated in one layer only', () => {
    expect(run(s(), 'PB').bold).toBe(true);
    expect(run(s(), undefined, 'CB').bold).toBe(true);
    expect(run(s(), 'PB', 'CB').italic).toBe(true);
  });

  it('lets direct formatting set a toggle ABSOLUTELY', () => {
    expect(run(s(), 'PB', 'CB', '<w:b/>').bold).toBe(true);
    expect(run(s(), 'PB', undefined, '<w:b w:val="0"/>').bold).toBe(false);
  });

  it('falls back to docDefaults when no style layer states the toggle', () => {
    expect(run(s(), 'PB').strike).toBe(true);
  });
});

describe('style chains', () => {
  it('survives a basedOn cycle', () => {
    const s = S(style('paragraph', 'A', '<w:basedOn w:val="B"/><w:rPr><w:sz w:val="20"/></w:rPr>')
      + style('paragraph', 'B', '<w:basedOn w:val="A"/><w:rPr><w:color w:val="00FF00"/></w:rPr>'));
    expect(run(s, 'A')).toMatchObject({ sizePt: 10, color: [0, 1, 0] });
  });

  it('survives a basedOn cycle with NO depth bound — the seen set alone ends the walk', () => {
    // Under the default limits the depth bound also ends a cycle, so the case
    // above cannot tell the two apart; with maxNestingDepth null only seen can.
    const s = parseStyles(stylesXml(style('paragraph', 'A', '<w:basedOn w:val="B"/><w:rPr><w:sz w:val="20"/></w:rPr>')
      + style('paragraph', 'B', '<w:basedOn w:val="A"/><w:rPr><w:color w:val="00FF00"/></w:rPr>')), EMPTY_THEME, LoadLimits.unlimited());
    expect(run(s, 'A')).toMatchObject({ sizePt: 10, color: [0, 1, 0] });
  });

  it('stops at an unknown or wrongly-typed base', () => {
    const s = S(style('paragraph', 'A', '<w:basedOn w:val="Ghost"/><w:rPr><w:sz w:val="20"/></w:rPr>')
      + style('paragraph', 'B', '<w:basedOn w:val="C"/>') + style('character', 'C', '<w:rPr><w:sz w:val="40"/></w:rPr>'));
    expect(run(s, 'A').sizePt).toBe(10);
    expect(run(s, 'B').sizePt).toBe(10);
  });

  it('bounds a chain by maxNestingDepth', () => {
    let xml = style('paragraph', 'S0', '<w:rPr><w:sz w:val="40"/></w:rPr>');
    for (let i = 1; i <= 5; i++) xml += style('paragraph', `S${i}`, `<w:basedOn w:val="S${i - 1}"/>`);
    // parseXml enforces maxNestingDepth per ELEMENT, and w:styles/w:style/w:rPr/w:sz
    // is already 4 deep — so a limit of 3 would refuse the XML before the walk
    // runs. Parse under the defaults, then check the bound the walk reads.
    expect(() => parseStyles(stylesXml(xml), EMPTY_THEME, LoadLimits.defaults.with({ maxNestingDepth: 3 }))).toThrow(ResourceLimitError);
    const parsed = parseStyles(stylesXml(xml), EMPTY_THEME, LoadLimits.defaults.with({ maxNestingDepth: 4 }));
    expect(parsed.maxDepth).toBe(4);
    const deep: WmlStyles = { ...parsed, maxDepth: 3 };
    expect(run(deep, 'S5').sizePt).toBe(10);
    expect(run(deep, 'S2').sizePt).toBe(20);
  });

  it('keeps the first of two styles with one id', () => {
    const s = S(style('paragraph', 'A', '<w:rPr><w:sz w:val="20"/></w:rPr>') + style('paragraph', 'A', '<w:rPr><w:sz w:val="40"/></w:rPr>'));
    expect(run(s, 'A').sizePt).toBe(10);
  });

  it('counts styles against maxContainerItems', () => {
    const xml = style('paragraph', 'A', '') + style('paragraph', 'B', '') + style('paragraph', 'C', '');
    expect(() => parseStyles(stylesXml(xml), EMPTY_THEME, LoadLimits.defaults.with({ maxContainerItems: 2 }))).toThrow(ResourceLimitError);
    expect(() => parseStyles(stylesXml(xml), EMPTY_THEME, LoadLimits.defaults.with({ maxContainerItems: 3 }))).not.toThrow();
  });
});

describe('headings', () => {
  it('takes the level from outlineLvl through a localized style id', () => {
    const s = S(NORMAL + style('paragraph', '1', '<w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr>')
      + style('paragraph', '3', '<w:basedOn w:val="1"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr>')
      + style('paragraph', 'Kid', '<w:basedOn w:val="3"/>'));
    expect(resolveParagraph(s, '1', pPr(''))).toMatchObject({ heading: 1, styleName: 'heading 1' });
    expect(resolveParagraph(s, 'Kid', pPr('')).heading).toBe(3);
  });

  it('is no heading at outlineLvl 9 (body text) or with none', () => {
    const s = S(NORMAL + style('paragraph', 'Body9', '<w:pPr><w:outlineLvl w:val="9"/></w:pPr>')
      + style('paragraph', 'Heading1', '<w:name w:val="heading 1"/>'));
    expect(resolveParagraph(s, 'Body9', pPr('')).heading).toBeUndefined();
    expect(resolveParagraph(s, 'Heading1', pPr('')).heading).toBeUndefined();
  });

  it('lets direct outlineLvl make a heading', () => {
    expect(resolveParagraph(S(NORMAL), undefined, pPr('<w:outlineLvl w:val="1"/>')).heading).toBe(2);
  });
});

describe('fonts', () => {
  const theme = parseTheme(themeXml('Cambria', 'Georgia', 'MS Mincho'));

  it('reads the theme font scheme, treating an empty typeface as none', () => {
    expect(theme).toEqual({ major: { latin: 'Georgia' }, minor: { latin: 'Cambria', ea: 'MS Mincho' } });
  });

  it('resolves a theme font and lets it outrank the literal beside it', () => {
    const s = S(NORMAL, '', theme);
    expect(run(s, undefined, undefined, '<w:rFonts w:asciiTheme="minorHAnsi" w:ascii="Arial"/>').font).toBe('Cambria');
    expect(run(s, undefined, undefined, '<w:rFonts w:hAnsiTheme="majorHAnsi"/>').font).toBe('Georgia');
    expect(run(s, undefined, undefined, '<w:rFonts w:eastAsiaTheme="minorEastAsia"/>').eastAsiaFont).toBe('MS Mincho');
  });

  it('falls back to the literal name when a theme font does not resolve', () => {
    expect(run(S(NORMAL), undefined, undefined, '<w:rFonts w:asciiTheme="minorHAnsi" w:ascii="Arial"/>').font).toBe('Arial');
  });

  it('lets a nearer layer\'s font win', () => {
    const s = S(NORMAL, '<w:rPrDefault><w:rPr><w:rFonts w:ascii="Times"/></w:rPr></w:rPrDefault>', theme);
    expect(run(s).font).toBe('Times');
    expect(run(s, undefined, undefined, '<w:rFonts w:ascii="Courier"/>').font).toBe('Courier');
  });
});

describe('colour, highlight and shading', () => {
  it('reads auto as no colour and hex as a colour, and a nearer auto wins', () => {
    const s = S(NORMAL + style('paragraph', 'Red', '<w:rPr><w:color w:val="FF0000"/></w:rPr>'));
    expect(run(s, 'Red').color).toEqual([1, 0, 0]);
    expect(run(s, 'Red', undefined, '<w:color w:val="auto"/>').color).toBeUndefined();
  });

  it('maps a named highlight, lets highlight outrank shading, and none fall back to shading', () => {
    const s = S(NORMAL);
    expect(run(s, undefined, undefined, '<w:highlight w:val="yellow"/>').highlight).toEqual([1, 1, 0]);
    expect(run(s, undefined, undefined, '<w:highlight w:val="yellow"/><w:shd w:fill="00FF00"/>').highlight).toEqual([1, 1, 0]);
    expect(run(s, undefined, undefined, '<w:highlight w:val="none"/><w:shd w:fill="00FF00"/>').highlight).toEqual([0, 1, 0]);
    expect(run(s, undefined, undefined, '<w:shd w:fill="auto"/>').highlight).toBeUndefined();
  });

  it('ignores a highlight name it does not know, including an inherited Object key', () => {
    expect(run(S(NORMAL), undefined, undefined, '<w:highlight w:val="constructor"/>').highlight).toBeUndefined();
  });
});

describe('paragraph layer', () => {
  it('maps alignment', () => {
    const align = (v: string) => pPr(`<w:jc w:val="${v}"/>`).align;
    expect([align('left'), align('start'), align('center'), align('right'), align('end'), align('both'), align('distribute')])
      .toEqual(['left', 'left', 'center', 'right', 'right', 'justify', 'justify']);
    expect(pPr('<w:jc w:val="thaiDistribute"/>').unmodelled).toEqual(['w:jc=thaiDistribute']);
  });

  it('reads spacing and the three line rules', () => {
    expect(pPr('<w:spacing w:before="120" w:after="240" w:line="276" w:lineRule="auto"/>'))
      .toMatchObject({ spaceBeforePt: 6, spaceAfterPt: 12, line: { auto: 1.15 } });
    expect(pPr('<w:spacing w:line="360"/>').line).toEqual({ auto: 1.5 });
    expect(pPr('<w:spacing w:line="280" w:lineRule="exact"/>').line).toEqual({ exactPt: 14 });
    expect(pPr('<w:spacing w:line="280" w:lineRule="atLeast"/>').line).toEqual({ atLeastPt: 14 });
  });

  it('merges indent per field across layers', () => {
    const s = S(NORMAL + style('paragraph', 'P', '<w:pPr><w:ind w:left="720" w:firstLine="360"/></w:pPr>'));
    expect(resolveParagraph(s, 'P', pPr('<w:ind w:right="240"/>')).props.indent)
      .toEqual({ leftPt: 36, rightPt: 12, firstLinePt: 18 });
  });

  it('resolves firstLine and hanging as ONE signed property — the nearer layer\'s replaces the other', () => {
    // A Normal with a first-line indent under a hanging list level: the level is
    // nearer, so its hanging wins and the style's firstLine is gone.
    const s = S(style('paragraph', 'Normal', '<w:pPr><w:ind w:firstLine="709"/></w:pPr>', ' w:default="1"'));
    const level: ParaLayer = pPr('<w:ind w:left="720" w:hanging="360"/>');
    expect(resolveParagraph(s, undefined, pPr('<w:numPr><w:numId w:val="1"/></w:numPr>'), () => level).props.indent)
      .toEqual({ leftPt: 36, hangingPt: 18 });
    // And the other way: a direct firstLine over a style's hanging.
    const h = S(style('paragraph', 'Normal', '<w:pPr><w:ind w:hanging="360"/></w:pPr>', ' w:default="1"'));
    expect(resolveParagraph(h, undefined, pPr('<w:ind w:firstLine="200"/>')).props.indent).toEqual({ firstLinePt: 10 });
  });

  it('lets hanging win when one layer states both', () => {
    expect(pPr('<w:ind w:firstLine="200" w:hanging="360"/>').indent).toEqual({ hangingPt: 18 });
  });

  it('reads start/end as left/right', () => {
    expect(pPr('<w:ind w:start="200" w:end="100"/>').indent).toEqual({ leftPt: 10, rightPt: 5 });
  });
});

describe('unmodelled properties', () => {
  it('records a stated property it does not model, from any layer, once', () => {
    const s = S(NORMAL + style('paragraph', 'P', '<w:rPr><w:caps/></w:rPr><w:pPr><w:pBdr/></w:pPr>'));
    expect(resolveRun(s, 'P', undefined, rPr('<w:caps/><w:vertAlign w:val="superscript"/>')).unmodelled)
      .toEqual(['w:caps', 'w:vertAlign']);
    expect(resolveParagraph(s, 'P', pPr('')).unmodelled).toEqual(['w:pBdr']);
  });

  it('stays quiet about properties that carry no rendering', () => {
    expect(rPr('<w:lang w:val="ru-RU"/><w:noProof/><w:szCs w:val="22"/><w:bCs/><w:iCs/><w:kern w:val="32"/>').unmodelled).toEqual([]);
    expect(pPr('<w:keepNext/><w:keepLines/><w:widowControl/>').unmodelled).toEqual([]);
  });

  it('records spacing it does not model — line-unit spacing, autospacing, contextual spacing — only when stated on', () => {
    expect(pPr('<w:spacing w:before="0" w:beforeLines="100" w:afterLines="0" w:beforeAutospacing="1" w:afterAutospacing="0"/>'
      + '<w:contextualSpacing/>').unmodelled).toEqual(['w:spacing@beforeLines', 'w:spacing@beforeAutospacing', 'w:contextualSpacing']);
    expect(pPr('<w:spacing w:afterLines="50" w:afterAutospacing="true"/><w:contextualSpacing w:val="0"/>').unmodelled)
      .toEqual(['w:spacing@afterLines', 'w:spacing@afterAutospacing']);
  });
});
