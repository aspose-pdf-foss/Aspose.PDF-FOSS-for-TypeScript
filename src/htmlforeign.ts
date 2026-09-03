/** The data half of HTML5 foreign content (HTML Standard §13.2.6.5): the four
 *  adjustment tables, the two integration-point predicates and the breakout
 *  list.
 *
 *  Invariant: a PURE LEAF. It imports htmldom.js for TYPES ONLY and nothing
 *  else — no stack, no insertion, no tokenizer — which is what lets every
 *  table entry and every predicate be asserted from an element literal with no
 *  parser in the picture. The token RULES stay in htmltree.ts, because they
 *  insert elements, pop the stack and reconstruct formatting; moving those out
 *  needs either a wide seam of injected callbacks or an import back that
 *  closes a cycle. Same split htmlcharref.ts makes against htmltoken.ts.
 *
 *  Invariant: nothing here throws.
 *
 *  Every table below is transcribed from the HTML Standard on 2026-08-27 and
 *  its SIZE is asserted in test/htmlforeign.test.ts, so a half-transcribed
 *  table is a red build rather than a silently mis-cased element that still
 *  renders. */

import type { HtmlElement } from './htmldom.js';

/** §13.2.6.5's SVG tag-name table: 37 entries, keyed on the all-lowercase
 *  spelling the tokenizer emits. */
export const SVG_TAG_NAMES: ReadonlyMap<string, string> = new Map([
  ['altglyph', 'altGlyph'], ['altglyphdef', 'altGlyphDef'], ['altglyphitem', 'altGlyphItem'],
  ['animatecolor', 'animateColor'], ['animatemotion', 'animateMotion'],
  ['animatetransform', 'animateTransform'], ['clippath', 'clipPath'], ['feblend', 'feBlend'],
  ['fecolormatrix', 'feColorMatrix'], ['fecomponenttransfer', 'feComponentTransfer'],
  ['fecomposite', 'feComposite'], ['feconvolvematrix', 'feConvolveMatrix'],
  ['fediffuselighting', 'feDiffuseLighting'], ['fedisplacementmap', 'feDisplacementMap'],
  ['fedistantlight', 'feDistantLight'], ['fedropshadow', 'feDropShadow'],
  ['feflood', 'feFlood'], ['fefunca', 'feFuncA'], ['fefuncb', 'feFuncB'],
  ['fefuncg', 'feFuncG'], ['fefuncr', 'feFuncR'], ['fegaussianblur', 'feGaussianBlur'],
  ['feimage', 'feImage'], ['femerge', 'feMerge'], ['femergenode', 'feMergeNode'],
  ['femorphology', 'feMorphology'], ['feoffset', 'feOffset'], ['fepointlight', 'fePointLight'],
  ['fespecularlighting', 'feSpecularLighting'], ['fespotlight', 'feSpotLight'],
  ['fetile', 'feTile'], ['feturbulence', 'feTurbulence'], ['foreignobject', 'foreignObject'],
  ['glyphref', 'glyphRef'], ['lineargradient', 'linearGradient'],
  ['radialgradient', 'radialGradient'], ['textpath', 'textPath'],
]);

/** "Adjust SVG attributes": 58 entries. */
export const SVG_ATTRS: ReadonlyMap<string, string> = new Map([
  ['attributename', 'attributeName'], ['attributetype', 'attributeType'],
  ['basefrequency', 'baseFrequency'], ['baseprofile', 'baseProfile'], ['calcmode', 'calcMode'],
  ['clippathunits', 'clipPathUnits'], ['diffuseconstant', 'diffuseConstant'],
  ['edgemode', 'edgeMode'], ['filterunits', 'filterUnits'], ['glyphref', 'glyphRef'],
  ['gradienttransform', 'gradientTransform'], ['gradientunits', 'gradientUnits'],
  ['kernelmatrix', 'kernelMatrix'], ['kernelunitlength', 'kernelUnitLength'],
  ['keypoints', 'keyPoints'], ['keysplines', 'keySplines'], ['keytimes', 'keyTimes'],
  ['lengthadjust', 'lengthAdjust'], ['limitingconeangle', 'limitingConeAngle'],
  ['markerheight', 'markerHeight'], ['markerunits', 'markerUnits'],
  ['markerwidth', 'markerWidth'], ['maskcontentunits', 'maskContentUnits'],
  ['maskunits', 'maskUnits'], ['numoctaves', 'numOctaves'], ['pathlength', 'pathLength'],
  ['patterncontentunits', 'patternContentUnits'], ['patterntransform', 'patternTransform'],
  ['patternunits', 'patternUnits'], ['pointsatx', 'pointsAtX'], ['pointsaty', 'pointsAtY'],
  ['pointsatz', 'pointsAtZ'], ['preservealpha', 'preserveAlpha'],
  ['preserveaspectratio', 'preserveAspectRatio'], ['primitiveunits', 'primitiveUnits'],
  ['refx', 'refX'], ['refy', 'refY'], ['repeatcount', 'repeatCount'],
  ['repeatdur', 'repeatDur'], ['requiredextensions', 'requiredExtensions'],
  ['requiredfeatures', 'requiredFeatures'], ['specularconstant', 'specularConstant'],
  ['specularexponent', 'specularExponent'], ['spreadmethod', 'spreadMethod'],
  ['startoffset', 'startOffset'], ['stddeviation', 'stdDeviation'],
  ['stitchtiles', 'stitchTiles'], ['surfacescale', 'surfaceScale'],
  ['systemlanguage', 'systemLanguage'], ['tablevalues', 'tableValues'], ['targetx', 'targetX'],
  ['targety', 'targetY'], ['textlength', 'textLength'], ['viewbox', 'viewBox'],
  ['viewtarget', 'viewTarget'], ['xchannelselector', 'xChannelSelector'],
  ['ychannelselector', 'yChannelSelector'], ['zoomandpan', 'zoomAndPan'],
]);

/** "Adjust MathML attributes". ONE entry is what the spec defines — it reads
 *  like an error and is not. A table anyway, so all three adjust calls have
 *  one shape. */
export const MATHML_ATTRS: ReadonlyMap<string, string> = new Map([
  ['definitionurl', 'definitionURL'],
]);

/** "Adjust foreign attributes", stored as the html5lib DISPLAY key: the
 *  prefix, a SPACE, then the local name. `xmlns` has no prefix and so keeps
 *  its own name — the one row whose key and value are equal.
 *
 *  Storing the display key is sound rather than merely convenient: whitespace
 *  terminates an attribute name in the tokenizer, so no document can produce a
 *  literal `xlink href` that would collide with an adjusted one. */
export const FOREIGN_ATTRS: ReadonlyMap<string, string> = new Map([
  ['xlink:actuate', 'xlink actuate'], ['xlink:arcrole', 'xlink arcrole'],
  ['xlink:href', 'xlink href'], ['xlink:role', 'xlink role'],
  ['xlink:show', 'xlink show'], ['xlink:title', 'xlink title'],
  ['xlink:type', 'xlink type'], ['xml:lang', 'xml lang'],
  ['xml:space', 'xml space'], ['xmlns', 'xmlns'], ['xmlns:xlink', 'xmlns xlink'],
]);

/** The HTML start tags that pop out of foreign content, 44 of them. `font` is
 *  deliberately absent: it breaks out only when it carries `color`, `face` or
 *  `size`, which is a test at the call site rather than a member here. */
export const FOREIGN_BREAKOUT: ReadonlySet<string> = new Set([
  'b', 'big', 'blockquote', 'body', 'br', 'center', 'code', 'dd', 'div', 'dl', 'dt', 'em',
  'embed', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'hr', 'i', 'img', 'li', 'listing',
  'menu', 'meta', 'nobr', 'ol', 'p', 'pre', 'ruby', 's', 'small', 'span', 'strong', 'strike',
  'sub', 'sup', 'table', 'tt', 'u', 'ul', 'var',
]);

export function adjustSvgTagName(name: string): string {
  return SVG_TAG_NAMES.get(name) ?? name;
}

/** Rename every listed attribute, keeping its value and leaving the rest
 *  alone. Returns a NEW map: a token's attributes are run through two tables
 *  in SVG (SVG_ATTRS then FOREIGN_ATTRS), and mutating in place would make the
 *  order of those two calls matter. */
export function adjustAttributes(
  attrs: Map<string, string>,
  table: ReadonlyMap<string, string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of attrs) out.set(table.get(k) ?? k, v);
  return out;
}

const MATHML_TEXT_POINTS = new Set(['mi', 'mo', 'mn', 'ms', 'mtext']);
const SVG_HTML_POINTS = new Set(['foreignObject', 'desc', 'title']);
const HTML_ENCODINGS = new Set(['text/html', 'application/xhtml+xml']);

/** §13.2.6.5. The NAMESPACE is half the answer: an HTML `<mi>` is an ordinary
 *  unknown element and only a MathML one is an integration point. */
export function isMathmlTextIntegrationPoint(el: HtmlElement): boolean {
  return el.ns === 'math' && MATHML_TEXT_POINTS.has(el.name);
}

/** §13.2.6.5. Note the SVG names are the ADJUSTED spellings, because that is
 *  what the element carries by the time this is asked — matching
 *  `foreignobject` here silently never fires.
 *
 *  The spec phrases the annotation-xml case as a property of the START TAG's
 *  `encoding` attribute, which invites keeping a side table; we store the
 *  token's attributes on the element, so reading the element is equivalent. */
export function isHtmlIntegrationPoint(el: HtmlElement): boolean {
  if (el.ns === 'svg') return SVG_HTML_POINTS.has(el.name);
  if (el.ns !== 'math' || el.name !== 'annotation-xml') return false;
  const enc = el.attrs.get('encoding');
  return enc !== undefined && HTML_ENCODINGS.has(enc.toLowerCase());
}
