import type { Document } from './document.js';
import type { Page } from './page.js';
import type { StructTreeRoot } from './struct.js';
import { readContentForSplice, type ContentSplice } from './content.js';
import { EditableContent } from './editcontent.js';
import { freshKey } from './pagecontent.js';
import { contentStreamBytes } from './text.js';
import { isDict, isName, name, type PdfDict, type PdfObject } from './types.js';

/** Without a ParentTree owner an old MCID would alias the next newly tagged
 *  draw. Preserve all other marked content and leave the original resource
 *  dictionaries available to shared pages, Forms and other operators. */
export function stripOrphanPageMcids(doc: Document): void {
  if (doc.IsTagged) return;
  const root = doc.GetStructTree();
  for (const page of doc.Pages) stripPage(doc, page, root);
}

function stripPage(doc: Document, page: Page, root: StructTreeRoot | null): void {
  const structParents = doc.resolve(page.Dict.get('StructParents'));
  const properties = doc.resolve(page.Resources?.get('Properties'));
  const clones = new Map<PdfDict, string>();
  let newProperties: PdfDict | undefined;
  const changed = new Map<number, Uint8Array>();
  const budget = { tokens: 0 };
  for (const [index, bytes] of contentStreamBytes(doc, page).entries()) {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (!buffer.includes('BDC') && !buffer.includes('DP')) continue;
    const source = readContentForSplice(bytes, doc.loadLimits, budget);
    const edits: ContentSplice[] = [];
    source.ops.forEach((op, i) => {
      if (op.operator !== 'BDC' && op.operator !== 'DP') return;
      const [tag, operand] = op.operands;
      const dict = isName(operand) && isDict(properties) ? doc.resolve(properties.get(operand.name)) : operand;
      if (!isDict(dict)) return;
      const mcid = doc.resolve(dict.get('MCID'));
      if (typeof mcid !== 'number' || (typeof structParents === 'number' && root?.ElementFor(structParents, mcid))) return;
      let replacement: PdfObject;
      if (isName(operand)) {
        let key = clones.get(dict);
        if (key === undefined) {
          newProperties ??= new Map(isDict(properties) ? properties : []);
          key = freshKey(newProperties, 'Prop');
          const copy = new Map(dict);
          copy.delete('MCID');
          newProperties.set(key, copy);
          clones.set(dict, key);
        }
        replacement = name(key);
      } else {
        const copy = new Map(dict);
        copy.delete('MCID');
        replacement = copy;
      }
      edits.push({ first: i, end: i + 1, ops: [{ operator: op.operator, operands: [tag, replacement] }] });
    });
    if (edits.length) changed.set(index, source.replaceAll(edits));
  }
  if (changed.size) new EditableContent(doc, page).writeTopStreams(changed);
  if (newProperties) page.Dict.set('Resources', new Map(page.Resources).set('Properties', newProperties));
}
