import type { OoxmlPart, OoxmlRelationship } from './ooxml.js';
import type { EncodedImage } from './imagehref.js';

const XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const ART = 'http://schemas.openxmlformats.org/drawingml/2006/main';
export const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Unrotated picture rectangle, in points from the sheet's top left. */
export interface XlsxPicture {
  media: EncodedImage;
  x: number; y: number; width: number; height: number;
  angle: number;
  flipV: boolean;
}

const emu = (points: number): number => Math.round(points * 12700);

/** One DrawingML part per picture-bearing sheet. The exporter interns media
 * by content; every placement still has its own non-visual picture ID. */
export function addSheetDrawing(
  sheetId: number, pictures: readonly XlsxPicture[], mediaIds: Map<EncodedImage, number>,
  parts: OoxmlPart[], rels: OoxmlRelationship[],
): void {
  const drawing = 'xl/drawings/drawing' + sheetId + '.xml';
  rels.push({ source: 'xl/worksheets/sheet' + sheetId + '.xml', id: 'rId1',
    type: OFFICE_REL + '/drawing', target: '../drawings/drawing' + sheetId + '.xml' });
  const anchors = pictures.map((p, i) => {
    const id = i + 1;
    let mediaId = mediaIds.get(p.media);
    const ext = p.media.mediaType === 'image/jpeg' ? 'jpeg' : 'png';
    if (mediaId === undefined) {
      mediaId = mediaIds.size + 1;
      mediaIds.set(p.media, mediaId);
      parts.push({ path: 'xl/media/image' + mediaId + '.' + ext, bytes: p.media.bytes,
        contentType: p.media.mediaType, store: true });
    }
    rels.push({ source: drawing, id: 'rId' + id, type: OFFICE_REL + '/image',
      target: '../media/image' + mediaId + '.' + ext });
    const pos = `x="${emu(p.x)}" y="${emu(p.y)}"`;
    const size = `cx="${emu(p.width)}" cy="${emu(p.height)}"`;
    const orient = `rot="${Math.round(p.angle * 60000)}" flipV="${p.flipV ? 1 : 0}"`;
    return `<xdr:absoluteAnchor><xdr:pos ${pos}/><xdr:ext ${size}/><xdr:pic>`
      + `<xdr:nvPicPr><xdr:cNvPr id="${id}" name="Picture ${id}"/><xdr:cNvPicPr/></xdr:nvPicPr>`
      + `<xdr:blipFill><a:blip r:embed="rId${id}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>`
      + `<xdr:spPr><a:xfrm ${orient}><a:off ${pos}/><a:ext ${size}/></a:xfrm>`
      + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:absoluteAnchor>';
  });
  const xml = `<xdr:wsDr xmlns:xdr="${XDR}" xmlns:a="${ART}" xmlns:r="${OFFICE_REL}">${anchors.join('')}</xdr:wsDr>`;
  parts.push({ path: drawing, bytes: new TextEncoder().encode(xml),
    contentType: 'application/vnd.openxmlformats-officedocument.drawing+xml' });
}
