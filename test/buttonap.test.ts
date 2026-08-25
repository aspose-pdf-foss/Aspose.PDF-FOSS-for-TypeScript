import { describe, it, expect } from 'vitest';
import {
  buttonRegions, BUTTON_POSITIONS, TP_FOR, type ButtonIconPosition,
  buildPushButtonAP,
} from '../src/buttonap.js';
import { Document } from '../src/document.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import { makePng } from './helpers/make-png.js';
import { buildImageXObject } from '../src/imageembed.js';
import { isDict, isName, isStream, name, PdfDict, PdfObject, PdfStream } from '../src/types.js';

describe('buttonRegions', () => {
  it('gives caption-only the whole inset box and no icon', () => {
    const r = buttonRegions('caption-only', 100, 40, 2);
    expect(r.icon).toBeUndefined();
    expect(r.caption).toEqual([2, 2, 96, 36]);
  });

  it('gives icon-only the whole inset box and no caption', () => {
    const r = buttonRegions('icon-only', 100, 40, 2);
    expect(r.caption).toBeUndefined();
    expect(r.icon).toEqual([2, 2, 96, 36]);
  });

  it('overlays both on the whole box for caption-over-icon', () => {
    const r = buttonRegions('caption-over-icon', 100, 40, 2);
    expect(r.icon).toEqual([2, 2, 96, 36]);
    expect(r.caption).toEqual([2, 2, 96, 36]);
  });

  it('stacks the icon above a caption strip', () => {
    const r = buttonRegions('icon-above-caption', 100, 40, 2);
    // The caption sits at the bottom, the icon fills what is left above it.
    expect(r.caption![1]).toBe(2);
    expect(r.icon![1]).toBe(2 + r.caption![3]);
    expect(r.caption![3] + r.icon![3]).toBeCloseTo(36, 6);
    expect(r.icon![3]).toBeGreaterThan(r.caption![3]);
  });

  it('stacks the icon below a caption strip', () => {
    const r = buttonRegions('icon-below-caption', 100, 40, 2);
    // The caption sits at the top, the icon fills what is left beneath it.
    expect(r.caption![1] + r.caption![3]).toBeCloseTo(38, 6);
    expect(r.icon![1]).toBe(2);
    expect(r.caption![3] + r.icon![3]).toBeCloseTo(36, 6);
    expect(r.icon![3]).toBeGreaterThan(r.caption![3]);
  });

  it('mirrors icon-above-caption when the caption moves to the top', () => {
    // The two vertical layouts differ only in which end each element takes,
    // so a strip height computed differently for one of them is a bug.
    const above = buttonRegions('icon-above-caption', 100, 40, 2);
    const below = buttonRegions('icon-below-caption', 100, 40, 2);
    expect(below.caption![3]).toBeCloseTo(above.caption![3], 6);
    expect(below.icon![3]).toBeCloseTo(above.icon![3], 6);
  });

  it('puts the icon left of the caption', () => {
    const r = buttonRegions('icon-left-of-caption', 100, 40, 2);
    expect(r.icon![0]).toBe(2);
    expect(r.caption![0]).toBeCloseTo(2 + r.icon![2], 6);
    expect(r.icon![2] + r.caption![2]).toBeCloseTo(96, 6);
    // Both span the full inset height; only the width is split.
    expect(r.icon![3]).toBeCloseTo(36, 6);
    expect(r.caption![3]).toBeCloseTo(36, 6);
    // The icon takes a square at most, so a wide button leaves the caption room.
    expect(r.icon![2]).toBeCloseTo(36, 6);
  });

  it('puts the icon right of the caption', () => {
    const r = buttonRegions('icon-right-of-caption', 100, 40, 2);
    expect(r.caption![0]).toBe(2);
    expect(r.icon![0]).toBeCloseTo(2 + r.caption![2], 6);
    expect(r.icon![2] + r.caption![2]).toBeCloseTo(96, 6);
    expect(r.icon![2]).toBeCloseTo(36, 6);
  });

  it('never lets the icon crowd the caption out of a narrow button', () => {
    // A tall, narrow button: capping the icon at half the width is what keeps
    // the caption from getting a zero-width box.
    for (const pos of ['icon-left-of-caption', 'icon-right-of-caption'] as const) {
      const r = buttonRegions(pos, 20, 200, 2);
      expect(r.caption![2]).toBeGreaterThan(0);
      expect(r.icon![2]).toBeCloseTo(8, 6);   // (20 - 4) / 2
    }
  });

  it('never returns a negative extent for a box smaller than its border', () => {
    for (const pos of BUTTON_POSITIONS) {
      const r = buttonRegions(pos, 4, 4, 10);
      for (const rect of [r.icon, r.caption]) {
        if (!rect) continue;
        expect(rect[2]).toBeGreaterThanOrEqual(0);
        expect(rect[3]).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('maps each position to its specification /TP value', () => {
    // PDF 32000-1 table 189.
    expect(TP_FOR['caption-only']).toBe(0);
    expect(TP_FOR['icon-only']).toBe(1);
    expect(TP_FOR['icon-above-caption']).toBe(2);   // "caption below the icon"
    expect(TP_FOR['icon-below-caption']).toBe(3);   // "caption above the icon"
    expect(TP_FOR['icon-left-of-caption']).toBe(4); // "caption to the right"
    expect(TP_FOR['icon-right-of-caption']).toBe(5);// "caption to the left"
    expect(TP_FOR['caption-over-icon']).toBe(6);
  });

  it('lists all seven layouts table 189 defines', () => {
    expect([...BUTTON_POSITIONS].sort()).toEqual([
      'caption-only', 'caption-over-icon', 'icon-above-caption',
      'icon-below-caption', 'icon-left-of-caption', 'icon-only',
      'icon-right-of-caption',
    ]);
    // /TP is the wire form: seven distinct values, 0..6.
    expect(new Set(BUTTON_POSITIONS.map((p) => TP_FOR[p])).size).toBe(7);
  });
});

describe('buildPushButtonAP', () => {
  const widget = (): PdfDict => new Map<string, PdfObject>([
    ['Type', name('Annot')],
    ['Subtype', name('Widget')],
    ['Rect', [0, 0, 100, 40]],
    ['DA', { kind: 'string', bytes: new TextEncoder().encode('/Helv 0 Tf 0 0 0 rg') }],
    ['MK', new Map<string, PdfObject>([
      ['BG', [0.86, 0.86, 0.86]],
      ['BC', [0.5, 0.5, 0.5]],
    ])],
  ]);
  const ap = (doc: Document, w: PdfDict) => doc.resolve(w.get('AP')) as PdfDict;
  const body = (doc: Document, w: PdfDict, key: 'N' | 'R' | 'D') =>
    new TextDecoder('latin1').decode(
      (doc.resolve(ap(doc, w).get(key)) as { raw: Uint8Array }).raw,
    );
  const face = (over: Partial<Parameters<typeof buildPushButtonAP>[3]> = {}) => ({
    caption: 'Go', rolloverCaption: 'Go', downCaption: 'Go',
    position: 'caption-only' as ButtonIconPosition, ...over,
  });

  it('installs three sibling appearance streams', () => {
    const doc = Document.Open(buildBlankPage());
    const w = widget();
    buildPushButtonAP(doc, w, new Map(), face());
    expect([...ap(doc, w).keys()].sort()).toEqual(['D', 'N', 'R']);
  });

  it('draws each state its own caption', () => {
    const doc = Document.Open(buildBlankPage());
    const w = widget();
    buildPushButtonAP(doc, w, new Map(), face({
      caption: 'Normal', rolloverCaption: 'Hover', downCaption: 'Press',
    }));
    expect(body(doc, w, 'N')).toContain('Normal');
    expect(body(doc, w, 'R')).toContain('Hover');
    expect(body(doc, w, 'D')).toContain('Press');
  });

  it('darkens the face on the down state only', () => {
    const doc = Document.Open(buildBlankPage());
    const w = widget();
    buildPushButtonAP(doc, w, new Map(), face());
    // mkOps writes the face as "<r> <g> <b> rg 0 0 <w> <h> re f", all on one line.
    const grey = (s: string) => Number(/([\d.]+) [\d.]+ [\d.]+ rg 0 0 /.exec(s)![1]);
    expect(grey(body(doc, w, 'N'))).toBeCloseTo(0.86, 3);
    expect(grey(body(doc, w, 'R'))).toBeCloseTo(0.86, 3);
    expect(grey(body(doc, w, 'D'))).toBeLessThan(0.86);
  });

  it('registers the icon and draws it', () => {
    const doc = Document.Open(buildBlankPage());
    const w = widget();
    const icon = buildImageXObject(makePng());
    buildPushButtonAP(doc, w, new Map(), face({ position: 'icon-only', icon }));
    const n = doc.resolve(ap(doc, w).get('N')) as { dict: PdfDict; raw: Uint8Array };
    const res = doc.resolve(n.dict.get('Resources')) as PdfDict;
    const xo = doc.resolve(res.get('XObject'));
    expect(isDict(xo)).toBe(true);
    expect([...(xo as PdfDict).keys()].length).toBe(1);
    expect(new TextDecoder('latin1').decode(n.raw)).toContain(' Do');
  });

  it('exposes the icon as a /MK /I form XObject the streams share', () => {
    const doc = Document.Open(buildBlankPage());
    const w = widget();
    w.set('MK', new Map<string, PdfObject>());
    buildPushButtonAP(doc, w, new Map(), face({
      position: 'icon-only', icon: buildImageXObject(makePng()),
    }));

    // Table 189 /I is a *form* XObject, not the image itself — a viewer
    // regenerating the face draws /I directly.
    const mk = doc.resolve(w.get('MK')) as PdfDict;
    const iRef = mk.get('I')!;
    const form = doc.resolve(iRef) as PdfStream;
    expect(isStream(form)).toBe(true);
    const sub = form.dict.get('Subtype');
    expect(isName(sub) && sub.name).toBe('Form');
    expect(doc.resolve(form.dict.get('BBox'))).toEqual([0, 0, 2, 2]); // makePng is 2x2

    // One object, referenced from both places: /MK /I and the appearance's own
    // resources. Two copies would double the icon's bytes in every save.
    const n = doc.resolve(ap(doc, w).get('N')) as PdfStream;
    const res = doc.resolve(n.dict.get('Resources')) as PdfDict;
    const xo = doc.resolve(res.get('XObject')) as PdfDict;
    expect(xo.get('BtnIco')).toEqual(iRef);
  });

  it('records the icon fit so a regenerating viewer draws what we drew', () => {
    const doc = Document.Open(buildBlankPage());
    const w = widget();
    w.set('MK', new Map<string, PdfObject>());
    buildPushButtonAP(doc, w, new Map(), face({
      position: 'icon-only', icon: buildImageXObject(makePng()),
    }));
    // iconOps draws the icon proportionally scaled and centred; /IF is the only
    // way to say so, and without it a viewer stretches the icon to the box.
    const iff = doc.resolve((doc.resolve(w.get('MK')) as PdfDict).get('IF')) as PdfDict;
    const nm = (k: string) => { const v = doc.resolve(iff.get(k)); return isName(v) && v.name; };
    expect(nm('SW')).toBe('A');   // always scale
    expect(nm('S')).toBe('P');    // proportionally
    expect(doc.resolve(iff.get('A'))).toEqual([0.5, 0.5]);  // centred
  });

  it('writes no /MK /I for a button with no icon', () => {
    const doc = Document.Open(buildBlankPage());
    const w = widget();
    buildPushButtonAP(doc, w, new Map(), face());
    const mk = doc.resolve(w.get('MK')) as PdfDict;
    expect(mk.has('I')).toBe(false);
    expect(mk.has('IF')).toBe(false);
  });

  it('gives each layout a different stream', () => {
    const doc = Document.Open(buildBlankPage());
    const icon = buildImageXObject(makePng());
    const bodies = new Map<ButtonIconPosition, string>();
    for (const position of BUTTON_POSITIONS) {
      const w = widget();
      buildPushButtonAP(doc, w, new Map(), face({
        position, icon: position === 'caption-only' ? undefined : icon,
      }));
      bodies.set(position, body(doc, w, 'N'));
    }
    const seen = [...bodies.values()];
    // Pairwise distinct: a layout function that ignores the mode fails here.
    expect(new Set(seen).size).toBe(seen.length);
  });
});
