import type { Page } from '../../src/index.js';
import { addText, pageWidth, sectionHeader } from './theme.js';

export function addLandscapeChart(page: Page): void {
  const w = pageWidth(page); // 842 x 595 for A4 landscape

  sectionHeader(page, 'Annual Sales — 12 Month Trend',
    'PageFormat.A4.landscape()  •  alpha bar fills  •  dashed grid  •  polyline trend  •  labels');

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const values = [42, 51, 49, 58, 67, 72, 79, 81, 74, 68, 55, 62];

  const chartLeft = 80;
  const chartBottom = 110;
  const chartTop = 440;
  const chartRight = w - 60;
  const barSlot = (chartRight - chartLeft) / months.length;
  const barWidth = barSlot * 0.62;

  // Round the y-axis bound up to a nice value so labels read 20/40/60/80/100.
  const target = Math.max(...values) * 1.15;
  const yStep = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000]
    .find((s) => s * 5 >= target) ?? 1;
  const yMax = yStep * 5;
  const scaleY = (chartTop - chartBottom) / yMax;

  const g = page.Graphics();

  // Y-axis grid lines.
  for (let i = 1; i <= 5; i++) {
    const y = chartBottom + (i * (chartTop - chartBottom)) / 5;
    g.save().setStrokeColor([0.9, 0.9, 0.93]).setLineWidth(0.5).setDash([2, 3])
      .drawLine(chartLeft, y, chartRight, y).stroke().restore();
    addText(page, `€${(yStep * i).toFixed(0)}k`,
      [chartLeft - 38, y - 5, chartLeft - 4, y + 5],
      { size: 8, color: [0.5, 0.5, 0.55], align: 'right' });
  }

  // X-axis baseline.
  g.save().setStrokeColor([0.2, 0.2, 0.2]).setLineWidth(1.2).setLineCap(1)
    .drawLine(chartLeft, chartBottom, chartRight, chartBottom).stroke().restore();

  // Bars, month labels, value labels.
  const tops: Array<[number, number]> = [];
  values.forEach((v, i) => {
    const x = chartLeft + i * barSlot + (barSlot - barWidth) / 2;
    const barTop = chartBottom + v * scaleY;
    g.save().setOpacity(0.92)
      .setFillColor([0.3, 0.55, 0.85])
      .setStrokeColor([0.1, 0.3, 0.6]).setLineWidth(0.6)
      .rect(x, chartBottom, barWidth, barTop - chartBottom).fillStroke().restore();
    addText(page, months[i], [x - 5, chartBottom - 18, x + barWidth + 5, chartBottom - 5],
      { size: 10, color: [0.3, 0.3, 0.35], align: 'center' });
    addText(page, `€${v.toFixed(0)}k`, [x - 10, barTop + 2, x + barWidth + 10, barTop + 14],
      { font: 'Helvetica-Bold', size: 9, color: [0.1, 0.3, 0.6], align: 'center' });
    tops.push([x + barWidth / 2, barTop]);
  });

  // Trend polyline through the bar tops.
  g.setStrokeColor([0.95, 0.55, 0.05]).setLineWidth(1.8).setLineCap(1).setLineJoin(1)
    .polyline(tops).stroke();

  g.apply();
}
