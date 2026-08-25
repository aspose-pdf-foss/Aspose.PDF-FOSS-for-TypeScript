import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildFormPdf } from './helpers/build-form-pdf.js';
import { pageFormControls } from '../src/htmlforms.js';
import { buildFormButtonsPdf } from './helpers/build-form-buttons-pdf.js';

/** The controls for page 1 of the standard form fixture. */
function controls(): string {
  const doc = Document.Open(buildFormPdf());
  let n = 0;
  return pageFormControls(doc, doc.Pages[0], doc.Form, () => ++n).html;
}

describe('pageFormControls — text', () => {
  it('emits an input carrying the field name and value', () => {
    const html = controls();
    expect(html).toContain('type="text"');
    expect(html).toContain('name="name"');
    expect(html).toContain('value="Bob"');
  });

  it('positions it absolutely, in points, from /Rect', () => {
    // Fixed mode places everything in pt; a control that is not positioned
    // lands at the top of the page rather than on its field.
    expect(controls()).toMatch(/left:[\d.-]+pt;top:[\d.-]+pt;width:[\d.]+pt;height:[\d.]+pt/);
  });
});

describe('pageFormControls — checkbox and radio', () => {
  it('emits a checkbox whose value is its export name', () => {
    // NOT "on": the export name is what /V carries, and a checkbox posting the
    // wrong token is a form that submits a value the PDF never had.
    const html = controls();
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('name="agree"');
  });

  it('emits one radio per widget, sharing the field name', () => {
    // The `color` field has two kid widgets.
    const html = controls();
    expect(html.match(/type="radio"/g) ?? []).toHaveLength(2);
    expect((html.match(/name="color"/g) ?? []).length).toBe(2);
  });

  it("takes each radio value from that widget's own /AP /N key", () => {
    // Not synthOnState, which GUESSES an on-state for documents we did not
    // author by reading /AS, /Opt, /V and finally 'Yes'. Here the widget's own
    // appearance dictionary states it.
    const html = controls();
    expect(html).toContain('value="Red"');
    expect(html).not.toContain('value="Off"');
  });
});

describe('pageFormControls — choice', () => {
  it('emits a select with one option per entry', () => {
    const html = controls();
    expect(html).toContain('<select');
    expect(html).toContain('name="size"');
    expect(html).toContain('<option value="M" selected>M</option>');
  });

  it('splits an [export, display] entry into value and text', () => {
    // CLAUDE.md's invariant: /V holds the EXPORT and the display is what is
    // drawn. Every consumer that kept only one half got it wrong — a list box
    // that highlights nothing, a combo that draws the export value.
    //
    // The `tags` field's /Opt is [[(a) (Alpha)] (b) (c)], but its widget
    // carries no /Rect in the shared fixture, so it is skipped for want of
    // anywhere to go (see the test below). Give it one, and it converts.
    const doc = Document.Open(buildFormPdf());
    const w = doc.Form.Fields.find((f) => f.Name === 'tags')!.Widgets[0];
    w.set('Rect', [10, 10, 100, 30]);
    // ...and put it on the page: in the shared fixture it is in /AcroForm
    // /Fields but not in any page's /Annots, which is the other reason it does
    // not convert.
    (doc.resolve(doc.Pages[0].Dict.get('Annots')) as unknown[]).push(w);
    let n = 0;
    const html = pageFormControls(doc, doc.Pages[0], doc.Form, () => ++n).html;
    expect(html).toContain('<option value="a">Alpha</option>');
    // The plain entries keep export === display.
    expect(html).toContain('<option value="b">b</option>');
  });

  it('skips a widget with no /Rect rather than placing it at the origin', () => {
    // A control with no position stacks at the page's top-left, over content
    // that has nothing to do with it. Better absent — the widget keeps its own
    // appearance, since it is never claimed.
    const doc = Document.Open(buildFormPdf());
    let n = 0;
    const { html, converted } = pageFormControls(doc, doc.Pages[0], doc.Form, () => ++n);
    expect(html).not.toContain('name="tags"');
    const w = doc.Form.Fields.find((f) => f.Name === 'tags')!.Widgets[0];
    expect(converted.has(w)).toBe(false);
  });
});

describe('pageFormControls — styling', () => {
  it('takes font size from /DA', () => {
    expect(controls()).toMatch(/font-size:[\d.]+pt/);
  });
});

describe('pageFormControls — the claimed set', () => {
  it('reports every widget it converted', () => {
    const doc = Document.Open(buildFormPdf());
    let n = 0;
    const { converted } = pageFormControls(doc, doc.Pages[0], doc.Form, () => ++n);
    // Every control emitted claims exactly one widget; the count is what the
    // suppression pass will hide.
    expect(converted.size).toBeGreaterThan(0);
  });

  it('gives each control a tabindex from the injected counter', () => {
    expect(controls()).toContain('tabindex="1"');
  });
});

describe('pageFormControls — push buttons', () => {
  const buttons = () => {
    const doc = Document.Open(buildFormButtonsPdf());
    let n = 0;
    return pageFormControls(doc, doc.Pages[0], doc.Form, () => ++n);
  };

  it('converts a SubmitForm button to type=submit, with its /MK caption', () => {
    expect(buttons().html).toContain('type="submit"');
    expect(buttons().html).toContain('>Send</button>');
  });

  it('converts a ResetForm button to type=reset', () => {
    expect(buttons().html).toContain('type="reset"');
  });

  it('leaves a plain push button alone, appearance and all', () => {
    // Only submit and reset have an HTML meaning. A button whose action is a
    // JavaScript call or nothing at all would become a control that does
    // nothing, so it stays a picture — and must NOT be claimed, or its
    // appearance is suppressed and the page loses it entirely.
    const { html, converted } = buttons();
    expect(html).not.toContain('name="plain"');
    const doc = Document.Open(buildFormButtonsPdf());
    const plain = doc.Form.Fields.find((f) => f.Name === 'plain')!;
    expect([...converted].some((w) => w === plain.Widgets[0])).toBe(false);
  });

  it('reports that it converted a submit', () => {
    expect(buttons().submits).toBe(true);
  });
});

describe('pageFormControls — signature', () => {
  const sigs = () => {
    const doc = Document.Open(buildFormButtonsPdf());
    let n = 0;
    return pageFormControls(doc, doc.Pages[0], doc.Form, () => ++n).html;
  };

  it('emits a disabled input carrying the signer and date', () => {
    // Disabled on purpose: a signature cannot be produced in a browser, so the
    // control takes part in tab order and is announced, and promises nothing.
    const html = sigs();
    expect(html).toContain('name="signed"');
    expect(html).toMatch(/<input type="text" disabled[^>]*value="Oleg Subachev, 2026-08-18"/);
  });

  it('distinguishes an unsigned field by its aria-label', () => {
    // The two states must be tellable apart without sight — an empty box and a
    // signed one otherwise read identically.
    const html = sigs();
    expect(html).toContain('aria-label="Signature field: signed"');
    expect(html).toContain('aria-label="Unsigned signature field: unsigned"');
  });
});
