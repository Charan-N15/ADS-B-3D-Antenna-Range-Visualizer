// ATC-style data blocks for live traffic.
//
// Drawn flat on a 2D canvas laid over the 3D scene rather than inside it, so the
// text stays sharp and the same size on screen however far the camera is pulled
// back, the same way the aircraft themselves are kept a fixed size. Each frame
// every aircraft's position is projected to the screen and its box set against
// it, up and to the right. Always that corner: a box that hopped to whichever
// side was free would hop every time the view turned.

import * as THREE from 'three';

const FONT_PX = 12;
const LINE_PX = 14;
const PAD_X = 5;
const PAD_Y = 3;

/** Clear space between the aircraft and its box, beyond half the aircraft's size. */
const GAP_PX = 2;

/** Climbing or descending faster than this, feet a minute, earns an arrow. Matches the pitch. */
const LEVEL_FPM = 150;

/** Hijack, radio failure, emergency. The only time a label leaves monochrome. */
const EMERGENCY_SQUAWKS = new Set(['7500', '7600', '7700']);

const STYLE = {
  font: `${FONT_PX}px ui-monospace, "DejaVu Sans Mono", Consolas, monospace`,
  fill: 'rgba(15, 16, 18, 0.5)',
  edge: '#3c414a',
  text: '#f2f3f5',
  alert: '#ff6a5e',
};

/** What a label says until someone picks otherwise. */
export const DEFAULT_LABEL_FIELDS = {
  country: false, callsign: true, altitude: true, type: false,
  range: false, signal: false, rate: false,
};

/** A flag in a label: 3:2, sized to the text, with a little space after it. */
const FLAG_H = 10;
const FLAG_W = 15;
const FLAG_GAP = 4;

/** Messages a second: one decimal while it is small, whole numbers after. */
function fmtRate(rate) {
  return rate < 10 ? `${rate.toFixed(1)}/s` : `${Math.round(rate)}/s`;
}

/** The flag to draw on an aircraft's label, if country is on and it has one. */
export function labelFlag(c, fields) {
  return fields.country ? c.flag || null : null;
}

/**
 * Altitude the way a scope shows it: hundreds of feet, three digits, so 35,000 ft
 * is 350 and 4,500 ft is 045, with an arrow while climbing or descending.
 */
export function flightLevel(c) {
  if (c.onGround) return 'GND';
  const level = String(Math.max(0, Math.round(c.labelAltFt / 100))).padStart(3, '0');
  if (!Number.isFinite(c.vs)) return level;
  if (c.vs > LEVEL_FPM) return `${level}↑`;
  if (c.vs < -LEVEL_FPM) return `${level}↓`;
  return level;
}

/**
 * The lines of an aircraft's box: who it is on the first (country's flag,
 * callsign, type), how it is heard on the second (altitude, range from the
 * receiver, signal strength, message rate). Fields switched off drop out, and so
 * does anything the aircraft has not sent or the database does not know, rather
 * than leaving a placeholder. The flag is drawn, not written, so a first line
 * holding only a flag is an empty string.
 */
export function labelLines(c, fields) {
  const flag = labelFlag(c, fields);
  const top = [];
  if (fields.callsign) top.push(c.flight || c.hex.toUpperCase());
  if (fields.type && c.type) top.push(c.type);
  const bottom = [];
  if (fields.altitude) bottom.push(flightLevel(c));
  if (fields.range && Number.isFinite(c.rangeNm)) bottom.push(`${Math.round(c.rangeNm)}nm`);
  if (fields.signal && Number.isFinite(c.rssi)) bottom.push(`${Math.round(c.rssi)}dB`);
  if (fields.rate && Number.isFinite(c.msgRate)) bottom.push(fmtRate(c.msgRate));
  const lines = [];
  if (top.length || flag) lines.push(top.join(' '));
  if (bottom.length) lines.push(bottom.join(' '));
  return lines;
}

const _v = new THREE.Vector3();

export class LabelLayer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.textWidths = new Map();
    this.dirty = false;
  }

  resize(width, height, dpr) {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.dirty = true;
  }

  clear() {
    if (!this.dirty) return;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.dirty = false;
  }

  measure(text) {
    let w = this.textWidths.get(text);
    if (w === undefined) {
      // Callsigns come and go, so the cache is only ever a few hundred strings.
      if (this.textWidths.size > 2000) this.textWidths.clear();
      w = Math.ceil(this.ctx.measureText(text).width);
      this.textWidths.set(text, w);
    }
    return w;
  }

  /**
   * layer: the AircraftLayer, whose projected positions the boxes hang off, or
   * null to show nothing. planePx: roughly how big an aircraft is on screen.
   */
  draw(layer, camera, fields, planePx) {
    this.clear();
    if (!layer || !layer.contacts.length) return;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.font = STYLE.font;
    ctx.textBaseline = 'top';
    this.dirty = true;

    const gap = planePx / 2 + GAP_PX;
    const items = [];
    const { contacts, headPositions } = layer;
    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i];
      _v.fromArray(headPositions, i * 3);
      const dist = _v.distanceTo(camera.position);
      _v.project(camera);
      // Behind the camera, or past the far plane.
      if (_v.z < -1 || _v.z > 1) continue;
      const x = (_v.x + 1) / 2 * this.width;
      const y = (1 - _v.y) / 2 * this.height;
      if (x < -50 || x > this.width + 50 || y < -50 || y > this.height + 50) continue;

      const lines = labelLines(c, fields);
      if (!lines.length) continue;
      const flag = labelFlag(c, fields);
      // The flag leads the first line, so that line is that much wider.
      const lead = flag ? FLAG_W + (lines[0] ? FLAG_GAP : 0) : 0;
      const textW = Math.max(...lines.map((line, n) => this.measure(line) + (n ? 0 : lead)));
      items.push({
        hex: c.hex, lines, x, y, dist, flag, lead,
        w: textW + PAD_X * 2,
        h: lines.length * LINE_PX + PAD_Y * 2,
        alert: EMERGENCY_SQUAWKS.has(c.squawk),
      });
    }

    // Furthest first, so nearer aircraft draw over them, and emergencies over all.
    items.sort((a, b) => (a.alert - b.alert) || (b.dist - a.dist));

    ctx.lineWidth = 1;
    for (const { x, y, w, h, lines, alert, flag, lead } of items) {
      const bx = Math.round(x + gap);
      const by = Math.round(y - gap) - h;
      ctx.fillStyle = STYLE.fill;
      ctx.fillRect(bx, by, w, h);
      ctx.strokeStyle = alert ? STYLE.alert : STYLE.edge;
      ctx.strokeRect(bx + 0.5, by + 0.5, w - 1, h - 1);
      if (flag) ctx.drawImage(flag, bx + PAD_X, by + PAD_Y + 2, FLAG_W, FLAG_H);
      ctx.fillStyle = alert ? STYLE.alert : STYLE.text;
      lines.forEach((line, n) => {
        ctx.fillText(line, bx + PAD_X + (n ? 0 : lead), by + PAD_Y + n * LINE_PX + 1);
      });
    }
  }
}
