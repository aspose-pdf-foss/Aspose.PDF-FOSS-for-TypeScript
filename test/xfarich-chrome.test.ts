// test/xfarich-chrome.test.ts
import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/xml.js';
import { leafText, captionText } from '../src/xfarich.js';

const el = (s: string) => parseXml(new TextEncoder().encode(s));

describe('xfarich: what painting needs and measurement ignores (164g.4)', () => {
  it('reads para hAlign onto every paragraph, and leaves left unstated', () => {
    const t = leafText(el('<draw><para hAlign="center"/><value><text>a\nb</text></value></draw>'));
    expect(t.paras.map((p) => p.hAlign)).toEqual(['center', 'center']);
    expect(leafText(el('<draw><para hAlign="left"/><value><text>a</text></value></draw>')).paras[0].hAlign).toBeUndefined();
  });

  it('reads para vAlign onto the leaf, leaving top unstated', () => {
    expect(leafText(el('<draw><para vAlign="bottom"/><value><text>a</text></value></draw>')).vAlign).toBe('bottom');
    expect(leafText(el('<draw><para vAlign="top"/><value><text>a</text></value></draw>')).vAlign).toBeUndefined();
  });

  it('reads the font colour and decoration onto each run', () => {
    const t = leafText(el('<draw><font typeface="Arial" underline="1" lineThrough="1"><fill><color value="255,0,0"/></fill></font><value><text>a</text></value></draw>'));
    expect(t.paras[0].runs[0]).toMatchObject({ color: [1, 0, 0], underline: true, lineThrough: true });
  });

  it('leaves a black, undecorated run exactly as before', () => {
    const t = leafText(el('<draw><font typeface="Arial"/><value><text>a</text></value></draw>'));
    expect(t.paras[0].runs[0]).toEqual({ family: ['Arial'], size: 10, bold: false, italic: false, text: 'a' });
  });

  it('reads rich-text color, text-decoration and text-align', () => {
    const t = leafText(el(`<draw><value><exData contentType="text/html"><body xmlns="http://www.w3.org/1999/xhtml">
      <p style="text-align:right"><span style="color:#0000ff;text-decoration:underline">x</span></p></body></exData></value></draw>`));
    expect(t.paras[0].hAlign).toBe('right');
    expect(t.paras[0].runs[0]).toMatchObject({ text: 'x', color: [0, 0, 1], underline: true });
  });

  // Whitespace between block elements is not content: it must open no
  // paragraph, or measurement counts a blank line and painting shifts the text.
  it('opens no paragraph for whitespace between <body> and <p>', () => {
    const t = leafText(el(`<draw><value><exData contentType="text/html"><body xmlns="http://www.w3.org/1999/xhtml">
      <p>x</p>
      <p>y</p></body></exData></value></draw>`));
    expect(t.paras.map((p) => p.runs.map((r) => r.text).join(''))).toEqual(['x', 'y']);
  });

  it('does not merge two runs that differ only in colour', () => {
    const t = leafText(el(`<draw><value><exData contentType="text/html"><body xmlns="http://www.w3.org/1999/xhtml">
      <p><span style="color:#ff0000">a</span><span style="color:#0000ff">b</span></p></body></exData></value></draw>`));
    expect(t.paras[0].runs.map((r) => r.text)).toEqual(['a', 'b']);
  });

  it('falls back to black with a note for an unreadable rich-text colour, keeping the leaf', () => {
    const t = leafText(el(`<draw><value><exData contentType="text/html"><body xmlns="http://www.w3.org/1999/xhtml">
      <p><span style="color:wobble">a</span></p></body></exData></value></draw>`));
    expect(t.refusal).toBeUndefined();
    expect(t.paras[0].runs[0].color).toBeUndefined();
    expect(t.notes).toEqual(['color in rich text could not be read, so black is used']);
  });
});

describe('captionText', () => {
  it('is the caption value, in the caption font', () => {
    const t = captionText(el('<field><caption reserve="20mm"><font typeface="Arial" size="8pt"/><value><text>Name</text></value></caption></field>'));
    expect(t?.paras[0].runs[0]).toMatchObject({ text: 'Name', family: ['Arial'], size: 8 });
  });

  // pdf.js inherits the FIELD's font for a caption that states none (CSS
  // inheritance from the field div); XFA's own default would be Courier 10.
  it('takes the field font when the caption states none', () => {
    const t = captionText(el('<field><font typeface="Times New Roman" size="9pt"/><caption><value><text>N</text></value></caption></field>'));
    expect(t?.paras[0].runs[0]).toMatchObject({ family: ['Times New Roman'], size: 9 });
  });

  it('reads the caption margin as its insets and its para as its alignment', () => {
    const t = captionText(el('<field><caption><margin leftInset="2pt"/><para vAlign="middle" hAlign="right"/><value><text>N</text></value></caption></field>'));
    expect(t?.insets.l).toBe(2);
    expect(t?.vAlign).toBe('middle');
    expect(t?.paras[0].hAlign).toBe('right');
  });

  it('is undefined with no caption, a caption with no value, or a hidden caption', () => {
    expect(captionText(el('<field/>'))).toBeUndefined();
    expect(captionText(el('<field><caption reserve="1in"/></field>'))).toBeUndefined();
    expect(captionText(el('<field><caption presence="hidden"><value><text>N</text></value></caption></field>'))).toBeUndefined();
  });
});
