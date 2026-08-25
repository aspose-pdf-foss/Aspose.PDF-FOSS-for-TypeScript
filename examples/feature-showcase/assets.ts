import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** Absolute path to a file in this example's assets directory. */
export function assetPath(name: string): string {
  return join(here, 'assets', name);
}

const cache = new Map<string, Uint8Array>();

function load(name: string): Uint8Array {
  let bytes = cache.get(name);
  if (!bytes) {
    bytes = new Uint8Array(readFileSync(assetPath(name)));
    cache.set(name, bytes);
  }
  return bytes;
}

export const starryNight = (): Uint8Array => load('starry-night.jpg');
export const newton = (): Uint8Array => load('newton.jpg');
export const einstein = (): Uint8Array => load('einstein.jpg');
export const salesBanner = (): Uint8Array => load('sales-banner.jpg');
export const asposePinwheel = (): Uint8Array => load('aspose-pinwheel.svg');
export const asposeLogo = (): Uint8Array => load('aspose-logo.svg');
export const githubMark = (): Uint8Array => load('github-mark.svg');
export const bookIcon = (): Uint8Array => load('book-icon.svg');
export const asposeLogoPng = (): Uint8Array => load('aspose-logo.png');
export const dejaVuSansPath = (): string => assetPath('DejaVuSans.ttf');
