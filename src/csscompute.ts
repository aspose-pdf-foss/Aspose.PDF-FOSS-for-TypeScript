/** Inheritance and computed values: the top-down walk that turns the
 *  cascade's winning declarations into a ComputedStyle per element.
 *
 *  Invariant: a PURE LEAF over cssprop.js, cssvalue.js, csscascade.js and
 *  htmldom.js. No Document, no PDF object, no `node:` import, and it never
 *  throws — a value it cannot read is recorded and the property falls back.
 *
 *  Invariant: ORDER within an element is load-bearing, twice.
 *  `font-size` is computed FIRST, because every other property's `em`
 *  resolves against it. `color` is computed SECOND, because `currentColor` —
 *  which is also the INITIAL value of the three decoration and border colour
 *  properties — resolves against it. Computing colour after the properties
 *  that name it silently yields the initial black rather than the cascaded
 *  colour, which reads as an authoring mistake rather than a bug.
 *
 *  Invariant: `font-size` is the ONE property whose relative values resolve
 *  against the PARENT's computed size; every other property resolves against
 *  the element's own. cssprop.ts's computeFontSize owns that, and this module
 *  hands it a context whose `parentFontSize` is real. */

import type { HtmlDocument, HtmlElement, HtmlNode } from './htmldom.js';
import { cssWideOf } from './cssvalue.js';
import type { Color } from './cssvalue.js';
import { PROPERTIES, INITIAL_STYLE } from './cssprop.js';
import type { ComputedStyle, PropContext, PropDef, UnsupportedDeclaration } from './cssprop.js';
import { collect, cascade } from './csscascade.js';
import { customPropEnv, resolveDeclValue, isCustomProperty } from './cssvar.js';
import type { VarEnv } from './cssvar.js';
import type { CssValue } from './cssparse.js';
import type { ElementDeclarations } from './csscascade.js';

export interface ComputeResult {
  styles: Map<HtmlElement, ComputedStyle>;
  unsupported: UnsupportedDeclaration[];
}

/** The initial value, with the three `'currentcolor'` initials resolved. One
 *  rule for a declared `currentColor` and an initial one alike. */
function initialOf(def: PropDef, color: Color): unknown {
  return def.initial === 'currentcolor' ? color : def.initial;
}

/** Resolve ONE property for one element.
 *
 *  `color` is passed through `ctx` rather than read from a half-built style,
 *  because it is needed while that style is still being built. */
function resolveProp(
  name: string, def: PropDef, decls: ElementDeclarations | undefined,
  parent: ComputedStyle | null, ctx: PropContext, el: HtmlElement,
  unsupported: UnsupportedDeclaration[], env: VarEnv,
): unknown {
  const inheritedValue = (): unknown =>
    parent === null
      ? initialOf(def, ctx.color)
      : (parent as unknown as Record<string, unknown>)[def.key];

  const fallback = (): unknown =>
    def.inherited ? inheritedValue() : initialOf(def, ctx.color);

  const raw = decls?.all.get(name);
  if (raw === undefined) return fallback();

  // The CSS-wide keywords are read off the RAW value and NEVER off the
  // substituted one. Measured against Chrome: `--x: initial; color: var(--x)`
  // computes to the INHERITED colour rather than to color's initial black, so
  // a keyword arriving by substitution is not a keyword — the declaration is
  // invalid at computed-value time instead, which the def.compute failure
  // below already produces. Testing the substituted value gets `inherit`
  // right by luck and `initial` wrong.
  //
  // A pending shorthand can carry no keyword: expandShorthand hands a
  // CSS-wide keyword to every longhand it governs before this ever sees it.
  const wide = Array.isArray(raw) ? cssWideOf(raw) : undefined;
  if (wide === 'inherit') return inheritedValue();
  if (wide === 'initial') return initialOf(def, ctx.color);
  if (wide === 'unset') return fallback();
  if (wide === 'revert') {
    // The value this element would have had with the AUTHOR origin removed —
    // a LOOKUP in the UA winners the cascade kept, rather than a second pass
    // over the rule list. With nothing there it degrades to `unset`.
    const uaRaw = decls?.ua.get(name);
    if (uaRaw === undefined) return fallback();
    const uaRes = resolveDeclValue(uaRaw, name, env);
    if ('fail' in uaRes) return fallback();
    const ua = uaRes.value;
    if (cssWideOf(ua) !== undefined) return fallback();
    const got = def.compute(ua, ctx);
    return got === undefined ? fallback() : got;
  }

  // Substitution runs AFTER the keyword test and BEFORE the grammar: a
  // variable may carry a bare operator, so a var()-bearing value is a
  // fragment of a value until it is rewritten.
  const res = resolveDeclValue(raw, name, env);
  if ('fail' in res) {
    unsupported.push({ el, property: name, value: '', reason: res.fail });
    return fallback();
  }

  const got = def.compute(res.value, ctx);
  if (got !== undefined) return got;

  // A declaration we could parse as CSS but not as this property's value.
  // It is recorded, and the property falls back exactly as if it had not been
  // declared — which is CSS's own "invalid at computed-value time".
  unsupported.push({ el, property: name, value: '', reason: 'unparsable-value' });
  return fallback();
}

export function computeStyles(root: HtmlDocument): ComputeResult {
  const collected = collect(root);
  const decls = cascade(root, collected);
  const styles = new Map<HtmlElement, ComputedStyle>();
  const unsupported: UnsupportedDeclaration[] = [...collected.unsupported];

  // `rem` on the document element itself resolves against the INITIAL
  // font-size, there being no computed root size yet; every descendant sees
  // the root's real one.
  let rootFontSize = INITIAL_STYLE.fontSize;
  let seenRoot = false;

  const visit = (n: HtmlNode, parent: ComputedStyle | null, parentEnv: VarEnv): void => {
    let mine = parent;
    let env = parentEnv;

    if (n.kind === 'element') {
      const d = decls.get(n);

      // The environment is built BEFORE font-size, because `font-size:
      // var(--fs)` must work and font-size computes first. An element that
      // declares none reuses the parent's map by identity, so a document with
      // no custom properties allocates nothing here.
      const own = new Map<string, CssValue[]>();
      if (d !== undefined) {
        for (const [k, v] of d.all) {
          if (isCustomProperty(k) && Array.isArray(v)) own.set(k, v);
        }
      }
      const cp = customPropEnv(own, parentEnv);
      env = cp.env;
      for (const [prop, reason] of cp.invalid) {
        unsupported.push({ el: n, property: prop, value: '', reason });
      }

      const p = parent;
      const parentFontSize = p === null ? INITIAL_STYLE.fontSize : p.fontSize;
      const parentWeight = p === null ? INITIAL_STYLE.fontWeight : p.fontWeight;
      const parentColor = p === null ? INITIAL_STYLE.color : p.color;

      // 1. font-size, whose own `em` resolves against the PARENT.
      const fsCtx: PropContext = {
        fontSize: parentFontSize, parentFontSize, rootFontSize,
        parentWeight, color: parentColor,
      };
      const fsDef = PROPERTIES.get('font-size') as PropDef;
      const fontSize = resolveProp(
        'font-size', fsDef, d, p, fsCtx, n, unsupported, env) as number;

      if (!seenRoot) { rootFontSize = fontSize; seenRoot = true; }

      // 2. color, because currentColor — and the INITIAL of three colour
      //    properties — resolves against it.
      const colCtx: PropContext = {
        fontSize, parentFontSize, rootFontSize, parentWeight, color: parentColor,
      };
      const colDef = PROPERTIES.get('color') as PropDef;
      const color = resolveProp(
        'color', colDef, d, p, colCtx, n, unsupported, env) as Color;

      // 3. everything else, against the element's OWN font size and colour.
      const ctx: PropContext = {
        fontSize, parentFontSize, rootFontSize, parentWeight, color,
      };
      const s: Record<string, unknown> = { fontSize, color };
      for (const [name, def] of PROPERTIES) {
        if (name === 'font-size' || name === 'color') continue;
        s[def.key] = resolveProp(name, def, d, p, ctx, n, unsupported, env);
      }

      mine = s as unknown as ComputedStyle;
      styles.set(n, mine);
    }

    // Never `n.content`: a template's content is not part of the document.
    if (n.kind === 'element' || n.kind === 'document' || n.kind === 'fragment') {
      for (const c of n.children) visit(c, mine, env);
    }
  };
  visit(root, null, new Map());

  return { styles, unsupported };
}
