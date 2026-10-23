// tar1090's altitude-to-colour ramp, reproduced so the two tools agree.
//
// Table and interpolation lifted from this receiver's own install: the ramp lives in
// tar1090's defaults_*.js (the copy in config.js sits inside a block comment and is
// inactive), and the interpolation is altitudeColor() in planeObject_*.js. Hue is
// piecewise-linear in altitude; lightness is piecewise-linear in the resulting hue;
// saturation is fixed.
//
// One deliberate difference: tar1090 rounds altitude to 50/200/500 ft before picking
// a colour, to limit how many distinct marker images it has to cache. That is a
// rendering optimisation, not part of the ramp, and rounding would band a smooth
// surface — so it is left out here. Our altitude bands are 250 ft at their narrowest,
// well above tar1090's own rounding, so nothing visible changes.
//
// No three.js in here: this stays a pure lookup.

export const COLOR_BY_ALT = {
  unknown: { h: 0, s: 0, l: 75 },
  ground: { h: 220, s: 0, l: 30 },
  air: {
    h: [
      { alt: 0, val: 20 },        // orange
      { alt: 2000, val: 32.5 },   // yellow
      { alt: 4000, val: 43 },
      { alt: 6000, val: 54 },
      { alt: 8000, val: 72 },
      { alt: 9000, val: 85 },     // green yellow
      { alt: 11000, val: 140 },   // light green
      { alt: 40000, val: 300 },   // magenta
      { alt: 51000, val: 360 },   // red
    ],
    s: 88,
    l: [
      { h: 0, val: 53 }, { h: 20, val: 50 }, { h: 32, val: 54 },
      { h: 40, val: 52 }, { h: 46, val: 51 }, { h: 50, val: 46 },
      { h: 60, val: 43 }, { h: 80, val: 41 }, { h: 100, val: 41 },
      { h: 120, val: 41 }, { h: 140, val: 41 }, { h: 160, val: 40 },
      { h: 180, val: 40 }, { h: 190, val: 44 }, { h: 198, val: 50 },
      { h: 200, val: 58 }, { h: 220, val: 58 }, { h: 240, val: 58 },
      { h: 255, val: 55 }, { h: 266, val: 55 }, { h: 270, val: 58 },
      { h: 280, val: 58 }, { h: 290, val: 47 }, { h: 300, val: 43 },
      { h: 310, val: 48 }, { h: 320, val: 48 }, { h: 340, val: 52 },
      { h: 360, val: 53 },
    ],
  },
};

/** Piecewise-linear lookup over points keyed by `key`, clamped at both ends. */
function interpolate(points, key, x) {
  let out = points[0].val;
  for (let i = points.length - 1; i >= 0; i--) {
    if (x > points[i][key]) {
      if (i === points.length - 1) {
        out = points[i].val;
      } else {
        const a = points[i], b = points[i + 1];
        out = a.val + (b.val - a.val) * (x - a[key]) / (b[key] - a[key]);
      }
      break;
    }
  }
  return out;
}

/** [hue, saturation, lightness] for an altitude in feet. */
export function altitudeHsl(altFt) {
  if (altFt === null || altFt === undefined) {
    const u = COLOR_BY_ALT.unknown;
    return [u.h, u.s, u.l];
  }
  if (altFt === 'ground') {
    const g = COLOR_BY_ALT.ground;
    return [g.h, g.s, g.l];
  }
  let h = interpolate(COLOR_BY_ALT.air.h, 'alt', altFt);
  const l = interpolate(COLOR_BY_ALT.air.l, 'h', h);
  h = ((h % 360) + 360) % 360;
  return [h, COLOR_BY_ALT.air.s, l];
}

/** CSS colour for an altitude, for canvas work and for three's setStyle. */
export function altitudeCss(altFt, alpha) {
  const [h, s, l] = altitudeHsl(altFt);
  const hue = h.toFixed(2), sat = s.toFixed(2), lit = l.toFixed(2);
  return alpha === undefined
    ? `hsl(${hue}, ${sat}%, ${lit}%)`
    : `hsla(${hue}, ${sat}%, ${lit}%, ${alpha})`;
}

/** Altitudes worth labelling in a legend, spanning the ramp's useful range. */
export const LEGEND_ALTITUDES = [0, 2000, 5000, 10000, 20000, 30000, 40000];
