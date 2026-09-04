import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { inflateStream } from '../src/flate.js';
import { isStream } from '../src/types.js';
import {
  buildInheritedResourcesPdf, buildUnresolvableSpacePdf, buildInheritedShadingOnlyPdf,
} from './helpers/build-grayscale-pdf.js';
import { colorOps, type SpaceLookup } from '../src/colorops.js';
import type { ContentOp } from '../src/content.js';
import { name } from '../src/types.js';

/** Every content stream in the saved document, as text. */
function allContent(bytes: Uint8Array): string {
  const doc = Document.Open(bytes);
  const out: string[] = [];
  for (const [, obj] of doc.objectEntries()) {
    if (!isStream(obj)) continue;
    try { out.push(new TextDecoder().decode(inflateStream(obj))); } catch { /* not content */ }
  }
  return out.join('\n');
}

/**
 * A page whose `/Resources` is INHERITED from the page tree (85l8.5).
 *
 * `/Resources` is an inheritable page attribute (32000-1 7.7.3.4) and
 * `page.Resources` walks `/Parent` for it, but `colorconvert.ts` read
 * `page.Dict.get('Resources')`, which does not. With no resources in hand the
 * whole walk degrades at once, and every symptom below was measured on this
 * fixture before the fix:
 *
 *   - `/CS0 cs 1 0 0 sc` converting to rgb emitted `1 1 1 rg` -- RED BECAME
 *     WHITE, because the unresolvable name fell back to DeviceGray and three
 *     operands were read as one.
 *   - converting to gray emitted `/DeviceGray cs 1 0 0 sc`, three operands in
 *     a one-component space, which is malformed rather than merely wrong.
 *   - the form XObject and the named shading were never walked at all, so a
 *     GREYSCALED document still painted pure blue.
 *   - `skipped` was `[]` throughout.
 *
 * This predates 85l8.1's generalization: `ConvertToGrayscale` has shipped this
 * way, so the issue's framing of it as fallout from the target parameter was
 * wrong.
 */
describe('ConvertColors resolves resources inherited from the page tree', () => {
  // The `sc` keeps its operator here rather than becoming `rg`, because the
  // space it names IS the target and `isTarget` short-circuits it -- a rule
  // that predates this issue. What matters is that the operands survive: red
  // came out `1 1 1 rg`, pure white, when the space could not be resolved.
  it('converts a colour named by an inherited /ColorSpace entry', () => {
    const doc = Document.Open(buildInheritedResourcesPdf());
    doc.ConvertColors({ to: 'rgb' });
    const text = allContent(doc.Save());
    expect(text).toContain('/DeviceRGB cs');
    expect(text).toContain('1 0 0 sc');          // red, and still red
    expect(text).not.toContain('1 1 1');         // not white
  });

  it('reads the operands in the space the resource actually names', () => {
    const doc = Document.Open(buildInheritedResourcesPdf());
    doc.ConvertColors({ to: 'gray' });
    // luma(1, 0, 0). Read as DeviceGray it would have kept `1 0 0 sc`.
    expect(allContent(doc.Save())).toContain('0.299 g');
  });

  it('leaves no sc whose operand count contradicts the space it declares', () => {
    const doc = Document.Open(buildInheritedResourcesPdf());
    doc.ConvertColors({ to: 'gray' });
    expect(allContent(doc.Save())).not.toContain('1 0 0 sc');
  });

  it('walks a form XObject reachable only through the inherited resources', () => {
    const doc = Document.Open(buildInheritedResourcesPdf());
    doc.ConvertColors({ to: 'gray' });
    const text = allContent(doc.Save());
    expect(text).toContain('0.114 g');           // luma of pure blue
    expect(text).not.toContain('0 0 1 rg');
  });

  // The page loop in `convertShadings` exists for exactly this shape: with no
  // /Contents there is no scope, so the inherited resources reach the shading
  // walk by no other route. Without this case, fixing that loop's own resource
  // read reddens nothing — measured.
  it('converts an inherited shading on a page with no content stream', () => {
    const doc = Document.Open(buildInheritedShadingOnlyPdf());
    expect(doc.ConvertColors({ to: 'gray' }).shadings).toBe(1);
  });

  it('converts a shading reachable only through the inherited resources', () => {
    const doc = Document.Open(buildInheritedResourcesPdf());
    const report = doc.ConvertColors({ to: 'gray' });
    expect(report.shadings).toBe(1);
  });
});

/**
 * A `cs` naming a colour space that is in NO resource dict (85l8.5).
 *
 * With `page.Resources` in hand this is a damaged file rather than an everyday
 * one, but the answer still has to be right. It used to fall back to
 * DeviceGray and convert as though the document had said so, which is wrong in
 * two different ways depending on the target: to rgb, `sc 1 0 0` read as one
 * grey component and came out white; to gray, the `cs` was retargeted while
 * the `sc` was left alone, leaving `/DeviceGray cs 1 0 0 sc` -- three operands
 * in a one-component space, malformed rather than merely wrong.
 *
 * Both come from the same mistake: converting a colour whose space nobody
 * established. So the operators are LEFT, exactly as the document wrote them,
 * and the name is reported. That is the epic's own rule -- what cannot convert
 * is reported rather than silently mis-stated -- and it costs what the report
 * then says it costs: colour survives in the document.
 */
describe('colorOps refuses to convert a colour whose space it cannot resolve', () => {
  const op = (operator: string, ...operands: unknown[]): ContentOp =>
    ({ operator, operands: operands as ContentOp['operands'] });
  const none: SpaceLookup = () => undefined;

  it('leaves the cs and the sc exactly as written', () => {
    const ops = [op('cs', name('CS0')), op('sc', 1, 0, 0)];
    const r = colorOps(ops, none, 'rgb');
    expect(r.ops).toEqual(ops);
    expect(r.changed).toBe(0);
  });

  it('reports the resource name it could not resolve', () => {
    const r = colorOps([op('cs', name('CS0')), op('sc', 1, 0, 0)], none, 'rgb');
    expect([...r.unresolvedSpaces]).toEqual(['CS0']);
  });

  it('reports a stroke space too', () => {
    const r = colorOps([op('CS', name('CSx')), op('SC', 1, 0, 0)], none, 'cmyk');
    expect([...r.unresolvedSpaces]).toEqual(['CSx']);
    expect(r.changed).toBe(0);
  });

  // A name repeated down a long stream is one fault, not one per use.
  it('names each unresolvable space once', () => {
    const r = colorOps(
      [op('cs', name('CS0')), op('sc', 1, 0, 0),
        op('cs', name('CS0')), op('sc', 0, 1, 0)], none, 'rgb');
    expect([...r.unresolvedSpaces]).toEqual(['CS0']);
  });

  it('says nothing about a device space, which needs no resource entry', () => {
    const r = colorOps([op('cs', name('DeviceRGB')), op('sc', 1, 0, 0)], none, 'gray');
    expect([...r.unresolvedSpaces]).toEqual([]);
    expect(r.ops[1]).toEqual(op('g', 0.299));
  });

  // The refusal is scoped to the space in force, not latched for the stream.
  it('converts normally again once a resolvable space is set', () => {
    const r = colorOps(
      [op('cs', name('CS0')), op('sc', 1, 0, 0),
        op('cs', name('DeviceRGB')), op('sc', 0, 0, 1)], none, 'gray');
    expect(r.ops[1]).toEqual(op('sc', 1, 0, 0));   // refused
    expect(r.ops[3]).toEqual(op('g', 0.114));      // converted
  });

  it('restores the space a Q pops back to', () => {
    const r = colorOps(
      [op('cs', name('DeviceRGB')), op('q'), op('cs', name('CS0')),
        op('Q'), op('sc', 1, 0, 0)], none, 'gray');
    expect(r.ops[4]).toEqual(op('g', 0.299));      // back in DeviceRGB
  });

  it('leaves an uncoloured pattern scn alone under an unresolved space', () => {
    const ops = [op('cs', name('CSp')), op('scn', 1, 0, 0, name('P0'))];
    const r = colorOps(ops, none, 'gray');
    expect(r.ops).toEqual(ops);
  });
});

describe('ConvertColors reports a colour space it could not resolve', () => {
  it('names the stream and the resource key', () => {
    const doc = Document.Open(buildUnresolvableSpacePdf());
    const report = doc.ConvertColors({ to: 'rgb' });
    expect(report.skipped).toEqual([{
      objNum: 4, what: 'content',
      reason: 'colour space /CS0 is not in the resources; '
        + 'its colour operators were left unconverted',
    }]);
  });

  it('leaves that colour in the document rather than mis-stating it', () => {
    const doc = Document.Open(buildUnresolvableSpacePdf());
    doc.ConvertColors({ to: 'rgb' });
    expect(allContent(doc.Save())).toContain('/CS0 cs');
  });
});
