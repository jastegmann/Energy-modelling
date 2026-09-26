// Loading of the precomputed grids (see scripts/build-grid.mjs) and evaluation
// of the heatmap values for the current inputs. Each grid ("dataset", one per
// resolution) is stored in square blocks that are loaded when they come into view.

import { stagesFromFields } from './model/losses.js';
import { FIXED_TILTS, configId } from './model/configs.js';
import { unpackFields, GRID_ENCODING } from './grid-codec.js';
import { decodeScreenBlock, alignScreen, evaluateFilters, protectedShare } from './screening-layers.js';

export async function loadBinary(url) {
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

// Decoded configuration fields of all blocks share one LRU cache.
const CONFIG_CACHE_SIZE = 300;
const configCache = new Map();
function cached(key, make) {
  if (configCache.has(key)) {
    const v = configCache.get(key);
    configCache.delete(key);
    configCache.set(key, v);
    return v;
  }
  const v = make();
  configCache.set(key, v);
  v.catch(() => configCache.delete(key));
  if (configCache.size > CONFIG_CACHE_SIZE) configCache.delete(configCache.keys().next().value);
  return v;
}

export class Dataset {
  constructor(base, manifest) {
    if (manifest.encoding !== GRID_ENCODING) throw new Error(`Unsupported grid encoding "${manifest.encoding}"; rebuild the grid`);
    this.base = base;
    this.manifest = manifest;
    this.res = manifest.resolution;
    this.nx = manifest.nx;
    this.ny = manifest.ny;
    this.bdeg = manifest.blockDegrees;
    this.cpb = Math.round(this.bdeg / this.res); // cells per block side
    this.nbx = Math.round(360 / this.bdeg);
    this.nby = Math.round(180 / this.bdeg);
    this.minZoom = manifest.minZoom ?? 0;
    this.configIds = new Set(manifest.configs.map((c) => c.id));
    this.meta = new Map(manifest.blocks.map((b) => [b.id, b]));
    this.blocks = new Map(); // id -> Promise<Block>
    this.ready = new Array(this.nbx * this.nby); // loaded blocks by block row/col
  }

  get name() {
    return `${this.res}°`;
  }

  /** Load screening.json if the screening layers have been built for this grid. */
  async loadScreening(listed = true) {
    this.screening = null;
    this.screenBlocks = new Set();
    if (!listed) return null;
    try {
      const r = await fetch(`${this.base}screening.json`, { cache: 'no-cache' });
      this.screening = r.ok ? await r.json() : null;
    } catch {
      this.screening = null;
    }
    this.screenBlocks = new Set(this.screening?.blocks ?? []);
    return this.screening;
  }

  /** True if the grid holds every configuration needed for this mounting. */
  supports(mount) {
    return configsFor(mount).every((id) => this.configIds.has(id));
  }

  /** Ids of the blocks (present in this grid) overlapping a lat/lon box. */
  blockIdsIn(south, west, north, east) {
    const ids = [];
    const r0 = Math.max(0, Math.floor((90 - north) / this.bdeg));
    const r1 = Math.min(this.nby - 1, Math.floor((90 - south) / this.bdeg));
    if (east - west >= 360) (west = -180), (east = 180);
    const c0 = Math.floor((west + 180) / this.bdeg);
    const c1 = Math.floor((east + 180) / this.bdeg);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const id = `r${r}c${(((c % this.nbx) + this.nbx) % this.nbx)}`;
        if (this.meta.has(id) && !ids.includes(id)) ids.push(id);
      }
    }
    return ids;
  }

  blockIdsWithCountry(country) {
    return this.manifest.blocks.filter((b) => b.countries.includes(country)).map((b) => b.id);
  }

  /** Load a block (cells, static fields, in-block lookup table). */
  block(id) {
    if (!this.blocks.has(id)) {
      const p = (async () => {
        const meta = this.meta.get(id);
        const dir = `${this.base}blocks/${id}/`;
        const [cellsBuf, staticBuf] = await Promise.all([loadBinary(`${dir}cells.bin.gz`), loadBinary(`${dir}static.bin.gz`)]);
        const cells = new Uint32Array(cellsBuf);
        const M = cells.length;
        const [, br, bc] = id.match(/r(\d+)c(\d+)/).map(Number);
        const row0 = br * this.cpb;
        const col0 = bc * this.cpb;
        const local = new Int32Array(this.cpb * this.cpb).fill(-1);
        for (let i = 0; i < M; i++) {
          const row = Math.floor(cells[i] / this.nx);
          const col = cells[i] % this.nx;
          local[(row - row0) * this.cpb + (col - col0)] = i;
        }
        const b = {
          id,
          meta,
          dataset: this,
          cells,
          M,
          row0,
          col0,
          br,
          bc,
          local,
          stat: unpackFields(staticBuf, this.manifest.staticFields, M),
          config: (cid) => cached(`${this.base}${id}/${cid}`, () => loadBinary(`${dir}${cid}.bin.gz`).then((buf) => unpackFields(buf, this.manifest.fields, M))),
          values: new Map(), // evaluation cache: key -> results
          screenData: null,
          filterCache: new Map(),
        };
        /** Screening layers aligned to this block's cells, or null if not built. */
        b.screen = () => {
          if (!this.screenBlocks?.has(id)) return Promise.resolve(null);
          b.screenData ??= loadBinary(`${this.base}screening/${id}.bin.gz`)
            .then((buf) => {
              const sc = alignScreen(decodeScreenBlock(buf), cells);
              sc.protected = protectedShare(sc);
              return sc;
            })
            .catch((e) => {
              console.warn(e);
              return null;
            });
          return b.screenData;
        };
        this.ready[br * this.nbx + bc] = b;
        return b;
      })();
      p.catch(() => this.blocks.delete(id));
      this.blocks.set(id, p);
    }
    return this.blocks.get(id);
  }

  /** Loaded block and position of the cell containing a point (synchronous), or null. */
  lookup(lat, lon) {
    const row = Math.floor((90 - lat) / this.res);
    const col = Math.floor(((((lon + 180) % 360) + 360) % 360) / this.res);
    if (row < 0 || row >= this.ny) return null;
    const br = Math.floor(row / this.cpb);
    const bc = Math.floor(col / this.cpb);
    const b = this.ready[br * this.nbx + bc];
    if (!b) return null;
    const pos = b.local[(row - b.row0) * this.cpb + (col - b.col0)];
    return pos >= 0 ? { block: b, pos } : null;
  }

  cellCenter(block, pos) {
    const idx = block.cells[pos];
    return { lat: 90 - (Math.floor(idx / this.nx) + 0.5) * this.res, lon: -180 + ((idx % this.nx) + 0.5) * this.res };
  }
}

/** Load all grids listed in data/grids/index.json, coarse to fine. */
export async function loadDatasets(base = 'data/grids/') {
  let index;
  try {
    const r = await fetch(`${base}index.json`, { cache: 'no-cache' });
    if (!r.ok) return [];
    index = await r.json();
  } catch {
    return [];
  }
  const list = await Promise.all(
    index.datasets.map(async (d) => {
      const r = await fetch(`${base}${d.path}manifest.json`, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`${base}${d.path}manifest.json: HTTP ${r.status}`);
      const ds = new Dataset(`${base}${d.path}`, await r.json());
      await ds.loadScreening(d.screening !== false);
      return ds;
    })
  );
  return list.sort((a, b) => b.res - a.res);
}

/**
 * Configurations (and weights) that represent the selected mounting in a grid.
 * Fixed and E-W tilts are interpolated linearly between the 5° layers.
 */
export function gridSelection(mount) {
  if (mount.type === 'tracker') return [{ id: configId(mount), w: 1 }];
  const tilts = mount.type === 'fixed' ? FIXED_TILTS : FIXED_TILTS.filter((t) => t <= 30);
  const t = Math.min(Math.max(mount.tilt, mount.type === 'ew' ? 5 : 0), tilts[tilts.length - 1]);
  const k = tilts.findIndex((x) => x >= t);
  if (tilts[k] === t) return [{ id: layerId(mount, tilts[k]), w: 1 }];
  const t0 = tilts[k - 1], t1 = tilts[k];
  const w1 = (t - t0) / (t1 - t0);
  return [
    { id: layerId(mount, t0), w: 1 - w1 },
    { id: layerId(mount, t1), w: w1 },
  ];
}

function layerId(mount, tilt) {
  // Any mounting at tilt 0 is simply a horizontal plane.
  if (tilt === 0) return configId({ type: 'fixed', tilt: 0, gcr: 0 });
  return configId({ ...mount, tilt });
}

function configsFor(mount) {
  if (mount.type === 'fixed' && mount.optimal) return FIXED_TILTS.map((t) => layerId({ ...mount, type: 'fixed' }, t));
  return gridSelection(mount).map((s) => s.id);
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
 * Annual results of every cell of a block for the given inputs (cached per block):
 * {yield, pr, poa, ghi, tilt?} as Float32Arrays. Stages are recomputed from the
 * stored sums, so this is fast.
 */
export async function blockResults(block, mount, params) {
  const key = JSON.stringify([mount, params]);
  const hit = block.values.get(key);
  if (hit) return hit;
  const M = block.M;
  const out = { yield: new Float32Array(M), pr: new Float32Array(M), poa: new Float32Array(M), ghi: block.stat.ghi };
  const { ghi, wind } = block.stat;
  const f = {};
  if (mount.type === 'fixed' && mount.optimal) {
    const layers = await Promise.all(FIXED_TILTS.map(async (t) => ({ t, data: await block.config(layerId({ ...mount, type: 'fixed' }, t)) })));
    out.tilt = new Float32Array(M);
    const y = new Float64Array(layers.length);
    const st = new Array(layers.length);
    for (let i = 0; i < M; i++) {
      let best = 0;
      for (let k = 0; k < layers.length; k++) {
        st[k] = stagesFromFields(fieldsAt([{ w: 1, data: layers[k].data }], i, f), params, ghi[i], wind[i]);
        y[k] = st[k].avail;
        if (y[k] > y[best]) best = k;
      }
      let t = layers[best].t;
      if (best > 0 && best < layers.length - 1) {
        const d = y[best - 1] - 2 * y[best] + y[best + 1];
        if (d < 0) t += (0.5 * (y[best - 1] - y[best + 1]) / d) * (layers[best + 1].t - layers[best].t);
      }
      out.tilt[i] = t;
      put(out, i, st[best]);
    }
  } else {
    const parts = await Promise.all(gridSelection(mount).map(async (s) => ({ w: s.w, data: await block.config(s.id) })));
    for (let i = 0; i < M; i++) put(out, i, stagesFromFields(fieldsAt(parts, i, f), params, ghi[i], wind[i]));
  }
  block.values.set(key, out);
  if (block.values.size > 4) block.values.delete(block.values.keys().next().value);
  return out;
}

function put(out, i, st) {
  out.yield[i] = st.avail;
  out.pr[i] = (100 * st.avail) / st.inc;
  out.poa[i] = st.inc;
}

/** Full annual stages (for the loss diagram) of one cell. */
export async function cellStages(block, mount, params, pos) {
  const { ghi, wind } = block.stat;
  if (mount.type === 'fixed' && mount.optimal) {
    const r = await blockResults(block, mount, params);
    const tilt = r.tilt[pos];
    return { ...(await cellStages(block, { ...mount, optimal: false, tilt: Math.round(tilt) }, params, pos)), tilt };
  }
  const parts = await Promise.all(gridSelection(mount).map(async (s) => ({ w: s.w, data: await block.config(s.id) })));
  return stagesFromFields(fieldsAt(parts, pos, {}), params, ghi[pos], wind[pos]);
}

/** Value of a map variable from blockResults(). */
export function pickValue(results, variable, i) {
  if (variable === 'opttilt') return results.tilt ? results.tilt[i] : NaN;
  return results[variable][i];
}

/**
 * Screening results of a block for the given filters (cached):
 * {suitable (0–1), pass (0/1), gridKm, protected} or null if no layers exist.
 */
export async function blockFilters(block, filters) {
  const sc = await block.screen();
  if (!sc) return null;
  const key = JSON.stringify(filters);
  let r = block.filterCache.get(key);
  if (!r) {
    r = { ...evaluateFilters(sc, filters), gridKm: sc.gridKm, protected: sc.protected, land: sc.land };
    block.filterCache.set(key, r);
    if (block.filterCache.size > 4) block.filterCache.delete(block.filterCache.keys().next().value);
  }
  return r;
}
