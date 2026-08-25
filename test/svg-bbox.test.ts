import { describe, it, expect } from 'vitest';
import { parseXml, type XmlNode } from '../src/xml.js';
import { subtreeBBox } from '../src/svgpath.js';

const xml = (s: string) => new TextEncoder().encode(s);

/** Index every element carrying an id, as svgdraw does. */
function index(root: XmlNode): Map<string, XmlNode> {
  const m = new Map<string, XmlNode>();
  const walk = (n: XmlNode): void => {
    const id = n.attrs.get('id');
    if (id !== undefined && !m.has(id)) m.set(id, n);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return m;
}

function bbox(src: string, id?: string) {
  const root = parseXml(xml(src));
  const ids = index(root);
  const node = id === undefined ? root : ids.get(id)!;
  return subtreeBBox(node, ids);
}

const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe('subtreeBBox', () => {
  it('takes a lone shape as its own fill box', () => {
    const { box, complete } = bbox('<svg><rect id="r" x="10" y="20" width="40" height="80"/></svg>', 'r');
    expect(complete).toBe(true);
    near(box!.x, 10); near(box!.y, 20); near(box!.w, 40); near(box!.h, 80);
  });

  it('ignores stroke-width — objectBoundingBox is fill geometry', () => {
    const { box } = bbox(
      '<svg><rect id="r" x="10" y="10" width="10" height="10" stroke-width="20"/></svg>', 'r');
    near(box!.w, 10); near(box!.h, 10);
  });

  it('unions children of a group', () => {
    const { box, complete } = bbox(
      '<svg><g id="g"><rect x="0" y="0" width="10" height="10"/>' +
      '<rect x="90" y="40" width="10" height="10"/></g></svg>', 'g');
    expect(complete).toBe(true);
    near(box!.x, 0); near(box!.y, 0); near(box!.w, 100); near(box!.h, 50);
  });

  it("applies a child's transform but NOT the element's own", () => {
    const { box } = bbox(
      '<svg><g id="g" transform="translate(1000,1000)">' +
      '<rect transform="translate(5,7)" x="0" y="0" width="10" height="10"/></g></svg>', 'g');
    // The child's +5,+7 shows; the group's +1000,+1000 must not.
    near(box!.x, 5); near(box!.y, 7); near(box!.w, 10); near(box!.h, 10);
  });

  it('grows the box to cover a rotated child', () => {
    const { box } = bbox(
      '<svg><g id="g"><rect transform="rotate(45)" x="0" y="0" width="10" height="10"/></g></svg>', 'g');
    // A 10x10 square rotated 45 deg spans 10*sqrt(2) on each axis.
    near(box!.w, Math.SQRT2 * 10);
    near(box!.h, Math.SQRT2 * 10);
  });

  it('contributes nothing from defs', () => {
    const { box, complete } = bbox(
      '<svg><g id="g"><defs><rect x="0" y="0" width="500" height="500"/></defs>' +
      '<rect x="10" y="10" width="10" height="10"/></g></svg>', 'g');
    expect(complete).toBe(true);
    near(box!.w, 10);
  });

  it('follows a use and applies its shift', () => {
    const { box, complete } = bbox(
      '<svg><defs><rect id="r" x="0" y="0" width="10" height="10"/></defs>' +
      '<g id="g"><use href="#r" x="30" y="40"/></g></svg>', 'g');
    expect(complete).toBe(true);
    near(box!.x, 30); near(box!.y, 40); near(box!.w, 10); near(box!.h, 10);
  });

  it('reports incomplete for an unresolvable use', () => {
    const { complete } = bbox('<svg><g id="g"><use href="#nope"/></g></svg>', 'g');
    expect(complete).toBe(false);
  });

  it('breaks a use cycle instead of recursing forever', () => {
    const { complete } = bbox(
      '<svg><g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g></svg>', 'a');
    expect(complete).toBe(false);   // returns, does not hang
  });

  it('reports incomplete for text with no measure callback', () => {
    const { complete } = bbox(
      '<svg><g id="g"><rect x="0" y="0" width="10" height="10"/>' +
      '<text x="0" y="0">hi</text></g></svg>', 'g');
    expect(complete).toBe(false);
  });

  it('covers an image placement rect', () => {
    const { box } = bbox(
      '<svg><g id="g"><image x="5" y="6" width="20" height="30"/></g></svg>', 'g');
    near(box!.x, 5); near(box!.y, 6); near(box!.w, 20); near(box!.h, 30);
  });

  it('returns a null box for an empty group', () => {
    const { box, complete } = bbox('<svg><g id="g"/></svg>', 'g');
    expect(box).toBeNull();
    expect(complete).toBe(true);
  });
});
