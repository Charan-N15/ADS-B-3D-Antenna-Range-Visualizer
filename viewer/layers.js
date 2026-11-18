// three.js objects for each layer. Geometry only — no UI state lives here.

import * as THREE from 'three';
import {
  project, curvatureDropFt, horizonFloorFt, horizonRangeNm, FT_PER_NM,
} from './geo.js';
import { rangeAt, bandRange } from './envelope.js';
import { altitudeCss } from './altitude.js';
import { SHAPES, PLANE_PX } from './shapes.js';

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

  // Vertices are always built for every level, even filtered-out ones: the index
  // arithmetic below depends on a dense grid, and 18,000 positions cost nothing.
  // The filter decides which quads get drawn, not which vertices exist.
  const [loBand, hiBand] = bandRange(model, opts.altMinFt ?? 0,
    opts.altMaxFt ?? model.edges[nb]);

  // A bearing with no coverage in a band has no surface there — not a surface at
  // zero range. Collapsing those vertices to the origin would fan enormous
  // triangles across the scene and read as coverage that was never measured.
  const indices = [];
  for (let level = loBand; level <= hiBand && level < levels - 1; level++) {
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
  for (let level = loBand; level <= hiBand + 1 && level < levels; level += 2) {
    for (let az = 0; az < 360; az++) {
      pushSegment(level * 360 + az, level * 360 + (az + 1) % 360);
    }
  }
  for (let az = 0; az < 360; az += 15) {
    for (let level = loBand; level <= hiBand && level < levels - 1; level++) {
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
export function buildContourRings(model, altitudes, opts, onGround = false) {
  const group = new THREE.Group();
  group.name = onGround ? 'footprint' : 'contours';
  const byAlt = Boolean(opts.colorByAlt);
  const altMin = opts.altMinFt ?? 0;
  const altMax = opts.altMaxFt ?? model.edges[model.nBands];

  for (const altFt of altitudes) {
    if (altFt < altMin || altFt > altMax) continue;
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
      // Dropped to the ground the ring becomes a footprint: the same reach, laid
      // over the map so you can read it against towns rather than against air.
      const [x, y, z] = project(a, r, onGround ? 0 : altFt, opts);
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
export function buildHorizonSurface(maxRangeNm, opts, extendToAltFt) {
  const group = new THREE.Group();
  group.name = 'horizon';
  const mat = new THREE.LineBasicMaterial({
    color: COLORS.horizon, transparent: true, opacity: 0.5,
  });
  const rxAltFt = opts.rxAltFt || 0;

  // Stopping at the measured range truncates this surface low down — at 142 nm
  // the horizon limit is only about 11,000 ft, so it reads as a saucer under the
  // envelope rather than something to compare against. Running it out to where
  // it reaches the top of the measured data makes the two directly comparable,
  // at the cost of a surface roughly twice as wide.
  let limit = maxRangeNm;
  if (extendToAltFt) {
    limit = Math.max(limit, horizonRangeNm(extendToAltFt, rxAltFt));
  }

  const ranges = [];
  for (let r = 10; r <= limit; r += 10) ranges.push(r);

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
    for (let r = 0; r <= limit; r += 5) {
      const [x, y, z] = project(az, r, horizonFloorFt(r, rxAltFt), opts);
      pts.push(new THREE.Vector3(x, y, z));
    }
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
  }
  return group;
}

/** On-screen selection: the cell's fill is its altitude colour this far toward white. */
const HIGHLIGHT_LIGHTEN = 0.45;

/** Size of the ring round a selected cell, in pixels, however far out the view is. */
const SELECT_RING_PX = 22;

/** A white ring edged in black, so it reads over the surface and the dark sky alike. */
let selectRing = null;
function selectRingTexture() {
  if (selectRing) return selectRing;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  // Widest first, so the black band is left showing on both sides of the white.
  for (const [width, style] of [[14, '#000'], [6, '#fff']]) {
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, 24, 0, Math.PI * 2);
    ctx.lineWidth = width;
    ctx.strokeStyle = style;
    ctx.stroke();
  }
  selectRing = new THREE.CanvasTexture(canvas);
  return selectRing;
}

/**
 * The selected cell, picked out on the envelope: its four corners lifted
 * straight from the surface's own vertices, so it sits exactly on the cell,
 * filled bright and edged in white. A cell is one degree by one band, often a
 * sliver at normal zoom, so a ring of fixed size marks where it is from any
 * distance. Drawn over everything, so a cell on the far side of the bowl still
 * shows through the near wall. Null when the cell has no surface to sit on.
 */
export function buildCellHighlight(surface, az, band) {
  const pos = surface.geometry.getAttribute('position');
  const { model } = surface.userData;
  const next = (az + 1) % 360;
  const corners = [
    band * 360 + az, band * 360 + next, (band + 1) * 360 + next, (band + 1) * 360 + az,
  ];
  if (corners[2] >= pos.count) return null;
  const points = corners.map((i) => new THREE.Vector3().fromBufferAttribute(pos, i));
  // A corner pulled in to the receiver has no coverage, and so no surface.
  if (points.some((p) => Math.hypot(p.x, p.y) < MIN_RADIUS_NM)) return null;

  const fillGeom = new THREE.BufferGeometry().setFromPoints(points);
  fillGeom.setIndex([0, 1, 2, 0, 2, 3]);
  const tint = altitudeThreeColor(model.edges[band]).clone()
    .lerp(new THREE.Color(0xffffff), HIGHLIGHT_LIGHTEN);
  const fill = new THREE.Mesh(fillGeom, new THREE.MeshBasicMaterial({
    color: tint, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
    depthTest: false, depthWrite: false,
  }));
  const edge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false }));
  const centre = points.reduce((sum, p) => sum.add(p), new THREE.Vector3()).divideScalar(4);
  const ring = new THREE.Points(new THREE.BufferGeometry().setFromPoints([centre]),
    new THREE.PointsMaterial({
      map: selectRingTexture(), size: SELECT_RING_PX, sizeAttenuation: false,
      transparent: true, depthTest: false, depthWrite: false,
    }));
  ring.frustumCulled = false;
  // Last of all, after the aircraft and the heat.
  fill.renderOrder = 20;
  edge.renderOrder = 21;
  ring.renderOrder = 22;

  const group = new THREE.Group();
  group.name = 'cellHighlight';
  group.add(fill, edge, ring);
  return group;
}

const FLAT_COLOR = new THREE.Color(COLORS.aircraft);
const _pos = new THREE.Vector3();
const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _matrix = new THREE.Matrix4();

/** Feet per minute in one knot, to put climb rate and ground speed in one unit. */
const FPM_PER_KT = 101.27;

/** Climb or descent slower than this is drawn level, so noise does not rock it. */
const LEVEL_FPM = 150;

/** The steepest an aircraft is ever tilted, however the exaggeration adds up. */
const MAX_PITCH = 40 * Math.PI / 180;

/** Shapes that do not fly along their nose, and so are never tilted or banked. */
const UNPITCHED = new Set(['helicopter', 'balloon', 'drone']);

/** Turns slower than this, degrees a second, are flown wings level. */
const LEVEL_TURN_DEG_S = 0.15;

/** The steepest bank ever drawn. Airliners rarely pass 30 degrees. */
const MAX_BANK = 35 * Math.PI / 180;

const KT_TO_MS = 0.514444;
const GRAVITY = 9.81;

/**
 * The bank angle of a coordinated turn: tan(bank) = speed x turn rate / g. Not
 * exaggerated like the climb, since bank is a roll about the aircraft's own nose
 * and the scene does not stretch it. Positive is right wing down.
 */
export function bankAngle(c) {
  if (UNPITCHED.has(c.shape) || !Number.isFinite(c.turnRate) || !(c.gs > 0)) return 0;
  if (Math.abs(c.turnRate) < LEVEL_TURN_DEG_S) return 0;
  const bank = Math.atan((c.gs * KT_TO_MS * c.turnRate * Math.PI / 180) / GRAVITY);
  return Math.max(-MAX_BANK, Math.min(MAX_BANK, bank));
}

/**
 * The angle an aircraft's path makes in the scene. A real climb is a few
 * degrees, too little to see; but the scene stretches height by the vertical
 * exaggeration, and so does this, so the aircraft points along the line it is
 * actually tracing through the bowl.
 */
function scenePitch(c, exag) {
  if (UNPITCHED.has(c.shape) || !Number.isFinite(c.vs) || !(c.gs > 0)) return 0;
  if (Math.abs(c.vs) < LEVEL_FPM) return 0;
  const angle = Math.atan((exag * c.vs) / (FPM_PER_KT * c.gs));
  return Math.max(-MAX_PITCH, Math.min(MAX_PITCH, angle));
}

/**
 * Live traffic: a silhouette per aircraft at its altitude, pointed along its
 * track and tilted to its climb, with a drop line to the surface below.
 */
export class AircraftLayer {
  constructor(capacity = 600) {
    this.capacity = capacity;
    this.group = new THREE.Group();
    this.group.name = 'aircraft';
    this.contacts = [];
    this.planeScale = 1;

    this.headPositions = new Float32Array(capacity * 3);
    this.headings = new Float32Array(capacity);
    this.pitches = new Float32Array(capacity);
    this.banks = new Float32Array(capacity);
    this.slotMesh = new Array(capacity);
    this.slotIndex = new Int32Array(capacity);

    // One instanced mesh per silhouette, so every aircraft of a kind is a single
    // draw call. White base colour lets each instance's colour through as is.
    //
    // Drawn last: three.js paints translucent objects after opaque ones, so an
    // opaque aircraft inside the bowl would be washed over by every surface
    // layer in front of it. In the translucent pass with a high render order it
    // lands on top instead, and keeps its altitude colour.
    this.planes = new THREE.Group();
    this.shapes = new Map();
    for (const [name, def] of Object.entries(SHAPES)) {
      const mesh = new THREE.InstancedMesh(def.geometry, new THREE.MeshBasicMaterial({
        color: 0xffffff, vertexColors: true, transparent: true,
      }), capacity);
      mesh.renderOrder = 11;
      mesh.name = `aircraft-${name}`;
      mesh.userData.scale = def.scale;
      mesh.frustumCulled = false;
      mesh.setColorAt(0, FLAT_COLOR);   // allocates the per-instance colours
      mesh.count = 0;

      // The outline: a larger black copy showing only its back faces, drawn
      // just before the aircraft. Wherever the aircraft covers it, the aircraft
      // is nearer and wins; round the edge only the black is there. It shares
      // the aircraft's matrices, so placing one places both.
      const outline = new THREE.InstancedMesh(def.outline, new THREE.MeshBasicMaterial({
        color: 0x000000, side: THREE.BackSide, transparent: true,
      }), capacity);
      outline.renderOrder = 10;
      outline.instanceMatrix = mesh.instanceMatrix;
      outline.frustumCulled = false;
      outline.count = 0;
      mesh.userData.outline = outline;

      this.shapes.set(name, mesh);
      this.planes.add(outline, mesh);
    }

    this.dropPositions = new Float32Array(capacity * 6);
    const dropGeom = new THREE.BufferGeometry();
    dropGeom.setAttribute('position',
      new THREE.BufferAttribute(this.dropPositions, 3));
    this.drops = new THREE.LineSegments(dropGeom, new THREE.LineBasicMaterial({
      color: COLORS.aircraftDrop, transparent: true, opacity: 0.7,
    }));
    this.drops.frustumCulled = false;

    this.group.add(this.planes, this.drops);
  }

  setVisibility(show) {
    this.group.visible = show;
  }

  /** contacts: [{hex, flight, az, rangeNm, altFt, track, shape, ...}] */
  setContacts(contacts) {
    this.contacts = contacts.slice(0, this.capacity);
  }

  /** Re-projects the current contacts. Called whenever view options change. */
  update(opts) {
    const byAlt = Boolean(opts.colorByAlt);

    for (const mesh of this.shapes.values()) mesh.count = 0;
    const fallback = this.shapes.get('generic');

    const n = this.contacts.length;
    for (let i = 0; i < n; i++) {
      const c = this.contacts[i];
      const [x, y, z] = project(c.az, c.rangeNm, c.altFt, opts);
      this.headPositions[i * 3] = x;
      this.headPositions[i * 3 + 1] = y;
      this.headPositions[i * 3 + 2] = z;
      const tint = altitudeThreeColor(Math.round(c.altFt / 100) * 100);

      // Track is degrees clockwise from north; the scene turns anticlockwise
      // about +z from +y, hence the sign. No track, no turn: it points north.
      this.headings[i] = Number.isFinite(c.track) ? -c.track * Math.PI / 180 : 0;
      this.pitches[i] = scenePitch(c, opts.exag || 1);
      this.banks[i] = bankAngle(c);
      const mesh = this.shapes.get(c.shape) || fallback;
      const slot = mesh.count++;
      mesh.setColorAt(slot, byAlt ? tint : FLAT_COLOR);
      this.slotMesh[i] = mesh;
      this.slotIndex[i] = slot;

      const [gx, gy, gz] = project(c.az, c.rangeNm, 0, opts);
      this.dropPositions[i * 6] = x;
      this.dropPositions[i * 6 + 1] = y;
      this.dropPositions[i * 6 + 2] = z;
      this.dropPositions[i * 6 + 3] = gx;
      this.dropPositions[i * 6 + 4] = gy;
      this.dropPositions[i * 6 + 5] = gz;
    }
    for (const mesh of this.shapes.values()) {
      mesh.instanceColor.needsUpdate = true;
      mesh.userData.outline.count = mesh.count;
    }
    this.drops.geometry.setDrawRange(0, n * 2);
    this.drops.geometry.attributes.position.needsUpdate = true;
  }

  /**
   * Sizes each silhouette to a fixed length on screen, so an aircraft overhead
   * and one two hundred miles out read the same. Runs every frame, since it
   * depends on where the camera is.
   */
  fitToView(camera, heightPx) {
    const n = this.contacts.length;
    if (!this.planes.visible || n === 0) return;
    const worldPerPx = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)
      / Math.max(1, heightPx);
    for (let i = 0; i < n; i++) {
      const mesh = this.slotMesh[i];
      _pos.fromArray(this.headPositions, i * 3);
      _scale.setScalar(PLANE_PX * this.planeScale * mesh.userData.scale
        * worldPerPx * camera.position.distanceTo(_pos));
      // Roll about the nose, pitch about the wing, then turn onto the track:
      // ZXY applies Y, then X, then Z, so bank and climb stay the aircraft's own.
      _quat.setFromEuler(_euler.set(this.pitches[i], this.banks[i], this.headings[i], 'ZXY'));
      mesh.setMatrixAt(this.slotIndex[i], _matrix.compose(_pos, _quat, _scale));
    }
    for (const mesh of this.shapes.values()) mesh.instanceMatrix.needsUpdate = true;
  }
}

/**
 * Trails share the altitude colours with the envelope and its rings, so on their
 * own they sink into them. Lifted this far toward white they read as a separate,
 * lighter ribbon on the same colour.
 */
const TRAIL_LIGHTEN = 0.45;
const _white = new THREE.Color(0xffffff);

/** How opaque a trail is right behind the aircraft. It fades to nothing at the tail. */
const TRAIL_OPACITY = 0.4;

/** A trail's width on screen, as a share of the aircraft's length: about its wingspan. */
const TRAIL_WIDTH = 0.8;

const RIBBON_VERTEX = /* glsl */ `
  attribute vec3 side;
  attribute float edge;
  attribute vec3 tint;
  attribute float alpha;
  uniform float uHalfPx;
  uniform float uWorldPerPx;
  varying vec3 vTint;
  varying float vAlpha;
  void main() {
    // The same width on screen however far away the trail is, as the
    // aircraft are: its world width grows with distance from the camera.
    float depth = -(modelViewMatrix * vec4(position, 1.0)).z;
    vec3 p = position + side * edge * uHalfPx * uWorldPerPx * depth;
    vTint = tint;
    vAlpha = alpha;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const RIBBON_FRAGMENT = /* glsl */ `
  varying vec3 vTint;
  varying float vAlpha;
  void main() {
    gl_FragColor = vec4(vTint, vAlpha);
  }
`;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _t = new THREE.Vector3();
const _s = new THREE.Vector3();
const _u = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);

/**
 * Where each aircraft has been, as a flat ribbon behind it through every
 * position heard since it appeared. The ribbon lies level, and rolls with the
 * aircraft where it was banking, so turns twist it the way the aircraft went
 * through them. It is widest and most solid at the aircraft and fades out
 * toward the oldest end.
 *
 * Every trail shares one mesh, so a sky full of them is still a single draw.
 * Positions are kept as bearing, range and altitude and projected here, so a
 * change of exaggeration or curvature bends the trails with everything else.
 * The width is applied on the GPU, so zooming costs nothing.
 */
export class TrailLayer {
  constructor() {
    this.capacity = 0;
    this.geometry = new THREE.BufferGeometry();
    this.material = new THREE.ShaderMaterial({
      vertexShader: RIBBON_VERTEX,
      fragmentShader: RIBBON_FRAGMENT,
      uniforms: { uHalfPx: { value: 1 }, uWorldPerPx: { value: 0 } },
      // Drawn after the envelope and the heat and without depth, so a trail
      // behind the envelope's wall still shows through it, as the aircraft do.
      transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.renderOrder = 9;
    this.mesh.name = 'trails';
    // The geometry changes every second; working out its bounds for culling
    // would cost more than drawing it.
    this.mesh.frustumCulled = false;
    this.group = this.mesh;
  }

  setVisibility(show) {
    this.mesh.visible = show;
  }

  /** Keeps the ribbon's on-screen width in step with the camera. Every frame. */
  fitToView(camera, heightPx, planeScale) {
    this.material.uniforms.uWorldPerPx.value =
      2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / Math.max(1, heightPx);
    this.material.uniforms.uHalfPx.value = PLANE_PX * planeScale * TRAIL_WIDTH / 2;
  }

  grow(points) {
    if (points <= this.capacity) return;
    this.capacity = Math.max(1024, Math.ceil(points * 1.5));
    const n = this.capacity * 2;   // two vertices, one each side, per point
    this.attrs = {
      position: new THREE.BufferAttribute(new Float32Array(n * 3), 3),
      side: new THREE.BufferAttribute(new Float32Array(n * 3), 3),
      edge: new THREE.BufferAttribute(new Float32Array(n), 1),
      tint: new THREE.BufferAttribute(new Float32Array(n * 3), 3),
      alpha: new THREE.BufferAttribute(new Float32Array(n), 1),
    };
    for (const [name, attr] of Object.entries(this.attrs)) this.geometry.setAttribute(name, attr);
    this.index = new THREE.BufferAttribute(new Uint32Array(this.capacity * 6), 1);
    this.geometry.setIndex(this.index);
  }

  /**
   * trails: one array per aircraft, oldest first, of {t, az, rangeNm, altFt,
   * bank}, the last being the aircraft where it is now. bank is radians, right
   * wing down positive.
   */
  update(trails, opts) {
    let total = 0;
    for (const points of trails) if (points.length > 1) total += points.length;
    this.grow(total);
    const byAlt = Boolean(opts.colorByAlt);
    const flat = FLAT_COLOR.clone();
    const rgb = { r: 0, g: 0, b: 0 };
    const tint = new THREE.Color();
    const pos = this.attrs ? this.attrs.position.array : null;
    const side = this.attrs ? this.attrs.side.array : null;
    const edge = this.attrs ? this.attrs.edge.array : null;
    const tints = this.attrs ? this.attrs.tint.array : null;
    const alpha = this.attrs ? this.attrs.alpha.array : null;
    const index = this.index ? this.index.array : null;

    let v = 0;
    let k = 0;
    for (const points of trails) {
      const n = points.length;
      if (n < 2) continue;
      const centres = points.map((p) => project(p.az, p.rangeNm, p.altFt, opts));
      const t0 = points[0].t;
      const span = Math.max(1e-6, points[n - 1].t - t0);
      _s.set(1, 0, 0);
      for (let i = 0; i < n; i++) {
        const p = points[i];
        // Along the path here, from the neighbours either side.
        _a.fromArray(centres[Math.max(0, i - 1)]);
        _b.fromArray(centres[Math.min(n - 1, i + 1)]);
        _t.subVectors(_b, _a);
        _t.z = 0;
        // Level and square to the path; a point that has not moved keeps the
        // last direction rather than turning the ribbon edge on.
        if (_t.lengthSq() > 1e-12) _s.crossVectors(_t.normalize(), _z).normalize();
        // Rolled by the bank: the right edge (+side) goes down in a right turn.
        _u.crossVectors(_s, _t);
        const bank = Number.isFinite(p.bank) ? p.bank : 0;
        const sx = _s.x * Math.cos(bank) - _u.x * Math.sin(bank);
        const sy = _s.y * Math.cos(bank) - _u.y * Math.sin(bank);
        const sz = _s.z * Math.cos(bank) - _u.z * Math.sin(bank);

        const c = byAlt
          ? tint.copy(altitudeThreeColor(Math.round(p.altFt / 100) * 100)).lerp(_white, TRAIL_LIGHTEN)
          : flat;
        c.getRGB(rgb, THREE.SRGBColorSpace);
        // Solid at the aircraft, gone at the tail.
        const a = TRAIL_OPACITY * ((p.t - t0) / span);

        for (const e of [-1, 1]) {
          pos.set(centres[i], v * 3);
          side[v * 3] = sx;
          side[v * 3 + 1] = sy;
          side[v * 3 + 2] = sz;
          edge[v] = e;
          tints[v * 3] = rgb.r;
          tints[v * 3 + 1] = rgb.g;
          tints[v * 3 + 2] = rgb.b;
          alpha[v] = a;
          v++;
        }
        if (i > 0) {
          const l0 = v - 4, r0 = v - 3, l1 = v - 2, r1 = v - 1;
          index[k++] = l0; index[k++] = r0; index[k++] = l1;
          index[k++] = r0; index[k++] = r1; index[k++] = l1;
        }
      }
    }
    this.geometry.setDrawRange(0, k);
    if (this.attrs) {
      for (const attr of Object.values(this.attrs)) attr.needsUpdate = true;
      this.index.needsUpdate = true;
    }
  }
}

export { horizonRangeNm, curvatureDropFt, FT_PER_NM };
