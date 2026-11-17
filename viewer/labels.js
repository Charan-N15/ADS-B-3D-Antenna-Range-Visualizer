// ATC-style data blocks for live traffic.
//
// Drawn flat on a 2D canvas laid over the 3D scene rather than inside it, so the
// text stays sharp and the same size on screen however far the camera is pulled
// back, the same way the aircraft themselves are kept a fixed size. Each frame
// every aircraft's position is projected to the screen and its box is placed at
// one of its four corners, whichever collides least with the boxes already down.

import * as THREE from 'three';

const FONT_PX = 12;
const LINE_PX = 14;
const PAD_X = 5;
const PAD_Y = 3;

/** Clear space between the aircraft's centre and its box, beyond half its size. */
const GAP_PX = 2;

/** Climbing or descending faster than this, feet a minute, earns an arrow. Matches the pitch. */
const LEVEL_FPM = 150;

/** Hijack, radio failure, emergency. The only time a label leaves monochrome. */
const EMERGENCY_SQUAWKS = new Set(['7500', '7600', '7700']);

const STYLE = {
  font: `${FONT_PX}px ui-monospace, "DejaVu Sans Mono", Consolas, monospace`,
  fill: 'rgba(15, 16, 18, 0.8)',
  edge: '#3c414a',
  text: '#f2f3f5',
  alert: '#ff6a5e',
};

/** Up-right, up-left, down-right, down-left: the order a box tries the corners. */
const CORNERS = [[1, -1], [-1, -1], [1, 1], [-1, 1]];

/** Other aircraft count against a placement, but less than covering another label. */
const PLANE_WEIGHT = 0.5;

/** What O steps through, each adding a field to the one before. */
export const LABEL_PRESETS = [
  { callsign: true, altitude: false, type: false },
  { callsign: true, altitude: true, type: false },
  { callsign: true, altitude: true, type: true },
];

/** The preset these fields match, or -1 for a mix of one's own. */
export function presetIndex(fields) {
  return LABEL_PRESETS.findIndex((p) => Object.keys(p).every((k) => p[k] === fields[k]));
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
 * The lines of an aircraft's box: callsign and type share the first, altitude
 * has the second. Fields switched off drop out, and so does a type the database
 * does not know, rather than leaving a placeholder.
 */
export function labelLines(c, fields) {
  const top = [];
  if (fields.callsign) top.push(c.flight || c.hex.toUpperCase());
  if (fields.type && c.type) top.push(c.type);
  const lines = [];
  if (top.length) lines.push(top.join(' '));
  if (fields.altitude) lines.push(flightLevel(c));
  return lines;
}

function overlap(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

const _v = new THREE.Vector3();

export class LabelLayer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    // Corner each aircraft's box sat at last frame, so labels only move when
    // they have to rather than flickering between equally good spots.
    this.corners = new Map();
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
    if (!layer || !layer.contacts.length) {
      this.corners.clear();
      return;
    }
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.font = STYLE.font;
    ctx.textBaseline = 'top';
    this.dirty = true;

    const half = planePx / 2;
    const items = [];
    const planes = [];
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
      planes.push({ x: x - half, y: y - half, w: planePx, h: planePx, hex: c.hex });

      const lines = labelLines(c, fields);
      if (!lines.length) continue;
      const textW = Math.max(...lines.map((line) => this.measure(line)));
      items.push({
        hex: c.hex, lines, x, y, dist,
        w: textW + PAD_X * 2,
        h: lines.length * LINE_PX + PAD_Y * 2,
        alert: EMERGENCY_SQUAWKS.has(c.squawk),
      });
    }

    // Emergencies choose first, then the nearest aircraft: the ones furthest
    // away are the ones that give way.
    items.sort((a, b) => (b.alert - a.alert) || (a.dist - b.dist));

    const gap = half + GAP_PX;
    const placed = [];
    const seen = new Set();
    for (const item of items) {
      seen.add(item.hex);
      const last = this.corners.get(item.hex);
      const order = last === undefined ? [0, 1, 2, 3] : [last, 0, 1, 2, 3].filter((k, i, a) => a.indexOf(k) === i);
      let best = null;
      let bestCost = Infinity;
      for (const k of order) {
        const [dx, dy] = CORNERS[k];
        const rect = {
          x: Math.round(dx > 0 ? item.x + gap : item.x - gap - item.w),
          y: Math.round(dy > 0 ? item.y + gap : item.y - gap - item.h),
          w: item.w,
          h: item.h,
        };
        let cost = 0;
        for (const other of placed) cost += overlap(rect, other);
        for (const plane of planes) {
          if (plane.hex !== item.hex) cost += overlap(rect, plane) * PLANE_WEIGHT;
        }
        // Whatever hangs off the edge of the view is as bad as being covered.
        const inside = overlap(rect, { x: 0, y: 0, w: this.width, h: this.height });
        cost += rect.w * rect.h - inside;
        if (cost < bestCost) {
          best = { rect, k };
          bestCost = cost;
          if (cost === 0) break;
        }
      }
      this.corners.set(item.hex, best.k);
      item.rect = best.rect;
      placed.push(best.rect);
    }
    for (const hex of this.corners.keys()) {
      if (!seen.has(hex)) this.corners.delete(hex);
    }

    // Lowest priority first, so where boxes do have to overlap the one that
    // chose first is drawn on top.
    ctx.lineWidth = 1;
    for (let i = items.length - 1; i >= 0; i--) {
      const { rect, lines, alert } = items[i];
      ctx.fillStyle = STYLE.fill;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      ctx.strokeStyle = alert ? STYLE.alert : STYLE.edge;
      ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
      ctx.fillStyle = alert ? STYLE.alert : STYLE.text;
      lines.forEach((line, n) => {
        ctx.fillText(line, rect.x + PAD_X, rect.y + PAD_Y + n * LINE_PX + 1);
      });
    }
  }
}
