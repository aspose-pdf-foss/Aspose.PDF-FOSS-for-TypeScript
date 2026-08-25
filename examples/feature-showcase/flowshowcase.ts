import type { Document, EmbeddedFont, Page } from '../../src/index.js';
import { PageFormat } from '../../src/index.js';
import { sectionHeader, INK, MUTED, NAVY } from './theme.js';
import { einstein, newton } from './assets.js';

/** `formulaFont` is the shared DejaVu Sans handle, so the sub/superscripts in
 *  the formula cards render. It is the same handle the text page uses: one
 *  AddFontFile per document means one subset embedded at Save, not two. */
export function addFlowShowcase(doc: Document, formulaFont: EmbeddedFont): Page[] {
  const indigo = NAVY;
  const ink = INK;
  const muted = MUTED;

  const body = { font: 'Helvetica' as const, fontSize: 9.5, color: ink, leading: 13.3 };
  const h2 = { font: 'Helvetica-Bold' as const, fontSize: 15, color: indigo };
  const caption = {
    font: 'Helvetica-Oblique' as const, fontSize: 8, color: muted, align: 'center' as const,
  };
  const lede = {
    font: 'Helvetica-BoldOblique' as const, fontSize: 10, color: indigo, leading: 13,
  };

  const flow = doc.NewFlow({
    format: PageFormat.A4.landscape(),
    columns: 2,
    columnGap: 34,
    marginLeft: 48,
    marginRight: 48,
    marginTop: 128,
    marginBottom: 52,
    paragraphSpacing: 7,
  });

  const giant = (
    img: Uint8Array, name: string, dates: string, tagline: string, prose: string,
    formula: string, quote: string, bullets: string[], accent: [number, number, number],
  ): void => {
    // Portrait + caption, floated left; the heading and prose wrap beside it and
    // then continue at full column width beneath.
    const portrait = doc.NewFloatingBox({ width: 112, spacing: 2 });
    portrait.AddImage(img, { width: 112 });
    portrait.AddParagraph(dates, caption);
    flow.AddFloatBox(portrait, 'left');

    flow.AddHeading(2, name, h2);
    flow.AddParagraph(tagline, lede);
    flow.AddParagraph(prose, body);

    // Formula card — an in-flow box; symmetric padding centres the single line.
    const card = doc.NewFloatingBox({
      width: 320,
      spacing: 0,
      background: [0.95, 0.96, 1],
      border: { width: 0.7, color: accent, sides: 'all' },
      padding: { top: 11, right: 8, bottom: 11, left: 8 },
    });
    card.AddParagraph(formula,
      { font: formulaFont, fontSize: 15, color: indigo, align: 'center' });
    flow.AddFloatingBox(card);

    // Pull-quote — an in-flow box with a left rule only.
    const pull = doc.NewFloatingBox({
      width: 320,
      spacing: 0,
      border: { width: 3, color: accent, sides: { left: true } },
      padding: { top: 9, right: 6, bottom: 9, left: 12 },
    });
    pull.AddParagraph(quote,
      { font: 'Times-Italic', fontSize: 10, color: muted, leading: 11.5 });
    flow.AddFloatingBox(pull);

    flow.AddList(bullets, { font: 'Helvetica', fontSize: 9, color: ink, leading: 11.7 });
  };

  giant(newton(),
    'Isaac Newton',
    'Woolsthorpe, 1643  —  London, 1727',
    'The architect of classical mechanics.',
    "Newton's Principia Mathematica (1687) unified terrestrial and celestial motion under a single law of universal gravitation, and his three laws of motion became the bedrock of physics for the next two centuries. Working in near-isolation during the plague years at Woolsthorpe, he also co-invented the calculus, and in the Opticks he demonstrated with prisms that white light is a mixture of colours. A reflecting telescope of his own design and studies of cooling and the speed of sound rounded out a singular career. As Lucasian Professor at Cambridge, and later Master of the Royal Mint, he pursued mathematics, alchemy and theology with the same relentless focus. Elected President of the Royal Society in 1703, he was knighted by Queen Anne two years later — the first man of science to be so honoured.",
    'F  =  G · m₁m₂ / r²',
    '“If I have seen further it is by standing on the shoulders of Giants.”',
    [
      'Laws of motion & universal gravitation',
      'Co-invention of the calculus',
      'Decomposition of white light (Opticks)',
      'The reflecting telescope',
    ],
    [0.55, 0.45, 0.20]);

  flow.AddColumnBreak(); // Newton fills the left column; Einstein opens the right.

  giant(einstein(),
    'Albert Einstein',
    'Ulm, 1879  —  Princeton, 1955',
    'The author of relativity.',
    "Einstein's 1905 “miracle year” produced special relativity, the explanation of Brownian motion, the photoelectric effect — for which he received the 1921 Nobel Prize — and the mass–energy equivalence E = mc². A decade later, general relativity recast gravity as the curvature of spacetime, a description confirmed again and again, from starlight bending around the Sun in 1919 to the gravitational waves detected a century later. Born in Ulm and schooled in Munich and Zurich, he sketched his earliest ideas while working as a clerk in the Bern patent office. He left Germany for good in 1933, settled at the Institute for Advanced Study in Princeton, and spent his final years there — an outspoken advocate for pacifism and civil rights — pursuing a unified field theory.",
    'E  =  mc²',
    '“Imagination is more important than knowledge.”',
    [
      'Special & general relativity',
      'Mass–energy equivalence, E = mc²',
      'Photoelectric effect (1921 Nobel Prize)',
      'Foundations of modern cosmology',
    ],
    [0.20, 0.40, 0.60]);

  const pages = flow.Render();

  // The standard section header, drawn on the flow's first page — the flow left
  // a 128pt top margin clear for exactly this.
  sectionHeader(pages[0], 'Flow Layout — Giants of Physics',
    'two columns  •  floated portraits with wrap-around  •  formula cards  •  pull-quotes  •  lists');

  return pages;
}
