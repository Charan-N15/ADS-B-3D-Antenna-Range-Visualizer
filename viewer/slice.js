// Vertical cross-section through the envelope along one bearing.
//
// Plain 2D canvas. Altitude runs up, ground range runs right, and the picture
// separates three regions:
//
//   below the theoretical floor   geometrically impossible, curvature says no
//   between theory and measured   possible but not achieved: terrain, pattern, gain
//   above the measured floor      confirmed coverage
//
// Curvature is not drawn as a curved ground line, because it is already carried by
// the theoretical floor. Keeping the axes straight makes the chart readable.

import { horizonFloorFt } from './geo.js';
import { rangeAt } from './envelope.js';
import { altitudeCss } from './altitude.js';

const PAD = { left: 52, right: 12, top: 14, bottom: 30 };

const STYLE = {
  axis: '#555',
  text: '#9a9a9a',
  textDim: '#6a6a6a',
  grid: '#262626',
  impossible: '#111111',
  unachieved: '#1d1d1d',
  achieved: 'rgba(61,125,191,0.17)',
  measured: '#6ba8df',
  theory: '#808080',
  aircraft: '#e8e8e8',
};

export class SliceView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.maxRangeNm = 160;
    this.maxAltFt = 45000;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = rect.width;
    this.h = rect.height;
  }

  xOf(rangeNm) {
    const inner = this.w - PAD.left - PAD.right;
    return PAD.left + (rangeNm / this.maxRangeNm) * inner;
  }

  yOf(altFt) {
    const inner = this.h - PAD.top - PAD.bottom;
    return PAD.top + inner - (altFt / this.maxAltFt) * inner;
  }

  /**
   * model     grid from envelope.js
   * azDeg     bearing to cut along
   * spreadDeg bearings either side to merge, since one degree is sparse
   * rxAltFt   antenna height above sea level
   * contacts  live aircraft, filtered to the window by the caller
   */
  draw({ model, azDeg, spreadDeg, rxAltFt, contacts, colorByAlt }) {
    this.resize();
    this.colorByAlt = Boolean(colorByAlt);
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    if (!model) return;

    const x0 = this.xOf(0), x1 = this.xOf(this.maxRangeNm);
    const yTop = this.yOf(this.maxAltFt), yBottom = this.yOf(0);

    // Measured floor, merged across the azimuth window: the best range achieved in
    // each band anywhere in the window.
    const nb = model.nBands;
    const merged = new Float32Array(nb);
    for (let band = 0; band < nb; band++) {
      let best = 0;
      for (let k = -spreadDeg; k <= spreadDeg; k++) {
        const r = rangeAt(model, azDeg + k, band);
        if (r > best) best = r;
      }
      merged[band] = best;
    }

    // Region fills, back to front.
    ctx.fillStyle = STYLE.unachieved;
    ctx.fillRect(x0, yTop, x1 - x0, yBottom - yTop);

    ctx.fillStyle = STYLE.impossible;
    ctx.beginPath();
    ctx.moveTo(x0, yBottom);
    for (let r = 0; r <= this.maxRangeNm; r += 2) {
      ctx.lineTo(this.xOf(r), this.yOf(Math.min(horizonFloorFt(r, rxAltFt), this.maxAltFt)));
    }
    ctx.lineTo(x1, yBottom);
    ctx.closePath();
    ctx.fill();

    // One rectangle per altitude band rather than a single polygon, so each band can
    // carry its own colour from tar1090's ramp.
    for (let band = 0; band < nb; band++) {
      const r = Math.min(merged[band], this.maxRangeNm);
      if (r <= 0) continue;
      const yHigh = this.yOf(Math.min(model.edges[band + 1], this.maxAltFt));
      const yLow = this.yOf(Math.min(model.edges[band], this.maxAltFt));
      ctx.fillStyle = colorByAlt
        ? altitudeCss(model.edges[band], 0.3)
        : STYLE.achieved;
      ctx.fillRect(x0, yHigh, this.xOf(r) - x0, yLow - yHigh);
    }

    this.drawGrid(ctx, x0, x1, yTop, yBottom);

    // Theoretical floor.
    ctx.strokeStyle = STYLE.theory;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    for (let r = 0; r <= this.maxRangeNm; r += 2) {
      const alt = horizonFloorFt(r, rxAltFt);
      if (alt > this.maxAltFt) break;
      const px = this.xOf(r), py = this.yOf(alt);
      if (r === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Measured floor as a staircase: each step is one altitude band. Stroked per
    // step so the step's own altitude colour carries through.
    ctx.lineWidth = 1.5;
    let prev = null;
    for (let band = nb - 1; band >= 0; band--) {
      const r = Math.min(merged[band], this.maxRangeNm);
      if (r <= 0) continue;
      const px = this.xOf(r);
      const yHigh = this.yOf(Math.min(model.edges[band + 1], this.maxAltFt));
      const yLow = this.yOf(model.edges[band]);
      ctx.strokeStyle = colorByAlt
        ? altitudeCss(model.edges[band])
        : STYLE.measured;
      ctx.beginPath();
      if (prev !== null) ctx.moveTo(prev, yHigh); else ctx.moveTo(px, yHigh);
      ctx.lineTo(px, yHigh);
      ctx.lineTo(px, yLow);
      ctx.stroke();
      prev = px;
    }

    // Live traffic in the window.
    for (const c of contacts || []) {
      if (c.rangeNm > this.maxRangeNm || c.altFt > this.maxAltFt) continue;
      ctx.fillStyle = colorByAlt ? altitudeCss(c.altFt) : STYLE.aircraft;
      ctx.fillRect(this.xOf(c.rangeNm) - 1.5, this.yOf(c.altFt) - 1.5, 3, 3);
    }

    this.drawLabels(ctx, x0, x1, yTop, yBottom, azDeg, spreadDeg);
  }

  drawGrid(ctx, x0, x1, yTop, yBottom) {
    ctx.strokeStyle = STYLE.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let alt = 10000; alt <= this.maxAltFt; alt += 10000) {
      const y = this.yOf(alt);
      ctx.moveTo(x0, y); ctx.lineTo(x1, y);
    }
    const step = this.maxRangeNm > 200 ? 50 : 25;
    for (let r = step; r <= this.maxRangeNm; r += step) {
      const x = this.xOf(r);
      ctx.moveTo(x, yTop); ctx.lineTo(x, yBottom);
    }
    ctx.stroke();

    ctx.strokeStyle = STYLE.axis;
    ctx.beginPath();
    ctx.moveTo(x0, yTop); ctx.lineTo(x0, yBottom); ctx.lineTo(x1, yBottom);
    ctx.stroke();
  }

  drawLabels(ctx, x0, x1, yTop, yBottom, azDeg, spreadDeg) {
    ctx.font = '10px ui-monospace, "DejaVu Sans Mono", monospace';
    ctx.fillStyle = STYLE.text;

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let alt = 0; alt <= this.maxAltFt; alt += 10000) {
      ctx.fillText(alt === 0 ? '0' : `${alt / 1000}k`, x0 - 6, this.yOf(alt));
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const step = this.maxRangeNm > 200 ? 50 : 25;
    for (let r = 0; r <= this.maxRangeNm; r += step) {
      ctx.fillText(String(r), this.xOf(r), yBottom + 6);
    }

    ctx.fillStyle = STYLE.textDim;
    ctx.textAlign = 'left';
    ctx.fillText('ft', x0 - 46, yTop - 2);
    ctx.textAlign = 'right';
    ctx.fillText('nm', x1, yBottom + 16);

    ctx.fillStyle = STYLE.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const pad = String(Math.round(azDeg)).padStart(3, '0');
    ctx.fillText(`${pad}° ±${spreadDeg}°`, x0 + 6, yTop + 2);

    this.drawLegend(ctx, x0, yTop);
  }

  // Kept on the left, under the bearing label: the top right of the stage carries
  // the contact count.
  drawLegend(ctx, x0, yTop) {
    const rows = [
      [STYLE.achieved, 'confirmed coverage'],
      [STYLE.unachieved, 'not reached'],
      [STYLE.impossible, 'below the horizon'],
    ];
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    let y = yTop + 20;
    for (const [fill, label] of rows) {
      const x = x0 + 6;
      if (fill === STYLE.achieved && this.colorByAlt) {
        // Coverage is no longer one colour, so the swatch shows the ramp instead.
        const steps = [30000, 10000, 2000];
        for (let i = 0; i < steps.length; i++) {
          ctx.fillStyle = altitudeCss(steps[i], 0.75);
          ctx.fillRect(x, y - 4 + i * 3, 9, 3);
        }
      } else {
        ctx.fillStyle = fill;
        ctx.fillRect(x, y - 4, 9, 9);
      }
      ctx.strokeStyle = STYLE.grid;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y - 3.5, 8, 8);
      ctx.fillStyle = STYLE.textDim;
      ctx.fillText(label, x + 14, y);
      y += 13;
    }
  }
}
