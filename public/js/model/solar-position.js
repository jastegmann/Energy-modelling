// Solar position (NOAA / Meeus low-precision algorithm, ~0.01° for 1800–2100).
// All angles in the returned object are in degrees unless suffixed "Rad".
// The sun vector is expressed in local East-North-Up (ENU) coordinates.

export const RAD = Math.PI / 180;
export const DEG = 180 / Math.PI;

const mod = (a, b) => ((a % b) + b) % b;

/**
 * Solar position for a UTC instant.
 * @param {number} timeMs  UTC epoch milliseconds
 * @param {number} lat     latitude, degrees north
 * @param {number} lon     longitude, degrees east
 */
export function solarPosition(timeMs, lat, lon) {
  const jd = timeMs / 86400000 + 2440587.5;
  const jc = (jd - 2451545) / 36525;

  const L0 = mod(280.46646 + jc * (36000.76983 + jc * 0.0003032), 360);
  const M = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
  const e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
  const Mr = M * RAD;
  const C =
    Math.sin(Mr) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) +
    Math.sin(2 * Mr) * (0.019993 - 0.000101 * jc) +
    Math.sin(3 * Mr) * 0.000289;
  const omega = (125.04 - 1934.136 * jc) * RAD;
  const appLong = L0 + C - 0.00569 - 0.00478 * Math.sin(omega);
  const meanObliq = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
  const obliq = (meanObliq + 0.00256 * Math.cos(omega)) * RAD;
  const decl = Math.asin(Math.sin(obliq) * Math.sin(appLong * RAD));

  const y = Math.tan(obliq / 2) ** 2;
  const L0r = L0 * RAD;
  const eot =
    4 * DEG *
    (y * Math.sin(2 * L0r) -
      2 * e * Math.sin(Mr) +
      4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r) -
      0.5 * y * y * Math.sin(4 * L0r) -
      1.25 * e * e * Math.sin(2 * Mr)); // minutes

  const minutesUtc = mod(timeMs / 60000, 1440);
  const tst = mod(minutesUtc + eot + 4 * lon, 1440);
  const ha = (tst / 4 - 180) * RAD; // hour angle, positive in the afternoon

  const phi = lat * RAD;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const sinD = Math.sin(decl);
  const cosD = Math.cos(decl);
  const cosH = Math.cos(ha);

  const sE = -cosD * Math.sin(ha);
  const sN = sinD * cosPhi - cosD * cosH * sinPhi;
  const sU = sinD * sinPhi + cosD * cosH * cosPhi;

  const zenith = Math.acos(Math.max(-1, Math.min(1, sU))) * DEG;
  const azimuth = mod(Math.atan2(sE, sN) * DEG, 360);
  return { sE, sN, sU, zenith, azimuth, declination: decl * DEG, eot };
}

/** Day of year (1..366) of a UTC instant. */
export function dayOfYear(timeMs) {
  const d = new Date(timeMs);
  return Math.floor((timeMs - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1;
}

/** Extraterrestrial normal irradiance, Spencer (1971), W/m². Same as pvlib's default. */
export function extraterrestrialDni(doy, solarConstant = 1366.1) {
  const b = (2 * Math.PI * (doy - 1)) / 365;
  return (
    solarConstant *
    (1.00011 + 0.034221 * Math.cos(b) + 0.00128 * Math.sin(b) + 0.000719 * Math.cos(2 * b) + 0.000077 * Math.sin(2 * b))
  );
}

/** Relative (not pressure-corrected) air mass, Kasten & Young (1989). NaN below the horizon. */
export function relativeAirmass(zenithDeg) {
  if (!(zenithDeg <= 90)) return NaN;
  return 1 / (Math.cos(zenithDeg * RAD) + 0.50572 * (96.07995 - zenithDeg) ** -1.6364);
}
