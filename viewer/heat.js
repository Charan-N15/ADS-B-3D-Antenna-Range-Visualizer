// The heat footprint: where aircraft have actually flown.
//
// The collector counts every accepted position into a grid of 2 nm cells, eight
// altitude bands deep (class Heatmap in collector/range3d_collect.py). Those
// bands are up to 10,000 ft deep, far too coarse to draw a route at its height
// directly: at the default exaggeration a route would fill a band as a sheet
// thirteen times taller than it is wide. So each route's altitude is estimated
// first, and the routes are drawn as round tubes along those estimates, glowing
// the way Endless ATC shows where the aircraft you handled went.

import * as THREE from 'three';
import { project, EARTH_RADIUS_NM, FT_PER_NM } from './geo.js';
import { altitudeThreeColor } from './layers.js';

/** The route this far up the distribution of hits is drawn brightest. */
const BRIGHT_PERCENTILE = 0.99;

/** The faintest a route that passes the minimum hits is ever drawn, 0 to 1. */
const MIN_VISIBLE = 0.35;

/**
 * Altitudes are averaged over neighbouring cells this many cells away, to turn
 * the bands' staircase into a slope. Only routes within SMOOTH_TOLERANCE_FT of
 * each other are averaged, so an arrival does not get pulled toward the
 * overflights above it.
 */
const SMOOTH_RADIUS = 4;
const SMOOTH_TOLERANCE_FT = 6000;

/**
 * Radius of a tube, in the scene's own miles. Height is converted with the
 * vertical exaggeration, so tubes stay round however the scene is stretched.
 */
const TUBE_RADIUS_NM = 1;

/** Most altitude layers the volume texture is given, however fine the tubes. */
const MAX_LAYERS = 160;

/** Samples taken along each line of sight through the volume. */
const VOLUME_STEPS = 192;

/** How quickly a tube turns opaque, per scene unit, at full strength. */
const VOLUME_DENSITY = 0.6;

/** Colour is brightened by this much before it is laid down. */
const VOLUME_GAIN = 1.35;

/** The colour ramp is looked up from a strip this many texels long, 0 to 50,000 ft. */
const RAMP_TEXELS = 256;
const RAMP_TOP_FT = 50000;

const FLAT_COLOR = new THREE.Color(0xe8e8e8);
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Reads heatmap.json and heatmap.bin, and checks they describe the same grid. */
export async function loadHeatmap(base) {
  const metaResp = await fetch(`${base}.json`, { cache: 'no-store' });
  if (!metaResp.ok) throw new Error(`HTTP ${metaResp.status} from ${base}.json`);
  const meta = await metaResp.json();
  if (meta.version !== 1 || meta.dtype !== 'uint16' || meta.byteOrder !== 'little') {
    throw new Error('heatmap format not recognised');
  }
  const binResp = await fetch(`${base}.bin`, { cache: 'no-store' });
  if (!binResp.ok) throw new Error(`HTTP ${binResp.status} from ${base}.bin`);
  const buffer = await binResp.arrayBuffer();

  const bands = meta.bandEdges.length - 1;
  const cells = meta.size * meta.size;
  if (buffer.byteLength !== bands * cells * 2) {
    throw new Error(`heatmap.bin is ${buffer.byteLength} bytes, expected ${bands * cells * 2}`);
  }
  // The file is little-endian whatever wrote it. A typed array reads in the
  // machine's own order, which is little on everything a browser runs on, but
  // swapping is cheap enough not to assume it.
  let counts = new Uint16Array(buffer);
  if (!littleEndian) {
    const view = new DataView(buffer);
    counts = new Uint16Array(counts.length);
    for (let i = 0; i < counts.length; i++) counts[i] = view.getUint16(i * 2, true);
  }
  return { meta, counts, bands, cells };
}

/**
 * Every route through every cell, with an estimated altitude.
 *
 * A route shows as a peak across a cell's bands. Its altitude starts as the
 * centre of the peak band, pulled toward whichever neighbouring band holds the
 * rest of it: an arrival halfway through crossing from one band to the next
 * splits its hits between them, and lands on the boundary. Within a band that
 * still gives one altitude for the whole band, a staircase; averaging each
 * route with the same route in nearby cells turns the staircase into the slope
 * it came from. On a receiver south of SFO this recovers the arrival's descent
 * at about 310 ft per mile, where a 3 degree approach is 318.
 */
function findRoutes(heat, minHits) {
  const { meta, counts, bands, cells } = heat;
  const size = meta.size;
  const edges = meta.bandEdges;
  const centre = [];
  for (let b = 0; b < bands; b++) centre.push((edges[b] + edges[b + 1]) / 2);

  const cell = [];
  const alt = [];
  const hits = [];
  const col = new Array(bands);
  for (let i = 0; i < cells; i++) {
    let any = false;
    for (let b = 0; b < bands; b++) {
      col[b] = counts[b * cells + i];
      if (col[b]) any = true;
    }
    if (!any) continue;
    for (let b = 0; b < bands; b++) {
      const c = col[b];
      const below = b > 0 ? col[b - 1] : 0;
      const above = b < bands - 1 ? col[b + 1] : 0;
      // A peak: no lower band busier, no upper band as busy, so a flat top
      // counts once.
      if (!c || c < below || c <= above) continue;
      let h = c;
      let sum = c * centre[b];
      if (below) { h += below; sum += below * centre[b - 1]; }
      if (above) { h += above; sum += above * centre[b + 1]; }
      if (h < minHits) continue;
      cell.push(i);
      alt.push(sum / h);
      hits.push(h);
    }
  }

  // Routes by cell, for finding the same route next door.
  const byCell = new Map();
  for (let r = 0; r < cell.length; r++) {
    const list = byCell.get(cell[r]);
    if (list) list.push(r); else byCell.set(cell[r], [r]);
  }
  const smoothed = new Float32Array(cell.length);
  for (let r = 0; r < cell.length; r++) {
    const x = cell[r] % size;
    const y = (cell[r] - x) / size;
    let num = 0;
    let den = 0;
    for (let dy = -SMOOTH_RADIUS; dy <= SMOOTH_RADIUS; dy++) {
      for (let dx = -SMOOTH_RADIUS; dx <= SMOOTH_RADIUS; dx++) {
        if (dx * dx + dy * dy > SMOOTH_RADIUS * SMOOTH_RADIUS) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const near = byCell.get(ny * size + nx);
        if (!near) continue;
        for (const n of near) {
          if (Math.abs(alt[n] - alt[r]) >= SMOOTH_TOLERANCE_FT) continue;
          num += hits[n] * alt[n];
          den += hits[n];
        }
      }
    }
    smoothed[r] = num / den;
  }
  return { cell, alt: smoothed, hits };
}

/** The value below which `fraction` of the entries fall. */
function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

/**
 * The routes with at least `minHits` hits, drawn into a 3D texture as tubes:
 * each route in each cell is a small round blob at its estimated altitude, and
 * the blobs along a route overlap into a tube. Brightness rises with the log of
 * a route's hits, from MIN_VISIBLE for one that only just passes to full for the
 * busiest, so every route shown can be seen. The texture covers only the cells
 * with a route, and only as high as the highest one.
 */
export function buildTubeTexture(heat, { minHits, exag }) {
  const { meta } = heat;
  const { size, cellNm, halfNm } = meta;
  const routes = findRoutes(heat, Math.max(1, minHits));
  if (routes.cell.length === 0) return null;

  // Tubes are TUBE_RADIUS_NM round in the scene, so their height in feet
  // depends on how far the scene stretches height.
  const radiusFt = (TUBE_RADIUS_NM * FT_PER_NM) / Math.max(1, exag);
  let topAlt = 0;
  let xMin = size;
  let xMax = -1;
  let yMin = size;
  let yMax = -1;
  for (let r = 0; r < routes.cell.length; r++) {
    const x = routes.cell[r] % size;
    const y = (routes.cell[r] - x) / size;
    xMin = Math.min(xMin, x); xMax = Math.max(xMax, x);
    yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
    topAlt = Math.max(topAlt, routes.alt[r]);
  }
  // A cell of margin all round, so the outer blobs are not cut off.
  xMin = Math.max(0, xMin - 1); yMin = Math.max(0, yMin - 1);
  xMax = Math.min(size - 1, xMax + 1); yMax = Math.min(size - 1, yMax + 1);
  const topFt = Math.min(RAMP_TOP_FT, topAlt + 3 * radiusFt);
  const spacingFt = Math.max(radiusFt * 0.75, topFt / MAX_LAYERS);
  const layers = Math.ceil(topFt / spacingFt) + 1;
  const wx = xMax - xMin + 1;
  const wy = yMax - yMin + 1;
  const data = new Uint8Array(wx * wy * layers);

  const brightHits = percentile(routes.hits, BRIGHT_PERCENTILE);
  const span = Math.log(Math.max(brightHits, minHits + 1) / Math.max(1, minHits));
  const across = TUBE_RADIUS_NM / cellNm;        // radius in cells
  const upward = radiusFt / spacingFt;           // radius in layers
  const reachZ = Math.ceil(3 * upward);
  for (let r = 0; r < routes.cell.length; r++) {
    const ratio = span > 0 ? Math.log(routes.hits[r] / Math.max(1, minHits)) / span : 1;
    const strength = MIN_VISIBLE + (1 - MIN_VISIBLE) * Math.min(1, Math.max(0, ratio));
    const cx = (routes.cell[r] % size) - xMin;
    const cy = Math.floor(routes.cell[r] / size) - yMin;
    const cz = routes.alt[r] / spacingFt;
    for (let dy = -1; dy <= 1; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= wy) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= wx) continue;
        const flat = Math.exp(-0.5 * (dx * dx + dy * dy) / (across * across));
        for (let z = Math.max(0, Math.round(cz) - reachZ); z <= Math.min(layers - 1, Math.round(cz) + reachZ); z++) {
          const v = strength * flat * Math.exp(-0.5 * ((z - cz) / upward) ** 2);
          const at = (z * wy + y) * wx + x;
          const byte = Math.round(v * 255);
          // The strongest blob wins rather than adding up, so a tube is as
          // bright along its length however many cells it crosses.
          if (byte > data[at]) data[at] = byte;
        }
      }
    }
  }

  const texture = new THREE.Data3DTexture(data, wx, wy, layers);
  texture.format = THREE.RedFormat;
  texture.type = THREE.UnsignedByteType;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  texture.userData = {
    x0: -halfNm + xMin * cellNm,
    y0: -halfNm + yMin * cellNm,
    width: wx * cellNm,
    height: wy * cellNm,
    layers,
    spacingFt,
    topFt,
    routes: routes.cell.length,
  };
  return texture;
}

/** The altitude ramp as a strip of sRGB texels, read raw by the shader. */
let rampTexture = null;
function ramp() {
  if (rampTexture) return rampTexture;
  const data = new Uint8Array(RAMP_TEXELS * 4);
  const rgb = { r: 0, g: 0, b: 0 };
  for (let i = 0; i < RAMP_TEXELS; i++) {
    const altFt = (i / (RAMP_TEXELS - 1)) * RAMP_TOP_FT;
    altitudeThreeColor(Math.round(altFt / 100) * 100).getRGB(rgb, THREE.SRGBColorSpace);
    data[i * 4] = rgb.r * 255;
    data[i * 4 + 1] = rgb.g * 255;
    data[i * 4 + 2] = rgb.b * 255;
    data[i * 4 + 3] = 255;
  }
  rampTexture = new THREE.DataTexture(data, RAMP_TEXELS, 1, THREE.RGBAFormat);
  rampTexture.magFilter = THREE.LinearFilter;
  rampTexture.minFilter = THREE.LinearFilter;
  rampTexture.needsUpdate = true;
  return rampTexture;
}

const VOLUME_VERTEX = /* glsl */ `
out vec3 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

// Marches each line of sight through the box, turning every sample's scene
// position back into a range and an altitude with the inverse of geo.js's
// project(), so the tubes follow exaggeration and curvature exactly as
// everything else in the scene does. Emission and absorption, front to back:
// a look through a tube's middle crosses more of it than one past its edge, so
// each tube glows strongest along its core and reads as round.
const VOLUME_FRAGMENT = /* glsl */ `
precision highp float;
precision highp sampler3D;

in vec3 vWorld;
out vec4 fragColor;

uniform sampler3D uVolume;
uniform sampler2D uRamp;
uniform vec3 uBoxMin;
uniform vec3 uBoxMax;
uniform vec2 uOrigin;
uniform vec2 uSpan;
uniform float uLayers;
uniform float uSpacingFt;
uniform float uExag;
uniform float uRxAltFt;
uniform float uCurvature;
uniform float uEarthRadiusNm;
uniform float uFtPerNm;
uniform float uAltMin;
uniform float uAltMax;
uniform float uDensity;
uniform float uGain;
uniform float uOpacity;
uniform float uByAlt;
uniform vec3 uFlat;

vec2 hitBox(vec3 origin, vec3 dir) {
  vec3 safe = mix(dir, vec3(1e-6), step(abs(dir), vec3(1e-6)));
  vec3 t0 = (uBoxMin - origin) / safe;
  vec3 t1 = (uBoxMax - origin) / safe;
  vec3 near = min(t0, t1);
  vec3 far = max(t0, t1);
  return vec2(max(max(near.x, near.y), near.z), min(min(far.x, far.y), far.z));
}

void main() {
  vec3 dir = normalize(vWorld - cameraPosition);
  vec2 span = hitBox(cameraPosition, dir);
  float start = max(span.x, 0.0);
  if (span.y <= start) discard;
  float dt = (span.y - start) / float(STEPS);
  // A different offset per pixel turns the banding of a fixed step into fine
  // noise the eye ignores.
  float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);

  vec3 color = vec3(0.0);
  float alpha = 0.0;
  for (int i = 0; i < STEPS; i++) {
    vec3 p = cameraPosition + dir * (start + (float(i) + jitter) * dt);
    float range = length(p.xy);
    float drop = uCurvature * range * range / (2.0 * uEarthRadiusNm) * uFtPerNm;
    float altFt = p.z / uExag * uFtPerNm + uRxAltFt + drop;
    if (altFt < 0.0 || altFt < uAltMin || altFt > uAltMax) continue;
    vec3 uvw = vec3((p.xy - uOrigin) / uSpan, (altFt / uSpacingFt + 0.5) / uLayers);
    if (uvw.z > 1.0) continue;
    float v = texture(uVolume, uvw).r;
    if (v < 0.004) continue;
    float a = 1.0 - exp(-v * uDensity * dt);
    vec3 c = uByAlt > 0.5 ? texture(uRamp, vec2(altFt / RAMP_TOP_FT, 0.5)).rgb : uFlat;
    color += (1.0 - alpha) * a * min(c * uGain, vec3(1.0));
    alpha += (1.0 - alpha) * a;
    if (alpha > 0.98) break;
  }
  fragColor = vec4(color, alpha) * uOpacity;
}`;

/**
 * The tubes in the scene: a box fitted to the routes, whose every pixel marches
 * its line of sight through the tube texture. Reads from any angle, side-on
 * included, and the altitude filter cuts it at exactly the heights asked for.
 */
export function buildHeatVolume(tubes, opts, opacity) {
  if (!tubes) return null;
  const { x0, y0, width, height, layers, spacingFt, topFt } = tubes.userData;
  const x1 = x0 + width;
  const y1 = y0 + height;
  // Highest over the receiver, lowest at the farthest corner, where the curve
  // of the earth has dropped the ground furthest.
  const far = Math.max(Math.hypot(x0, y0), Math.hypot(x0, y1), Math.hypot(x1, y0), Math.hypot(x1, y1));
  const z1 = project(0, 0, topFt, opts)[2] + 1;
  const z0 = project(0, far, 0, opts)[2] - 1;
  // The ramp is read raw as sRGB, so the flat colour has to be in sRGB too.
  const flat = FLAT_COLOR.getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);

  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    defines: { STEPS: VOLUME_STEPS, RAMP_TOP_FT: RAMP_TOP_FT.toFixed(1) },
    uniforms: {
      uVolume: { value: tubes },
      uRamp: { value: ramp() },
      uBoxMin: { value: new THREE.Vector3(x0, y0, z0) },
      uBoxMax: { value: new THREE.Vector3(x1, y1, z1) },
      uOrigin: { value: new THREE.Vector2(x0, y0) },
      uSpan: { value: new THREE.Vector2(width, height) },
      uLayers: { value: layers },
      uSpacingFt: { value: spacingFt },
      uExag: { value: opts.exag || 1 },
      uRxAltFt: { value: opts.rxAltFt || 0 },
      uCurvature: { value: opts.curvature === false ? 0 : 1 },
      uEarthRadiusNm: { value: EARTH_RADIUS_NM },
      uFtPerNm: { value: FT_PER_NM },
      uAltMin: { value: opts.altMinFt ?? 0 },
      uAltMax: { value: opts.altMaxFt ?? RAMP_TOP_FT },
      uDensity: { value: VOLUME_DENSITY },
      uGain: { value: VOLUME_GAIN },
      uOpacity: { value: opacity },
      uByAlt: { value: opts.colorByAlt ? 1 : 0 },
      uFlat: { value: new THREE.Vector3(flat.r, flat.g, flat.b) },
    },
    vertexShader: VOLUME_VERTEX,
    fragmentShader: VOLUME_FRAGMENT,
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    // Drawn from the inside faces so it still works with the camera in the box,
    // and without a depth test so nothing it encloses can hide those faces.
    depthTest: false,
    side: THREE.BackSide,
  });

  const mesh = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), material);
  mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  // After the envelope, for the same reason as the aircraft: drawn before it,
  // every surface in front would wash the tubes out. Before the aircraft, so
  // they sit in front of them.
  mesh.renderOrder = 5;
  mesh.name = 'heat-volume';
  return mesh;
}

/** Figures for the info panel. */
export function summarizeHeat(heat) {
  const { counts, cells, bands } = heat;
  let lit = 0;
  for (let i = 0; i < cells; i++) {
    for (let b = 0; b < bands; b++) {
      if (counts[b * cells + i]) { lit++; break; }
    }
  }
  return {
    samples: heat.meta.samples || 0,
    lit,
    created: heat.meta.created,
    updated: heat.meta.updated,
  };
}
