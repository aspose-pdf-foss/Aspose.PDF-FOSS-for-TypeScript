import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isName } from '../src/types.js';
import {
  buildArtifactsPdf, buildNamedArtifactPdf, buildNestedArtifactPdf,
  buildFormArtifactPdf, buildArtifactAroundFormPdf, buildEmptyArtifactPdf,
  buildUnbalancedArtifactPdf, buildReversedBBoxArtifactPdf,
  buildCollidingArtifactPdf, buildInkArtifactsPdf,
} from './helpers/build-artifacts-pdf.js';
import { buildBlankPage } from './helpers/build-blank-page.js';

const artifacts = (bytes: Uint8Array) => Document.Open(bytes).Pages[0].Artifacts;

describe('page.Artifacts — the declared property list', () => {
  it('reports a declared /Type, /Subtype and /Attached', () => {
    const a = artifacts(buildArtifactsPdf());
    const header = a.find((x) => x.subtype === 'Header');
    expect(header).toBeDefined();
    expect(header!.type).toBe('Pagination');
    expect(header!.attached).toEqual(['Top']);   // /Sideways is not an edge
  });

  it('reports a declared /BBox verbatim, flagged as declared', () => {
    const header = artifacts(buildArtifactsPdf()).find((x) => x.subtype === 'Header')!;
    // The ink inside it is [20,175,120,185]; the declaration is wider, and the
    // declaration is what a producer said.
    expect(header.bbox).toEqual([10, 170, 190, 190]);
    expect(header.bboxSource).toBe('declared');
  });

  it('exposes the raw property list for keys it does not model', () => {
    const header = artifacts(buildArtifactsPdf()).find((x) => x.subtype === 'Header')!;
    const t = header.properties?.get('Type');
    expect(isName(t) && t.name).toBe('Pagination');
  });

  it('resolves a property list named through /Resources /Properties', () => {
    const a = artifacts(buildNamedArtifactPdf());
    expect(a).toHaveLength(1);
    expect(a[0].type).toBe('Layout');
    expect(a[0].bbox).toEqual([0, 0, 50, 50]);
  });

  it('normalizes a /BBox written corner-to-corner the other way round', () => {
    const a = artifacts(buildReversedBBoxArtifactPdf());
    expect(a[0].bbox).toEqual([20, 30, 80, 90]);
    expect(a[0].bboxSource).toBe('declared');
  });

  it('leaves every declared field undefined for a bare /Artifact BMC', () => {
    const bare = artifacts(buildArtifactsPdf()).find((x) => x.type === undefined)!;
    expect(bare.subtype).toBeUndefined();
    expect(bare.attached).toBeUndefined();
    expect(bare.properties).toBeUndefined();
  });

  it('does not report a non-artifact marked-content sequence', () => {
    // The fixture's /Span BDC draws a rectangle too; only the two /Artifact
    // scopes are artifacts.
    expect(artifacts(buildArtifactsPdf())).toHaveLength(2);
  });

  it('reports nothing for a page with no marked content', () => {
    expect(artifacts(buildBlankPage())).toEqual([]);
  });
});

describe('page.Artifacts — the measured extent', () => {
  it('measures the ink a bare /Artifact BMC encloses, flagged as content', () => {
    const bare = artifacts(buildArtifactsPdf()).find((x) => x.type === undefined)!;
    expect(bare.bbox).toEqual([40, 40, 60, 70]);
    expect(bare.bboxSource).toBe('content');
  });

  it('reports no bbox for an artifact enclosing no ink', () => {
    const a = artifacts(buildEmptyArtifactPdf());
    expect(a).toHaveLength(2);
    expect(a[0].type).toBe('Layout');
    expect(a[0].bbox).toBeUndefined();
    expect(a[0].bboxSource).toBeUndefined();
    // ...while the one beside it, which draws, still measures.
    expect(a[1].bbox).toEqual([1, 2, 4, 6]);
  });

  it('measures an artifact whose ink is drawn inside a form it invokes', () => {
    // The scope opens on the page and closes on the page; every glyph and path
    // between sits in the form, under `2 0 0 2 100 100 cm`.
    const a = artifacts(buildArtifactAroundFormPdf());
    expect(a).toHaveLength(1);
    expect(a[0].addr.path).toEqual([]);
    expect(a[0].bbox).toEqual([100, 100, 140, 140]);
  });

  it('measures an image an artifact encloses', () => {
    const [img] = artifacts(buildInkArtifactsPdf());
    expect(img.bbox).toEqual([150, 20, 170, 30]);
  });

  it('measures the text an artifact encloses', () => {
    const [, text] = artifacts(buildInkArtifactsPdf());
    // Helvetica 12pt "Hi": H 722 + i 222 = 944/1000 em = 11.328pt wide,
    // the box running baseline..baseline+size.
    expect(text.bbox).toEqual([100, 700, 111.328, 712]);
  });

  it('attributes ink by the whole address, not stream and op alone', () => {
    // Both scopes sit at stream 0, op 0; only the XObject chain tells them apart.
    const [page, form] = artifacts(buildCollidingArtifactPdf());
    expect(page.addr.path).toEqual([]);
    expect(form.addr.path).toEqual(['Fm0']);
    expect(form.bbox).toEqual([100, 100, 120, 120]);
    expect(page.bbox).toEqual([5, 5, 120, 120]);
  });

  it('still reports an /Artifact BMC that is never closed', () => {
    const a = artifacts(buildUnbalancedArtifactPdf());
    expect(a).toHaveLength(1);
    expect(a[0].bbox).toEqual([10, 10, 30, 30]);
  });
});

describe('page.Artifacts — nesting and Form XObjects', () => {
  it('addresses an artifact inside a form by the XObject chain', () => {
    const a = artifacts(buildFormArtifactPdf());
    expect(a).toHaveLength(1);
    expect(a[0].addr.path).toEqual(['Fm0']);
    // ...and measures it in page space, not the form's own.
    expect(a[0].bbox).toEqual([100, 100, 140, 140]);
  });

  it('reports a nested artifact as its own entry naming its parent', () => {
    const a = artifacts(buildNestedArtifactPdf());
    expect(a).toHaveLength(2);
    expect(a[0].type).toBe('Page');
    expect(a[0].parent).toBeUndefined();
    expect(a[1].type).toBe('Layout');
    expect(a[1].parent).toEqual(a[0].addr);
  });

  it('covers a nested scope’s ink in the enclosing scope’s extent', () => {
    const [outer, inner] = artifacts(buildNestedArtifactPdf());
    expect(inner.bbox).toEqual([100, 100, 120, 120]);
    // The outer draws only [10,10,30,30] itself; the inner is inside it
    // geometrically as well as syntactically.
    expect(outer.bbox).toEqual([10, 10, 120, 120]);
  });
});

describe('page.Artifacts — content this library itself writes', () => {
  it('enumerates a PageGraphics BeginArtifact drawing', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    page.Graphics()
      .BeginArtifact()
      .setFillColor([0, 0, 0])
      .rect(30, 40, 50, 60)
      .fill()
      .EndMarkedContent()
      .apply();

    const a = Document.Open(doc.Save()).Pages[0].Artifacts;
    expect(a).toHaveLength(1);
    // Bare `/Artifact BMC` — `wrapArtifact` and `BeginArtifact` declare no
    // property list at all, so the extent is the only thing to report.
    expect(a[0].type).toBeUndefined();
    expect(a[0].bboxSource).toBe('content');
    expect(a[0].bbox).toEqual([30, 40, 80, 100]);
  });
});
