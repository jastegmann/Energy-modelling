// Perez et al. (1990) anisotropic sky-diffuse transposition model.
// Coefficient set "allsitescomposite1990", the one used by PVsyst and by pvlib's default.

// Rows: sky clearness bins 1..8. Columns: f11 f12 f13 f21 f22 f23.
export const PEREZ_1990 = [
  [-0.008, 0.588, -0.062, -0.06, 0.072, -0.022],
  [0.13, 0.683, -0.151, -0.019, 0.066, -0.029],
  [0.33, 0.487, -0.221, 0.055, -0.064, -0.026],
  [0.568, 0.187, -0.295, 0.109, -0.152, -0.014],
  [0.873, -0.392, -0.362, 0.226, -0.462, 0.001],
  [1.132, -1.237, -0.412, 0.288, -0.823, 0.056],
  [1.06, -1.6, -0.359, 0.264, -1.127, 0.131],
  [0.678, -0.327, -0.25, 0.156, -1.377, 0.251],
];

const EPS_BINS = [1.065, 1.23, 1.5, 1.95, 2.8, 4.5, 6.2];
const KAPPA = 1.041; // for zenith in radians
export const COS85 = Math.cos((85 * Math.PI) / 180);

/**
 * Sky-condition coefficients F1 (circumsolar) and F2 (horizon brightening).
 * They depend only on the sky and sun, not on the receiving plane, so they are
 * computed once per hour and reused for every orientation.
 * @returns {{F1:number, F2:number, bin:number}|null} null when there is no diffuse light
 */
export function perezCoefficients(dhi, dni, zenithRad, airmass, dniExtra) {
  if (!(dhi > 0) || !(airmass > 0)) return null;
  const z3 = zenithRad ** 3;
  const eps = ((dhi + dni) / dhi + KAPPA * z3) / (1 + KAPPA * z3);
  let bin = 0;
  while (bin < EPS_BINS.length && eps >= EPS_BINS[bin]) bin++;
  const delta = (dhi * airmass) / dniExtra;
  const c = PEREZ_1990[bin];
  const F1 = Math.max(0, c[0] + c[1] * delta + c[2] * zenithRad);
  const F2 = c[3] + c[4] * delta + c[5] * zenithRad;
  return { F1, F2, bin };
}

/**
 * Split the sky diffuse irradiance on a tilted plane into Perez components.
 * Mirrors pvlib.irradiance.perez(return_components=True): when the total is
 * negative, all components are zero.
 * @param {number} dhi       diffuse horizontal irradiance, W/m²
 * @param {number} F1
 * @param {number} F2
 * @param {number} cosAoi    cosine of the angle of incidence on the plane
 * @param {number} cosZ      cosine of the solar zenith
 * @param {number} cosTilt
 * @param {number} sinTilt
 * @param {object} out       receives {iso, cs, hz}
 */
export function perezComponents(dhi, F1, F2, cosAoi, cosZ, cosTilt, sinTilt, out) {
  const a = cosAoi > 0 ? cosAoi : 0;
  const b = cosZ > COS85 ? cosZ : COS85;
  const iso = dhi * 0.5 * (1 - F1) * (1 + cosTilt);
  const cs = (dhi * F1 * a) / b;
  const hz = dhi * F2 * sinTilt;
  if (iso + cs + hz <= 0) {
    out.iso = 0;
    out.cs = 0;
    out.hz = 0;
  } else {
    out.iso = iso;
    out.cs = cs;
    out.hz = hz;
  }
  return out;
}
