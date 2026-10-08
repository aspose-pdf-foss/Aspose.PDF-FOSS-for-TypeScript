/** v9j3.4's Chrome pixel oracle: TEXT-FREE boxes, so font substitution cannot
 *  intrude. Each page is `width` x `height` CSS px with the body padded 20px
 *  (padding, not margin: a root's escaped top margin is dropped here, by
 *  design, where Chrome keeps it). scripts/gen-box-paint-goldens.ts renders
 *  them in headless Chrome; test/box-paint-oracle.test.ts renders them here. */
import { solidPng } from './solid-png.js';

export interface BoxPaintFixture { id: string; html: string; width: number; height: number }

const uri = (png: Uint8Array): string => `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
/** 20x20: blue, with a yellow bottom-right quarter, so placement and tiling show. */
const TILE = uri(solidPng(20, 20, [0, 0, 255], [255, 220, 0]));

const page = (body: string): string =>
  `<style>html,body{margin:0;padding:0;background:#fff}body{padding:20px}</style>${body}`;
const box = (style: string, w = 200, h = 120): string =>
  page(`<div style="width:${w}px;height:${h}px;${style}"></div>`);

export const BOX_PAINT_FIXTURES: BoxPaintFixture[] = [
  { id: 'radius-uniform', html: box('background:#d00;border-radius:24px'), width: 240, height: 160 },
  { id: 'radius-per-corner', html: box('background:#d00;border-radius:0 40px 10px 60px'), width: 240, height: 160 },
  { id: 'radius-elliptical-slash', html: box('background:#d00;border-radius:60px / 30px'), width: 240, height: 160 },
  { id: 'radius-50pct-nonsquare', html: box('background:#d00;border-radius:50%'), width: 240, height: 160 },
  { id: 'radius-overlap-pill', html: box('background:#d00;border-radius:9999px', 200, 60), width: 240, height: 100 },
  { id: 'border-widths-rounded', html: box('background:#eee;border-radius:30px;border-style:solid;border-color:#036;border-width:4px 12px 8px 2px'), width: 254, height: 172 },
  { id: 'border-colors-rounded', html: box('border-radius:30px;border:10px solid;border-color:#c00 #0a0 #00c #cc0'), width: 260, height: 180 },
  { id: 'image-no-repeat', html: box(`background:url(${TILE}) no-repeat`), width: 240, height: 160 },
  { id: 'image-repeat-x', html: box(`background:url(${TILE}) repeat-x 0 30px`), width: 240, height: 160 },
  { id: 'image-cover', html: box(`background:url(${TILE}) center / cover no-repeat`), width: 240, height: 160 },
  { id: 'image-contain-center', html: box(`background:#eee url(${TILE}) center / contain no-repeat`), width: 240, height: 160 },
  { id: 'image-position-right-bottom', html: box(`background:url(${TILE}) right 10px bottom 15px no-repeat`), width: 240, height: 160 },
  { id: 'linear-to-right', html: box('background:linear-gradient(to right, #f00, #00f)'), width: 240, height: 160 },
  { id: 'linear-to-top-right-nonsquare', html: box('background:linear-gradient(to top right, #f00, #0f0 40%, #00f)'), width: 240, height: 160 },
  { id: 'linear-angle-stops-outside', html: box('background:linear-gradient(30deg, #f00 -20%, #00f 120%)'), width: 240, height: 160 },
  { id: 'radial-ellipse-default', html: box('background:radial-gradient(#ff0, #f00, #00f)'), width: 240, height: 160 },
  { id: 'radial-circle-closest-side-at', html: box('background:radial-gradient(circle closest-side at 30% 40%, #fff, #080)'), width: 240, height: 160 },
  { id: 'gradient-transparent-stop', html: box('background:#9cf linear-gradient(to bottom, #c00, transparent)'), width: 240, height: 160 },
];
