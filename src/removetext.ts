import type { Document } from './document.js';
import type { Page } from './page.js';
import { readContentForSplice, type ContentOp, type ContentSplice } from './content.js';
import { UnsupportedFeatureError } from './errors.js';
import { inflateStream } from './flate.js';
import { reserveAliasNames } from './formedit.js';
import { ensureOwnSubdict, MAX_XOBJECT_DEPTH, streamOf } from './pagecontent.js';
import { isArray, isDict, isName, isStream, isString, name, type PdfDict, type PdfObject,
  type PdfRef, type PdfStream } from './types.js';

interface FormEdit { clone?: PdfStream; hadText: boolean }
interface StreamEdit { bytes?: Uint8Array; resources?: PdfDict; hadText: boolean }
const aliasPrefix = 'TextCleanup';

/** Remove the showing part of a text-show operator. The quote operators also
 * change the text state, which later graphic operations and Forms can inherit. */
function withoutShow(op: ContentOp): ContentOp[] {
  if (op.operator === "'") return [{ operator: 'T*', operands: [] }];
  if (op.operator === '"') return [
    { operator: 'Tw', operands: [op.operands[0]] }, { operator: 'Tc', operands: [op.operands[1]] },
    { operator: 'T*', operands: [] },
  ];
  return [];
}

export function removeAllText(doc: Document, page: Page): void {
  const tokens = { tokens: 0 };
  const active = new Set<PdfStream>();
  // An inherited resource dictionary, entry clipping mode, and remaining
  // depth each affect the outcome of visiting a shared Form.
  const memo = new Map<PdfStream, Map<PdfDict | undefined, Map<number, FormEdit>>>();
  const bindings: { dict: PdfDict; key: string; clone: PdfStream }[] = [];
  let reserved: Set<string> | undefined;
  let nextAlias = 0;
  function dictOf(value: PdfObject | undefined) {
    const dict = doc.resolve(value);
    return isDict(dict) ? dict : undefined;
  }
  function formEdit(form: PdfStream, inherited: PdfDict | undefined, clipping: boolean, depth: number): FormEdit {
    doc.loadLimits.enforce('maxNestingDepth', depth, 'text removal in Form XObjects');
    if (depth > MAX_XOBJECT_DEPTH || active.has(form))
      throw new UnsupportedFeatureError('RemoveAllText cannot traverse a cyclic or too deeply nested Form');
    const resources = dictOf(form.dict.get('Resources')) ?? inherited;
    let scopes = memo.get(form);
    if (!scopes) memo.set(form, scopes = new Map());
    let entries = scopes.get(resources);
    if (!entries) scopes.set(resources, entries = new Map());
    const key = 2 * depth + Number(clipping);
    const cached = entries.get(key);
    if (cached) return cached;
    active.add(form);
    const plan = walk(inflateStream(form, { contentSoFar: 0 }), resources, clipping, depth);
    active.delete(form);
    const result: FormEdit = { hadText: plan.hadText };
    if (plan.bytes) {
      // A structure tree can identify a Form by its stream reference. Cloning
      // that stream with the same parent-tree key would invalidate that link.
      if (form.dict.has('StructParents') || form.dict.has('StructParent'))
        throw new UnsupportedFeatureError('RemoveAllText cannot clone a Form with a structure-parent entry');
      const dict = new Map(form.dict);
      for (const key of ['Filter', 'DecodeParms', 'F', 'FFilter', 'FDecodeParms', 'DL']) dict.delete(key);
      dict.set('Length', plan.bytes.length);
      if (plan.resources) dict.set('Resources', plan.resources);
      result.clone = { kind: 'stream', dict, raw: plan.bytes };
    }
    entries.set(key, result);
    return result;
  }

  function walk(bytes: Uint8Array, resources: PdfDict | undefined, clipping: boolean, depth: number): StreamEdit {
    const src = readContentForSplice(bytes, doc.loadLimits, tokens);
    const splices: ContentSplice[] = [];
    const modes: boolean[] = [];
    const marked: { first: number; textBefore: number }[] = [];
    let textSeen = 0;
    let copy: PdfDict | undefined;
    const subdicts = new Map<string, PdfDict>();
    const aliases = new Map<PdfDict | PdfStream, string>();
    const properties = dictOf(resources?.get('Properties'));
    const xobjects = dictOf(resources?.get('XObject'));
    function bind(category: 'XObject' | 'Properties', object: PdfStream | PdfDict): PdfObject {
      const prior = aliases.get(object);
      if (prior) return name(prior);
      copy ??= new Map(resources);
      let sub = subdicts.get(category);
      if (!sub) subdicts.set(category, sub = ensureOwnSubdict(doc, copy, category));
      reserved ??= reserveAliasNames(doc, page, page.Resources, aliasPrefix);
      let key: string;
      do { key = aliasPrefix + nextAlias++; } while (sub.has(key) || reserved.has(key));
      if (isStream(object)) bindings.push({ dict: sub, key, clone: object });
      else sub.set(key, object);
      aliases.set(object, key);
      return name(key);
    }
    const cleanedProperties = new Map<PdfDict, PdfDict>();
    function endMarked() {
      const scope = marked.pop();
      if (!scope || scope.textBefore === textSeen) return;
      const op = src.ops[scope.first];
      if (op.operator !== 'BDC') return;
      const [tag, operand] = op.operands;
      const props = isName(operand) ? dictOf(properties?.get(operand.name)) : operand;
      if (!isDict(props) || !props.has('ActualText')) return;
      let clean = cleanedProperties.get(props);
      if (!clean) {
        clean = new Map(props);
        clean.delete('ActualText');
        cleanedProperties.set(props, clean);
      }
      // Keep named lists in resources: their other values may be indirect
      // references, which are illegal as inline content-stream operands.
      const replacement = isName(operand) ? bind('Properties', clean) : clean;
      splices.push({ first: scope.first, end: scope.first + 1, ops: [{ operator: 'BDC', operands: [tag, replacement] }] });
    }
    for (const [first, op] of src.ops.entries()) {
      const operand = op.operands[0];
      switch (op.operator) {
        case 'q': modes.push(clipping); break;
        case 'Q': if (modes.length) clipping = modes.pop()!; break;
        case 'Tr': clipping = typeof operand === 'number' && operand >= 4; break;
        case 'BDC': case 'BMC': marked.push({ first, textBefore: textSeen }); break;
        case 'EMC': endMarked(); break;
        case 'Tj': case 'TJ': case "'": case '"': {
          const arg = op.operator === '"' ? op.operands[2] : operand;
          const hasBytes = isArray(arg) ? arg.some(v => isString(v) && v.bytes.length > 0) : isString(arg) && arg.bytes.length > 0;
          if (hasBytes) {
            if (clipping) throw new UnsupportedFeatureError('RemoveAllText cannot remove text used for clipping');
            textSeen++;
          }
          splices.push({ first, end: first + 1, ops: withoutShow(op) });
          break;
        }
        case 'Do': {
          if (!isName(operand)) break;
          const form = doc.resolve(xobjects?.get(operand.name));
          if (!isStream(form)) break;
          const subtype = doc.resolve(form.dict.get('Subtype'));
          if (!isName(subtype) || subtype.name !== 'Form') break;
          const edit = formEdit(form, resources, clipping, depth + 1);
          if (edit.hadText) textSeen++;
          if (edit.clone) splices.push({ first, end: first + 1, ops: [{ operator: 'Do', operands: [bind('XObject', edit.clone)] }] });
          break;
        }
      }
    }
    while (marked.length) endMarked();
    return { bytes: splices.length ? src.replaceAll(splices) : undefined, resources: copy, hadText: textSeen > 0 };
  }

  const plan = walk(page.Contents, page.Resources, false, 0);
  if (!plan.bytes) return;
  if (doc.Pages.filter(p => p.Dict === page.Dict).length !== 1)
    throw new UnsupportedFeatureError('RemoveAllText requires a unique page dictionary');
  // Parsing, clipping checks, and serialization precede the first live write.
  const refs = new Map<PdfStream, PdfRef>();
  for (const { dict, key, clone } of bindings) {
    let ref = refs.get(clone);
    if (!ref) { ref = doc.allocObject(clone); refs.set(clone, ref); }
    dict.set(key, ref);
  }
  page.Dict.set('Contents', doc.allocObject(streamOf(plan.bytes)));
  if (plan.resources) page.Dict.set('Resources', plan.resources);
}
