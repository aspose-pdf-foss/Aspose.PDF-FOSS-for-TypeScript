// JPEG 2000 (JPXDecode) decoder — ISO/IEC 15444-1.
// This file parses the JP2 box container and the codestream main-header markers,
// and (below) orchestrates the full decode pipeline in decodeJpx.

import { PdfParseError, UnsupportedFeatureError } from './errors.js';
import { decodeTier2 } from './jpxt2.js';
import { decodeCodeBlock } from './jpxt1.js';
import { inverseDwt, ResolutionSpec, Subband } from './jpxwavelet.js';

export interface ComponentSpec { precision: number; signed: boolean; xrSiz: number; yrSiz: number }
export interface CodingStyle {
  progression: 0 | 1 | 2 | 3 | 4; // 0=LRCP 1=RLCP 2=RPCL 3=PCRL 4=CPRL
  layers: number;
  levels: number;
  cbW: number;
  cbH: number;
  reversible: boolean; // true = 5/3, false = 9/7
  mct: boolean;
}
export interface QuantSpec { style: number; guardBits: number; steps: { mantissa: number; exponent: number }[] }
export interface Codestream {
  xsiz: number; ysiz: number; xosiz: number; yosiz: number;
  xtsiz: number; ytsiz: number; xtosiz: number; ytosiz: number;
  comps: ComponentSpec[];
  cod: CodingStyle;
  qcd: QuantSpec;
  tileData: Uint8Array;
}

const u32 = (b: Uint8Array, p: number) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const u16 = (b: Uint8Array, p: number) => (b[p] << 8) | b[p + 1];

/** Unwrap a JP2 box container to its jp2c codestream; pass a bare codestream through. */
export function extractCodestream(buf: Uint8Array): Uint8Array {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0x4f) return buf; // SOC → already bare
  let p = 0;
  while (p + 8 <= buf.length) {
    let len = u32(buf, p);
    const type = u32(buf, p + 4);
    let hdr = 8;
    if (len === 1) { // 64-bit XL length
      const hi = u32(buf, p + 8), lo = u32(buf, p + 12);
      len = hi * 2 ** 32 + lo; hdr = 16;
    } else if (len === 0) {
      len = buf.length - p;
    }
    if (type === 0x6a703263) return buf.subarray(p + hdr, p + len); // 'jp2c'
    if (len <= 0) break;
    p += len;
  }
  throw new PdfParseError('JPX: no jp2c codestream box found');
}

/** Parse the codestream main header + single tile into a Codestream model. */
export function parseCodestream(buf: Uint8Array): Codestream {
  if (!(buf.length >= 2 && buf[0] === 0xff && buf[1] === 0x4f)) throw new PdfParseError('JPX: missing SOC marker');
  let p = 2;
  let siz: Partial<Codestream> | undefined;
  const comps: ComponentSpec[] = [];
  let cod: CodingStyle | undefined;
  let qcd: QuantSpec | undefined;
  let tileData: Uint8Array | undefined;
  let sotStart = -1, psot = 0;

  while (p + 2 <= buf.length) {
    const markerPos = p;
    const m = u16(buf, p); p += 2;
    if (m === 0xffd9) break; // EOC
    if (m === 0xff93) { // SOD — start of tile data (single tile)
      let end = buf.length;
      if (psot > 0 && sotStart >= 0) end = Math.min(buf.length, sotStart + psot);
      else { for (let i = p; i + 1 < buf.length; i++) if (buf[i] === 0xff && buf[i + 1] === 0xd9) { end = i; break; } }
      tileData = buf.subarray(p, end);
      break;
    }
    if (p + 2 > buf.length) break;
    const len = u16(buf, p);
    const seg = buf.subarray(p + 2, p + len);
    p += len;

    switch (m) {
      case 0xff51: { // SIZ
        const xsiz = u32(seg, 2), ysiz = u32(seg, 6), xosiz = u32(seg, 10), yosiz = u32(seg, 14);
        const xtsiz = u32(seg, 18), ytsiz = u32(seg, 22), xtosiz = u32(seg, 26), ytosiz = u32(seg, 30);
        const csiz = u16(seg, 34);
        if (csiz > 3) throw new UnsupportedFeatureError(`JPX: ${csiz} components (>3) unsupported`);
        for (let i = 0; i < csiz; i++) {
          const ssiz = seg[36 + i * 3], xr = seg[37 + i * 3], yr = seg[38 + i * 3];
          if (xr !== 1 || yr !== 1) throw new UnsupportedFeatureError('JPX: component sub-sampling unsupported');
          comps.push({ precision: (ssiz & 0x7f) + 1, signed: (ssiz & 0x80) !== 0, xrSiz: xr, yrSiz: yr });
        }
        const nTiles = Math.ceil((xsiz - xtosiz) / xtsiz) * Math.ceil((ysiz - ytosiz) / ytsiz);
        if (nTiles !== 1) throw new UnsupportedFeatureError('JPX: multiple tiles unsupported');
        siz = { xsiz, ysiz, xosiz, yosiz, xtsiz, ytsiz, xtosiz, ytosiz };
        break;
      }
      case 0xff52: { // COD
        const scod = seg[0];
        if (scod & 0x01) throw new UnsupportedFeatureError('JPX: custom precinct partitions unsupported');
        const progression = seg[1] as CodingStyle['progression'];
        const layers = u16(seg, 2);
        const mct = seg[4] === 1;
        const levels = seg[5];
        const cbW = 1 << (seg[6] + 2), cbH = 1 << (seg[7] + 2);
        const transform = seg[9]; // 0 = 9/7 irreversible, 1 = 5/3 reversible
        cod = { progression, layers, levels, cbW, cbH, reversible: transform === 1, mct };
        break;
      }
      case 0xff5c: { // QCD
        const sqcd = seg[0];
        const style = sqcd & 0x1f, guardBits = sqcd >> 5;
        const steps: { mantissa: number; exponent: number }[] = [];
        if (style === 0) { // reversible: one exponent per subband
          for (let i = 1; i < seg.length; i++) steps.push({ mantissa: 0, exponent: seg[i] >> 3 });
        } else { // scalar quantization: 16-bit (exponent<<11 | mantissa) per subband
          for (let i = 1; i + 1 < seg.length; i += 2) { const v = u16(seg, i); steps.push({ exponent: v >> 11, mantissa: v & 0x7ff }); }
        }
        qcd = { style, guardBits, steps };
        break;
      }
      case 0xff5e: // RGN
        throw new UnsupportedFeatureError('JPX: region of interest (RGN) unsupported');
      case 0xff90: { // SOT
        sotStart = markerPos;
        psot = u32(seg, 2);
        break;
      }
      default: break; // COM/CRG/TLM/PLM/PLT/PPM/PPT/COC/QCC ... ignored at baseline
    }
  }

  if (!siz || !cod || !qcd || !tileData) throw new PdfParseError('JPX: missing SIZ/COD/QCD/tile data');
  return { ...(siz as Codestream), comps, cod, qcd, tileData };
}

// ---------- Decode pipeline ----------

export interface JpxImage { width: number; height: number; comps: number; data: Uint8Array; bitDepth: number }

const GAIN_LOG2: Record<string, number> = { LL: 0, HL: 1, LH: 1, HH: 2 };

/** Global subband index into the QCD step list (LL, then HL/LH/HH per level). */
function subbandQcdIndex(level: number, type: string): number {
  if (type === 'LL') return 0;
  return (level - 1) * 3 + (type === 'HL' ? 1 : type === 'LH' ? 2 : 3);
}

/** Decode a JPEG 2000 codestream (bare J2K or JP2 box) to interleaved 8-bit samples. */
export function decodeJpx(bytes: Uint8Array): JpxImage {
  const cs = parseCodestream(extractCodestream(bytes));
  const width = cs.xsiz - cs.xosiz, height = cs.ysiz - cs.yosiz;
  const nc = cs.comps.length;
  const N = cs.cod.levels;
  const reversible = cs.cod.reversible;
  const guardBits = cs.qcd.guardBits;
  const coded = decodeTier2(cs);
  const planes: Float32Array[] = [];

  for (let c = 0; c < nc; c++) {
    const prec = cs.comps[c].precision;
    const resolutions: ResolutionSpec[] = coded[c].map((rr) => {
      const subbands: Subband[] = rr.subbands.map((sb) => {
        const sw = sb.x1 - sb.x0, sh = sb.y1 - sb.y0;
        const coeffs = new Float32Array(sw * sh);
        const qi = subbandQcdIndex(rr.level, sb.type);
        const step = cs.qcd.steps[qi] ?? cs.qcd.steps[cs.qcd.steps.length - 1] ?? { exponent: 0, mantissa: 0 };
        const eps = step.exponent;
        const mb = guardBits + eps - 1;
        let delta = 1;
        if (!reversible) delta = 2 ** (prec + GAIN_LOG2[sb.type] - eps) * (1 + step.mantissa / 2048);
        for (const cb of sb.blocks) {
          const bw = cb.x1 - cb.x0, bh = cb.y1 - cb.y0;
          const numBitPlanes = Math.max(0, mb - cb.zeroBitPlanes);
          const dec = decodeCodeBlock({ width: bw, height: bh, data: cb.segment, passes: cb.passes, zeroBitPlanes: cb.zeroBitPlanes, numBitPlanes, sbType: cb.sbType });
          for (let yy = 0; yy < bh; yy++) for (let xx = 0; xx < bw; xx++) {
            coeffs[(cb.y0 - sb.y0 + yy) * sw + (cb.x0 - sb.x0 + xx)] = dec[yy * bw + xx] * delta;
          }
        }
        return { type: sb.type, x0: sb.x0, y0: sb.y0, x1: sb.x1, y1: sb.y1, coeffs };
      });
      return { level: rr.level, x0: rr.x0, y0: rr.y0, x1: rr.x1, y1: rr.y1, subbands };
    });
    planes.push(inverseDwt(resolutions, reversible));
  }

  // Inverse multiple-component transform (RCT reversible / ICT irreversible).
  if (nc === 3 && cs.cod.mct) {
    const [p0, p1, p2] = planes;
    for (let i = 0; i < width * height; i++) {
      if (reversible) { // RCT (Annex G.2)
        const y = p0[i], u = p1[i], v = p2[i];
        const g = y - Math.floor((u + v) / 4);
        p0[i] = v + g; p1[i] = g; p2[i] = u + g; // R, G, B
      } else { // ICT (Annex G.1)
        const y = p0[i], cb = p1[i], cr = p2[i];
        p0[i] = y + 1.402 * cr;
        p1[i] = y - 0.344136 * cb - 0.714136 * cr;
        p2[i] = y + 1.772 * cb;
      }
    }
  }

  // DC level shift (+2^(prec-1) for unsigned) + clamp + downshift to 8-bit, interleave.
  const data = new Uint8Array(width * height * nc);
  for (let c = 0; c < nc; c++) {
    const prec = cs.comps[c].precision;
    const shift = cs.comps[c].signed ? 0 : 1 << (prec - 1);
    const down = prec > 8 ? prec - 8 : 0;
    const max = (1 << prec) - 1;
    const pl = planes[c];
    for (let i = 0; i < width * height; i++) {
      let v = Math.round(pl[i]) + shift;
      v = v < 0 ? 0 : v > max ? max : v;
      data[i * nc + c] = down ? v >> down : v;
    }
  }
  return { width, height, comps: nc, data, bitDepth: cs.comps[0].precision };
}
