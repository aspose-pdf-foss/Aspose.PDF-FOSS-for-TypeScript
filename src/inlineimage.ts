// Inline (`BI … ID … EI`) images: enumeration and removal.
//
// An inline image lives in NO object. It has no /XObject entry, no resource
// name and no stream to hold a handle on -- its samples sit in the content op
// itself -- so `ImageInfo` cannot represent one, and `page.Images` correctly
// never sees it. This module supplies the addressing that is missing: a
// `ContentAddr` naming the op.
//
// **Invariant:** it does not import image.ts. `InlineImageInfo` composes an
// `ImageInfo` over the normalized stream rather than reimplementing its
// accessors -- but the import goes the other way round would close nothing, so
// the dependency is stated plainly here and page.ts wires both.

import type { Document } from './document.js';
import type { Page } from './page.js';
import { PdfDict, PdfStream, isName } from './types.js';
import { visitContent } from './text.js';
import type { ContentAddr } from './editcontent.js';
import { EditableContent } from './editcontent.js';
import { ContentOp, imageCutSet } from './content.js';
import { inlineImageToStream } from './imageredact.js';
import { ImageInfo } from './image.js';

/** A single `BI … EI` image drawn on a page, addressed by its position in the
 *  content stream that draws it.
 *
 *  Read accessors delegate to an {@link ImageInfo} over the NORMALIZED dict, so
 *  an inline image and an image XObject report their colour space and decode
 *  their samples by exactly one rule. The file's abbreviated keys (`/W`, `/CS`,
 *  `/BPC`, `/F`) are expanded once, at construction.
 *
 *  **Handles do not survive a removal.** Cutting one image shifts the op
 *  indices of every later one, so a handle taken before a `Remove` may address
 *  a different op afterwards. `Remove` verifies what it is about to cut and
 *  throws rather than guessing — see its own note. To remove several, remove
 *  one and enumerate again. */
export class InlineImageInfo {
  private readonly view: ImageInfo;

  constructor(
    private readonly doc: Document,
    private readonly page: Page,
    /** Where the `BI` op sits: which content stream, and which op within it. */
    readonly Addr: ContentAddr,
    /** The op's own inline dict and data, recorded at enumeration so `Remove`
     *  can tell whether it is still looking at the same image. */
    private readonly inline: { dict: PdfDict; data: Uint8Array },
  ) {
    const stream: PdfStream = inlineImageToStream(inline);
    this.view = new ImageInfo(doc, '', stream);
  }

  /** The normalized image dict — `/Width`, not the file's `/W`. */
  get Dict(): PdfDict { return this.view.Dict; }
  /** /Width (0 when absent/invalid). */
  get Width(): number { return this.view.Width; }
  /** /Height (0 when absent/invalid). */
  get Height(): number { return this.view.Height; }
  /** /BitsPerComponent; 1 for an image mask, else 8. */
  get Bits(): number { return this.view.Bits; }
  /** Colorspace label, expanded from the inline abbreviation. */
  get ColorSpace(): string { return this.view.ColorSpace; }
  /** Effective codec filter name, expanded from the inline abbreviation. */
  get Filter(): string | undefined { return this.view.Filter; }
  /** The op's encoded sample bytes, exactly as they sit in the stream. */
  get RawData(): Uint8Array { return this.inline.data; }
  /** Decoded samples, by the same rules `ImageInfo.Decode` applies. */
  Decode(): Uint8Array { return this.view.Decode(); }

  /** Remove this image from the page: the `BI … EI` op and, where it forms one,
   *  the enclosing `q [cm…] BI…EI Q` placement group.
   *
   *  Removes exactly ONE draw. That differs from `ImageInfo.Remove`, which
   *  takes every draw of a resource key, and the difference is not a choice:
   *  an inline image IS a single draw, so a handle names one occurrence.
   *
   *  Nothing is pruned from `/Resources` — an inline image occupies no resource
   *  entry, which is the whole point of the format.
   *
   *  **Invariant:** the op at `Addr` is verified against the dict and data
   *  recorded at enumeration before anything is cut, and a mismatch throws
   *  `RangeError`. Without that check a handle stale from an earlier removal
   *  would silently cut whatever op had shifted into its place — destroying the
   *  wrong picture, on a page that still looks plausible. */
  Remove(): void {
    const ec = new EditableContent(this.doc, this.page);
    const { path, streamIndex, opIndex } = this.Addr;
    const ops = path.length === 0 ? ec.topOps(streamIndex) : ec.xobjectOps(path);

    const op = ops[opIndex];
    if (!op || op.operator !== 'BI' || !op.inlineImage || !sameInline(op.inlineImage, this.inline))
      throw new RangeError(
        'InlineImageInfo.Remove: this handle no longer addresses its image '
        + '(an earlier removal invalidates handles; enumerate page.InlineImages again)');

    const cut = imageCutSet(ops, new Set([opIndex]));
    const out = ops.filter((_, i) => !cut.has(i));
    if (path.length === 0) ec.setTopOps(streamIndex, out as ContentOp[]);
    else ec.setXobjectOps(path, out as ContentOp[]);
    ec.commit();
  }
}

/** True when two inline images carry the same data bytes and the same dict.
 *  Compared on the RAW (abbreviated) dict, which is what the op holds, so no
 *  normalization step can mask a difference. */
function sameInline(
  a: { dict: PdfDict; data: Uint8Array },
  b: { dict: PdfDict; data: Uint8Array },
): boolean {
  if (a.data.length !== b.data.length) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  if (a.dict.size !== b.dict.size) return false;
  for (const [k, v] of a.dict) {
    const o = b.dict.get(k);
    if (v === o) continue;
    // Names and numbers cover every key an inline dict actually uses; anything
    // else falls back to identity, which is conservative -- it reports a
    // difference where there may be none, so Remove refuses rather than cuts.
    if (isName(v) && isName(o) && v.name === o.name) continue;
    return false;
  }
  return true;
}

/** Every `BI … EI` image drawn by `page`, in content order, descending into
 *  Form XObjects exactly as `collectImages` does for XObject images. */
export function collectInlineImages(doc: Document, page: Page): InlineImageInfo[] {
  const out: InlineImageInfo[] = [];
  visitContent(doc, page, {
    image: (e) => {
      if (e.kind !== 'inline') return;
      const op = opAt(doc, page, e.addr);
      if (op?.inlineImage) out.push(new InlineImageInfo(doc, page, e.addr, op.inlineImage));
    },
  });
  return out;
}

/** The parsed op at `addr`. `visitContent` reports where an inline image is but
 *  not the op itself, and re-parsing through EditableContent is what makes the
 *  recorded dict/data identical to what `Remove` will later compare against. */
function opAt(doc: Document, page: Page, addr: ContentAddr): ContentOp | undefined {
  const ec = new EditableContent(doc, page);
  const ops = addr.path.length === 0 ? ec.topOps(addr.streamIndex) : ec.xobjectOps(addr.path);
  return ops[addr.opIndex];
}
