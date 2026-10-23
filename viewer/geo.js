// Local geometry for the range3d viewer.
//
// Frame: east-north-up centred on the receiver, units of nautical miles.
//   x = east, y = north, z = up
// Azimuth is degrees true, 0 = north, clockwise, matching the rest of the project.

export const EARTH_RADIUS_NM = 3440.065;
export const FT_PER_NM = 6076.115;

// Line-of-sight constant over a 4/3-radius earth: nautical miles from feet.
export const LOS_K = 1.23;

/** Great-circle distance in nautical miles. */
export function haversineNm(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
  const dp = p2 - p1, dl = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dp / 2) ** 2
    + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing in degrees true. */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
  const dl = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/**
 * Point reached by travelling distNm along a great circle from (lat, lon) on the
 * given bearing. The inverse of haversine/bearing, used to put the ground mesh's
 * vertices back on the globe so map tiles can be mapped onto them.
 */
export function destination(lat, lon, bearingDegTrue, distNm) {
  const p1 = lat * Math.PI / 180;
  const l1 = lon * Math.PI / 180;
  const brg = bearingDegTrue * Math.PI / 180;
  const ang = distNm / EARTH_RADIUS_NM;

  const sinP2 = Math.sin(p1) * Math.cos(ang)
    + Math.cos(p1) * Math.sin(ang) * Math.cos(brg);
  const p2 = Math.asin(Math.min(1, Math.max(-1, sinP2)));
  const l2 = l1 + Math.atan2(
    Math.sin(brg) * Math.sin(ang) * Math.cos(p1),
    Math.cos(ang) - Math.sin(p1) * sinP2,
  );
  return [p2 * 180 / Math.PI, ((l2 * 180 / Math.PI + 540) % 360) - 180];
}

/** Web Mercator x, normalized to 0..1 across the whole world. */
export function mercatorX(lon) {
  return (lon + 180) / 360;
}

/** Web Mercator y, normalized to 0..1, increasing southward as tiles do. */
export function mercatorY(lat) {
  const p = Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180;
  return (1 - Math.log(Math.tan(p) + 1 / Math.cos(p)) / Math.PI) / 2;
}

/**
 * Drop of the earth's surface below the receiver's tangent plane, in feet, at a
 * ground range of d nautical miles. True radius, not the 4/3 refraction radius —
 * this is the shape of the planet, not a propagation model.
 */
export function curvatureDropFt(d) {
  return (d * d / (2 * EARTH_RADIUS_NM)) * FT_PER_NM;
}

/**
 * Altitude above sea level, in feet, of the 4/3-earth line-of-sight limit at
 * ground range d. The inverse of the familiar range formula, so it can be drawn as
 * a floor surface in the same space as the measured one.
 */
export function horizonFloorFt(d, rxAltFt) {
  const t = d / LOS_K - Math.sqrt(Math.max(rxAltFt, 0));
  return t <= 0 ? 0 : t * t;
}

/** Ground range, in nautical miles, of the line-of-sight limit for an altitude. */
export function horizonRangeNm(altFt, rxAltFt) {
  return LOS_K * (Math.sqrt(Math.max(rxAltFt, 0)) + Math.sqrt(Math.max(altFt, 0)));
}

/**
 * Projects a point into the scene.
 *
 * Height is measured from the receiver's tangent plane, so curvature pulls distant
 * things down exactly as it does in reality. `exag` stretches the vertical only:
 * 250 NM across against 40,000 ft is 6.6 NM tall and unreadable at 1:1.
 */
export function project(azDeg, rangeNm, altFt, opts) {
  const { rxAltFt = 0, exag = 1, curvature = true } = opts || {};
  const a = azDeg * Math.PI / 180;
  const drop = curvature ? curvatureDropFt(rangeNm) : 0;
  const zFt = altFt - rxAltFt - drop;
  return [
    rangeNm * Math.sin(a),
    rangeNm * Math.cos(a),
    (zFt / FT_PER_NM) * exag,
  ];
}

/** Scene z for an altitude at a range, in scene units. */
export function zAt(rangeNm, altFt, opts) {
  return project(0, rangeNm, altFt, opts)[2];
}
