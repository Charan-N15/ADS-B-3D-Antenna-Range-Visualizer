// OpenStreetMap tiles on the ground plane.
//
// The tiles are Web Mercator; the scope is azimuthal equidistant centred on the
// receiver. Rather than fight that, the ground is built as a disc in bearing and
// range — the same frame as the range rings — and each vertex carries the UV of its
// own latitude and longitude. The map is therefore warped into the scope's
// projection, so a range ring crosses the coastline where it really does.

import * as THREE from 'three';
import { project, destination, mercatorX, mercatorY } from './geo.js';

const RADIAL_STEPS = 56;
const AZIMUTH_STEPS = 180;

// Full-colour OSM over a monochrome scope fights with everything, so the tiles get
// darkened and mostly desaturated. The catch is that OSM renders land (#f2efe9) and
// water (#aad3df) at almost the same lightness — 239 against 231 — and separates
// them by hue alone. Desaturate naively and the coastline disappears, which on a
// coastal receiver throws away the single most useful landmark on the map. So water
// is identified by its blueness and pushed down hard; everything else just dims.
const CHROMA = 0.9;
const BRIGHTNESS = 0.42;
const WATER_BLUENESS = 6;
const WATER_DARKEN = 0.45;

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`tile ${url}`));
    img.src = url;
  });
}

/**
 * Loads meta.json and every tile, composes them into one canvas and returns a
 * texture plus the Mercator bounds the canvas covers.
 */
export async function loadBasemap(baseUrl = 'basemap') {
  const resp = await fetch(`${baseUrl}/meta.json`, { cache: 'force-cache' });
  if (!resp.ok) throw new Error(`basemap meta: HTTP ${resp.status}`);
  const meta = await resp.json();

  const across = meta.x1 - meta.x0 + 1;
  const down = meta.y1 - meta.y0 + 1;
  const size = meta.tileSize || 256;

  const canvas = document.createElement('canvas');
  canvas.width = across * size;
  canvas.height = down * size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const jobs = [];
  for (let x = meta.x0; x <= meta.x1; x++) {
    for (let y = meta.y0; y <= meta.y1; y++) {
      jobs.push(loadImage(`${baseUrl}/${meta.zoom}/${x}/${y}.png`)
        .then((img) => ctx.drawImage(img, (x - meta.x0) * size, (y - meta.y0) * size))
        .catch(() => { /* a missing tile just stays black */ }));
    }
  }
  await Promise.all(jobs);

  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = frame.data;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const k = (b - r) > WATER_BLUENESS ? BRIGHTNESS * WATER_DARKEN : BRIGHTNESS;
    px[i] = (lum + (r - lum) * CHROMA) * k;
    px[i + 1] = (lum + (g - lum) * CHROMA) * k;
    px[i + 2] = (lum + (b - lum) * CHROMA) * k;
  }
  ctx.putImageData(frame, 0, 0);

  const n = 2 ** meta.zoom;
  const texture = new THREE.CanvasTexture(canvas);
  texture.flipY = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;

  return {
    meta,
    texture,
    bounds: {
      mx0: meta.x0 / n,
      mx1: (meta.x1 + 1) / n,
      my0: meta.y0 / n,
      my1: (meta.y1 + 1) / n,
    },
  };
}

/**
 * The ground disc. rx is the receiver position; the disc is clipped to the
 * coverage radius so the map never extends past the data it is there to explain.
 */
export function buildBasemapDisc(basemap, rx, maxRangeNm, opts, opacity) {
  const { bounds, texture } = basemap;
  const rings = RADIAL_STEPS + 1;
  const positions = new Float32Array(rings * AZIMUTH_STEPS * 3);
  const uvs = new Float32Array(rings * AZIMUTH_STEPS * 2);

  const spanX = bounds.mx1 - bounds.mx0;
  const spanY = bounds.my1 - bounds.my0;

  for (let i = 0; i < rings; i++) {
    const range = (maxRangeNm * i) / RADIAL_STEPS;
    for (let j = 0; j < AZIMUTH_STEPS; j++) {
      const az = (360 * j) / AZIMUTH_STEPS;
      const [x, y, z] = project(az, range, 0, opts);
      const v = i * AZIMUTH_STEPS + j;
      positions[v * 3] = x;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = z;

      const [lat, lon] = destination(rx.lat, rx.lon, az, range);
      uvs[v * 2] = (mercatorX(lon) - bounds.mx0) / spanX;
      uvs[v * 2 + 1] = (mercatorY(lat) - bounds.my0) / spanY;
    }
  }

  const indices = [];
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < AZIMUTH_STEPS; j++) {
      const next = (j + 1) % AZIMUTH_STEPS;
      const a = i * AZIMUTH_STEPS + j;
      const b = i * AZIMUTH_STEPS + next;
      const c = (i + 1) * AZIMUTH_STEPS + j;
      const d = (i + 1) * AZIMUTH_STEPS + next;
      indices.push(a, c, d, a, d, b);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geom.setIndex(indices);

  const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    depthWrite: false,
  }));
  mesh.name = 'basemap';
  // Sits just under the range rings so the two never fight for the same depth.
  mesh.position.z = -0.08;
  mesh.renderOrder = -1;
  return mesh;
}
