// Incidence angle modifier (IAM): ASHRAE model, as used by PVsyst (default b0 = 0.05).
// Diffuse and ground-reflected light arrive from many directions, so PVsyst
// integrates the IAM over the part of the hemisphere seen by the plane. We do the
// same numerically and tabulate the result against plane tilt.

/** ASHRAE IAM: 1 - b0 (1/cos θ - 1), clipped to [0, 1]. */
export function iamAshrae(cosAoi, b0) {
  if (cosAoi <= 0) return 0;
  const v = 1 - b0 * (1 / cosAoi - 1);
  return v <= 0 ? 0 : v > 1 ? 1 : v;
}

export const IAM_TABLE_STEP = 0.5; // degrees of tilt
const N_TILT = Math.round(90 / IAM_TABLE_STEP) + 1;

/**
 * Hemispherically integrated IAM, weighted by cos θ, for isotropic sky diffuse,
 * for the Perez horizon band, and for isotropic ground-reflected light.
 * Tabulated for tilt 0..90° in IAM_TABLE_STEP steps.
 */
export function buildDiffuseIamTable(b0, nTheta = 90, nPhi = 180) {
  const sky = new Float64Array(N_TILT);
  const gnd = new Float64Array(N_TILT);
  const hz = new Float64Array(N_TILT);

  const dTheta = Math.PI / 2 / nTheta;
  const thetaW = new Float64Array(nTheta);
  const thetaIam = new Float64Array(nTheta);
  const cosT = new Float64Array(nTheta);
  const sinT = new Float64Array(nTheta);
  for (let i = 0; i < nTheta; i++) {
    const t = (i + 0.5) * dTheta;
    cosT[i] = Math.cos(t);
    sinT[i] = Math.sin(t);
    thetaW[i] = cosT[i] * sinT[i];
    thetaIam[i] = iamAshrae(cosT[i], b0);
  }
  const sinPhi = new Float64Array(nPhi);
  for (let j = 0; j < nPhi; j++) sinPhi[j] = Math.sin(((j + 0.5) * 2 * Math.PI) / nPhi);

  // Horizon band: directions on the horizon at azimuth ψ from the plane's facing direction.
  const nPsi = 360;
  const cosPsi = new Float64Array(nPsi);
  for (let k = 0; k < nPsi; k++) cosPsi[k] = Math.cos(-Math.PI / 2 + ((k + 0.5) * Math.PI) / nPsi);

  for (let k = 0; k < N_TILT; k++) {
    const beta = (k * IAM_TABLE_STEP * Math.PI) / 180;
    const sb = Math.sin(beta);
    const cb = Math.cos(beta);
    let sW = 0, sWI = 0, gW = 0, gWI = 0;
    for (let i = 0; i < nTheta; i++) {
      const w = thetaW[i];
      const wi = w * thetaIam[i];
      const a = sinT[i] * sb;
      const c = cosT[i] * cb;
      for (let j = 0; j < nPhi; j++) {
        // Elevation component of the direction in world coordinates.
        if (a * sinPhi[j] + c > 0) {
          sW += w;
          sWI += wi;
        } else {
          gW += w;
          gWI += wi;
        }
      }
    }
    sky[k] = sW > 0 ? sWI / sW : 1;
    gnd[k] = gW > 0 ? gWI / gW : 0;

    let hW = 0, hWI = 0;
    for (let m = 0; m < nPsi; m++) {
      const ct = sb * cosPsi[m];
      if (ct > 0) {
        hW += ct;
        hWI += ct * iamAshrae(ct, b0);
      }
    }
    hz[k] = hW > 0 ? hWI / hW : 0;
  }
  return { b0, sky, gnd, hz };
}

const tableCache = new Map();

/** Cached diffuse IAM table for a given b0. */
export function diffuseIamTable(b0) {
  const key = b0.toFixed(4);
  let t = tableCache.get(key);
  if (!t) {
    t = buildDiffuseIamTable(b0);
    tableCache.set(key, t);
  }
  return t;
}

/** Linear interpolation into one of the tabulated arrays. tiltDeg in [0, 90]. */
export function lookupIam(arr, tiltDeg) {
  const x = Math.min(Math.max(tiltDeg, 0), 90) / IAM_TABLE_STEP;
  const i = Math.min(Math.floor(x), N_TILT - 2);
  const f = x - i;
  return arr[i] + (arr[i + 1] - arr[i]) * f;
}
