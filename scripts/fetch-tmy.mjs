#!/usr/bin/env node
// Download PVGIS TMY data for every land cell of the grid into cache/tmy/<res>/.
// Resumable: cells already in the cache are skipped, so it can be stopped
// (Ctrl-C) and restarted at any time.
//
//   node scripts/fetch-tmy.mjs [--res 0.5] [--bbox=lonMin,latMin,lonMax,latMax]
//        [--region africa] [--countries "Kenya,Tanzania"]
//        [--concurrency 8] [--rate 20] [--limit N] [--retry-failed]
//        [--base https://re.jrc.ec.europa.eu/api/v5_3] [--startyear Y --endyear Y]
//
// PVGIS allows at most 30 requests/s per IP; the default stays well below that.
// Behind an HTTP proxy, run with NODE_USE_ENV_PROXY=1 (Node >= 22.21 / 24).

import { parseArgs } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PVGIS_BASE, tmyUrl, parsePvgisTmy, pvgisErrorMessage, isSeaError } from '../public/js/pvgis.js';
import { writeTmyFile } from './lib/tmy-store.mjs';
import { ROOT, loadLandCells, selectCells, landSamples, cachePath, parseBbox } from './lib/grid.mjs';

const { values: args } = parseArgs({
  options: {
    res: { type: 'string', default: '0.5' },
    bbox: { type: 'string' },
    region: { type: 'string' },
    countries: { type: 'string' },
    concurrency: { type: 'string', default: '8' },
    rate: { type: 'string', default: '20' },
    limit: { type: 'string' },
    'retry-failed': { type: 'boolean', default: false },
    base: { type: 'string', default: PVGIS_BASE },
    startyear: { type: 'string' },
    endyear: { type: 'string' },
    timeout: { type: 'string', default: '120' },
    cache: { type: 'string' },
    'max-candidates': { type: 'string', default: '3' },
  },
});

const res = Number(args.res);
const land = loadLandCells(res);
const bbox = parseBbox(args.bbox);
const cacheDir = args.cache ?? join(ROOT, 'cache', 'tmy', String(res));
const failedPath = join(cacheDir, 'failed.json');
mkdirSync(cacheDir, { recursive: true });
const failed = existsSync(failedPath) ? JSON.parse(readFileSync(failedPath, 'utf8')) : {};
const official = args.base.replace(/\/$/, '') === PVGIS_BASE;

let todo = selectCells(land, { bbox, region: args.region, countries: args.countries });
const inArea = todo.length;
todo = todo.filter((c) => !existsSync(cachePath(cacheDir, c.idx, land.nx)));
const cached = inArea - todo.length;
if (!args['retry-failed']) todo = todo.filter((c) => !failed[c.idx]);
if (args.limit) todo = todo.slice(0, Number(args.limit));

console.log(
  `${inArea} land cells in area, ${cached} already cached, ${Object.keys(failed).length} previously failed, ${todo.length} to fetch` +
    ` from ${args.base}${official ? '' : '  (NOT the official PVGIS API)'}`
);
if (!todo.length) process.exit(0);

// Global request pacing (token bucket with one token).
const minGap = 1000 / Number(args.rate);
let nextSlot = 0;
async function paced() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + minGap;
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

async function request(lat, lon) {
  const url = tmyUrl(lat, lon, { base: args.base, startyear: args.startyear, endyear: args.endyear });
  for (let attempt = 0; ; attempt++) {
    await paced();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Number(args.timeout) * 1000);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'accept-encoding': 'gzip' } });
      const text = await r.text();
      if (r.ok) return { ok: true, json: JSON.parse(text) };
      const message = pvgisErrorMessage(text);
      if ((r.status === 429 || r.status >= 500) && attempt < 5) {
        await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt));
        continue;
      }
      return { ok: false, status: r.status, message };
    } catch (e) {
      if (attempt < 5) {
        await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt));
        continue;
      }
      return { ok: false, status: 0, message: `${e.name}: ${e.message}${e.cause ? ` (${e.cause.code ?? e.cause.message})` : ''}` };
    } finally {
      clearTimeout(timer);
    }
  }
}

let done = 0, ok = 0, bad = 0, stopping = false;
const t0 = Date.now();
process.on('SIGINT', () => {
  if (stopping) process.exit(130);
  stopping = true;
  console.log('\nStopping after the requests in flight (Ctrl-C again to abort)...');
});

async function processCell(cell) {
  const candidates = landSamples(cell, res, land.nx, land.subsamples).slice(0, Number(args['max-candidates']));
  let last = null;
  for (const p of candidates) {
    const r = await request(p.lat, p.lon);
    if (r.ok) {
      const tmy = parsePvgisTmy(r.json);
      writeTmyFile(cachePath(cacheDir, cell.idx, land.nx), tmy, {
        idx: cell.idx,
        res,
        query: { lat: p.lat, lon: p.lon },
        source: args.base,
        synthetic: !official || r.json?.meta?.synthetic === true,
        fetched: new Date().toISOString(),
      });
      delete failed[cell.idx];
      return true;
    }
    last = r;
    if (!(r.status === 400 && isSeaError(r.message))) break; // only "sea" errors are worth another point
  }
  failed[cell.idx] = { status: last?.status, message: last?.message, at: new Date().toISOString() };
  return false;
}

const report = () => {
  const s = (Date.now() - t0) / 1000;
  const rate = done / s;
  const eta = rate > 0 ? (todo.length - done) / rate : NaN;
  const fmt = (x) => (Number.isFinite(x) ? `${Math.floor(x / 3600)}h${String(Math.floor((x % 3600) / 60)).padStart(2, '0')}m` : '?');
  process.stdout.write(`\r${done}/${todo.length}  ok ${ok}  failed ${bad}  ${rate.toFixed(1)} cells/s  ETA ${fmt(eta)}   `);
};
const timer = setInterval(report, 2000);

let next = 0;
async function worker() {
  while (!stopping && next < todo.length) {
    const cell = todo[next++];
    try {
      (await processCell(cell)) ? ok++ : bad++;
    } catch (e) {
      bad++;
      failed[cell.idx] = { status: -1, message: String(e.message ?? e), at: new Date().toISOString() };
    }
    done++;
  }
}
await Promise.all(Array.from({ length: Number(args.concurrency) }, worker));
clearInterval(timer);
report();
writeFileSync(failedPath, JSON.stringify(failed, null, 1));
console.log(`\nDone: ${ok} fetched, ${bad} failed (see ${failedPath}).`);
if (bad) {
  const reasons = {};
  for (const f of Object.values(failed)) reasons[f.message] = (reasons[f.message] ?? 0) + 1;
  for (const [m, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`  ${n} × ${m}`);
}
