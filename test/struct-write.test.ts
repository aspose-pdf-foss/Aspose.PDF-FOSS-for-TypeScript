import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isDict, isArray, isName } from '../src/types.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';
import { buildPngRgb } from './helpers/build-embed-images.js';
import { buildAnnotTarget } from './helpers/build-annot-target.js';

describe('Document.CreateStructTree', () => {
  it('creates a marked struct tree on an untagged doc', () => {
    const doc = Document.Open(buildStampTarget());
    expect(doc.IsTagged).toBe(false);
    const root = doc.CreateStructTree();
    expect(doc.IsTagged).toBe(true);
    expect(root.Children).toEqual([]);
    // round-trips
    const re = Document.Open(doc.Save());
    expect(re.IsTagged).toBe(true);
    expect(re.GetStructTree()).not.toBeNull();
  });

  it('is idempotent (no duplicate root / ParentTree / MarkInfo)', () => {
    const doc = Document.Open(buildStampTarget());
    const a = doc.CreateStructTree();
    const b = doc.CreateStructTree();
    expect(b.Ref!.num).toBe(a.Ref!.num);
    const cat = (doc as any).catalog();
    const mi = doc.resolve(cat.get('MarkInfo'));
    expect(isDict(mi) && doc.resolve((mi as Map<string, any>).get('Marked'))).toBe(true);
    const pt = doc.resolve(a.Dict.get('ParentTree'));
    expect(isDict(pt) && isArray(doc.resolve((pt as Map<string, any>).get('Nums')))).toBe(true);
  });

  it('sets the document language', () => {
    const doc = Document.Open(buildStampTarget());
    doc.Lang = 'en-US';
    const re = Document.Open(doc.Save());
    expect(re.Lang).toBe('en-US');
  });
});

describe('struct tree write API', () => {
  it('builds a tree and round-trips element properties through S1', () => {
    const doc = Document.Open(buildStampTarget());
    const root = doc.CreateStructTree();
    const sect = root.Append('Sect', { title: 'Body' });
    const h1 = sect.Append('H1', { lang: 'en-GB' });
    h1.Alt = 'Heading one';
    sect.Append('P');

    const re = Document.Open(doc.Save());
    const rroot = re.GetStructTree()!;
    expect(rroot.Children.map((c) => c.Type)).toEqual(['Sect']);
    const rsect = rroot.Children[0];
    expect(rsect.Title).toBe('Body');
    expect(rsect.Children.map((c) => c.Type)).toEqual(['H1', 'P']);
    const rh1 = rsect.Children[0];
    expect(rh1.Alt).toBe('Heading one');
    expect(rh1.Lang).toBe('en-GB');
    expect(rh1.Parent!.Type).toBe('Sect');
  });

  it('registers a custom role resolved through RoleMap', () => {
    const doc = Document.Open(buildStampTarget());
    const root = doc.CreateStructTree();
    root.RegisterRole('Subtitle', 'P');
    root.Append('Subtitle');
    const re = Document.Open(doc.Save());
    const re0 = re.GetStructTree()!.Children[0];
    expect(re0.Type).toBe('Subtitle');
    expect(re0.StandardType).toBe('P');
    expect(re0.IsStandardType).toBe(true);
  });

  it('clears a property when set to undefined', () => {
    const doc = Document.Open(buildStampTarget());
    const root = doc.CreateStructTree();
    const e = root.Append('P', { alt: 'x' });
    e.Alt = undefined;
    expect(e.Alt).toBeUndefined();
  });
});

describe('low-level marked content (NextMcid)', () => {
  it('allocates an MCID, wires ParentTree + /K, and resolves via ElementFor', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const root = doc.CreateStructTree();
    const p = root.Append('P');
    const mcid = p.NextMcid(page);
    expect(mcid).toBe(0);

    const re = Document.Open(doc.Save());
    const rpage = re.Pages[0];
    const spKey = re.resolve(rpage.Dict.get('StructParents')) as number;
    expect(typeof spKey).toBe('number');
    const found = re.GetStructTree()!.ElementFor(spKey, 0);
    expect(found!.Type).toBe('P');
  });

  it('increments MCID per page and sets the element /Pg', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const root = doc.CreateStructTree();
    const p = root.Append('P');
    expect(p.NextMcid(page)).toBe(0);
    expect(p.NextMcid(page)).toBe(1);
    const pg = p.Dict.get('Pg');
    expect(pg && (pg as any).num).toBe((doc as any).pageRef(page.Number).num);
    const k = doc.resolve(p.Dict.get('K')) as any[];
    expect(k).toEqual([0, 1]);
  });
});

describe('tag-aware AddText / AddTextBlock', () => {
  it('round-trips tagged text into reading-order GetText + ElementFor', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const root = doc.CreateStructTree();
    const sect = root.Append('Sect');
    const h1 = sect.Append('H1');
    page.AddText('Title', 72, 700, { tag: h1 });
    const p = sect.Append('P');
    page.AddTextBlock('Body text here.', [72, 600, 400, 80], { tag: p });

    const re = Document.Open(doc.Save());
    const rroot = re.GetStructTree()!;
    expect(rroot.GetText()).toContain('Title');
    expect(rroot.GetText()).toContain('Body text here.');
    const spKey = re.resolve(re.Pages[0].Dict.get('StructParents')) as number;
    expect(re.GetStructTree()!.ElementFor(spKey, 0)!.Type).toBe('H1');
    expect(re.GetStructTree()!.ElementFor(spKey, 1)!.Type).toBe('P');
  });

  it('emits a BDC/EMC pair around the tagged body', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const h = doc.CreateStructTree().Append('H2');
    page.AddText('X', 72, 700, { tag: h });
    const content = new TextDecoder('latin1').decode(page.Contents);
    expect(content).toContain('/H2 <</MCID 0>> BDC');
    expect(content).toContain('EMC');
  });

  it('uses MCR entries when one element spans two pages', () => {
    const doc = Document.Open(buildStampTarget());
    doc.AddPage(); // blank second page
    const root = doc.CreateStructTree();
    const p = root.Append('P');
    doc.Pages[0].AddText('one', 72, 700, { tag: p });
    doc.Pages[1].AddText('two', 72, 700, { tag: p });
    const k = doc.resolve(p.Dict.get('K')) as any[];
    expect(k[0]).toBe(0); // first page: integer MCID
    const second = k[1] as Map<string, any>;
    expect(isName(second.get('Type'))).toBe(true);
    expect((second.get('Type') as any).name).toBe('MCR');
  });
});

describe('tag-aware AddImage', () => {
  it('tags an image as a Figure with /Alt and resolves via ElementFor', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const root = doc.CreateStructTree();
    const fig = root.Append('Figure', { alt: 'A red square' });
    page.AddImage(buildPngRgb(), [72, 500, 64, 64], { tag: fig });

    const content = new TextDecoder('latin1').decode(page.Contents);
    expect(content).toContain('/Figure <</MCID 0>> BDC');

    const re = Document.Open(doc.Save());
    const spKey = re.resolve(re.Pages[0].Dict.get('StructParents')) as number;
    const found = re.GetStructTree()!.ElementFor(spKey, 0)!;
    expect(found.Type).toBe('Figure');
    expect(found.Alt).toBe('A red square');
  });
});

describe('PageGraphics marked content', () => {
  it('marks vector content with an MCID that resolves to its element', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const root = doc.CreateStructTree();
    const fig = root.Append('Figure', { alt: 'box' });

    const gfx = page.Graphics();
    const mcid = fig.NextMcid(gfx.page);
    gfx.BeginMarkedContent(fig.Type, mcid)
      .setFillColor([1, 0, 0]).drawRect(72, 400, 50, 50).fill()
      .EndMarkedContent();
    gfx.apply();

    const content = new TextDecoder('latin1').decode(page.Contents);
    expect(content).toContain('/Figure <</MCID 0>> BDC');
    expect(content).toContain('EMC');

    const re = Document.Open(doc.Save());
    const spKey = re.resolve(re.Pages[0].Dict.get('StructParents')) as number;
    expect(re.GetStructTree()!.ElementFor(spKey, 0)!.Type).toBe('Figure');
  });
});

describe('tag annotations (OBJR / StructParent)', () => {
  it('round-trips a tagged Link via ElementForObject', () => {
    const doc = Document.Open(buildAnnotTarget());
    const page = doc.Pages[0];
    const root = doc.CreateStructTree();
    const link = root.Append('Link');
    const annot = page.AddLink({
      rect: [72, 700, 200, 720],
      action: { type: 'uri', uri: 'https://example.com' },
    });
    link.AddAnnotation(annot);

    // OBJR appended to the element's /K
    const k = doc.resolve(link.Dict.get('K')) as any[];
    expect(((k[k.length - 1] as Map<string, any>).get('Type') as any).name).toBe('OBJR');

    const re = Document.Open(doc.Save());
    const annots = re.resolve(re.Pages[0].Dict.get('Annots')) as any[];
    let spKey: number | undefined;
    for (const a of annots) {
      const d = re.resolve(a) as Map<string, any>;
      const sp = re.resolve(d.get('StructParent'));
      if (typeof sp === 'number') spKey = sp;
    }
    expect(spKey).toBeDefined();
    expect(re.GetStructTree()!.ElementForObject(spKey!)!.Type).toBe('Link');
  });
});
