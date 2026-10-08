// test/helpers/solid-png.ts
import { encodePng } from '../../src/pngencode.js';
/** A w×h PNG of one RGB colour; a `quadrants` second colour fills the
 *  bottom-right quarter, so position and tiling errors are visible. */
export function solidPng(w: number, h: number, rgb: [number, number, number], quadrants?: [number, number, number]): Uint8Array {
  const px = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = quadrants && x >= w / 2 && y >= h / 2 ? quadrants : rgb;
    px.set(c, (y * w + x) * 3);
  }
  return encodePng(w, h, px, 'rgb');
}
