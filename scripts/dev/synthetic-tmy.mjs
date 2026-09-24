// Deterministic SYNTHETIC weather year in the PVGIS TMY JSON format.
// For tests and offline development only: it is NOT real PVGIS data.
// A clear-sky model with pseudo-random cloudiness, Erbs decomposition,
// and irradiance evaluated `offsetMin` minutes after each time stamp.

import { solarPosition, dayOfYear, extraterrestrialDni, RAD } from '../../public/js/model/solar-position.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Erbs et al. (1982) diffuse fraction from the clearness index. */
export function erbsDiffuseFraction(kt) {
  if (kt <= 0.22) return 1 - 0.09 * kt;
  if (kt <= 0.8) return 0.9511 - 0.1604 * kt + 4.388 * kt ** 2 - 16.638 * kt ** 3 + 12.336 * kt ** 4;
  return 0.165;
}

/** A smooth, made-up "cloudiness" field in [0, 1] (0 = clear climate). */
export function syntheticCloudiness(lat, lon) {
  const itcz = Math.exp(-(((lat - 5) / 10) ** 2)) * 0.45;
  const subtropicalDesert = Math.exp(-(((Math.abs(lat) - 24) / 8) ** 2)) * 0.35;
  const midLat = Math.max(0, (Math.abs(lat) - 35) / 30) * 0.5;
  const wave = 0.12 * Math.sin(lon * RAD * 3 + lat * RAD * 2) + 0.08 * Math.cos(lon * RAD * 7);
  return Math.min(0.95, Math.max(0.03, 0.3 + itcz - subtropicalDesert + midLat + wave));
}

export function syntheticPvgisTmy(lat, lon, { offsetMin = 10, db = 'PVGIS-SARAH3', year = 2019 } = {}) {
  const rand = mulberry32(Math.round((lat + 90) * 1000) * 360000 + Math.round((lon + 180) * 1000));
  const cloud = syntheticCloudiness(lat, lon);
  const rows = [];
  let dayState = 0.5;
  for (let d = 0; d < 365; d++) {
    const r = rand();
    dayState = r < cloud ? 0.25 + 0.4 * rand() : 0.85 + 0.15 * rand();
    for (let hr = 0; hr < 24; hr++) {
      const t0 = Date.UTC(year, 0, 1 + d, hr, 0);
      const t = t0 + offsetMin * 60000;
      const sp = solarPosition(t, lat, lon);
      const doy = dayOfYear(t);
      let ghi = 0, dhi = 0, dni = 0;
      if (sp.sU > 0.01) {
        const cz = sp.sU;
        const ghiClear = 1098 * cz * Math.exp(-0.057 / cz);
        const kc = Math.min(1.05, Math.max(0.05, dayState + 0.1 * (rand() - 0.5)));
        ghi = ghiClear * kc;
        const kt = ghi / (extraterrestrialDni(doy) * cz);
        dhi = ghi * erbsDiffuseFraction(kt);
        dni = (ghi - dhi) / cz;
      }
      const seasonal = Math.cos(((doy - (lat >= 0 ? 196 : 15)) * 2 * Math.PI) / 365);
      const tMean = 28 - 0.45 * Math.max(0, Math.abs(lat) - 15);
      const t2m = tMean + (4 + 0.25 * Math.abs(lat)) * seasonal + 4 * Math.sin(((hr + lon / 15 - 9) * Math.PI) / 12);
      const ws = 1 + 5 * rand();
      const ds = new Date(t0).toISOString();
      rows.push({
        'time(UTC)': `${ds.slice(0, 4)}${ds.slice(5, 7)}${ds.slice(8, 10)}:${ds.slice(11, 13)}00`,
        T2m: +t2m.toFixed(2),
        RH: 50,
        'G(h)': +ghi.toFixed(2),
        'Gb(n)': +dni.toFixed(2),
        'Gd(h)': +dhi.toFixed(2),
        'IR(h)': 300,
        WS10m: +ws.toFixed(2),
        WD10m: 180,
        SP: 101325,
      });
    }
  }
  return {
    inputs: {
      location: { latitude: lat, longitude: lon, elevation: 100 },
      meteo_data: {
        radiation_db: db,
        meteo_db: 'SYNTHETIC',
        year_min: year,
        year_max: year,
        use_horizon: true,
        horizon_db: 'none',
      },
    },
    outputs: {
      months_selected: Array.from({ length: 12 }, (_, m) => ({ month: m + 1, year })),
      tmy_hourly: rows,
    },
    meta: { synthetic: true, note: 'SYNTHETIC test data, not PVGIS' },
  };
}

// CLI: node scripts/dev/synthetic-tmy.mjs <lat> <lon> [offsetMin] > tmy.json
if (import.meta.url === `file://${process.argv[1]}`) {
  const [lat, lon, off] = process.argv.slice(2).map(Number);
  process.stdout.write(JSON.stringify(syntheticPvgisTmy(lat, lon, { offsetMin: Number.isFinite(off) ? off : 10 })));
}
