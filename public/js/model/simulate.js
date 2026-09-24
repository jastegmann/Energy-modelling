// Hourly simulation chain, modelled on PVsyst:
//   GHI/DHI/DNI -> Perez transposition -> near shading (unlimited rows)
//   -> IAM -> soiling -> PVsyst thermal model -> temperature correction
//   -> constant system losses -> AC specific yield.

import { solarPosition, dayOfYear, extraterrestrialDni, relativeAirmass, RAD, DEG } from './solar-position.js';
import { perezCoefficients, perezComponents } from './perez.js';
import { iamAshrae, diffuseIamTable, lookupIam } from './iam.js';
import { cosAoi, trackerAngle, rowViewFactors, shadedFraction, mountPlanes } from './geometry.js';
import { systemStages, lossBreakdown } from './losses.js';

/**
 * Pre-compute everything that does not depend on the receiving plane: sun
 * position and the Perez sky coefficients for every daylight hour.
 * @param {object} tmy  {meta:{lat,lon}, time, ghi, dni, dhi, t2m, ws}
 * @param {number} shiftMinutes  offset added to the time stamps to get the
 *                               instant the irradiance values refer to
 */
export function prepareHourly(tmy, shiftMinutes = 0) {
  const { lat, lon } = tmy.meta;
  const N = tmy.time.length;
  const idx = [];
  const ghiMonthly = new Float64Array(12);
  const dhiMonthly = new Float64Array(12);
  const taSum = new Float64Array(12);
  const taCount = new Float64Array(12);
  const months = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const m = new Date(tmy.time[i]).getUTCMonth();
    months[i] = m;
    ghiMonthly[m] += tmy.ghi[i] / 1000;
    dhiMonthly[m] += tmy.dhi[i] / 1000;
    taSum[m] += tmy.t2m[i];
    taCount[m] += 1;
    if (tmy.ghi[i] > 0) idx.push(i);
  }
  const n = idx.length;
  const h = {
    lat,
    lon,
    shiftMinutes,
    n,
    sE: new Float64Array(n),
    sN: new Float64Array(n),
    sU: new Float64Array(n),
    F1: new Float64Array(n),
    F2: new Float64Array(n),
    ghi: new Float64Array(n),
    dni: new Float64Array(n),
    dhi: new Float64Array(n),
    ta: new Float64Array(n),
    ws: new Float64Array(n),
    month: new Uint8Array(n),
    twilight: new Uint8Array(n),
    ghiMonthly,
    dhiMonthly,
    taMonthly: Array.from(taSum, (s, m) => (taCount[m] ? s / taCount[m] : NaN)),
    ghiAnnual: ghiMonthly.reduce((a, b) => a + b, 0),
    dhiAnnual: dhiMonthly.reduce((a, b) => a + b, 0),
  };
  const shiftMs = shiftMinutes * 60000;
  for (let k = 0; k < n; k++) {
    const i = idx[k];
    const t = tmy.time[i] + shiftMs;
    const sp = solarPosition(t, lat, lon);
    h.sE[k] = sp.sE;
    h.sN[k] = sp.sN;
    h.sU[k] = sp.sU;
    h.ghi[k] = tmy.ghi[i];
    h.dhi[k] = Math.min(tmy.dhi[i], tmy.ghi[i]);
    h.ta[k] = tmy.t2m[i];
    h.ws[k] = tmy.ws[i];
    h.month[k] = months[i];
    if (sp.sU <= 0.01) {
      // Sun at or below the horizon in our ephemeris but light was recorded:
      // treat the hour as isotropic diffuse only.
      h.twilight[k] = 1;
      h.dni[k] = 0;
      h.dhi[k] = tmy.ghi[i];
      continue;
    }
    h.dni[k] = tmy.dni[i];
    const zen = sp.zenith;
    const c = perezCoefficients(h.dhi[k], h.dni[k], zen * RAD, relativeAirmass(zen), extraterrestrialDni(dayOfYear(t)));
    if (c) {
      h.F1[k] = c.F1;
      h.F2[k] = c.F2;
    }
  }
  return h;
}

/**
 * Run the hourly chain for one mounting configuration.
 * @param {object} h      output of prepareHourly()
 * @param {object} mount  see geometry.mountPlanes()
 * @param {object} p      parameters (see losses.DEFAULT_PARAMS)
 * @returns {object} annual stages, loss breakdown, monthly values and the
 *                   annual sums used for the precomputed grid
 */
export function simulate(h, mount, p) {
  const iam = diffuseIamTable(p.b0);
  const rho = p.albedo;
  const k0 = p.alpha * (1 - p.effStc / 100);
  const gamma = p.gamma / 100;
  const soilF = 1 - p.soiling / 100;
  const tracker = mount.type === 'tracker';
  const fixedPlanes = tracker ? null : mountPlanes(mount, h.lat);
  const limitRad = tracker ? mount.limit * RAD : 0;
  const trkGcr = tracker && mount.gcr > 0 ? mount.gcr : 0;
  const trkPitch = trkGcr > 0 ? 1 / trkGcr : Infinity;
  const trkPlane = tracker ? { weight: 1, pitch: trkPitch, gap: trkPitch } : null;

  // Pre-tabulate IAM values of the fixed planes.
  if (fixedPlanes) {
    for (const pl of fixedPlanes) {
      pl.iamSky = lookupIam(iam.sky, pl.tilt);
      pl.iamHz = lookupIam(iam.hz, pl.tilt);
      pl.iamGnd = lookupIam(iam.gnd, pl.tilt);
    }
  }

  let incSky = 0, incGnd1 = 0, shdSky = 0, shdGnd1 = 0, effSky = 0, effGnd1 = 0;
  let sGeff = 0, sGeffTa = 0, sGeffGth = 0, eTempWh = 0;
  const mInc = new Float64Array(12);
  const mTemp = new Float64Array(12);
  const comp = { iso: 0, cs: 0, hz: 0 };

  for (let k = 0; k < h.n; k++) {
    const sE = h.sE[k], sN = h.sN[k], sU = h.sU[k];
    const ghi = h.ghi[k], dni = h.dni[k], dhi = h.dhi[k];
    const F1 = h.F1[k], F2 = h.F2[k];
    const ta = h.ta[k];
    const u = p.uc + p.uv * h.ws[k];
    const twilight = h.twilight[k] === 1;
    const month = h.month[k];

    let planes = fixedPlanes;
    if (tracker) {
      const r = twilight ? 0 : trackerAngle(sE, sU, limitRad, trkGcr, mount.backtrack);
      const beta = Math.abs(r);
      const cosB = Math.cos(beta);
      const sinB = Math.sin(beta);
      const vf = rowViewFactors(cosB, sinB, trkPitch, trkPitch);
      const tiltDeg = beta * DEG;
      trkPlane.tilt = tiltDeg;
      trkPlane.cosB = cosB;
      trkPlane.sinB = sinB;
      trkPlane.sinAz = r >= 0 ? 1 : -1; // facing east (90°) or west (270°)
      trkPlane.cosAz = 0;
      trkPlane.vfSky = vf.sky;
      trkPlane.vfGnd = vf.gnd;
      trkPlane.skyFree = (1 + cosB) / 2;
      trkPlane.gndFree = (1 - cosB) / 2;
      trkPlane.iamSky = lookupIam(iam.sky, tiltDeg);
      trkPlane.iamHz = lookupIam(iam.hz, tiltDeg);
      trkPlane.iamGnd = lookupIam(iam.gnd, tiltDeg);
      planes = [trkPlane];
    }

    let hourInc = 0, hourTemp = 0;
    for (let j = 0; j < planes.length; j++) {
      const pl = planes[j];
      const w = pl.weight;
      const ca = cosAoi(sE, sN, sU, pl.sinB, pl.cosB, pl.sinAz, pl.cosAz);
      const beam = ca > 0 ? dni * ca : 0;
      if (twilight) {
        comp.iso = dhi * pl.skyFree;
        comp.cs = 0;
        comp.hz = 0;
      } else {
        perezComponents(dhi, F1, F2, ca, sU, pl.cosB, pl.sinB, comp);
      }
      const inc = beam + comp.iso + comp.cs + comp.hz;
      const gnd1 = ghi * pl.gndFree;

      // Near shading: linear beam shading by the row in front, and the reduced
      // sky / ground view factors inside the array.
      let fs = 0;
      if (beam > 0 && Number.isFinite(pl.pitch)) {
        const horiz = sE * pl.sinAz + sN * pl.cosAz;
        fs = shadedFraction(horiz, sU, pl.cosB, pl.sinB, pl.pitch);
      }
      const kSky = pl.skyFree > 0 ? pl.vfSky / pl.skyFree : 1;
      const bS = (beam + comp.cs) * (1 - fs);
      const dS = comp.iso * kSky;
      const hS = comp.hz * kSky;
      const gS1 = ghi * pl.vfGnd;
      const shdS = bS + dS + hS;

      // Incidence angle modifier.
      const eS = bS * iamAshrae(ca, p.b0) + dS * pl.iamSky + hS * pl.iamHz;
      const eG1 = gS1 * pl.iamGnd;

      // PVsyst thermal model: U (Tc - Ta) = α G (1 - η).
      const geff = eS + rho * eG1;
      const gth = shdS + rho * gS1;
      const tc = ta + (k0 * gth) / u;
      const pTemp = geff * soilF * (1 + gamma * (tc - 25));

      incSky += w * inc;
      incGnd1 += w * gnd1;
      shdSky += w * shdS;
      shdGnd1 += w * gS1;
      effSky += w * eS;
      effGnd1 += w * eG1;
      sGeff += w * geff;
      sGeffTa += w * geff * ta;
      sGeffGth += w * geff * gth;
      eTempWh += w * pTemp;
      hourInc += w * (inc + rho * gnd1);
      hourTemp += w * pTemp;
    }
    mInc[month] += hourInc / 1000;
    mTemp[month] += hourTemp / 1000;
  }

  const kWh = (x) => x / 1000;
  const inc = kWh(incSky + rho * incGnd1);
  const shd = kWh(shdSky + rho * shdGnd1);
  const eff = kWh(effSky + rho * effGnd1);
  const soiled = eff * soilF;
  const temp = kWh(eTempWh);
  const stages = {
    ghi: h.ghiAnnual,
    inc,
    shd,
    eff,
    soiled,
    temp,
    tcell: sGeff > 0 ? sGeffTa / sGeff + (k0 * (sGeffGth / sGeff)) / p.uc : NaN,
    ...systemStages(temp, p),
  };
  const sys = stages.avail / (temp || 1);
  const monthly = Array.from({ length: 12 }, (_, m) => {
    const y = mTemp[m] * sys;
    return { ghi: h.ghiMonthly[m], inc: mInc[m], yield: y, pr: mInc[m] > 0 ? y / mInc[m] : NaN };
  });
  return {
    mount,
    stages,
    yield: stages.avail,
    pr: inc > 0 ? stages.avail / inc : NaN,
    losses: lossBreakdown(stages),
    monthly,
    fields: {
      incSky: kWh(incSky),
      incGnd1: kWh(incGnd1),
      effSky: kWh(effSky),
      iamLSky: kWh(shdSky - effSky),
      effGnd1: kWh(effGnd1),
      iamLGnd1: kWh(shdGnd1 - effGnd1),
      Tw: sGeff > 0 ? sGeffTa / sGeff : 0,
      Gw: sGeff > 0 ? sGeffGth / sGeff : 0,
    },
  };
}

/**
 * Equator-facing tilt (0..maxTilt, 0.5° resolution) maximising the specific yield.
 * Golden-section search; yield vs tilt is unimodal for fixed arrays.
 */
export function optimalTilt(h, mount, p, maxTilt = 75) {
  const f = (t) => simulate(h, { ...mount, type: 'fixed', tilt: t }, p).yield;
  const g = (Math.sqrt(5) - 1) / 2;
  let a = 0, b = maxTilt;
  let c = b - g * (b - a), d = a + g * (b - a);
  let fc = f(c), fd = f(d);
  while (b - a > 0.5) {
    if (fc > fd) {
      b = d; d = c; fd = fc; c = b - g * (b - a); fc = f(c);
    } else {
      a = c; c = d; fc = fd; d = a + g * (b - a); fd = f(d);
    }
  }
  const tilt = Math.round(((a + b) / 2) * 2) / 2;
  return { tilt, result: simulate(h, { ...mount, type: 'fixed', tilt }, p) };
}
