// three.js objects for each layer. Geometry only — no UI state lives here.

import * as THREE from 'three';
import {
  project, curvatureDropFt, horizonFloorFt, horizonRangeNm, FT_PER_NM,
} from './geo.js';
import { rangeAt } from './envelope.js';
import { altitudeCss } from './altitude.js';

/** tar1090's ramp as a three colour. Cached: the ramp is a pure lookup. */
const colorCache = new Map();
export function altitudeThreeColor(altFt) {
  let c = colorCache.get(altFt);
  if (!c) {
    c = new THREE.Color().setStyle(altitudeCss(altFt));
    colorCache.set(altFt, c);
  }
  return c;
}

export const COLORS = {
  envelope: 0x3d7dbf,
  envelopeWire: 0x2f5f92,
  contour: 0x6ba8df,
  grid: 0x2e2e2e,
  gridMajor: 0x454545,
  horizon: 0x6a6a6a,
  aircraft: 0xe8e8e8,
  aircraftDrop: 0x4a4a4a,
  selected: 0xffb000,
};

const RING_STEPS_NM = [10, 25, 50, 75, 100, 150, 200, 250, 300];

// Below this a cell is treated as having no coverage rather than coverage at zero
// range, which keeps empty bearings out of the geometry entirely.
const MIN_RADIUS_NM = 0.5;

/** Range rings and bearing spokes, lying on the curved surface. */
export function buildGround(maxRangeNm, opts) {
  const group = new THREE.Group();
  group.name = 'ground';

  const ringMat = new THREE.LineBasicMaterial({ color: COLORS.grid });
  const majorMat = new THREE.LineBasicMaterial({ color: COLORS.gridMajor });

  for (const r of RING_STEPS_NM) {
    if (r > maxRangeNm * 1.05) continue;
    const pts = [];
    for (let az = 0; az <= 360; az += 2) {
      const [x, y, z] = project(az, r, 0, opts);
      pts.push(new THREE.Vector3(x, y, z));
    }
    const geom = new THREE.BufferGeometry().setFromPoints(pts);
    group.add(new THREE.Line(geom, r % 50 === 0 ? majorMat : ringMat));
  }

  for (let az = 0; az < 360; az += 30) {
    const pts = [];
    for (let r = 0; r <= maxRangeNm; r += 5) {
      const [x, y, z] = project(az, r, 0, opts);
      pts.push(new THREE.Vector3(x, y, z));
    }
    const geom = new THREE.BufferGeometry().setFromPoints(pts);
    group.add(new THREE.Line(geom, az % 90 === 0 ? majorMat : ringMat));
  }

  return group;
}

/**
 * The measured envelope as a surface of revolution-ish mesh: one ring of vertices
 * per altitude band edge, each at the maximum range reached in that band.
 *
 * This single surface is both readings of the data. Seen from outside it is the
 * range envelope; seen from inside and above it is the coverage floor.
 */
export function buildEnvelopeSurface(model, opts) {
  const nb = model.nBands;
  const levels = nb + 1;
  const positions = new Float32Array(360 * levels * 3);
  const colors = new Float32Array(360 * levels * 3);
  const radii = new Float32Array(360 * levels);
  const vertexAz = new Uint16Array(360 * levels);
  const vertexBand = new Uint16Array(360 * levels);

  for (let level = 0; level < levels; level++) {
    const band = Math.min(level, nb - 1);
    const altFt = model.edges[level];
    const tint = altitudeThreeColor(altFt);
    for (let az = 0; az < 360; az++) {
      const r = rangeAt(model, az, band);
      const [x, y, z] = project(az, r, altFt, opts);
      const i = (level * 360 + az);
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      colors[i * 3] = tint.r;
      colors[i * 3 + 1] = tint.g;
      colors[i * 3 + 2] = tint.b;
      radii[i] = r;
      vertexAz[i] = az;
      vertexBand[i] = band;
    }
  }

  // A bearing with no coverage in a band has no surface there — not a surface at
  // zero range. Collapsing those vertices to the origin would fan enormous
  // triangles across the scene and read as coverage that was never measured.
  const indices = [];
  for (let level = 0; level < levels - 1; level++) {
    for (let az = 0; az < 360; az++) {
      const next = (az + 1) % 360;
      const a = level * 360 + az;
      const b = level * 360 + next;
      const c = (level + 1) * 360 + az;
      const d = (level + 1) * 360 + next;
      if (radii[a] < MIN_RADIUS_NM || radii[b] < MIN_RADIUS_NM
        || radii[c] < MIN_RADIUS_NM || radii[d] < MIN_RADIUS_NM) continue;
      indices.push(a, c, d, a, d, b);
    }
  }

  const byAlt = Boolean(opts.colorByAlt);

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();

  const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
    // White base so the vertex colours come through unmultiplied.
    color: byAlt ? 0xffffff : COLORS.envelope,
    vertexColors: byAlt,
    transparent: true,
    opacity: byAlt ? 0.2 : 0.16,
    side: THREE.DoubleSide,
    depthWrite: false,
  }));
  mesh.name = 'envelopeSurface';
  mesh.userData = { vertexAz, vertexBand, model };

  // A coarse wire over the same vertices. A full wireframe of 35,000 triangles is
  // noise; rings every other band plus meridians every 15 degrees reads cleanly.
  const wirePts = [];
  const wireColors = [];
  const pushSegment = (i, j) => {
    if (radii[i] < MIN_RADIUS_NM || radii[j] < MIN_RADIUS_NM) return;
    wirePts.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    wirePts.push(positions[j * 3], positions[j * 3 + 1], positions[j * 3 + 2]);
    wireColors.push(colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]);
    wireColors.push(colors[j * 3], colors[j * 3 + 1], colors[j * 3 + 2]);
  };
  for (let level = 0; level < levels; level += 2) {
    for (let az = 0; az < 360; az++) {
      pushSegment(level * 360 + az, level * 360 + (az + 1) % 360);
    }
  }
  for (let az = 0; az < 360; az += 15) {
    for (let level = 0; level < levels - 1; level++) {
      pushSegment(level * 360 + az, (level + 1) * 360 + az);
    }
  }
  const wireGeom = new THREE.BufferGeometry();
  wireGeom.setAttribute('position',
    new THREE.BufferAttribute(new Float32Array(wirePts), 3));
  wireGeom.setAttribute('color',
    new THREE.BufferAttribute(new Float32Array(wireColors), 3));
  const wire = new THREE.LineSegments(wireGeom, new THREE.LineBasicMaterial({
    color: byAlt ? 0xffffff : COLORS.envelopeWire,
    vertexColors: byAlt,
    transparent: true,
    opacity: byAlt ? 0.65 : 0.55,
  }));
  wire.name = 'envelopeWire';

  const group = new THREE.Group();
  group.name = 'envelope';
  group.add(mesh, wire);
  group.userData = { mesh };
  return group;
}

/**
 * The familiar outline, repeated at height. One closed ring per altitude, each
 * drawn at its true height, which is the whole point of the exercise.
 */
export function buildContourRings(model, altitudes, opts) {
  const group = new THREE.Group();
  group.name = 'contours';
  const byAlt = Boolean(opts.colorByAlt);

  for (const altFt of altitudes) {
    // The rings are where the altitude-to-colour mapping is easiest to read, so
    // each one gets its own material at its own altitude's colour.
    const mat = new THREE.LineBasicMaterial({
      color: byAlt ? altitudeThreeColor(altFt) : COLORS.contour,
    });
    let band = 0;
    for (let b = 0; b < model.nBands; b++) {
      if (model.edges[b] <= altFt) band = b; else break;
    }

    // Gaps are real: a bearing with no coverage must break the ring rather than
    // being chorded across, which would draw a range that was never achieved.
    let run = [];
    const flush = () => {
      if (run.length >= 2) {
        const geom = new THREE.BufferGeometry().setFromPoints(run);
        const line = new THREE.Line(geom, mat);
        line.userData = { altFt };
        group.add(line);
      }
      run = [];
    };

    for (let az = 0; az <= 360; az++) {
      const a = az % 360;
      const r = rangeAt(model, a, band);
      if (r < MIN_RADIUS_NM) { flush(); continue; }
      const [x, y, z] = project(a, r, altFt, opts);
      run.push(new THREE.Vector3(x, y, z));
    }
    flush();
  }
  return group;
}

/**
 * The 4/3-earth line-of-sight limit, as a reference surface. Azimuth-independent
 * by definition, so any departure from it in the measured surface is antenna
 * pattern, sensitivity or terrain rather than geometry.
 */
export function buildHorizonSurface(maxRangeNm, opts) {
  const group = new THREE.Group();
  group.name = 'horizon';
  const mat = new THREE.LineBasicMaterial({
    color: COLORS.horizon, transparent: true, opacity: 0.5,
  });
  const rxAltFt = opts.rxAltFt || 0;

  const ranges = [];
  for (let r = 10; r <= maxRangeNm; r += 10) ranges.push(r);

  for (const r of ranges) {
    const altFt = horizonFloorFt(r, rxAltFt);
    const pts = [];
    for (let az = 0; az <= 360; az += 5) {
      const [x, y, z] = project(az, r, altFt, opts);
      pts.push(new THREE.Vector3(x, y, z));
    }
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
  }

  for (let az = 0; az < 360; az += 30) {
    const pts = [];
    for (let r = 0; r <= maxRangeNm; r += 5) {
      const [x, y, z] = project(az, r, horizonFloorFt(r, rxAltFt), opts);
      pts.push(new THREE.Vector3(x, y, z));
    }
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
  }
  return group;
}

/** Live traffic: a point per aircraft plus a drop line to the surface below it. */
export class AircraftLayer {
  constructor(capacity = 600) {
    this.capacity = capacity;
    this.group = new THREE.Group();
    this.group.name = 'aircraft';
    this.contacts = [];

    this.pointPositions = new Float32Array(capacity * 3);
    this.pointColors = new Float32Array(capacity * 3);
    const pointGeom = new THREE.BufferGeometry();
    pointGeom.setAttribute('position',
      new THREE.BufferAttribute(this.pointPositions, 3));
    pointGeom.setAttribute('color',
      new THREE.BufferAttribute(this.pointColors, 3));
    this.points = new THREE.Points(pointGeom, new THREE.PointsMaterial({
      color: COLORS.aircraft, size: 4, sizeAttenuation: false,
    }));
    this.points.frustumCulled = false;

    this.dropPositions = new Float32Array(capacity * 6);
    const dropGeom = new THREE.BufferGeometry();
    dropGeom.setAttribute('position',
      new THREE.BufferAttribute(this.dropPositions, 3));
    this.drops = new THREE.LineSegments(dropGeom, new THREE.LineBasicMaterial({
      color: COLORS.aircraftDrop, transparent: true, opacity: 0.7,
    }));
    this.drops.frustumCulled = false;

    this.group.add(this.points, this.drops);
  }

  /** contacts: [{hex, flight, az, rangeNm, altFt, ...}] */
  setContacts(contacts) {
    this.contacts = contacts.slice(0, this.capacity);
  }

  /** Re-projects the current contacts. Called whenever view options change. */
  update(opts) {
    const byAlt = Boolean(opts.colorByAlt);
    this.points.material.vertexColors = byAlt;
    this.points.material.color.set(byAlt ? 0xffffff : COLORS.aircraft);
    this.points.material.needsUpdate = true;

    const n = this.contacts.length;
    for (let i = 0; i < n; i++) {
      const c = this.contacts[i];
      const [x, y, z] = project(c.az, c.rangeNm, c.altFt, opts);
      this.pointPositions[i * 3] = x;
      this.pointPositions[i * 3 + 1] = y;
      this.pointPositions[i * 3 + 2] = z;
      const tint = altitudeThreeColor(Math.round(c.altFt / 100) * 100);
      this.pointColors[i * 3] = tint.r;
      this.pointColors[i * 3 + 1] = tint.g;
      this.pointColors[i * 3 + 2] = tint.b;
      const [gx, gy, gz] = project(c.az, c.rangeNm, 0, opts);
      this.dropPositions[i * 6] = x;
      this.dropPositions[i * 6 + 1] = y;
      this.dropPositions[i * 6 + 2] = z;
      this.dropPositions[i * 6 + 3] = gx;
      this.dropPositions[i * 6 + 4] = gy;
      this.dropPositions[i * 6 + 5] = gz;
    }
    this.points.geometry.setDrawRange(0, n);
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
    this.drops.geometry.setDrawRange(0, n * 2);
    this.drops.geometry.attributes.position.needsUpdate = true;
  }
}

export { horizonRangeNm, curvatureDropFt, FT_PER_NM };
