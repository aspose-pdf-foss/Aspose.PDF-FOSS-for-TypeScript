// JBIG2 integer sources — the seam between T.88's two entropy stacks.
//
// T.88 writes §6.5 (symbol dictionary) and §6.4 (text region) as one procedure
// each with the entropy source swapped: every step reads "decode DT using
// SBHUFFDT or IADT". `IntSource` is that swap made explicit, so `jbig2symbol.ts`
// and `jbig2text.ts` depend on the interface rather than on both stacks, and
// there is ONE height-class walk and ONE strip walk. A second copy of either —
// which is how Go arranges it, in jbig2_huffsym.go and jbig2_hufftext.go — is
// how the two paths come to disagree about one document.
//
// Table SELECTION is not here. A symbol dictionary picks its tables from flag
// bits and referred-to segments, which is header work and lives in jbig2.ts;
// this module receives concrete tables and never sees a flag word.
import { PdfParseError } from './errors.js';
import type { MqDecoder } from './jpxmq.js';
import { IntCtx, IaidCtx, decodeInt, decodeIaid } from './jbig2arith.js';
import type { HuffmanReader, HuffmanTable } from './jbig2huffman.js';
import type { Bitmap } from './jbig2.js';

/** The per-instance integers a symbol dictionary and a text region read.
 *  `null` is OOB, which both stacks can produce and both walks act on. */
export interface IntSource {
  /** Height-class delta (IADH / SDHUFFDH). */
  dh(): number | null;
  /** Symbol-width delta (IADW / SDHUFFDW); OOB ends the height class. */
  dw(): number | null;
  /** Export run (IAEX / Table B.1 — §6.5.10 fixes the table, there is no selector). */
  ex(): number | null;
  /** REFAGGNINST (IAAI / SDHUFFAGGINST). */
  ai(): number | null;
  dt(): number | null;
  fs(): number | null;
  /** OOB ends the strip. */
  ds(): number | null;
  it(): number | null;
  ri(): number | null;
  rdw(): number | null;
  rdh(): number | null;
  rdx(): number | null;
  rdy(): number | null;
  /** BMSIZE in a symbol dictionary, RSIZE in a text region. One method: T.88
   *  gives the field two names and, in both places, Table B.1. */
  size(): number | null;
  /** Symbol ID — the one method returning a bare number, because it is never OOB. */
  id(): number;
  /** Byte-align. A NO-OP on the arithmetic path, which is not bit-addressed;
   *  present so the shared walks never branch on which source they hold. */
  align(): void;
}

/** `decodeInt`/`decodeIaid` over one `MqDecoder` and one set of contexts.
 *
 *  It owns EVERY context both walks use, on purpose. T.88 §6.5.8.2.1 has a
 *  symbol dictionary's aggregate text region use the dictionary's own
 *  arithmetic statistics, so the dictionary and the region it decodes share one
 *  source rather than holding two sets that drift. */
export class ArithIntSource implements IntSource {
  private readonly IADH = new IntCtx();
  private readonly IADW = new IntCtx();
  private readonly IAEX = new IntCtx();
  private readonly IAAI = new IntCtx();
  private readonly IADT = new IntCtx();
  private readonly IAFS = new IntCtx();
  private readonly IADS = new IntCtx();
  private readonly IAIT = new IntCtx();
  private readonly IARI = new IntCtx();
  private readonly IARDW = new IntCtx();
  private readonly IARDH = new IntCtx();
  private readonly IARDX = new IntCtx();
  private readonly IARDY = new IntCtx();
  private readonly IAID: IaidCtx;

  constructor(private readonly mq: MqDecoder, private readonly symCodeLen: number) {
    this.IAID = new IaidCtx(symCodeLen);
  }

  dh(): number | null { return decodeInt(this.mq, this.IADH); }
  dw(): number | null { return decodeInt(this.mq, this.IADW); }
  ex(): number | null { return decodeInt(this.mq, this.IAEX); }
  ai(): number | null { return decodeInt(this.mq, this.IAAI); }
  dt(): number | null { return decodeInt(this.mq, this.IADT); }
  fs(): number | null { return decodeInt(this.mq, this.IAFS); }
  ds(): number | null { return decodeInt(this.mq, this.IADS); }
  it(): number | null { return decodeInt(this.mq, this.IAIT); }
  ri(): number | null { return decodeInt(this.mq, this.IARI); }
  rdw(): number | null { return decodeInt(this.mq, this.IARDW); }
  rdh(): number | null { return decodeInt(this.mq, this.IARDH); }
  rdx(): number | null { return decodeInt(this.mq, this.IARDX); }
  rdy(): number | null { return decodeInt(this.mq, this.IARDY); }
  // BMSIZE/RSIZE is not read at all on the arithmetic path: a refinement's
  // extent comes from the height class or the decoded deltas, never from a
  // byte count. Returning null rather than throwing keeps the walks branch-free.
  size(): number | null { return null; }
  id(): number { return decodeIaid(this.mq, this.IAID, this.symCodeLen); }
  align(): void { /* the MQ decoder is not bit-addressed */ }
}

/** The tables a Huffman source reads its fields through, already resolved.
 *  A field with no table throws when READ rather than returning a plausible
 *  zero: a dictionary reading a field it was given no table for is a header we
 *  mis-parsed, and a zero there decodes silently. */
export interface HuffmanTables {
  dh?: HuffmanTable; dw?: HuffmanTable; ex?: HuffmanTable; ai?: HuffmanTable;
  dt?: HuffmanTable; fs?: HuffmanTable; ds?: HuffmanTable;
  rdw?: HuffmanTable; rdh?: HuffmanTable;
  rdx?: HuffmanTable; rdy?: HuffmanTable; size?: HuffmanTable;
  // NOTE there is deliberately no `it` and no `ri`. A Huffman text region reads CURT as
  // LOG2SBSTRIPS RAW BITS (T.88 §6.4.5 3(c)(ii)) — the flag word's eight
  // selectors are FS, DS, DT, RDW, RDH, RDX, RDY and RSIZE, and IT is not among
  // them. A table here would be a field the format does not have.
  /** The symbol-ID code table (§7.4.3.1.7). Absent for a symbol dictionary,
   *  which reads IDs as `symCodeLen` raw bits (§6.5.8.2.3); a Huffman text
   *  region supplies one. */
  id?: HuffmanTable;
}

export class HuffmanIntSource implements IntSource {
  /** `logStrips` is LOG2SBSTRIPS, which `it()` reads as raw bits. It is 0 for a
   *  symbol dictionary, whose walk never asks for CURT at all. */
  constructor(
    private readonly r: HuffmanReader,
    private readonly tables: HuffmanTables,
    private readonly symCodeLen: number,
    private readonly logStrips = 0,
  ) {}

  private read(name: keyof HuffmanTables): number | null {
    const t = this.tables[name];
    if (t === undefined) throw new PdfParseError(`JBIG2: no Huffman table for ${name}`);
    return t.decode(this.r);
  }

  dh(): number | null { return this.read('dh'); }
  dw(): number | null { return this.read('dw'); }
  ex(): number | null { return this.read('ex'); }
  ai(): number | null { return this.read('ai'); }
  dt(): number | null { return this.read('dt'); }
  fs(): number | null { return this.read('fs'); }
  ds(): number | null { return this.read('ds'); }
  /** §6.4.5 3(c)(ii): CURT is LOG2SBSTRIPS raw bits, not a table read. */
  it(): number | null { return this.r.bits(this.logStrips); }
  /** §6.4.5 3(c)(iv): RI is ONE raw bit under Huffman — like CURT it has no
   *  selector in the flag word, so there is no table for it either. */
  ri(): number | null { return this.r.bit(); }
  rdw(): number | null { return this.read('rdw'); }
  rdh(): number | null { return this.read('rdh'); }
  rdx(): number | null { return this.read('rdx'); }
  rdy(): number | null { return this.read('rdy'); }
  size(): number | null { return this.read('size'); }

  /** §6.5.8.2.3: with no symbol-ID table, an ID is `symCodeLen` raw bits. That
   *  is a symbol dictionary; a Huffman TEXT region builds a runcode table and
   *  supplies it, which is the hook utax.7 uses. */
  id(): number {
    const t = this.tables.id;
    if (t === undefined) return this.r.bits(this.symCodeLen);
    return t.decode(this.r) ?? 0;
  }

  align(): void { this.r.align(); }
}

/** How a symbol dictionary's height-class walk gets its bitmaps.
 *
 *  This is where the `IntSource` abstraction genuinely stops. The arithmetic
 *  path and the Huffman REFAGG path produce one bitmap per SYMBOL, as each
 *  width is decoded; a Huffman dictionary with SDREFAGG clear produces one
 *  bitmap per HEIGHT CLASS (§6.5.9) and slices it by the widths afterwards. A
 *  discriminated union rather than two optional methods, so the walk branches
 *  exactly once and neither shape can silently be absent. */
export type SymbolProducer =
  | { kind: 'perSymbol'; produce(width: number, height: number, index: number): Bitmap }
  | { kind: 'perClass'; produce(widths: number[], height: number): Bitmap[] };

/** How a text region's strip walk refines one instance (T.88 §6.4.11).
 *
 *  The second place the seam stops. Arithmetically the refinement rides the
 *  region's own MQ stream and there is nothing to arrange; under Huffman the
 *  region reads RSIZE, aligns, runs an `MqDecoder` over exactly those bytes and
 *  resumes Huffman reading after them — one stream, two entropy coders,
 *  alternating. That difference cannot hide behind an integer interface, so it
 *  is injected rather than branched on inside the walk. */
export type RefinementProducer = (
  sym: Bitmap, rdw: number, rdh: number, rdx: number, rdy: number,
) => Bitmap;
