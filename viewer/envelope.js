// Reads the collector's state file and turns it into a grid the renderer can use.
//
// Pure data handling — no three.js in here. See ../DESIGN.md §2 for the model, and
// in particular §2.1 for why the closure runs upward in altitude.

/** Fetches and lightly validates the envelope state. */
export async function loadEnvelope(url) {
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`envelope.json: HTTP ${resp.status}`);
  const doc = await resp.json();
  if (doc.version !== 1) throw new Error(`envelope version ${doc.version} unsupported`);
  if (!Array.isArray(doc.bandEdges) || doc.bandEdges.length < 2) {
    throw new Error('envelope has no band edges');
  }
  return doc;
}

/**
 * Builds a 360 x nBands grid of maximum ranges.
 *
 * minHits    cells with fewer corroborating positions are ignored outright, so a
 *            single bad decode cannot shape the surface
 * closure    monotone-upward fill: coverage at an altitude implies coverage at every
 *            altitude above it, at the same range
 * smoothDeg  circular boxcar across azimuth, averaging only over bearings that
 *            already have data, so smoothing never invents coverage
 */
export function buildGrid(doc, { minHits = 2, closure = true, smoothDeg = 5 } = {}) {
  const nb = doc.bandEdges.length - 1;
  const ranges = new Float32Array(360 * nb);
  const hits = new Uint32Array(360 * nb);

  for (const key in doc.cells) {
    const comma = key.indexOf(',');
    const az = +key.slice(0, comma);
    const band = +key.slice(comma + 1);
    if (!(az >= 0 && az < 360) || !(band >= 0 && band < nb)) continue;
    const cell = doc.cells[key];
    const n = cell.n || 0;
    if (n < minHits) continue;
    ranges[az * nb + band] = cell.d || 0;
    hits[az * nb + band] = n;
  }

  let grid = ranges;

  if (closure) {
    grid = new Float32Array(ranges);
    for (let az = 0; az < 360; az++) {
      let running = 0;
      const row = az * nb;
      for (let band = 0; band < nb; band++) {
        if (grid[row + band] > running) running = grid[row + band];
        grid[row + band] = running;
      }
    }
  }

  if (smoothDeg > 1) {
    const half = Math.floor(smoothDeg / 2);
    const out = new Float32Array(grid.length);
    for (let band = 0; band < nb; band++) {
      for (let az = 0; az < 360; az++) {
        const centre = grid[az * nb + band];
        if (centre <= 0) continue;        // never fill an empty bearing
        let sum = 0, count = 0;
        for (let k = -half; k <= half; k++) {
          const v = grid[(((az + k) % 360) + 360) % 360 * nb + band];
          if (v > 0) { sum += v; count++; }
        }
        out[az * nb + band] = count ? sum / count : centre;
      }
    }
    grid = out;
  }

  return { grid, hits, nBands: nb, edges: doc.bandEdges, doc };
}

/** Max range at a bearing and band, with bearings wrapped. */
export function rangeAt(model, az, band) {
  const a = (((az | 0) % 360) + 360) % 360;
  return model.grid[a * model.nBands + band];
}

/** Index of the band containing an altitude, or -1. */
export function bandOf(model, altFt) {
  const e = model.edges;
  if (altFt < e[0] || altFt >= e[e.length - 1]) return -1;
  let lo = 0, hi = model.nBands;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (e[mid] <= altFt) lo = mid; else hi = mid;
  }
  return lo;
}

/**
 * The coverage floor: lowest altitude ever received at this bearing and range.
 * Returns null where nothing has ever been heard that far out.
 */
export function floorAltFt(model, az, rangeNm) {
  for (let band = 0; band < model.nBands; band++) {
    if (rangeAt(model, az, band) >= rangeNm) return model.edges[band];
  }
  return null;
}

/** Closed ring of ranges for one altitude, as a 360-length array. */
export function ringForAltitude(model, altFt) {
  const band = bandOf(model, altFt);
  if (band < 0) return null;
  const out = new Float32Array(360);
  for (let az = 0; az < 360; az++) out[az] = rangeAt(model, az, band);
  return out;
}

/** Summary numbers for the readout panel. */
export function summarize(model, minHits) {
  let filled = 0, best = 0, bestAz = 0, bestAlt = 0;
  for (const key in model.doc.cells) {
    const cell = model.doc.cells[key];
    if ((cell.n || 0) < minHits) continue;
    filled++;
    if (cell.d > best) {
      best = cell.d;
      bestAz = +key.slice(0, key.indexOf(','));
      bestAlt = cell.rec ? cell.rec.alt : 0;
    }
  }
  const bearings = new Set();
  for (let az = 0; az < 360; az++) {
    for (let band = 0; band < model.nBands; band++) {
      if (model.grid[az * model.nBands + band] > 0) { bearings.add(az); break; }
    }
  }
  return {
    filled,
    cells: Object.keys(model.doc.cells).length,
    samples: model.doc.samples || 0,
    bearings: bearings.size,
    maxRangeNm: best,
    maxRangeAz: bestAz,
    maxRangeAltFt: bestAlt,
    created: model.doc.created,
    updated: model.doc.updated,
  };
}

/** The record-setting contact for a cell, for the click readout. */
export function cellRecord(model, az, band) {
  const cell = model.doc.cells[`${az},${band}`];
  return cell ? { ...cell } : null;
}
