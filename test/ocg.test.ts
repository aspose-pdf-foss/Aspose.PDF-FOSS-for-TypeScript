import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isStream, isArray } from '../src/types.js';
import { decodeStream } from '../src/filters.js';
import { buildOcgPdf } from './helpers/build-ocg-pdf.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';
import { buildOcmdVePdf } from './helpers/build-ocmd-ve-pdf.js';
import { buildOcmdPrunePdf } from './helpers/build-ocmd-prune-pdf.js';
import { buildOcgXObjectPdf } from './helpers/build-ocg-xobject-pdf.js';
import { buildOcgNestedXObjectPdf } from './helpers/build-ocg-nested-xobject-pdf.js';
import { buildOcgDoPdf } from './helpers/build-ocg-do-pdf.js';
import { name, isRef } from '../src/types.js';

describe('OCG enumeration', () => {
  it('lists layers with names and intent', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    expect(oc.Layers.map((l) => l.Name)).toEqual(['Layer A', 'Layer B', 'Layer C']);
    expect(oc.GetLayer('Layer B')?.Name).toBe('Layer B');
    expect(oc.GetLayer('nope')).toBeUndefined();
    expect(oc.Layers[0].Intent).toEqual(['View']); // explicit /View
    expect(oc.Layers[1].Intent).toEqual(['View']); // default when absent
  });

  it('returns an empty layer list when /OCProperties is absent', () => {
    const empty = Document.Open(buildOcgPdf());
    empty.catalog().delete('OCProperties');
    expect(empty.OptionalContent.Layers).toEqual([]);
  });
});

describe('OCG visibility (default config)', () => {
  it('resolves default visibility from /ON, /OFF and BaseState', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    const [a, b, c] = oc.Layers;
    expect(a.Visible).toBe(true);  // BaseState ON, not in OFF
    expect(b.Visible).toBe(false); // in /OFF
    expect(c.Visible).toBe(true);  // BaseState ON
    expect(oc.Default.BaseState).toBe('ON');
  });

  it('toggles visibility by editing /ON and /OFF', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    const [a, b] = oc.Layers;
    b.Visible = true;
    expect(b.Visible).toBe(true);
    a.Visible = false;
    expect(a.Visible).toBe(false);
    // setting visible removes it from /OFF; setting hidden removes it from /ON
    expect(oc.Default.IsVisible(b)).toBe(true);
    expect(oc.Default.IsVisible(a)).toBe(false);
  });
});

describe('OCG named configurations', () => {
  it('enumerates named configs and their per-layer state', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    expect(oc.Configs.map((c) => c.Name)).toEqual(['Print']);
    const print = oc.GetConfig('Print')!;
    const [a, b] = oc.Layers;
    expect(print.IsVisible(a)).toBe(true);  // in /ON
    expect(print.IsVisible(b)).toBe(false); // BaseState OFF, not in /ON
  });

  it('adds, renames and removes configs', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    const cfg = oc.AddConfig('Screen');
    expect(oc.Configs.map((c) => c.Name)).toEqual(['Print', 'Screen']);
    cfg.Name = 'Web';
    expect(oc.GetConfig('Web')).toBeDefined();
    oc.RemoveConfig(cfg);
    expect(oc.Configs.map((c) => c.Name)).toEqual(['Print']);
  });

  it('reads and edits the Locked list of the default config', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    const [a, , c] = oc.Layers;
    expect(oc.Default.Locked.map((l) => l.Name)).toEqual(['Layer C']);
    oc.Default.SetLocked(a, true);
    expect(oc.Default.Locked.map((l) => l.Name).sort()).toEqual(['Layer A', 'Layer C']);
    oc.Default.SetLocked(c, false);
    expect(oc.Default.Locked.map((l) => l.Name)).toEqual(['Layer A']);
  });
});

describe('OCG RemoveLayer — definitions/annots/xobjects', () => {
  it('removes the layer from /OCGs and the default config arrays', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    const b = oc.GetLayer('Layer B')!;
    oc.RemoveLayer(b);
    expect(oc.Layers.map((l) => l.Name)).toEqual(['Layer A', 'Layer C']);
    // /D /OFF no longer references B
    expect(oc.Default.IsVisible(oc.Layers[0])).toBe(true);
    // /Order no longer references B (length 2)
    const ocProps = doc.resolve(doc.catalog().get('OCProperties')) as Map<string, unknown>;
    const d = doc.resolve(ocProps.get('D') as never) as Map<string, unknown>;
    expect((doc.resolve(d.get('Order') as never) as unknown[]).length).toBe(2);
  });

  it('drops annotations bound to the layer', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    oc.RemoveLayer(oc.GetLayer('Layer B')!);
    const annots = doc.resolve(doc.Pages[0].Dict.get('Annots'));
    expect(Array.isArray(annots) ? annots.length : 0).toBe(0);
  });

  it('removes an XObject whose sole purpose was the deleted layer', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    const res = doc.Pages[0].Resources!;
    const fm0Ref = (doc.resolve(res.get('XObject')) as Map<string, unknown>).get('Fm0');
    oc.RemoveLayer(oc.GetLayer('Layer C')!); // Fm0 is /OC-bound to Layer C
    const xobjs = doc.resolve(res.get('XObject')) as Map<string, unknown>;
    expect(xobjs.has('Fm0')).toBe(false);           // resource entry removed
    expect(doc.resolve(fm0Ref as never)).toBeNull(); // object deleted
  });
});

/** Decoded concatenation of a page's /Contents streams, as text. */
function pageContentText(doc: Document, pageIndex = 0): string {
  const c = doc.resolve(doc.Pages[pageIndex].Dict.get('Contents'));
  const refs = Array.isArray(c) ? c : [c];
  let out = '';
  for (const r of refs) {
    const s = doc.resolve(r as never);
    if (isStream(s)) out += new TextDecoder().decode(decodeStream(s));
  }
  return out;
}

describe('OCG RemoveLayer — content excision', () => {
  it('excises the inner nested block when deleting Layer B', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    oc.RemoveLayer(oc.GetLayer('Layer B')!);
    const txt = pageContentText(doc);
    expect(txt).toContain('/MC0');        // outer (Layer A) block kept
    expect(txt).not.toContain('/MC1');    // inner (Layer B) block gone
    expect(txt).not.toContain('20 20 50 50 re'); // inner body gone
    expect(txt).toContain('10 10 100 100 re');   // outer body kept
  });

  it('excises the whole outer block (with its nested child) when deleting Layer A', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    oc.RemoveLayer(oc.GetLayer('Layer A')!);
    const txt = pageContentText(doc);
    expect(txt).not.toContain('/MC0');
    expect(txt).not.toContain('/MC1');            // nested child removed with parent
    expect(txt).not.toContain('10 10 100 100 re');
    expect(txt).toContain('0 0 0 rg');            // content outside any OC block kept
  });
});

describe('OCG round-trip through Save()', () => {
  for (const compressed of [false, true]) {
    it(`preserves layers, visibility and edits (compressed=${compressed})`, () => {
      const doc = Document.Open(buildOcgPdf());
      const oc = doc.OptionalContent;
      oc.GetLayer('Layer B')!.Visible = true;       // edit /D
      oc.AddConfig('Screen');                        // add a config
      oc.RemoveLayer(oc.GetLayer('Layer C')!);       // delete a layer

      const out = doc.Save({ compressed });
      const re = Document.Open(out);
      const roc = re.OptionalContent;

      expect(roc.Layers.map((l) => l.Name)).toEqual(['Layer A', 'Layer B']);
      expect(roc.GetLayer('Layer B')!.Visible).toBe(true);
      expect(roc.Configs.map((c) => c.Name)).toEqual(['Print', 'Screen']);
      // deleted layer's XObject was un-layered and its content excised
      const txt = pageContentText(re);
      expect(txt).toContain('/MC0');
    });
  }
});

describe('OCG authoring — AddLayer', () => {
  it('creates a top-level layer in /OCGs and /D /Order, visible by default', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    const before = oc.Layers.length;
    const l = oc.AddLayer('New Layer');
    expect(l.Name).toBe('New Layer');
    expect(l.Visible).toBe(true);
    expect(l.Intent).toEqual(['View']); // default when /Intent absent
    expect(oc.Layers.length).toBe(before + 1);
    expect(oc.GetLayer('New Layer')).toBeTruthy();

    const props = doc.resolve(doc.catalog().get('OCProperties')) as Map<string, any>;
    const d = doc.resolve(props.get('D')) as Map<string, any>;
    const order = doc.resolve(d.get('Order'));
    expect(isArray(order)).toBe(true);
    // the new ref is present at the top level of /Order
    expect((order as any[]).some((e) => e && e.kind === 'ref' && e.num === l.Ref.num)).toBe(true);
  });

  it('nests a layer under a parent as a group heading in /Order', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    const parent = oc.AddLayer('Group');
    const child = oc.AddLayer('Child', { parent });

    const props = doc.resolve(doc.catalog().get('OCProperties')) as Map<string, any>;
    const d = doc.resolve(props.get('D')) as Map<string, any>;
    const order = doc.resolve(d.get('Order')) as any[];
    // find parent ref, expect the element right after it to be an array containing child
    const i = order.findIndex((e) => e && e.kind === 'ref' && e.num === parent.Ref.num);
    expect(i).toBeGreaterThanOrEqual(0);
    const kids = order[i + 1];
    expect(isArray(kids)).toBe(true);
    expect((kids as any[]).some((e) => e && e.kind === 'ref' && e.num === child.Ref.num)).toBe(true);
  });

  it('honors visible:false (adds to /D /OFF) and intent', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    const l = oc.AddLayer('Hidden', { visible: false, intent: 'Design' });
    expect(l.Visible).toBe(false);
    expect(l.Intent).toEqual(['Design']);
    expect(oc.Default.IsVisible(l)).toBe(false);
  });
});

describe('OCG authoring — round-trip', () => {
  it('re-enumerates authored layers after Save/Open', () => {
    const doc = Document.Open(buildStampTarget());
    const oc = doc.OptionalContent;
    const group = oc.AddLayer('Group');
    const child = oc.AddLayer('Child', { parent: group });
    oc.AddLayer('Hidden', { visible: false });

    const g = doc.Pages[0].Graphics();
    g.BeginLayer(child).rect(10, 10, 20, 20).fill().EndLayer();
    g.apply();

    const round = Document.Open(doc.Save());
    const names = round.OptionalContent.Layers.map((l) => l.Name);
    expect(names).toEqual(expect.arrayContaining(['Group', 'Child', 'Hidden']));
    expect(round.OptionalContent.GetLayer('Hidden')!.Visible).toBe(false);
    expect(round.OptionalContent.GetLayer('Child')!.Visible).toBe(true);

    // content still carries the /OC BDC after a serialize round-trip
    const text = new TextDecoder().decode(round.Pages[0].Contents);
    expect(text).toMatch(/\/OC\s+\/OC\d+\s+BDC/);
  });
});

describe('OCMD /VE — RemoveLayer membership', () => {
  it('drops content, annotation and XObject /OC bound to an OCMD that references the target only via /VE', () => {
    const doc = Document.Open(buildOcmdVePdf());
    const oc = doc.OptionalContent;
    const a = oc.GetLayer('Layer A')!;
    oc.RemoveLayer(a);

    // page-content /OC block excised
    const text = pageContentText(doc);
    expect(text).not.toContain('BDC');
    expect(text).not.toContain('100 100 re');

    // annotation dropped
    const annots = doc.resolve(doc.Pages[0].Dict.get('Annots'));
    expect(isArray(annots) ? (annots as any[]).length : 0).toBe(0);

    // XObject /OC cleared
    const xobjs = doc.resolve(doc.Pages[0].Resources!.get('XObject')) as Map<string, any>;
    const fm = doc.resolve([...xobjs.values()][0]) as any;
    expect(fm.dict.get('OC')).toBeUndefined();
  });

  it('survives a Save/Open round-trip after removal', () => {
    const doc = Document.Open(buildOcmdVePdf());
    doc.OptionalContent.RemoveLayer(doc.OptionalContent.GetLayer('Layer A')!);
    const re = Document.Open(doc.Save());
    expect(pageContentText(re)).not.toContain('BDC');
    const annots = re.resolve(re.Pages[0].Dict.get('Annots'));
    expect(isArray(annots) ? (annots as any[]).length : 0).toBe(0);
  });
});

describe('OCMD pruning — RemoveLayer prunes/drops dangling OCMD refs', () => {
  /** All ref leaves in a resolved /VE tree, flattened. */
  function veRefs(doc: Document, ve: any): number[] {
    const a = doc.resolve(ve);
    if (!isArray(a)) return [];
    const out: number[] = [];
    for (let i = 1; i < a.length; i++) {
      const o = a[i];
      if (isRef(o)) out.push(o.num);
      else if (isArray(doc.resolve(o))) out.push(...veRefs(doc, o));
    }
    return out;
  }

  it('prunes the deleted layer out of a surviving OCMD /OCGs and /VE', () => {
    const doc = Document.Open(buildOcmdPrunePdf());
    const oc = doc.OptionalContent;
    const a = oc.GetLayer('Layer A')!;
    const aNum = a.Ref.num;
    const bNum = oc.GetLayer('Layer B')!.Ref.num;
    oc.RemoveLayer(a);

    const props = doc.resolve(doc.Pages[0].Resources!.get('Properties')) as Map<string, any>;
    const m = doc.resolve(props.get('P1')) as Map<string, any>; // OCMD-M survives
    expect(m).toBeTruthy();

    const ocgs = doc.resolve(m.get('OCGs')) as any[];
    expect(ocgs.map((r) => r.num)).toEqual([bNum]);          // A pruned, B kept
    expect(veRefs(doc, m.get('VE'))).toEqual([bNum]);        // A pruned from /VE too
    expect(veRefs(doc, m.get('VE'))).not.toContain(aNum);
  });

  it('drops a now-empty OCMD and its /Properties entry', () => {
    const doc = Document.Open(buildOcmdPrunePdf());
    const oc = doc.OptionalContent;
    const props0 = doc.resolve(doc.Pages[0].Resources!.get('Properties')) as Map<string, any>;
    const nRef = props0.get('P2'); // OCMD-N, references A only
    expect(isRef(nRef)).toBe(true);

    oc.RemoveLayer(oc.GetLayer('Layer A')!);

    const props = doc.resolve(doc.Pages[0].Resources!.get('Properties')) as Map<string, any>;
    expect(props.has('P2')).toBe(false);                     // mapping removed
    expect(props.has('P1')).toBe(true);                      // surviving OCMD kept
    expect(doc.resolve(nRef)).toBeNull();                    // object deleted
  });

  it('survives a Save/Open round-trip with no dangling OCMD refs', () => {
    const doc = Document.Open(buildOcmdPrunePdf());
    doc.OptionalContent.RemoveLayer(doc.OptionalContent.GetLayer('Layer A')!);
    const re = Document.Open(doc.Save());

    expect(re.OptionalContent.Layers.map((l) => l.Name)).toEqual(['Layer B']);
    const bNum = re.OptionalContent.GetLayer('Layer B')!.Ref.num;
    const props = re.resolve(re.Pages[0].Resources!.get('Properties')) as Map<string, any>;
    const m = re.resolve(props.get('P1')) as Map<string, any>;
    // every ref the surviving OCMD carries resolves to a real object (no dangling)
    const ocgs = re.resolve(m.get('OCGs')) as any[];
    expect(ocgs.map((r) => r.num)).toEqual([bNum]);
    expect(veRefs(re, m.get('VE'))).toEqual([bNum]);
  });
});

describe('OCG RemoveLayer — Form XObject content excision', () => {
  /** Decoded text of the page's /Fm0 Form XObject content stream. */
  function formText(doc: Document): string {
    const xobjs = doc.resolve(doc.Pages[0].Resources!.get('XObject')) as Map<string, any>;
    const fm = doc.resolve(xobjs.get('Fm0'));
    return isStream(fm) ? new TextDecoder().decode(decodeStream(fm)) : '';
  }

  it('excises an /OC block inside a Form XObject stream, keeping other blocks', () => {
    const doc = Document.Open(buildOcgXObjectPdf());
    doc.OptionalContent.RemoveLayer(doc.OptionalContent.GetLayer('Layer B')!);

    const txt = formText(doc);
    expect(txt).toContain('/OC0');            // Layer A block kept
    expect(txt).toContain('0 0 20 20 re');
    expect(txt).not.toContain('/OC1');        // Layer B block excised
    expect(txt).not.toContain('30 30 20 20 re');
  });

  it('excises the matching Form XObject block and survives a Save/Open round-trip', () => {
    const doc = Document.Open(buildOcgXObjectPdf());
    doc.OptionalContent.RemoveLayer(doc.OptionalContent.GetLayer('Layer A')!);
    const re = Document.Open(doc.Save());

    const txt = formText(re);
    expect(txt).not.toContain('/OC0');        // Layer A block gone after round-trip
    expect(txt).not.toContain('0 0 20 20 re');
    expect(txt).toContain('/OC1');            // Layer B block kept
    expect(txt).toContain('30 30 20 20 re');
  });
});

describe('OCG RemoveLayer — deep XObject/Do excision', () => {
  function pageXObjects(doc: Document): Map<string, any> {
    return doc.resolve(doc.Pages[0].Resources!.get('XObject')) as Map<string, any>;
  }
  const countOccurrences = (hay: string, needle: string) => hay.split(needle).length - 1;

  it('removes /OC-bound and invocation-orphaned XObjects, keeps still-invoked ones', () => {
    const doc = Document.Open(buildOcgDoPdf());
    const x0 = pageXObjects(doc);
    const fm0 = x0.get('Fm0'), fm1 = x0.get('Fm1'), fm2 = x0.get('Fm2');
    doc.OptionalContent.RemoveLayer(doc.OptionalContent.GetLayer('Layer B')!);

    const txt = pageContentText(doc);
    expect(txt).not.toContain('/Fm0');           // case A Do stripped
    expect(txt).not.toContain('/Fm1');           // case B Do (in excised block) gone
    expect(txt).not.toContain('BDC');            // layer blocks excised
    expect(countOccurrences(txt, '/Fm2 Do')).toBe(1); // one unconditional Fm2 Do kept

    const x = pageXObjects(doc);
    expect(x.has('Fm0')).toBe(false);            // resource entries removed
    expect(x.has('Fm1')).toBe(false);
    expect(x.has('Fm2')).toBe(true);             // still-invoked kept

    expect(doc.resolve(fm0)).toBeNull();         // objects deleted
    expect(doc.resolve(fm1)).toBeNull();
    expect(isStream(doc.resolve(fm2))).toBe(true);
  });

  it('survives a Save/Open round-trip', () => {
    const doc = Document.Open(buildOcgDoPdf());
    doc.OptionalContent.RemoveLayer(doc.OptionalContent.GetLayer('Layer B')!);
    const re = Document.Open(doc.Save());
    const x = re.resolve(re.Pages[0].Resources!.get('XObject')) as Map<string, any>;
    expect(x.has('Fm0')).toBe(false);
    expect(x.has('Fm1')).toBe(false);
    expect(isStream(re.resolve(x.get('Fm2')))).toBe(true);
    const txt = pageContentText(re);
    expect(countOccurrences(txt, ' Do')).toBe(1); // only the surviving Fm2 draw
  });
});

describe('OCG RemoveLayer — nested Form XObject bound by /OC', () => {
  /** The outer Form XObject (page /Fm0) and its /XObject sub-dict. */
  function outerForm(doc: Document): { dict: any; xobjs: Map<string, any> } {
    const pageX = doc.resolve(doc.Pages[0].Resources!.get('XObject')) as Map<string, any>;
    const outer = doc.resolve(pageX.get('Fm0')) as any;
    const outerRes = doc.resolve(outer.dict.get('Resources')) as Map<string, any>;
    return { dict: outer.dict, xobjs: doc.resolve(outerRes.get('XObject')) as Map<string, any> };
  }

  it('removes a nested form bound by /OC and its Do from the outer form', () => {
    const doc = Document.Open(buildOcgNestedXObjectPdf());
    const innerRef = outerForm(doc).xobjs.get('Inner');
    doc.OptionalContent.RemoveLayer(doc.OptionalContent.GetLayer('Layer B')!);

    const outer = outerForm(doc);
    expect(outer.xobjs.has('Inner')).toBe(false);               // resource entry gone
    expect(doc.resolve(innerRef)).toBeNull();                   // inner object deleted
    const pageX = doc.resolve(doc.Pages[0].Resources!.get('XObject')) as Map<string, any>;
    const fm0 = doc.resolve(pageX.get('Fm0'));
    expect(isStream(fm0) ? new TextDecoder().decode(decodeStream(fm0)) : '').not.toContain('/Inner');
  });

  it('survives a Save/Open round-trip with no dangling ref', () => {
    const doc = Document.Open(buildOcgNestedXObjectPdf());
    doc.OptionalContent.RemoveLayer(doc.OptionalContent.GetLayer('Layer B')!);
    const re = Document.Open(doc.Save());
    expect(outerForm(re).xobjs.has('Inner')).toBe(false);
    expect(re.OptionalContent.Layers.map((l) => l.Name)).toEqual(['Layer A']);
  });
});

describe('OCG /Properties pruning — RemoveLayer drops direct-OCG entries', () => {
  it('drops a /Properties entry that maps a name straight to the deleted layer', () => {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    const bRef = oc.GetLayer('Layer B')!.Ref; // /Properties /MC1 -> Layer B directly
    oc.RemoveLayer(oc.GetLayer('Layer B')!);

    const props = doc.resolve(doc.Pages[0].Resources!.get('Properties')) as Map<string, any>;
    expect(props.has('MC1')).toBe(false);           // direct-OCG mapping removed
    expect(props.has('MC0')).toBe(true);            // surviving layer's mapping kept
    expect(doc.resolve(bRef)).toBeNull();           // layer object deleted
  });

  it('survives a Save/Open round-trip with no dangling /Properties ref', () => {
    const doc = Document.Open(buildOcgPdf());
    doc.OptionalContent.RemoveLayer(doc.OptionalContent.GetLayer('Layer B')!);
    const re = Document.Open(doc.Save());

    const props = re.resolve(re.Pages[0].Resources!.get('Properties')) as Map<string, any>;
    // the dangling MC1 entry is gone (else its stale ref points at an unrelated
    // renumbered object)…
    expect(props.has('MC1')).toBe(false);
    // …and the one surviving entry still resolves to Layer A (an OCG).
    expect(re.OptionalContent.layerForRef(props.get('MC0'))?.Name).toBe('Layer A');
  });
});

describe('OCMD /VE — ResolveVisibility', () => {
  function setup() {
    const doc = Document.Open(buildOcgPdf());
    const oc = doc.OptionalContent;
    const cfg = oc.Default;
    const a = oc.GetLayer('Layer A')!; // visible
    const b = oc.GetLayer('Layer B')!; // hidden
    return { doc, cfg, a, b };
  }
  const ocmd = (extra: [string, any][]) =>
    new Map<string, any>([['Type', name('OCMD')], ...extra]);

  it('resolves a plain OCG ref like IsVisible', () => {
    const { cfg, a, b } = setup();
    expect(cfg.ResolveVisibility(a.Ref)).toBe(true);
    expect(cfg.ResolveVisibility(b.Ref)).toBe(false);
  });

  it('returns true for undefined / non-OC values', () => {
    const { cfg } = setup();
    expect(cfg.ResolveVisibility(undefined)).toBe(true);
    expect(cfg.ResolveVisibility(42 as any)).toBe(true);
  });

  it('evaluates /VE And, Or, Not and nesting', () => {
    const { cfg, a, b } = setup();
    // And(A, Not(B)) = true && !false = true
    expect(cfg.ResolveVisibility(ocmd([['VE', [name('And'), a.Ref, [name('Not'), b.Ref]]]]))).toBe(true);
    // Or(B, Not(A)) = false || !true = false
    expect(cfg.ResolveVisibility(ocmd([['VE', [name('Or'), b.Ref, [name('Not'), a.Ref]]]]))).toBe(false);
    // Not(A) = false
    expect(cfg.ResolveVisibility(ocmd([['VE', [name('Not'), a.Ref]]]))).toBe(false);
    // Or(B, And(A, Not(B))) = false || (true && true) = true
    expect(cfg.ResolveVisibility(ocmd([['VE',
      [name('Or'), b.Ref, [name('And'), a.Ref, [name('Not'), b.Ref]]]]]))).toBe(true);
  });

  it('applies /P policy over /OCGs when /VE is absent', () => {
    const { cfg, a, b } = setup();
    const members: [string, any][] = [['OCGs', [a.Ref, b.Ref]]]; // A on, B off
    expect(cfg.ResolveVisibility(ocmd([['P', name('AnyOn')], ...members]))).toBe(true);
    expect(cfg.ResolveVisibility(ocmd([['P', name('AllOn')], ...members]))).toBe(false);
    expect(cfg.ResolveVisibility(ocmd([['P', name('AnyOff')], ...members]))).toBe(true);
    expect(cfg.ResolveVisibility(ocmd([['P', name('AllOff')], ...members]))).toBe(false);
    // default policy is AnyOn
    expect(cfg.ResolveVisibility(ocmd([...members]))).toBe(true);
  });

  it('prefers /VE over /P when both are present', () => {
    const { cfg, a } = setup();
    // VE Not(A) = false, but /P AnyOn over [A] would be true
    const m = ocmd([['VE', [name('Not'), a.Ref]], ['P', name('AnyOn')], ['OCGs', [a.Ref]]]);
    expect(cfg.ResolveVisibility(m)).toBe(false);
  });

  it('treats malformed /VE as visible', () => {
    const { cfg, a, b } = setup();
    expect(cfg.ResolveVisibility(ocmd([['VE', [name('Not'), a.Ref, b.Ref]]]))).toBe(true); // Not w/ 2 operands
    expect(cfg.ResolveVisibility(ocmd([['VE', [name('Xor'), a.Ref, b.Ref]]]))).toBe(true); // unknown op
    expect(cfg.ResolveVisibility(ocmd([['VE', []]]))).toBe(true);                          // empty
  });
});
