#!/usr/bin/env node
// Build the precomputed global grid shown by the heatmap from the cached PVGIS
// TMY files (see fetch-tmy.mjs). For every land cell and every mounting
// configuration in public/js/model/configs.js the full hourly model is run at
// the reference albedo/IAM, and the annual sums needed by the browser to apply
// the loss chain are stored.
//
//   node scripts/build-grid.mjs [--res 0.5] [--workers N] [--out public/data/grid]
//   node scripts/build-grid.mjs --synthetic --res 2   # SYNTHETIC demo data, no PVGIS needed

import { parseArgs } from 'node:util';
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { gridConfigs, CONFIG_FIELDS, STATIC_FIELDS } from '../public/js/model/configs.js';
import { REF_ALBEDO, REF_B0 } from '../public/js/model/losses.js';
import { PVGIS_BASE } from '../public/js/pvgis.js';
import { packFields, GRID_ENCODING } from '../public/js/grid-codec.js';
import { ROOT, loadLandCells, cellCenter, landSamples, cachePath, parseBbox, inBbox } from './lib/grid.mjs';

const { values: args } = parseArgs({
  options: {
    res: { type: 'string', default: '0.5' },
    workers: { type: 'string', default: String(Math.max(1, availableParallelism() - 1)) },
    out: { type: 'string' },
    cache: { type: 'string' },
    bbox: { type: 'string' },
    limit: { type: 'string' },
    synthetic: { type: 'boolean', default: false },
    batch: { type: 'string', default: '50' },
  },
});

const res = Number(args.res);
const land = loadLandCells(res);
const cacheDir = args.cache ?? join(ROOT, 'cache', 'tmy', String(res));
const outDir = args.out ?? join(ROOT, 'public', 'data', 'grid');
const bbox = parseBbox(args.bbox);
const configs = gridConfigs();
const NF = CONFIG_FIELDS.length;
const NS = STATIC_FIELDS.length;

// Cells to process.
let cells = land.cells
  .filter((c) => inBbox(cellCenter(c.idx, res, land.nx), bbox))
  .map((c) => {
    if (args.synthetic) {
      const p = landSamples(c, res, land.nx, land.subsamples)[0];
      return { idx: c.idx, synthetic: true, lat: p.lat, lon: p.lon };
    }
    return { idx: c.idx, path: cachePath(cacheDir, c.idx, land.nx) };
  })
  .filter((c) => c.synthetic || existsSync(c.path));
if (args.limit) cells = cells.slice(0, Number(args.limit));
if (!cells.length) {
  console.error(`No cached TMY files found in ${cacheDir}. Run "npm run fetch" first (or use --synthetic for demo data).`);
  process.exit(1);
}
const N = cells.length;
console.log(`${N} cells × ${configs.length} configurations, ${args.workers} worker threads${args.synthetic ? '  [SYNTHETIC DATA]' : ''}`);

const values = new Float64Array(configs.length * NF * N);
const stat = new Float64Array(NS * N);
const info = new Array(N);
const pos = new Map(cells.map((c, i) => [c.idx, i]));

async function runPool(list, fallbackShift) {
  const size = Number(args.batch);
  const batches = [];
  for (let i = 0; i < list.length; i += size) batches.push(list.slice(i, i + size));
  let next = 0, done = 0;
  const t0 = Date.now();
  const nWorkers = Math.min(Number(args.workers), batches.length);
  await Promise.all(
    Array.from({ length: nWorkers }, () =>
      new Promise((resolve, reject) => {
        const w = new Worker(new URL('./lib/grid-worker.mjs', import.meta.url), { workerData: { configs } });
        let batch;
        const send = () => {
          if (next >= batches.length) {
            w.terminate();
            return resolve();
          }
          batch = batches[next++];
          w.postMessage({ batch, fallbackShift });
        };
        w.on('message', (m) => {
          const n = batch.length;
          for (let c = 0; c < n; c++) {
            const i = pos.get(batch[c].idx);
            for (let k = 0; k < configs.length * NF; k++) values[k * N + i] = m.values[k * n + c];
            for (let j = 0; j < NS; j++) stat[j * N + i] = m.stat[j * n + c];
          }
          for (const inf of m.info) info[pos.get(inf.idx)] = inf;
          done += n;
          const s = (Date.now() - t0) / 1000;
          process.stdout.write(`\r${done}/${list.length} cells  ${(done / s).toFixed(1)} cells/s  ETA ${Math.round(((list.length - done) * s) / done / 60)} min   `);
          send();
        });
        w.on('error', reject);
        send();
      })
    )
  );
  process.stdout.write('\n');
}

await runPool(cells);

// Cells whose time offset could not be estimated (too little direct sun) use
// the median offset found for the same radiation database.
const byDb = {};
for (const inf of info) if (inf?.ok && inf.shiftEstimated) (byDb[inf.db] ??= []).push(inf.shift);
const shiftByDatabase = {};
for (const [db, list] of Object.entries(byDb)) {
  list.sort((a, b) => a - b);
  shiftByDatabase[db] = { median: list[Math.floor(list.length / 2)], p10: list[Math.floor(list.length * 0.1)], p90: list[Math.floor(list.length * 0.9)], n: list.length };
}
const retry = cells.filter((c, i) => info[i]?.needsFallback);
if (retry.length) {
  const fb = Object.fromEntries(Object.entries(shiftByDatabase).map(([db, s]) => [db, s.median]));
  console.log(`${retry.length} cells without enough direct sun to estimate the time offset; using database medians`);
  await runPool(retry, fb);
}

// Keep successful cells only.
const okIdx = [];
for (let i = 0; i < N; i++) if (info[i]?.ok) okIdx.push(i);
const errors = info.filter((x) => x?.error);
if (errors.length) console.log(`${errors.length} cells failed, e.g. ${errors[0].idx}: ${errors[0].error}`);
const M = okIdx.length;
const databases = [...new Set(okIdx.map((i) => info[i].db))].sort();
const dbIndex = new Map(databases.map((d, i) => [d, i]));
const synthetic = okIdx.some((i) => info[i].synthetic);
const sources = [...new Set(okIdx.map((i) => info[i].source).filter(Boolean))];
const years = okIdx.map((i) => info[i].years).filter((y) => y?.[0]);

const pack = (fields, get) => gzipSync(packFields(fields, M, (j, m) => get(j, okIdx[m])), { level: 9 });

rmSync(join(outDir, 'configs'), { recursive: true, force: true });
mkdirSync(join(outDir, 'configs'), { recursive: true });
writeFileSync(join(outDir, 'cells.bin.gz'), gzipSync(Buffer.from(Uint32Array.from(okIdx, (i) => cells[i].idx).buffer), { level: 9 }));
writeFileSync(
  join(outDir, 'static.bin.gz'),
  pack(STATIC_FIELDS, (j, i) => (STATIC_FIELDS[j].name === 'db' ? dbIndex.get(info[i].db) : stat[j * N + i]))
);
let bytes = 0;
const manifestConfigs = configs.map((cfg, k) => {
  const file = `configs/${cfg.id}.bin.gz`;
  const gz = pack(CONFIG_FIELDS, (j, i) => values[(k * NF + j) * N + i]);
  bytes += gz.length;
  writeFileSync(join(outDir, file), gz);
  return { ...cfg, file };
});

const manifest = {
  version: 1,
  generated: new Date().toISOString(),
  synthetic,
  source: synthetic ? 'SYNTHETIC test data (not PVGIS)' : 'PVGIS 5.3 typical meteorological year (TMY)',
  pvgis: { endpoints: sources.length ? sources : [PVGIS_BASE], usehorizon: 1, years: years.length ? [Math.min(...years.map((y) => y[0])), Math.max(...years.map((y) => y[1]))] : null },
  model: {
    refAlbedo: REF_ALBEDO,
    refB0: REF_B0,
    description: 'Perez 1990 transposition, unlimited-rows shading, ASHRAE IAM, PVsyst thermal model; see README',
  },
  grid: { resolution: res, nx: land.nx, ny: land.ny, latTop: 90, lonLeft: -180 },
  count: M,
  databases,
  shiftByDatabase,
  encoding: GRID_ENCODING,
  fields: CONFIG_FIELDS,
  staticFields: STATIC_FIELDS,
  files: { cells: 'cells.bin.gz', static: 'static.bin.gz' },
  configs: manifestConfigs,
};
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(`Wrote ${M} cells, ${configs.length} configurations (${(bytes / 1e6).toFixed(1)} MB) to ${outDir}`);
console.log('Time offsets by database:', JSON.stringify(shiftByDatabase));
