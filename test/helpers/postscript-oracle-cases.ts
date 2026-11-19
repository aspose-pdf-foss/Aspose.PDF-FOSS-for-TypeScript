import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type OracleBox = [number, number, number, number];
export interface OracleFont { name: string; path: string; sha256: string }
export interface OracleRegion {
  id: string; box: OracleBox; kind: 'paint' | 'text';
  probes?: readonly { x: number; y: number; rgb: [number, number, number] }[];
}
export interface OraclePage { mediaBox: OracleBox; blank?: true; text?: readonly string[]; regions: readonly OracleRegion[] }
export interface OracleCase {
  id: string; source: string; sourceSha256: string; format: 'ps' | 'eps';
  setup: 'ps' | 'eps-native' | 'eps-literal'; epsBox?: OracleBox;
  flushMarkedTail: boolean; fonts: readonly OracleFont[]; pages: readonly OraclePage[];
}
const type1: OracleFont = { name: 'NimbusSans-Regular', path: 'test/fixtures/fonts/NimbusSans-Regular.t1',
  sha256: '779a9c820bbe8b470d36e77bcf949eef7bf1b889184274ba0f51da4c8c883cfa' };
const sans: OracleFont = { name: 'LiberationSans', path: 'fonts/LiberationSans-Regular.ttf',
  sha256: '76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8' };
const serif: OracleFont = { name: 'Times-Roman', path: 'fonts/LiberationSerif-Regular.ttf',
  sha256: '058ea80864aef09a23f45cbec2bb5400bc3dfbdea01c3f10538a21fcb497fb74' };
const region = (id: string, box: OracleBox, kind: 'paint' | 'text' = 'paint'): OracleRegion => ({ id, box, kind });
const page = (w: number, h: number, regions: OracleRegion[], text?: string[]): OraclePage => ({ mediaBox: [0,0,w,h], regions, ...(text ? {text} : {}) });

/** Sources are relative to the corpus; fonts are relative to the repository.
 * Expected hashes are frozen data, never re-derived from the current inputs. */
export function oracleCases(root: string): OracleCase[] {
  const hashes = JSON.parse(readFileSync(join(root, 'test/fixtures/postscript-oracle/inputs/hashes.json'), 'utf8')) as Record<string, string>;
  const make = (id: string, pages: OraclePage[], fonts: OracleFont[] = [], format: 'ps' | 'eps' = 'ps',
    setup: OracleCase['setup'] = format === 'eps' ? 'eps-native' : 'ps'): OracleCase => {
    const file = `${id}.${format === 'eps' ? 'eps' : 'ps'}`;
    const sourceSha256 = hashes[file];
    if (!sourceSha256 || !/^[0-9a-f]{64}$/.test(sourceSha256)) throw new Error(`Missing frozen input hash: ${file}`);
    return { id, source: `inputs/${file}`, sourceSha256, format, setup, flushMarkedTail: id === 'ps-pages', fonts, pages };
  };
  const epsPage = (): OraclePage => page(100,50,[
    { ...region('origin-fill',[0,0,40,50]), probes:[{x:2,y:45,rgb:[255,0,0]}] },
    region('image',[4,4,18,18]), region('diagonal',[42,0,95,45]),
  ]);
  return [
    make('ps-pages', [
      { mediaBox:[0,0,80,60], blank:true, regions:[] },
      page(80,60,[{...region('red',[10,10,50,40]),probes:[{x:20,y:20,rgb:[255,0,0]}]}]),
      page(100,80,[{...region('blue',[20,20,70,60]),probes:[{x:40,y:40,rgb:[0,0,255]}]}]),
    ]),
    make('ps-paths',[page(160,120,[region('clip',[15,15,85,85]),region('dashes',[7,96,153,104]),region('cubic',[5,5,159,95])])]),
    make('ps-images',[page(160,120,[
      {...region('rgb',[10,10,70,50]),probes:[{x:12,y:48,rgb:[255,0,0]}]},
      {...region('gray',[90,10,150,50]),probes:[{x:92,y:30,rgb:[0,0,0]},{x:148,y:30,rgb:[255,255,255]}]},
    ])]),
    make('ps-fonts',[page(200,120,[region('type1',[10,88,105,118],'text'),region('truetype',[10,55,105,87],'text'),
      region('procedure',[10,20,48,44],'text'),region('transformed',[112,22,150,65],'text'),region('tiny-A',[176,98,187,110],'text')],['AWgy','AB'])],[type1,sans]),
    make('ps-reuse',[page(160,120,[region('nested-form',[38,18,135,96]),region('nested-text',[50,55,70,76],'text')],['F'])],[type1]),
    make('eps-integer',[epsPage()],[],'eps'),
    make('eps-hires',[page(99.25,49.25,[region('fractional-origin',[0,0,40,40]),region('diagonal',[40,0,95,45])])],[],'eps'),
    {...make('eps-deferred',[epsPage()],[],'eps','eps-literal'),epsBox:[-10,20,90,70]},
    make('eps-epsi',[page(100,50,[region('counted-image',[0,0,100,50])])],[],'eps'),
    make('eps-dos-tiff',[epsPage()],[],'eps'),
    make('eps-dos-wmf',[epsPage()],[],'eps'),
    make('upstream-tiger',[page(550,568,[region('tiger',[0,0,550,568])])],[],'eps'),
    make('upstream-colorcir',[page(595,842,[region('rings',[0,100,595,750]),region('labels',[65,65,595,100],'text')],['Red','Green','Blue'])],[serif]),
  ];
}
