// Mounting configurations precomputed for the global grid. The heatmap
// interpolates between fixed tilts; every other option is discrete.
// Clicking the map runs the full hourly model for the exact inputs instead.

export const FIXED_TILTS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];
export const FIXED_GCRS = [0, 0.3, 0.4, 0.5];
export const EW_TILTS = [5, 10, 15, 20, 25, 30];
export const EW_GCRS = [0, 0.7, 0.85, 0.95];
export const TRACKER_LIMITS = [45, 50, 55, 60];
export const TRACKER_GCRS = [0, 0.3, 0.35, 0.4, 0.45, 0.5];

const g3 = (g) => String(Math.round(g * 100)).padStart(3, '0');

/** Stable id of a mounting configuration, e.g. "fixed-t25-g040". */
export function configId(m) {
  if (m.type === 'fixed') return m.tilt === 0 ? 'fixed-t00-g000' : `fixed-t${String(m.tilt).padStart(2, '0')}-g${g3(m.gcr)}`;
  if (m.type === 'ew') return `ew-t${String(m.tilt).padStart(2, '0')}-g${g3(m.gcr)}`;
  if (m.type === 'tracker') {
    if (!(m.gcr > 0)) return `trk-l${m.limit}-g000`;
    return `trk-l${m.limit}-${m.backtrack ? 'bt' : 'tt'}-g${g3(m.gcr)}`;
  }
  throw new Error(`Unknown mount type ${m.type}`);
}

/** All configurations of the precomputed grid (deduplicated). */
export function gridConfigs() {
  const list = [];
  const seen = new Set();
  const add = (m) => {
    const id = configId(m);
    if (!seen.has(id)) {
      seen.add(id);
      list.push({ id, ...m });
    }
  };
  for (const gcr of FIXED_GCRS) for (const tilt of FIXED_TILTS) add({ type: 'fixed', tilt, gcr: tilt === 0 ? 0 : gcr });
  for (const gcr of EW_GCRS) for (const tilt of EW_TILTS) add({ type: 'ew', tilt, gcr });
  for (const limit of TRACKER_LIMITS) {
    for (const gcr of TRACKER_GCRS) {
      if (gcr === 0) add({ type: 'tracker', limit, gcr: 0, backtrack: false });
      else for (const backtrack of [true, false]) add({ type: 'tracker', limit, gcr, backtrack });
    }
  }
  return list;
}

/** Stored per-configuration fields and their quantisation (value = raw * scale). */
export const CONFIG_FIELDS = [
  { name: 'incSky', type: 'uint16', scale: 0.1 },
  { name: 'incGnd1', type: 'uint16', scale: 0.05 },
  { name: 'effSky', type: 'uint16', scale: 0.1 },
  { name: 'iamLSky', type: 'uint16', scale: 0.02 },
  { name: 'effGnd1', type: 'uint16', scale: 0.05 },
  { name: 'iamLGnd1', type: 'uint16', scale: 0.02 },
  { name: 'Tw', type: 'int16', scale: 0.01 },
  { name: 'Gw', type: 'uint16', scale: 0.05 },
];

/** Stored per-cell (configuration independent) fields. */
export const STATIC_FIELDS = [
  { name: 'ghi', type: 'uint16', scale: 0.1 }, // annual GHI, kWh/m²
  { name: 'dhi', type: 'uint16', scale: 0.1 }, // annual DHI, kWh/m²
  { name: 'tMean', type: 'int16', scale: 0.01 }, // annual mean air temperature, °C
  { name: 'wind', type: 'uint16', scale: 0.01 }, // irradiance-weighted wind speed, m/s
  { name: 'shift', type: 'int16', scale: 1 }, // time-stamp offset used, minutes
  { name: 'db', type: 'uint16', scale: 1 }, // index into manifest.databases
  { name: 'elevation', type: 'int16', scale: 1 }, // m
];
