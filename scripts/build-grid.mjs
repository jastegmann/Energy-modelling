#!/usr/bin/env node
// Build a precomputed grid for the heatmap from the cached PVGIS TMY files
// (see fetch-tmy.mjs). For every land cell and every mounting configuration the
// full hourly model is run at the reference albedo/IAM, and the annual sums the
// browser needs to apply the loss chain are stored.
//
// Output: public/data/grids/<res>/ (one dataset per resolution), stored in
// square blocks so the browser only loads what is in view. Blocks whose cells
// have not changed since the last build are reused, so adding a country later
// only computes the new blocks.
//
//   node scripts/build-grid.mjs [--res 0.5] [--workers N]
//   node scripts/build-grid.mjs --res 0.1 --countries "Kenya"   # only (re)build blocks touching Kenya
//   node scripts/build-grid.mjs --res 2 --synthetic              # SYNTHETIC demo data, no PVGIS needed
//
// Options: --configs full|standard (default: full for >= 0.5°, standard for finer grids),
//          --bbox=lonMin,latMin,lonMax,latMax, --region africa, --force, --clean

import { parseArgs } from 'node:util';
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { gridConfigs, blockDegrees, blockOf, CONFIG_FIELDS, STATIC_FIELDS } from '../public/js/model/configs.js';
import { REF_ALBEDO, REF_B0 } from '../public/js/model/losses.js';
import { packFields, GRID_ENCODING } from '../public/js/grid-codec.js';
import { ROOT, loadLandCells, selectCells, landSamples, cachePath, parseBbox } from './lib/grid.mjs';

/** Bump when the model changes, so that cached blocks are recomputed. */
const MODEL_VERSION = 1;

const { values: args } = parseArgs({
  options: {
    res: { type: 'string', default: '0.5' },
    workers: { type: 'string', default: String(Math.max(1, availableParallelism() - 1)) },
    out: { type: 'string' },
    cache: { type: 'string' },
    bbox: { type: 'string' },
    region: { type: 'string' },
    countries: { type: 'string' },
    configs: { type: 'string' },
    limit: { type: 'string' },
    synthetic: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    clean: { type: 'boolean', default: false },
    batch: { type: 'string', default: '50' },
  },
});

const res = Number(args.res);
const land = loadLandCells(res);
const cacheDir = args.cache ?? join(ROOT, 'cache', 'tmy', String(res));
const gridsDir = join(ROOT, 'public', 'data', 'grids');
const outDir = args.out ?? join(gridsDir, String(res));
const configSet = args.configs ?? (res >= 0.5 ? 'full' : 'standard');
const configs = gridConfigs(configSet);
const NF = CONFIG_FIELDS.length;
const NS = STATIC_FIELDS.length;
const bdeg = blockDegrees(res);

if (args.clean) rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'blocks'), { recursive: true });
const manifestPath = join(outDir, 'manifest.json');
const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
const reusable = previous?.version === 2 && previous.configSet === configSet ? new Map(previous.blocks.map((b) => [b.id, b])) : new Map();

// Cached cells, grouped by block. A filter selects whole blocks, so a block is
// always rebuilt from all its cached cells.
const cellInfo = (c) => {
  if (args.synthetic) {
    const p = landSamples(c, res, land.nx, land.subsamples)[0];
    return { idx: c.idx, country: c.country, synthetic: true, lat: p.lat, lon: p.lon };
  }
  return { idx: c.idx, country: c.country, path: cachePath(cacheDir, c.idx, land.nx) };
};
const filtered = args.bbox || args.region || args.countries;
const wantedBlocks = filtered
  ? new Set(selectCells(land, { bbox: parseBbox(args.bbox), region: args.region, countries: args.countries }).map((c) => blockOf(c.idx, res)))
  : null;
const blocks = new Map();
for (const c of land.cells) {
  const id = blockOf(c.idx, res);
  if (wantedBlocks && !wantedBlocks.has(id)) continue;
  const info = cellInfo(c);
  if (!info.synthetic && !existsSync(info.path)) continue;
  if (!blocks.has(id)) blocks.set(id, []);
  blocks.get(id).push(info);
}
let todo = [...blocks.entries()];
if (args.limit) {
  // Testing aid: process only the first N cells.
  let left = Number(args.limit);
  todo = todo
    .map(([id, list]) => {
      const part = list.slice(0, Math.max(0, left));
      left -= part.length;
      return [id, part];
    })
    .filter(([, l]) => l.length);
}
const total = todo.reduce((s, [, l]) => s + l.length, 0);
if (!total && !reusable.size) {
  console.error(`No cached TMY files found in ${cacheDir}. Run "npm run fetch" first (or use --synthetic for demo data).`);
  process.exit(1);
}
console.log(
  `${res}° grid: ${total} cells in ${todo.length} blocks × ${configs.length} configurations (${configSet} set), ${args.workers} worker threads${args.synthetic ? '  [SYNTHETIC DATA]' : ''}`
);

// Worker pool shared by all blocks; each free worker picks the next batch.
const workers = Array.from({ length: Math.max(1, Number(args.workers)) }, () => {
  const slot = { w: new Worker(new URL('./lib/grid-worker.mjs', import.meta.url), { workerData: { configs } }), pending: null };
  slot.w.on('message', (m) => slot.pending.resolve(m));
  slot.w.on('error', (e) => (slot.pending ? slot.pending.reject(e) : console.error(e)));
  return slot;
});
function schedule(batches, fallbackShift, onDone) {
  let next = 0;
  return Promise.all(
    workers.map(async (slot) => {
      while (next < batches.length) {
        const batch = batches[next++];
        const m = await new Promise((resolve, reject) => {
          slot.pending = { resolve, reject };
          slot.w.postMessage({ batch, fallbackShift });
        });
        slot.pending = null;
        onDone(batch, m);
      }
    })
  );
}

// Running record of fitted time offsets per radiation database (for cells
// where the offset cannot be fitted), merged with reused blocks.
const shifts = {}; // db -> {shift: count}
const addShifts = (hist) => {
  for (const [db, h] of Object.entries(hist ?? {})) for (const [s, n] of Object.entries(h)) ((shifts[db] ??= {})[s] = (shifts[db][s] ?? 0) + n);
};
const medianOf = (h) => {
  const entries = Object.entries(h).map(([s, n]) => [Number(s), n]).sort((a, b) => a[0] - b[0]);
  const n = entries.reduce((s, e) => s + e[1], 0);
  let acc = 0;
  for (const [s, c] of entries) if ((acc += c) >= n / 2) return s;
  return 0;
};
for (const b of reusable.values()) if (!blocks.has(b.id)) addShifts(b.shifts);

const t0 = Date.now();
let done = 0;
const signature = (list) =>
  createHash('sha1').update(`${MODEL_VERSION}|${configSet}|${args.synthetic}|${list.map((c) => c.idx).join(',')}`).digest('hex');

const results = new Map();
for (const [bid, list] of todo) {
  const sig = signature(list);
  const prev = reusable.get(bid);
  const dir = join(outDir, 'blocks', bid);
  if (!args.force && prev?.sig === sig && existsSync(join(dir, 'cells.bin.gz'))) {
    results.set(bid, prev);
    addShifts(prev.shifts);
    done += list.length;
    continue;
  }
  const n = list.length;
  const pos = new Map(list.map((c, i) => [c.idx, i]));
  const values = new Float32Array(configs.length * NF * n);
  const stat = new Float64Array(NS * n);
  const info = new Array(n);
  const collect = (batch, m) => {
    const bn = batch.length;
    for (let c = 0; c < bn; c++) {
      const i = pos.get(batch[c].idx);
      for (let k = 0; k < configs.length * NF; k++) values[k * n + i] = m.values[k * bn + c];
      for (let j = 0; j < NS; j++) stat[j * n + i] = m.stat[j * bn + c];
    }
    for (const inf of m.info) info[pos.get(inf.idx)] = inf;
  };
  const size = Number(args.batch);
  const batches = [];
  for (let i = 0; i < n; i += size) batches.push(list.slice(i, i + size));
  await schedule(batches, null, (batch, m) => {
    collect(batch, m);
    done += batch.length;
    const s = (Date.now() - t0) / 1000;
    process.stdout.write(`\r${done}/${total} cells  ${(done / s).toFixed(1)} cells/s  ETA ${Math.round(((total - done) * s) / Math.max(1, done) / 60)} min   `);
  });
  const hist = {};
  for (const inf of info) if (inf?.ok && inf.shiftEstimated) ((hist[inf.db] ??= {})[inf.shift] = (hist[inf.db][inf.shift] ?? 0) + 1);
  addShifts(hist);
  const retry = list.filter((c, i) => info[i]?.needsFallback);
  if (retry.length) {
    const fb = Object.fromEntries(Object.entries(shifts).map(([db, h]) => [db, medianOf(h)]));
    const rb = [];
    for (let i = 0; i < retry.length; i += size) rb.push(retry.slice(i, i + size));
    await schedule(rb, fb, collect);
  }

  // Write the block.
  const ok = [];
  for (let i = 0; i < n; i++) if (info[i]?.ok) ok.push(i);
  const errors = info.filter((x) => x?.error);
  if (errors.length) console.log(`\n${errors.length} cells failed in block ${bid}, e.g. ${errors[0].idx}: ${errors[0].error}`);
  rmSync(dir, { recursive: true, force: true });
  if (!ok.length) continue;
  mkdirSync(dir, { recursive: true });
  const M = ok.length;
  const databases = [...new Set(ok.map((i) => info[i].db))].sort();
  const dbIndex = new Map(databases.map((d, i) => [d, i]));
  const pack = (fields, get) => gzipSync(packFields(fields, M, (j, m) => get(j, ok[m])), { level: 9 });
  writeFileSync(join(dir, 'cells.bin.gz'), gzipSync(Buffer.from(Uint32Array.from(ok, (i) => list[i].idx).buffer), { level: 9 }));
  writeFileSync(
    join(dir, 'static.bin.gz'),
    pack(STATIC_FIELDS, (j, i) => {
      const name = STATIC_FIELDS[j].name;
      return name === 'db' ? dbIndex.get(info[i].db) : name === 'country' ? list[i].country : stat[j * n + i];
    })
  );
  configs.forEach((cfg, k) => writeFileSync(join(dir, `${cfg.id}.bin.gz`), pack(CONFIG_FIELDS, (j, i) => values[(k * NF + j) * n + i])));
  results.set(bid, {
    id: bid,
    sig,
    count: M,
    countries: [...new Set(ok.map((i) => list[i].country))].sort((a, b) => a - b),
    databases,
    shifts: hist,
    synthetic: ok.some((i) => info[i].synthetic),
    sources: [...new Set(ok.map((i) => info[i].source).filter(Boolean))],
    years: ok.reduce((y, i) => {
      const [a, b] = info[i].years ?? [];
      return a ? [Math.min(y[0], a), Math.max(y[1], b)] : y;
    }, [9999, 0]),
  });
}
await Promise.all(workers.map((s) => s.w.terminate()));
process.stdout.write('\n');

// Blocks from earlier builds that were not part of this run stay in the dataset.
for (const [id, b] of reusable) if (!results.has(id) && !blocks.has(id) && existsSync(join(outDir, 'blocks', id, 'cells.bin.gz'))) results.set(id, b);
const blockList = [...results.values()].sort((a, b) => a.id.localeCompare(b.id));
if (!blockList.length) {
  console.error('No cells could be processed.');
  process.exit(1);
}
const count = blockList.reduce((s, b) => s + b.count, 0);
const synthetic = blockList.some((b) => b.synthetic);
const countryIds = new Set(blockList.flatMap((b) => b.countries));
const years = blockList.map((b) => b.years).filter((y) => y && y[1]);
const manifest = {
  version: 2,
  name: String(res),
  generated: new Date().toISOString(),
  synthetic,
  source: synthetic ? 'SYNTHETIC test data (not PVGIS)' : 'PVGIS 5.3 typical meteorological year (TMY)',
  pvgis: {
    endpoints: [...new Set(blockList.flatMap((b) => b.sources ?? []))].slice(0, 5),
    usehorizon: 1,
    years: years.length ? [Math.min(...years.map((y) => y[0])), Math.max(...years.map((y) => y[1]))] : null,
  },
  model: {
    version: MODEL_VERSION,
    refAlbedo: REF_ALBEDO,
    refB0: REF_B0,
    description: 'Perez 1990 transposition, unlimited-rows shading, ASHRAE IAM, PVsyst thermal model; see README',
  },
  resolution: res,
  nx: land.nx,
  ny: land.ny,
  blockDegrees: bdeg,
  minZoom: res >= 0.5 ? 0 : res >= 0.1 ? 3 : 5,
  configSet,
  count,
  countries: Object.fromEntries([...countryIds].sort((a, b) => a - b).map((id) => [id, land.countries[id] ?? `#${id}`])),
  shiftByDatabase: Object.fromEntries(Object.entries(shifts).map(([db, h]) => [db, { median: medianOf(h), n: Object.values(h).reduce((a, b) => a + b, 0) }])),
  encoding: GRID_ENCODING,
  fields: CONFIG_FIELDS,
  staticFields: STATIC_FIELDS,
  configs,
  blocks: blockList,
};
writeFileSync(manifestPath, JSON.stringify(manifest));

// Index of all datasets, read by the web page.
const datasets = readdirSync(gridsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(gridsDir, d.name, 'manifest.json')))
  .map((d) => {
    const m = JSON.parse(readFileSync(join(gridsDir, d.name, 'manifest.json'), 'utf8'));
    return m.version === 2 ? { name: m.name, path: `${d.name}/`, resolution: m.resolution, count: m.count, minZoom: m.minZoom, configSet: m.configSet, synthetic: m.synthetic, screening: existsSync(join(gridsDir, d.name, 'screening.json')) } : null;
  })
  .filter(Boolean)
  .sort((a, b) => b.resolution - a.resolution);
if (outDir.startsWith(gridsDir)) writeFileSync(join(gridsDir, 'index.json'), JSON.stringify({ version: 2, datasets }, null, 1));
console.log(`Wrote ${count} cells in ${blockList.length} blocks (${configs.length} configurations) to ${outDir}`);
console.log('Time offsets by database:', JSON.stringify(manifest.shiftByDatabase));
