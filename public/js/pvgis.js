// PVGIS typical meteorological year (TMY) handling, shared by the browser, the
// local server and the precompute scripts.
// API docs: https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis/using-pvgis-5/api-non-interactive-service_en

import { solarPosition } from './model/solar-position.js';

export const PVGIS_BASE = 'https://re.jrc.ec.europa.eu/api/v5_3';

/** URL of the TMY endpoint for one location. */
export function tmyUrl(lat, lon, { base = PVGIS_BASE, usehorizon = 1, startyear, endyear } = {}) {
  const q = new URLSearchParams({
    lat: lat.toFixed(4),
    lon: lon.toFixed(4),
    usehorizon: String(usehorizon),
    outputformat: 'json',
  });
  if (startyear) q.set('startyear', String(startyear));
  if (endyear) q.set('endyear', String(endyear));
  return `${base.replace(/\/$/, '')}/tmy?${q}`;
}

/** Parse "YYYYMMDD:HHMM" (UTC) to epoch milliseconds. */
export function parsePvgisTime(s) {
  return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13));
}

/** Convert the PVGIS TMY JSON response into a compact columnar object. */
export function parsePvgisTmy(json) {
  const rows = json?.outputs?.tmy_hourly;
  if (!Array.isArray(rows) || rows.length < 8000) throw new Error('Unexpected PVGIS TMY response');
  const n = rows.length;
  const tmy = {
    meta: {},
    time: new Float64Array(n),
    ghi: new Float32Array(n),
    dni: new Float32Array(n),
    dhi: new Float32Array(n),
    t2m: new Float32Array(n),
    ws: new Float32Array(n),
  };
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    tmy.time[i] = parsePvgisTime(r['time(UTC)']);
    tmy.ghi[i] = Math.max(0, +r['G(h)'] || 0);
    tmy.dni[i] = Math.max(0, +r['Gb(n)'] || 0);
    tmy.dhi[i] = Math.max(0, +r['Gd(h)'] || 0);
    tmy.t2m[i] = +r['T2m'];
    tmy.ws[i] = Math.max(0, +r['WS10m'] || 0);
  }
  const loc = json.inputs?.location ?? {};
  const md = json.inputs?.meteo_data ?? {};
  tmy.meta = {
    lat: +loc.latitude,
    lon: +loc.longitude,
    elevation: loc.elevation != null ? +loc.elevation : null,
    radiationDb: md.radiation_db ?? null,
    meteoDb: md.meteo_db ?? null,
    yearMin: md.year_min ?? null,
    yearMax: md.year_max ?? null,
    useHorizon: md.use_horizon ?? null,
    horizonDb: md.horizon_db ?? null,
    monthsSelected: json.outputs?.months_selected ?? null,
  };
  return tmy;
}

/** Error message from a PVGIS error response body (JSON or text). */
export function pvgisErrorMessage(text) {
  try {
    const j = JSON.parse(text);
    return j.message || j.error || text;
  } catch {
    return String(text).slice(0, 300);
  }
}

/** True if a PVGIS error message means the point is over the sea / outside coverage. */
export function isSeaError(message) {
  return /sea|ocean|no data|outside|not available/i.test(message);
}

/**
 * Find the offset (minutes) between the PVGIS time stamps and the instant the
 * irradiance values refer to. PVGIS gives DNI and beam horizontal irradiance
 * (GHI - DHI) computed with its own sun position, so their ratio is the cosine
 * of the zenith angle PVGIS used. We pick the shift that best reproduces it.
 * Unlike correlating GHI with the sun, this is not biased by cloud patterns.
 * @returns {{shift:number|null, rmse:number, n:number}}
 */
export function estimateTimeShift(tmy, { range = 90, maxSamples = 600 } = {}) {
  const { lat, lon } = tmy.meta;
  const cand = [];
  for (let i = 0; i < tmy.time.length; i++) {
    const dni = tmy.dni[i];
    const bh = tmy.ghi[i] - tmy.dhi[i];
    if (dni > 50 && bh > 20) {
      const cz = bh / dni;
      if (cz > 0.05 && cz <= 1.02) cand.push(i);
    }
  }
  if (cand.length < 30) return { shift: null, rmse: NaN, n: cand.length };
  const step = Math.max(1, Math.floor(cand.length / maxSamples));
  const sel = cand.filter((_, k) => k % step === 0);
  const err = (s) => {
    let e = 0;
    for (const i of sel) {
      const cz = (tmy.ghi[i] - tmy.dhi[i]) / tmy.dni[i];
      const d = solarPosition(tmy.time[i] + s * 60000, lat, lon).sU - cz;
      e += d * d;
    }
    return e / sel.length;
  };
  let best = 0, bestErr = Infinity;
  for (let s = -range; s <= range; s += 10) {
    const e = err(s);
    if (e < bestErr) { bestErr = e; best = s; }
  }
  const coarse = best;
  for (let s = coarse - 9; s <= coarse + 9; s++) {
    const e = err(s);
    if (e < bestErr) { bestErr = e; best = s; }
  }
  return { shift: best, rmse: Math.sqrt(bestErr), n: sel.length };
}

/** Plain-JSON form of a parsed TMY (for the API and caches). */
export function tmyToJSON(tmy) {
  const r1 = (a) => Array.from(a, (v) => Math.round(v * 10) / 10);
  const r2 = (a) => Array.from(a, (v) => Math.round(v * 100) / 100);
  return {
    meta: tmy.meta,
    time: Array.from(tmy.time, (t) => t / 60000), // epoch minutes
    ghi: r1(tmy.ghi),
    dni: r1(tmy.dni),
    dhi: r1(tmy.dhi),
    t2m: r2(tmy.t2m),
    ws: r2(tmy.ws),
  };
}

export function tmyFromJSON(j) {
  return {
    meta: j.meta,
    time: Float64Array.from(j.time, (t) => t * 60000),
    ghi: Float32Array.from(j.ghi),
    dni: Float32Array.from(j.dni),
    dhi: Float32Array.from(j.dhi),
    t2m: Float32Array.from(j.t2m),
    ws: Float32Array.from(j.ws),
  };
}
