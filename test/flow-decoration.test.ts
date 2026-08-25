import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/flow.js';
import { measureText } from '../src/stamp.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import type { Page } from '../src/page.js';

const decoded = (page: Page) => new TextDecoder('latin1').decode(page.Contents);

// A flow is created on the Document and `Render()` APPENDS the laid-out pages
// and returns them — the decorated content is on the returned page.
const opts = () => ({
  format: PageFormat.custom(300, 500), columns: 1,
  marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20,
});

describe('Flow paragraph decoration', () => {
  it('forwards underline to the laid paragraph', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    flow.AddParagraph('hello world', { fontSize: 12, underline: true });
    expect(decoded(flow.Render()[0])).toContain('re f');
  });

  it('forwards background and strikethrough', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    flow.AddParagraph('hello', { fontSize: 12, background: [0, 0, 1], strikethrough: true });
    const c = decoded(flow.Render()[0]);
    expect(c).toContain('0 0 1 rg');
    expect((c.match(/re f/g) ?? []).length).toBe(2);
  });

  it('a heading inherits the same options', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    flow.AddHeading(1, 'Title', { underline: true });
    expect(decoded(flow.Render()[0])).toContain('re f');
  });

  it('an undecorated paragraph emits no rects', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    flow.AddParagraph('hello world', { fontSize: 12 });
    expect(decoded(flow.Render()[0])).not.toContain('re f');
  });
});

describe('Flow list decoration', () => {
  it('forwards underline to the item body', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    flow.AddList(['alpha'], { ordered: true, fontSize: 12, underline: true });
    expect(decoded(flow.Render()[0])).toContain('re f');
  });

  it('forwards background and strikethrough to the item body', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    flow.AddList(['alpha'], {
      ordered: true, fontSize: 12, background: [0, 0, 1], strikethrough: true,
    });
    expect(decoded(flow.Render()[0])).toContain('0 0 1 rg');
  });

  it('an undecorated list emits no rects', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    flow.AddList(['alpha', 'beta'], { ordered: true, fontSize: 12 });
    expect(decoded(flow.Render()[0])).not.toContain('re f');
  });

  it('underlines the ordinal marker as well as the body', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    flow.AddList(['alpha'], { ordered: true, fontSize: 12, underline: true });
    // One rule under the marker, one under the single body line.
    expect((decoded(flow.Render()[0]).match(/re f/g) ?? []).length).toBe(2);
  });

  it('places the two rules where GetPaths reads them back', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    flow.AddList(['alpha'], { ordered: true, fontSize: 12, underline: true });
    const page = flow.Render()[0];
    const rules = page.GetPaths().filter((p) => p.fill !== null)
      .sort((a, b) => a.bbox[0] - b.bbox[0]);
    expect(rules).toHaveLength(2);

    const mw = measureText('1.', 12, 'Helvetica');
    // The marker is right-aligned against the gutter, so it starts at the
    // column's left edge; the body starts one marker + one markerGap in.
    expect(rules[0].bbox[0]).toBeCloseTo(20, 3);
    expect(rules[0].bbox[2]).toBeCloseTo(20 + mw, 3);
    expect(rules[1].bbox[0]).toBeCloseTo(20 + mw + 6, 3);
    expect(rules[1].bbox[2]).toBeCloseTo(20 + mw + 6 + measureText('alpha', 12, 'Helvetica'), 3);
    // The gutter between them is blank: two runs, not one spanning rule.
    expect(rules[1].bbox[0]).toBeGreaterThan(rules[0].bbox[2]);

    // Both sit on the same baseline (480 - 12), offset -1.2, thickness 0.6.
    for (const r of rules) {
      expect(r.bbox[1]).toBeCloseTo(468 - 1.2 - 0.3, 3);
      expect(r.bbox[3]).toBeCloseTo(468 - 1.2 + 0.3, 3);
    }
  });

  it('decorates an explicit bullet string', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    flow.AddList(['alpha'], { bullet: '-', fontSize: 12, underline: true });
    expect((decoded(flow.Render()[0]).match(/re f/g) ?? []).length).toBe(2);
  });

  it('underlines the default vector bullet as well as the body', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    flow.AddList(['alpha'], { fontSize: 12, underline: true });
    // The disc itself is Beziers + `f`, never `re f`, so both rects are rules.
    expect((decoded(flow.Render()[0]).match(/re f/g) ?? []).length).toBe(2);
  });

  it("a bullet's background spans the font's ascent-to-descent, not the bullet box", () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    flow.AddList(['alpha'], { fontSize: 12, background: [0, 1, 0] });
    const page = flow.Render()[0];
    // GetPaths reports colour components in 0..255, not 0..1.
    const green = page.GetPaths().filter(
      (p) => p.fill !== null && p.fill.rgb[0] === 0 && p.fill.rgb[1] === 255 && p.fill.rgb[2] === 0);
    expect(green).toHaveLength(2); // marker background + body background

    const marker = green.sort((a, b) => a.bbox[0] - b.bbox[0])[0];
    // Horizontal extent is the bullet's own 0.35em box, at the column edge.
    expect(marker.bbox[0]).toBeCloseTo(20, 3);
    expect(marker.bbox[2]).toBeCloseTo(24.2, 3);
    // Vertical extent is the FONT's, so it aligns with the body's background
    // instead of floating as a small square at x-height.
    expect(marker.bbox[1]).toBeCloseTo(468 - 2.484, 3);
    expect(marker.bbox[3]).toBeCloseTo(468 + 8.616, 3);
  });

  it('a per-item underline decorates that item only', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    flow.AddList([{ text: 'alpha', underline: true }, 'beta'],
      { ordered: true, fontSize: 12 });
    // Item 1: marker rule + body rule. Item 2: nothing.
    expect((decoded(flow.Render()[0]).match(/re f/g) ?? []).length).toBe(2);
  });

  it('a per-item override can switch the list default off', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    flow.AddList(['alpha', { text: 'beta', underline: false }],
      { ordered: true, fontSize: 12, underline: true });
    expect((decoded(flow.Render()[0]).match(/re f/g) ?? []).length).toBe(2);
  });

  it('rejects a malformed per-item decoration', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    expect(() => flow.AddList([{ text: 'alpha', strikethrough: { thickness: -1 } }]))
      .toThrow(TypeError);
  });

  it('AddList rejects a malformed decoration before queuing anything', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    expect(() => flow.AddList(['alpha'], { underline: { color: [2, 0, 0] } }))
      .toThrow(TypeError);
    expect(() => flow.AddList(['alpha'], { background: { color: [0, 0] } as never }))
      .toThrow(TypeError);
    // Nothing was queued: the rejected calls left no content behind.
    expect(decoded(flow.Render()[0])).not.toContain('alpha');
  });
});
