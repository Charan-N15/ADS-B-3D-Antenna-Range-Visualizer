// Top-down aircraft silhouettes, drawn for this project.
//
// Each is an outline in the xy plane with the nose along +y and one unit from
// nose to tail, so the layer can point it along the track and size it on screen
// without knowing anything about the shape. Most are written as the right half
// and mirrored. `scale` is the kind's size relative to an airliner, so a Cessna
// stays visibly smaller than a 777 at any zoom.
//
// The outlines are extruded into thin solids, and each gets a slightly larger
// black copy that the layer draws behind it as an outline.
//
// A flat outline seen at an angle reads two ways: its top with the nose going
// away, or its underside with the nose coming toward you. Two things settle it:
// a fin standing up at the tail, which is always on top and always at the back,
// and an underside much darker than the top, since the eye takes the lit side
// to be the one facing up. `fin` is [back, front, tip back, tip front, height]
// along the length and above the top surface.

import * as THREE from 'three';

function outline(points) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();
  return shape;
}

/** Right half, nose to tail along +x, mirrored into one closed outline. */
function mirrored(half) {
  const left = half.slice().reverse()
    .filter(([x]) => x !== 0)
    .map(([x, y]) => [-x, y]);
  return outline([...half, ...left]);
}

/** A bar of the given length and width centred on (cx, cy), turned by deg. */
function bar(cx, cy, length, width, deg) {
  const a = deg * Math.PI / 180;
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  const hl = length / 2;
  const hw = width / 2;
  return outline([
    [cx - ux * hl - uy * hw, cy - uy * hl + ux * hw],
    [cx + ux * hl - uy * hw, cy + uy * hl + ux * hw],
    [cx + ux * hl + uy * hw, cy + uy * hl - ux * hw],
    [cx - ux * hl + uy * hw, cy - uy * hl - ux * hw],
  ]);
}

function disc(cx, cy, r) {
  const shape = new THREE.Shape();
  shape.absarc(cx, cy, r, 0, Math.PI * 2, false);
  return shape;
}

/** The widebody airframe the twin and the quad share; engines are added to it. */
function widebody() {
  return mirrored([
    [0, 0.5], [0.05, 0.45], [0.07, 0.36], [0.07, 0.14], [0.5, -0.1],
    [0.5, -0.16], [0.07, -0.06], [0.06, -0.32], [0.22, -0.43],
    [0.22, -0.48], [0.04, -0.44], [0, -0.5],
  ]);
}

const DEFS = {
  // Twin widebody: broader fuselage, longer and deeper wing, an engine under
  // each wing. Its engine count is what separates it from the quad below.
  heavy: {
    scale: 1.35,
    shapes: [
      widebody(),
      bar(0.21, 0.1, 0.16, 0.07, 90), bar(-0.21, 0.1, 0.16, 0.07, 90),
    ],
    fin: [-0.48, -0.27, -0.45, -0.38, 0.2],
  },

  // Four-engine widebody (747, A380, A340, C-17): the same airframe with two
  // engines under each wing.
  quad: {
    scale: 1.35,
    shapes: [
      widebody(),
      bar(0.17, 0.12, 0.15, 0.06, 90), bar(-0.17, 0.12, 0.15, 0.06, 90),
      bar(0.33, 0.035, 0.15, 0.06, 90), bar(-0.33, 0.035, 0.15, 0.06, 90),
    ],
    fin: [-0.48, -0.27, -0.45, -0.38, 0.2],
  },

  // Narrowbody: swept wing mid-fuselage, swept tailplane.
  airliner: {
    scale: 1,
    shapes: [mirrored([
      [0, 0.5], [0.04, 0.46], [0.055, 0.38], [0.055, 0.12], [0.45, -0.08],
      [0.45, -0.13], [0.055, -0.04], [0.05, -0.32], [0.2, -0.44],
      [0.2, -0.48], [0.035, -0.44], [0, -0.5],
    ])],
    fin: [-0.48, -0.29, -0.46, -0.39, 0.2],
  },

  // Business jet: wing set aft, engines on the rear fuselage, T-tail.
  bizjet: {
    scale: 0.75,
    shapes: [mirrored([
      [0, 0.5], [0.035, 0.44], [0.05, 0.3], [0.05, 0.06], [0.4, -0.1],
      [0.4, -0.15], [0.05, -0.08], [0.05, -0.2], [0.11, -0.22],
      [0.11, -0.34], [0.045, -0.34], [0.04, -0.4], [0.18, -0.46],
      [0.18, -0.5], [0, -0.48],
    ])],
    fin: [-0.47, -0.32, -0.47, -0.41, 0.2],
  },

  // Single-engine jet, mostly military: a delta.
  fighter: {
    scale: 0.75,
    shapes: [mirrored([
      [0, 0.5], [0.03, 0.35], [0.05, 0.15], [0.3, -0.3], [0.3, -0.36],
      [0.12, -0.36], [0.1, -0.42], [0.16, -0.5], [0.04, -0.5], [0, -0.46],
    ])],
    fin: [-0.46, -0.26, -0.45, -0.38, 0.18],
  },

  // Turboprop: straight high-aspect wing with nacelles standing forward of it,
  // which is the one detail that separates it from a piston single.
  turboprop: {
    scale: 0.85,
    shapes: [mirrored([
      [0, 0.5], [0.045, 0.44], [0.055, 0.3], [0.055, 0.16], [0.17, 0.155],
      [0.17, 0.25], [0.23, 0.25], [0.23, 0.15], [0.55, 0.13], [0.55, 0.05],
      [0.055, 0.04], [0.04, -0.34], [0.2, -0.38], [0.2, -0.46],
      [0.03, -0.46], [0, -0.5],
    ])],
    fin: [-0.47, -0.3, -0.46, -0.39, 0.2],
  },

  // Light piston single: short fuselage, long straight wing, wide chord.
  piston: {
    scale: 0.65,
    shapes: [mirrored([
      [0, 0.5], [0.06, 0.46], [0.07, 0.3], [0.07, 0.18], [0.65, 0.18],
      [0.65, 0.04], [0.07, 0.04], [0.035, -0.34], [0.22, -0.36],
      [0.22, -0.46], [0.03, -0.46], [0, -0.5],
    ])],
    fin: [-0.48, -0.32, -0.47, -0.41, 0.22],
  },

  // Cabin and tail boom, with two crossed blades for the rotor.
  helicopter: {
    scale: 0.7,
    shapes: [
      mirrored([
        [0, 0.32], [0.1, 0.27], [0.13, 0.1], [0.1, -0.08], [0.03, -0.14],
        [0.025, -0.42], [0.09, -0.42], [0.09, -0.48], [0, -0.48],
      ]),
      bar(0, 0.08, 1, 0.05, 45),
      bar(0, 0.08, 1, 0.05, -45),
    ],
    fin: [-0.47, -0.39, -0.48, -0.44, 0.18],
  },

  // Glider: very long thin wing on a slim fuselage.
  glider: {
    scale: 0.75,
    shapes: [mirrored([
      [0, 0.5], [0.03, 0.44], [0.035, 0.25], [0.035, 0.2], [0.9, 0.17],
      [0.9, 0.12], [0.035, 0.12], [0.02, -0.4], [0.14, -0.42],
      [0.14, -0.47], [0.015, -0.47], [0, -0.5],
    ])],
    fin: [-0.48, -0.36, -0.48, -0.42, 0.2],
  },

  balloon: {
    scale: 0.6,
    shapes: [disc(0, 0, 0.35)],
  },

  // Quadcopter: crossed arms with a rotor at each end.
  drone: {
    scale: 0.5,
    shapes: [
      bar(0, 0, 0.85, 0.08, 45),
      bar(0, 0, 0.85, 0.08, -45),
      disc(0.3, 0.3, 0.13), disc(-0.3, 0.3, 0.13),
      disc(0.3, -0.3, 0.13), disc(-0.3, -0.3, 0.13),
    ],
  },

  // Nothing known about it but its heading: a plain arrow.
  generic: {
    scale: 0.8,
    shapes: [mirrored([[0, 0.5], [0.34, -0.42], [0, -0.18]])],
    fin: [-0.18, 0.1, -0.16, -0.06, 0.18],
  },
};

/** On-screen length of an airliner at 100 % plane size, in pixels. */
export const PLANE_PX = 22;

/** Thickness of every aircraft, in the same units as its one-unit length. */
const THICKNESS = 0.07;

/** Width of the black outline at 100 % plane size, in pixels. */
const OUTLINE_PX = 1.1;

/** Thickness of a fin, across the aircraft. */
const FIN_WIDTH = 0.035;

/**
 * Shade of each face, multiplied with the aircraft's altitude colour. The
 * underside is far darker than the top so the lit side always reads as up; the
 * fin is nearly as bright as the top, since it is the other half of that cue.
 */
const SHADE_TOP = 1;
const SHADE_WALL = 0.5;
const SHADE_UNDER = 0.3;
const SHADE_FIN = 0.85;

/** Sets every vertex's shade; `pick` gets the vertex's normal z. */
function shaded(geom, pick) {
  const normals = geom.getAttribute('normal');
  const shade = new Float32Array(normals.count * 3);
  for (let i = 0; i < normals.count; i++) shade.fill(pick(normals.getZ(i)), i * 3, i * 3 + 3);
  geom.setAttribute('color', new THREE.BufferAttribute(shade, 3));
  return geom;
}

/**
 * The outline as a thin solid. The material is unlit, so depth is painted on,
 * face by face, from the SHADE_ values above.
 */
function solid(shapes) {
  const geom = new THREE.ExtrudeGeometry(shapes, {
    depth: THICKNESS, bevelEnabled: false, curveSegments: 16,
  });
  geom.translate(0, 0, -THICKNESS / 2);
  return shaded(geom, (nz) => (nz > 0.5 ? SHADE_TOP : nz < -0.5 ? SHADE_UNDER : SHADE_WALL));
}

/** The fin's side profile: along the length, and up from inside the body. */
function finProfile([back, front, tipBack, tipFront, height]) {
  const top = THICKNESS / 2 + height;
  return outline([[back, 0], [front, 0], [tipFront, top], [tipBack, top]]);
}

/**
 * A profile drawn in the length-and-height plane, extruded `width` across and
 * stood upright on the aircraft's centre line. Extrusion runs along z; this
 * turns it to run along x, with the profile's x along y and its y up.
 */
function upright(profile, width) {
  const geom = new THREE.ExtrudeGeometry(profile, {
    depth: width, bevelEnabled: false, curveSegments: 16,
  });
  geom.applyMatrix4(new THREE.Matrix4().set(
    0, 0, 1, -width / 2,
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 0, 1,
  ));
  return geom;
}

/** Two unindexed geometries as one, keeping the attributes both have. */
function joined(a, b) {
  const geom = new THREE.BufferGeometry();
  for (const [name, first] of Object.entries(a.attributes)) {
    const second = b.getAttribute(name);
    if (!second) continue;
    const data = new Float32Array(first.array.length + second.array.length);
    data.set(first.array);
    data.set(second.array, first.array.length);
    geom.setAttribute(name, new THREE.BufferAttribute(data, first.itemSize));
  }
  return geom;
}

/**
 * The outline moved outward by e, each corner along the bisector of its two
 * edges. The bisector is stretched so the edges stay e away, but capped, or a
 * sharp wingtip would throw a long black spike.
 */
function grown(shape, e) {
  const pts = shape.getPoints(16);
  if (pts.length > 1 && pts[0].distanceTo(pts[pts.length - 1]) < 1e-9) pts.pop();
  const sign = THREE.ShapeUtils.isClockWise(pts) ? -1 : 1;
  const outward = (a, b) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return [sign * dy / len, -sign * dx / len];
  };
  const n = pts.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const cur = pts[i];
    const [ax, ay] = outward(pts[(i - 1 + n) % n], cur);
    const [bx, by] = outward(cur, pts[(i + 1) % n]);
    let mx = ax + bx;
    let my = ay + by;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-6) { mx = ax; my = ay; } else { mx /= ml; my /= ml; }
    const reach = Math.min(e / Math.max(mx * ax + my * ay, 1e-3), e * 2.5);
    out.push(new THREE.Vector2(cur.x + mx * reach, cur.y + my * reach));
  }
  return new THREE.Shape(out);
}

/**
 * The black hull drawn behind a solid: grown by e on every side, top and bottom
 * included, so from any angle a rim of it shows round the aircraft.
 */
function hull(shapes, e) {
  const depth = THICKNESS + 2 * e;
  const geom = new THREE.ExtrudeGeometry(shapes.map((s) => grown(s, e)), {
    depth, bevelEnabled: false, curveSegments: 16,
  });
  geom.translate(0, 0, -depth / 2);
  return geom;
}

/** name -> { geometry, outline, scale }. Built once; the layer instances them. */
export const SHAPES = {};
for (const [name, def] of Object.entries(DEFS)) {
  // Every kind is drawn at a different size, so the outline is grown by a
  // different amount in each to come out the same width on screen.
  const e = OUTLINE_PX / (PLANE_PX * def.scale);
  let geometry = solid(def.shapes);
  let outlined = hull(def.shapes, e);
  if (def.fin) {
    const profile = finProfile(def.fin);
    geometry = joined(geometry, shaded(upright(profile, FIN_WIDTH), () => SHADE_FIN));
    outlined = joined(outlined, upright(grown(profile, e), FIN_WIDTH + 2 * e));
  }
  SHAPES[name] = { scale: def.scale, geometry, outline: outlined };
}
