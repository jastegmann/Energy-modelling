// Array geometry: plane orientation, single-axis tracking with backtracking, and
// the 2-D "unlimited rows" model PVsyst uses for mutual shading of sheds and trackers.
//
// Row geometry is expressed in units of the collector slant width (the module
// width across the row), so a ground coverage ratio (GCR) gives a row pitch of 1/GCR.

import { RAD } from './solar-position.js';

/**
 * Cosine of the angle of incidence on a plane.
 * @param {number} sE,sN,sU  sun unit vector (ENU)
 * @param {number} sinTilt,cosTilt
 * @param {number} sinAz,cosAz  plane azimuth, clockwise from north (180 = south)
 */
export function cosAoi(sE, sN, sU, sinTilt, cosTilt, sinAz, cosAz) {
  return sinTilt * (sE * sinAz + sN * cosAz) + cosTilt * sU;
}

/**
 * Rotation angle of a horizontal, north-south axis tracker, in radians.
 * Positive angles turn the modules to face east.
 * @param {number} sE,sU       sun vector components (sun above horizon)
 * @param {number} limitRad    mechanical rotation limit (symmetric)
 * @param {number} gcr         ground coverage ratio (only used if backtracking)
 * @param {boolean} backtrack
 */
export function trackerAngle(sE, sU, limitRad, gcr, backtrack) {
  let r = Math.atan2(sE, sU); // ideal (true-tracking) angle
  if (backtrack && gcr > 0) {
    // Lorenzo et al. (2011), as in pvlib.tracking.singleaxis for a flat site.
    const temp = Math.abs(Math.cos(r) / gcr);
    if (temp < 1) r -= Math.sign(r) * Math.acos(temp);
  }
  if (r > limitRad) r = limitRad;
  else if (r < -limitRad) r = -limitRad;
  return r;
}

/**
 * View factors from the front face of one row in an infinite array
 * (Hottel crossed strings, 2-D). The sky is seen through the gap between this
 * row's top edge and the top edge of the next row in front; the ground through
 * the gap between the bottom edges.
 * @param {number} cosB,sinB  collector tilt
 * @param {number} pitch      horizontal distance between corresponding edges of
 *                            adjacent obstructions, in slant widths (Infinity = isolated)
 * @param {number} gap        width of the ground opening in front, in slant widths
 * @returns {{sky:number, gnd:number}}
 */
export function rowViewFactors(cosB, sinB, pitch, gap) {
  const sky = Number.isFinite(pitch)
    ? (1 + pitch - Math.hypot(pitch - cosB, sinB)) / 2
    : (1 + cosB) / 2;
  const gnd = Number.isFinite(gap)
    ? Math.max(0, (1 + gap - Math.hypot(gap + cosB, sinB)) / 2)
    : (1 - cosB) / 2;
  return { sky, gnd };
}

/**
 * Fraction of the collector slant width in the shadow of the row in front
 * ("linear" beam shading, as PVsyst's unlimited-sheds model).
 * @param {number} horiz   horizontal component of the sun vector in the facing direction
 * @param {number} sU      vertical component of the sun vector
 * @param {number} cosB,sinB  collector tilt
 * @param {number} pitch   row pitch in slant widths
 */
export function shadedFraction(horiz, sU, cosB, sinB, pitch) {
  if (!Number.isFinite(pitch) || sU <= 0) return 0;
  // Profile angle ψ is the sun elevation projected on the plane perpendicular to the rows.
  const len = Math.hypot(horiz, sU);
  const sinPsi = sU / len;
  const cosPsi = horiz / len;
  const sinPsiB = sinPsi * cosB + cosPsi * sinB; // sin(ψ + β)
  if (sinPsiB <= 0) return 0;
  const fs = 1 - (pitch * sinPsi) / sinPsiB;
  return fs <= 0 ? 0 : fs >= 1 ? 1 : fs;
}

/**
 * Normalised description of a mounting configuration.
 *   fixed:   { type: 'fixed', tilt, gcr }     equator-facing
 *   ew:      { type: 'ew', tilt, gcr }        east/west "tent" pairs
 *   tracker: { type: 'tracker', limit, gcr, backtrack }  horizontal N-S axis
 * gcr = 0 means an isolated row (no mutual shading, full sky and ground view).
 */
export function mountPlanes(mount, lat) {
  const gcr = mount.gcr > 0 ? mount.gcr : 0;
  if (mount.type === 'fixed') {
    const az = lat >= 0 ? 180 : 0;
    const pitch = gcr > 0 ? 1 / gcr : Infinity;
    return [plane(mount.tilt, az, pitch, pitch, 1)];
  }
  if (mount.type === 'ew') {
    // Back-to-back pairs; GCR = 2 slant widths / ridge-to-ridge distance.
    const tilt = mount.tilt;
    const ridge = gcr > 0 ? 2 / gcr : Infinity;
    const gap = gcr > 0 ? Math.max(0, ridge - 2 * Math.cos(tilt * RAD)) : Infinity;
    return [plane(tilt, 90, ridge, gap, 0.5), plane(tilt, 270, ridge, gap, 0.5)];
  }
  if (mount.type === 'tracker') return null; // orientation changes every hour
  throw new Error(`Unknown mount type: ${mount.type}`);
}

function plane(tiltDeg, azDeg, pitch, gap, weight) {
  const b = tiltDeg * RAD;
  const a = azDeg * RAD;
  const cosB = Math.cos(b);
  const sinB = Math.sin(b);
  const vf = rowViewFactors(cosB, sinB, pitch, gap);
  return {
    tilt: tiltDeg,
    azimuth: azDeg,
    cosB,
    sinB,
    sinAz: Math.sin(a),
    cosAz: Math.cos(a),
    pitch,
    gap,
    weight,
    vfSky: vf.sky,
    vfGnd: vf.gnd,
    skyFree: (1 + cosB) / 2,
    gndFree: (1 - cosB) / 2,
  };
}
