// Loading of the precomputed grid (see scripts/build-grid.mjs) and evaluation
// of the heatmap values for the current inputs.

import { stagesFromFields, systemFactor } from './model/losses.js';
import { FIXED_TILTS, configId } from './model/configs.js';
import { unpackFields, GRID_ENCODING } from './grid-codec.js';

async function loadBinary(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  const b = new Uint8Array(buf, 0, 2);
  if (b[0] === 0x1f && b[1] === 0x8b) {
    // Files are stored gzip'd; hosts serve them as-is, so inflate here.
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).arrayBuffer();
  }
  return buf;
}

/** Load the grid manifest and per-cell data; null if no grid has been built. */
export async function loadGrid(base = 'data/grid/') {
  let manifest;
  try {
    const r = await fetch(`${base}manifest.json`, { cache: 'no-cache' });
    if (!r.ok) return null;
    manifest = await r.json();
  } catch {
    return null;
  }
  if (manifest.encoding !== GRID_ENCODING) throw new Error(`Unsupported grid encoding "${manifest.encoding}"; rebuild the grid`);
  const [cellsBuf, staticBuf] = await Promise.all([loadBinary(base + manifest.files.cells), loadBinary(base + manifest.files.static)]);
  const cells = new Uint32Array(cellsBuf);
  const M = cells.length;
  const { nx, ny } = manifest.grid;
  const gridIndex = new Int32Array(nx * ny).fill(-1);
  for (let i = 0; i < M; i++) gridIndex[cells[i]] = i;
  const configs = new Map(manifest.configs.map((c) => [c.id, c]));
  const cache = new Map();
  return {
    manifest,
    base,
    M,
    cells,
    gridIndex,
    stat: unpackFields(staticBuf, manifest.staticFields, M),
    hasConfig: (id) => configs.has(id),
    /** Decoded fields of one configuration (cached, LRU of 40). */
    async getConfig(id) {
      if (cache.has(id)) {
        const v = cache.get(id);
        cache.delete(id);
        cache.set(id, v);
        return v;
      }
      const cfg = configs.get(id);
      if (!cfg) throw new Error(`Configuration ${id} is not in the grid`);
      const p = loadBinary(base + cfg.file).then((buf) => unpackFields(buf, manifest.fields, M));
      cache.set(id, p);
      if (cache.size > 40) cache.delete(cache.keys().next().value);
      return p;
    },
  };
}

/** Cell index -> centre coordinates. */
export function cellCenter(grid, pos) {
  const { nx, resolution } = grid.manifest.grid;
  const idx = grid.cells[pos];
  return { lat: 90 - (Math.floor(idx / nx) + 0.5) * resolution, lon: -180 + ((idx % nx) + 0.5) * resolution };
}

/** Grid position (0..M-1) of the cell containing a point, or -1. */
export function cellAt(grid, lat, lon) {
  const { nx, ny, resolution } = grid.manifest.grid;
  const row = Math.floor((90 - lat) / resolution);
  const col = Math.floor((((lon + 180) % 360) + 360) % 360 / resolution);
  if (row < 0 || row >= ny) return -1;
  return grid.gridIndex[row * nx + Math.min(col, nx - 1)];
}

/**
 * Configurations (and weights) that represent the selected mounting in the grid.
 * Fixed and E-W tilts are interpolated linearly between the 5° layers.
 */
export function gridSelection(mount) {
  if (mount.type === 'tracker') return [{ id: configId(mount), w: 1 }];
  const tilts = mount.type === 'fixed' ? FIXED_TILTS : [0, ...FIXED_TILTS.filter((t) => t >= 5 && t <= 30)];
  const t = Math.min(Math.max(mount.tilt, tilts[0]), tilts[tilts.length - 1]);
  let k = tilts.findIndex((x) => x >= t);
  if (tilts[k] === t) return [{ id: layerId(mount, tilts[k]), w: 1 }];
  const t0 = tilts[k - 1], t1 = tilts[k];
  const w1 = (t - t0) / (t1 - t0);
  return [
    { id: layerId(mount, t0), w: 1 - w1 },
    { id: layerId(mount, t1), w: w1 },
  ];
}

function layerId(mount, tilt) {
  // E-W at tilt 0 is simply a horizontal plane.
  if (tilt === 0) return configId({ type: 'fixed', tilt: 0, gcr: 0 });
  return configId({ ...mount, tilt });
}

const FIELD_NAMES = ['incSky', 'incGnd1', 'effSky', 'iamLSky', 'effGnd1', 'iamLGnd1', 'Tw', 'Gw'];

function fieldsAt(parts, i, out) {
  for (const name of FIELD_NAMES) {
    let v = 0;
    for (const p of parts) v += p.w * p.data[name][i];
    out[name] = v;
  }
  return out;
}

/**
 * Annual stages for one cell (used for the hover read-out and the grid-cell
 * summary when no live data is available).
 */
export async function cellStages(grid, mount, params, pos) {
  if (mount.type === 'fixed' && mount.optimal) {
    const res = await evaluateOptimal(grid, mount, params, [pos]);
    return { ...res.stages[0], tilt: res.tilt[0] };
  }
  const sel = gridSelection(mount);
  const parts = await Promise.all(sel.map(async (s) => ({ w: s.w, data: await grid.getConfig(s.id) })));
  return stagesFromFields(fieldsAt(parts, pos, {}), params, grid.stat.ghi[pos], grid.stat.wind[pos]);
}

async function evaluateOptimal(grid, mount, params, positions) {
  const layers = await Promise.all(
    FIXED_TILTS.map(async (t) => ({ t, data: await grid.getConfig(layerId({ ...mount, type: 'fixed' }, t)) }))
  );
  const f = {};
  const n = positions.length;
  const tilt = new Float32Array(n);
  const stages = new Array(n);
  const y = new Float64Array(layers.length);
  const st = new Array(layers.length);
  for (let c = 0; c < n; c++) {
    const i = positions[c];
    let best = 0;
    for (let k = 0; k < layers.length; k++) {
      fieldsAt([{ w: 1, data: layers[k].data }], i, f);
      st[k] = stagesFromFields(f, params, grid.stat.ghi[i], grid.stat.wind[i]);
      y[k] = st[k].avail;
      if (y[k] > y[best]) best = k;
    }
    let t = layers[best].t;
    if (best > 0 && best < layers.length - 1) {
      const d = y[best - 1] - 2 * y[best] + y[best + 1];
      if (d < 0) t += (0.5 * (y[best - 1] - y[best + 1]) / d) * (layers[best + 1].t - layers[best].t);
    }
    tilt[c] = t;
    stages[c] = st[best];
  }
  return { tilt, stages };
}

/**
 * Heatmap values for every grid cell.
 * @returns {Promise<Float32Array>} NaN where not applicable
 */
export async function computeValues(grid, mount, params, variable) {
  const M = grid.M;
  const out = new Float32Array(M);
  if (variable === 'ghi') {
    out.set(grid.stat.ghi);
    return out;
  }
  if (mount.type === 'fixed' && mount.optimal) {
    const all = Array.from({ length: M }, (_, i) => i);
    const { tilt, stages } = await evaluateOptimal(grid, mount, params, all);
    for (let i = 0; i < M; i++) out[i] = variable === 'opttilt' ? tilt[i] : pick(stages[i], variable);
    return out;
  }
  if (variable === 'opttilt') return out.fill(NaN);
  const sel = gridSelection(mount);
  const parts = await Promise.all(sel.map(async (s) => ({ w: s.w, data: await grid.getConfig(s.id) })));
  const f = {};
  const sys = systemFactor(params);
  for (let i = 0; i < M; i++) {
    const st = stagesFromFields(fieldsAt(parts, i, f), params, NaN, grid.stat.wind[i]);
    out[i] = variable === 'yield' ? st.temp * sys : pick(st, variable);
  }
  return out;
}

function pick(st, variable) {
  if (variable === 'yield') return st.avail;
  if (variable === 'pr') return (100 * st.avail) / st.inc;
  if (variable === 'poa') return st.inc;
  return NaN;
}
