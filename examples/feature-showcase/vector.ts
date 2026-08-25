import type { Page } from '../../src/index.js';
import type { Box } from './theme.js';
import { cardGrid, sectionHeader } from './theme.js';

export function addVectorShowcase(page: Page): void {
  sectionHeader(page, 'Vector Graphics',
    'lines  •  rectangles  •  circle & ellipse  •  polyline  •  polygon  •  path with arc  •  gradient fills');

  const LABELS = [
    'Lines — width, dash, cap',
    'Rectangle  •  Rounded',
    'Circle  •  radial gradient',
    'Polyline',
    'Polygon',
    'Path with arc',
  ];

  const inners = cardGrid(page, LABELS, {
    cols: 2, rows: 3, left: 50, right: 545, top: 705, bottom: 105,
  });

  const midY = (b: Box): number => (b[1] + b[3]) / 2;
  const midX = (b: Box): number => (b[0] + b[2]) / 2;
  const g = page.Graphics();

  // --- Card 1: three stroke variants -------------------------------------
  let inner = inners[0];
  let ym = midY(inner);
  g.save().setStrokeColor([0.20, 0.30, 0.70]).setLineWidth(2.5).setLineCap(1)
    .drawLine(inner[0] + 8, ym + 28, inner[2] - 8, ym + 28).stroke().restore();
  g.save().setStrokeColor([0.95, 0.55, 0.05]).setLineWidth(2).setDash([8, 5])
    .drawLine(inner[0] + 8, ym, inner[2] - 8, ym).stroke().restore();
  g.save().setStrokeColor([0.10, 0.50, 0.30]).setLineWidth(3).setLineCap(1).setDash([0.5, 6])
    .drawLine(inner[0] + 8, ym - 28, inner[2] - 8, ym - 28).stroke().restore();

  // --- Card 2: rectangle + rounded rectangle ------------------------------
  inner = inners[1];
  const gap = 14;
  const half = (inner[2] - inner[0] - gap) / 2;
  g.save().setFillColor([0.82, 0.88, 1.00])
    .setStrokeColor([0.20, 0.30, 0.70]).setLineWidth(1.2)
    .rect(inner[0], inner[1] + 6, half, inner[3] - inner[1] - 12).fillStroke().restore();
  g.save().setFillColor([1.00, 0.92, 0.78])
    .setStrokeColor([0.95, 0.55, 0.05]).setLineWidth(1.2)
    .roundedRect(inner[0] + half + gap, inner[1] + 6,
      inner[2] - (inner[0] + half + gap), inner[3] - inner[1] - 12, 14)
    .fillStroke().restore();

  // --- Card 3: circle with a radial gradient, plus an ellipse -------------
  inner = inners[2];
  ym = midY(inner);
  const cR = 28;
  const cCx = inner[0] + cR + 12;
  g.save()
    .setFillGradient({
      kind: 'radial',
      cx: cCx,
      cy: ym,
      r: cR,
      fx: cCx - cR * 0.4,
      fy: ym + cR * 0.4,
      stops: [
        { offset: 0, color: [0.98, 0.95, 1.0] },
        { offset: 1, color: [0.55, 0.25, 0.70] },
      ],
    })
    .setStrokeColor([0.45, 0.20, 0.62]).setLineWidth(1.4)
    .circle(cCx, ym, cR).fillStroke().restore();
  g.save().setOpacity(0.92).setFillColor([0.85, 0.95, 0.85])
    .setStrokeColor([0.10, 0.50, 0.30]).setLineWidth(1.4)
    .ellipse(inner[2] - 50, ym, 44, 24).fillStroke().restore();

  // --- Card 4: polyline zigzag -------------------------------------------
  inner = inners[3];
  const steps = 8;
  const stride = (inner[2] - inner[0] - 16) / steps;
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= steps; i++) {
    pts.push([inner[0] + 8 + i * stride, i % 2 === 1 ? inner[3] - 14 : inner[1] + 14]);
  }
  g.save().setStrokeColor([0.95, 0.55, 0.05]).setLineWidth(2.5).setLineCap(1).setLineJoin(1)
    .polyline(pts).stroke().restore();

  // --- Card 5: five-point star with a radial gradient fill ----------------
  inner = inners[4];
  const sx = midX(inner);
  const sy = midY(inner);
  const outerR = 36;
  const innerR = 15;
  const star: Array<[number, number]> = [];
  for (let i = 0; i < 10; i++) {
    const ang = Math.PI / 2 - (i * Math.PI) / 5;
    const r = i % 2 === 1 ? innerR : outerR;
    star.push([sx + r * Math.cos(ang), sy + r * Math.sin(ang)]);
  }
  g.save()
    .setFillGradient({
      kind: 'radial',
      cx: sx,
      cy: sy,
      r: outerR,
      stops: [
        { offset: 0, color: [1.00, 0.96, 0.70] },
        { offset: 1, color: [0.96, 0.66, 0.12] },
      ],
    })
    .setStrokeColor([0.78, 0.55, 0.06]).setLineWidth(1.3).setLineJoin(0).setMiterLimit(4)
    .polygon(star).fillStroke().restore();

  // --- Card 6: pie slice via arc, plus a cubic Bezier wave ----------------
  inner = inners[5];
  const pcx = inner[0] + 38;
  const pcy = (inner[1] + inner[3]) / 2;
  const pieR = 34;
  g.save().setFillColor([0.78, 0.88, 1.00])
    .setStrokeColor([0.20, 0.45, 0.78]).setLineWidth(1.3)
    .moveTo(pcx, pcy).lineTo(pcx + pieR, pcy)
    .arc(pcx, pcy, pieR, 0, 2.0944) // 120 degrees
    .close()
    .fillStroke()
    .restore();

  const wx0 = inner[0] + 88;
  const wx1 = inner[2] - 4;
  g.save().setStrokeColor([0.95, 0.55, 0.05]).setLineWidth(2.2).setLineCap(1).setLineJoin(1)
    .moveTo(wx0, pcy)
    .curveTo(wx0 + 14, pcy + 30, wx0 + 30, pcy - 30, wx0 + 44, pcy)
    .curveTo(wx0 + 58, pcy + 30, wx1 - 14, pcy - 30, wx1, pcy)
    .stroke()
    .restore();

  g.apply();
}
