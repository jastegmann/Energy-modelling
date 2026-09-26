#!/usr/bin/env node
// Build the site-screening layers for the grid cells:
//   - protected areas      OpenStreetMap (ODbL) via the Overpass API
//   - land cover           ESA WorldCover 2021 v200 (CC BY 4.0), read from its overviews (~150 m)
//   - slope                Copernicus DEM GLO-90 (free licence), overview (~185 m)
//   - distance to grid     gridfinder (Arderne et al. 2020, CC BY 4.0)
//   - distance to OSM lines and substations of at least 33/66/132/220/330 kV
//                          OpenStreetMap (ODbL) via the Overpass API
// For every cell a joint histogram (protected × land cover × slope class) and the
// distance to the nearest power line are stored next to the yield grid, in
// public/data/grids/<res>/screening/. The page combines them with any filters.
//
//   npm install          (once; needs the "geotiff" package)
//   node scripts/build-screening.mjs --res 0.1 --region africa
//   node scripts/build-screening.mjs --res 0.05 --countries "Kenya"
//
// Work is cached per 1° tile in cache/screening/, so the script can be stopped
// and restarted, and further resolutions reuse the same tiles.

import { parseArgs } from 'node:util';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ROOT, loadLandCells, selectCells, cellCenter, parseBbox } from './lib/grid.mjs';
import { ISO2 } from './lib/regions.mjs';
import { blockOf } from '../public/js/model/configs.js';
import { LAND_COVER, SLOPE_LIMITS, NBINS, binIndex, encodeScreenBlock, TX_KV } from '../public/js/screening-layers.js';
import { powerDataFor } from './lib/osm-power.mjs';

const { values: args } = parseArgs({
  options: {
    res: { type: 'string' },
    bbox: { type: 'string' },
    region: { type: 'string' },
    countries: { type: 'string' },
    pixels: { type: 'string', default: '600' },
    concurrency: { type: 'string', default: '4' },
    gridfinder: { type: 'string', default: 'https://zenodo.org/records/3628142/files/grid.gpkg?download=1' },
    overpass: { type: 'string' },
    'worldcover-base': { type: 'string' },
    'dem-base': { type: 'string' },
    'skip-protected': { type: 'boolean', default: false },
    'skip-grid': { type: 'boolean', default: false },
    'skip-osm-power': { type: 'boolean', default: false },
    'max-grid-km': { type: 'string', default: '1000' },
    cache: { type: 'string' },
    grids: { type: 'string' },
  },
});

let raster, osm, gpkg;
try {
  raster = await import('./lib/raster.mjs');
} catch (e) {
  console.error(`The screening build needs the "geotiff" package: run "npm install" first.\n(${e.message})`);
  process.exit(1);
}
osm = await import('./lib/osm-protected.mjs');
gpkg = await import('./lib/gpkg-lines.mjs');

const P = Number(args.pixels); // working pixels per degree
const SUB = 0.05; // tiles are summarised on a 0.05° sub-grid, the finest grid resolution
const NSUB = Math.round(1 / SUB);
const PX_SUB = P / NSUB;
if (!Number.isInteger(PX_SUB)) throw new Error('--pixels must be a multiple of 20');
const cacheDir = args.cache ?? join(ROOT, 'cache', 'screening');
const gridsDir = args.grids ?? join(ROOT, 'public', 'data', 'grids');
const tileDir = join(cacheDir, `tiles-v1-${P}${args['skip-protected'] ? '-noprot' : ''}`);
mkdirSync(tileDir, { recursive: true });
const log = (...a) => console.log(...a);

// ------------------------------------------------------------ target cells
const resList = (args.res ?? (existsSync(join(gridsDir, 'index.json')) ? JSON.parse(readFileSync(join(gridsDir, 'index.json'), 'utf8')).datasets.map((d) => String(d.resolution)).join(',') : ''))
  .split(',')
  .filter(Boolean)
  .map(Number);
if (!resList.length) throw new Error('No resolution given (--res) and no built grids found.');
const filter = { bbox: parseBbox(args.bbox), region: args.region, countries: args.countries };
const targets = [];
for (const res of resList) {
  const land = loadLandCells(res);
  let cells = selectCells(land, filter);
  const mPath = join(gridsDir, String(res), 'manifest.json');
  if (existsSync(mPath)) {
    // Only where a yield grid exists.
    const blocks = new Set(JSON.parse(readFileSync(mPath, 'utf8')).blocks.map((b) => b.id));
    cells = cells.filter((c) => blocks.has(blockOf(c.idx, res)));
  } else if (!filter.bbox && !filter.region && !filter.countries) {
    throw new Error(`No ${res}° grid built yet; build it first or give --region/--countries/--bbox.`);
  }
  if (res < SUB - 1e-9 || Math.abs(res / SUB - Math.round(res / SUB)) > 1e-6) throw new Error(`Resolution ${res} must be a multiple of 0.05°`);
  targets.push({ res, land, cells });
  log(`${res}°: ${cells.length} cells`);
}

// 1° tiles covering all target cells.
const tiles = new Map();
const countries = new Set();
for (const { res, land, cells } of targets) {
  for (const c of cells) {
    countries.add(c.country);
    const { lat, lon } = cellCenter(c.idx, res, land.nx);
    const s = lat - res / 2, w = lon - res / 2;
    for (let la = Math.floor(s + 1e-9); la < s + res - 1e-9; la++) {
      for (let lo = Math.floor(w + 1e-9); lo < w + res - 1e-9; lo++) tiles.set(`${la}_${lo}`, [la, lo]);
    }
  }
}
log(`${tiles.size} tiles of 1°, ${countries.size} countries`);

// ------------------------------------------------------------ protected areas
let areas = [];
if (!args['skip-protected']) {
  const isos = [...new Set([...countries].map((c) => ISO2[c]).filter(Boolean))].sort();
  const missing = [...countries].filter((c) => !ISO2[c]);
  if (missing.length) log(`No OpenStreetMap country code for ids ${missing.join(', ')}; their protected areas are skipped.`);
  const endpoint = args.overpass ? args.overpass.split(',').map((u) => u.trim()).filter(Boolean) : osm.OVERPASS_MIRRORS;
  const failedIsos = [];
  for (const iso of isos) {
    const t0 = Date.now();
    try {
      const list = await osm.protectedAreas(iso, { cacheDir: join(cacheDir, 'osm-protected'), endpoint, log });
      log(`  protected areas ${iso}: ${list.length} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
      areas.push(...list);
    } catch (e) {
      log(`  protected areas ${iso}: FAILED (${e.message})`);
      failedIsos.push(iso);
    }
  }
  if (failedIsos.length) {
    // Tiles are cached, so building them without these countries' protected areas would stick.
    log(
      `\nProtected areas could not be downloaded for ${failedIsos.join(', ')} (Overpass busy). The other countries are cached;` +
        ` run the same command again later to retry only these, or pass --skip-protected to build without protected areas.`
    );
    process.exit(1);
  }
  areas = areas.map((a) => {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    const rings = a.rings.map((r) => {
      const f = new Float64Array(r.length * 2);
      r.forEach(([x, y], i) => {
        f[2 * i] = x;
        f[2 * i + 1] = y;
        if (x < w) w = x;
        if (x > e) e = x;
        if (y < s) s = y;
        if (y > n) n = y;
      });
      return f;
    });
    return { rings, w, s, e, n };
  });
}

function rasterizeProtected(la, lo) {
  const out = new Uint8Array(P * P);
  const hit = areas.filter((a) => a.e >= lo && a.w <= lo + 1 && a.n >= la && a.s <= la + 1);
  if (!hit.length) return out;
  const xs = [];
  for (const a of hit) {
    for (let y = 0; y < P; y++) {
      const lat = la + 1 - (y + 0.5) / P;
      if (lat < a.s || lat > a.n) continue;
      xs.length = 0;
      for (const r of a.rings) {
        const m = r.length / 2;
        for (let i = 0; i < m; i++) {
          const j = (i + 1) % m; // implicit closing edge
          const y1 = r[2 * i + 1], y2 = r[2 * j + 1];
          if ((y1 <= lat && y2 > lat) || (y2 <= lat && y1 > lat)) xs.push(r[2 * i] + ((lat - y1) / (y2 - y1)) * (r[2 * j] - r[2 * i]));
        }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const x0 = Math.max(0, Math.ceil((xs[k] - lo) * P - 0.5));
        const x1 = Math.min(P - 1, Math.floor((xs[k + 1] - lo) * P - 0.5));
        for (let x = x0; x <= x1; x++) out[y * P + x] = 1;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------ OSM power (distance to transmission)
// Lines and substations per voltage threshold; distances are computed per cell at output time.
let txIndex = null;
if (!args['skip-osm-power']) {
  const isos = [...new Set([...countries].map((c) => ISO2[c]).filter(Boolean))].sort();
  const endpoint = args.overpass ? args.overpass.split(',').map((u) => u.trim()).filter(Boolean) : osm.OVERPASS_MIRRORS;
  const power = await powerDataFor(isos, { cacheDir: join(cacheDir, 'osm-power'), endpoint, log });
  if (power.failed.length) {
    log(
      `\nOpenStreetMap power data could not be downloaded for ${power.failed.join(', ')} (Overpass busy). The other countries are cached;` +
        ` run the same command again later to retry only these, or pass --skip-osm-power to build without distances to transmission.`
    );
    process.exit(1);
  }
  txIndex = TX_KV.map((kv) => {
    const lines = new gpkg.SegmentIndex(0.25), subs = new gpkg.SegmentIndex(0.25);
    for (const l of power.lines) if (l.v >= kv) lines.addLine(l.p);
    for (const st of power.substations) if (st.v >= kv) subs.addSegment(st.lon, st.lat, st.lon, st.lat);
    return { lines, subs };
  });
  log(`OSM power: ${power.lines.length} lines, ${power.substations.length} substations; ≥ ${TX_KV.join('/')} kV: ${txIndex.map((t) => `${t.lines.count}/${t.subs.count}`).join(', ')} segments/substations`);
}

// ------------------------------------------------------------ per-tile summaries
const lcIndex = new Uint8Array(256).fill(255);
LAND_COVER.forEach((c, i) => (lcIndex[c.code] = i));
const tilePath = (la, lo) => join(tileDir, `${la}_${lo}.bin.gz`);

async function processTile(la, lo) {
  const box = { west: lo, south: la, east: lo + 1, north: la + 1 };
  const wcUrl = raster.WORLDCOVER.url(la + 0.5, lo + 0.5, args['worldcover-base'] ?? raster.WORLDCOVER.base);
  const demUrl = raster.COPDEM.url(la + 0.5, lo + 0.5, args['dem-base'] ?? raster.COPDEM.base);
  const [wc, dem] = await Promise.all([raster.readArea(wcUrl, box, P, P, 'nearest'), raster.readArea(demUrl, box, P, P, 'bilinear')]);
  const hist = new Uint16Array(NSUB * NSUB * NBINS);
  if (wc) {
    const slope = dem ? raster.slopeDegrees(dem, P, P, la + 1, 1 / P) : null;
    const prot = areas.length ? rasterizeProtected(la, lo) : null;
    for (let y = 0; y < P; y++) {
      const sy = Math.floor(y / PX_SUB);
      for (let x = 0; x < P; x++) {
        const l = lcIndex[wc[y * P + x]];
        if (l === 255) continue; // no data / sea
        const sd = slope ? slope[y * P + x] : 0;
        let s = 0;
        while (s < SLOPE_LIMITS.length && sd >= SLOPE_LIMITS[s]) s++;
        const p = prot ? prot[y * P + x] : 0;
        hist[(sy * NSUB + Math.floor(x / PX_SUB)) * NBINS + binIndex(p, l, s)]++;
      }
    }
  }
  const tmp = `${tilePath(la, lo)}.tmp`;
  writeFileSync(tmp, gzipSync(Buffer.from(hist.buffer), { level: 6 }));
  renameSync(tmp, tilePath(la, lo));
  return { wc: !!wc, dem: !!dem };
}

const todo = [...tiles.values()].filter(([la, lo]) => !existsSync(tilePath(la, lo)));
log(`${tiles.size - todo.length} tiles cached, ${todo.length} to process`);
{
  let next = 0, done = 0, noLc = 0, noDem = 0, failed = 0;
  const t0 = Date.now();
  const report = () => {
    const s = (Date.now() - t0) / 1000;
    process.stdout.write(`\r${done}/${todo.length} tiles  ${(done / s || 0).toFixed(2)}/s  ETA ${done ? Math.round(((todo.length - done) * s) / done / 60) : '?'} min  (no land cover: ${noLc}, no DEM: ${noDem}, failed: ${failed})   `);
  };
  const timer = setInterval(report, 2000);
  await Promise.all(
    Array.from({ length: Number(args.concurrency) }, async () => {
      while (next < todo.length) {
        const [la, lo] = todo[next++];
        for (let attempt = 0; ; attempt++) {
          try {
            const r = await processTile(la, lo);
            if (!r.wc) noLc++;
            if (r.wc && !r.dem) noDem++;
            break;
          } catch (e) {
            if (attempt < 3) {
              await new Promise((res) => setTimeout(res, 5000 * (attempt + 1)));
              continue;
            }
            failed++;
            console.error(`\nTile ${la},${lo} failed: ${e.message}`);
            break;
          }
        }
        done++;
      }
    })
  );
  clearInterval(timer);
  report();
  process.stdout.write('\n');
  if (failed) log(`${failed} tiles failed; run the script again to retry them.`);
}

// ------------------------------------------------------------ grid distance
let index = null;
if (!args['skip-grid']) {
  let path = args.gridfinder;
  if (/^https?:/.test(path)) {
    const local = join(cacheDir, 'gridfinder', 'grid.gpkg');
    if (!existsSync(local)) {
      mkdirSync(join(cacheDir, 'gridfinder'), { recursive: true });
      log(`Downloading gridfinder network from ${path} ...`);
      const r = await fetch(path);
      if (!r.ok) {
        throw new Error(
          `gridfinder download failed (HTTP ${r.status}). Download grid.gpkg manually from https://zenodo.org/records/3628142 and pass --gridfinder <path>, or use --skip-grid.`
        );
      }
      await pipeline(Readable.fromWeb(r.body), createWriteStream(`${local}.tmp`));
      renameSync(`${local}.tmp`, local);
      log(`  saved ${(statSync(local).size / 1e6).toFixed(0)} MB`);
    }
    path = local;
  }
  let w = 180, s = 90, e = -180, n = -90;
  for (const [la, lo] of tiles.values()) (w = Math.min(w, lo)), (e = Math.max(e, lo + 1)), (s = Math.min(s, la)), (n = Math.max(n, la + 1));
  const margin = 5;
  index = new gpkg.SegmentIndex(0.25);
  const rows = gpkg.readLines(path, { west: w - margin, south: s - margin, east: e + margin, north: n + margin }, (pts) => index.addLine(pts));
  log(`gridfinder: ${rows} features, ${index.count.toLocaleString('en-US')} segments`);
}

// ------------------------------------------------------------ per-grid output
const tileCache = new Map();
function tileHist(la, lo) {
  const k = `${la}_${lo}`;
  if (tileCache.has(k)) return tileCache.get(k);
  const p = tilePath(la, lo);
  const h = existsSync(p) ? new Uint16Array(gunzipSync(readFileSync(p)).buffer.slice(0)) : null;
  tileCache.set(k, h);
  if (tileCache.size > 600) tileCache.delete(tileCache.keys().next().value);
  return h;
}

const maxKm = Number(args['max-grid-km']);
for (const { res, land, cells } of targets) {
  const outDir = join(gridsDir, String(res));
  mkdirSync(join(outDir, 'screening'), { recursive: true });
  const k = Math.round(res / SUB); // sub-cells per cell side
  const pxPerCell = k * k * PX_SUB * PX_SUB;
  const byBlock = new Map();
  for (const c of cells) {
    const b = blockOf(c.idx, res);
    if (!byBlock.has(b)) byBlock.set(b, []);
    byBlock.get(b).push(c);
  }
  const acc = new Float64Array(NBINS);
  let written = 0;
  for (const [bid, list] of [...byBlock.entries()].sort()) {
    list.sort((a, b) => a.idx - b.idx);
    const n = list.length;
    const land8 = new Uint8Array(n);
    const hist8 = new Uint8Array(NBINS * n);
    const gridKm = new Float32Array(n).fill(NaN);
    const tx = txIndex ? { lineKm: new Float32Array(TX_KV.length * n).fill(NaN), subKm: new Float32Array(TX_KV.length * n).fill(NaN) } : null;
    list.forEach((c, i) => {
      const { lat, lon } = cellCenter(c.idx, res, land.nx);
      acc.fill(0);
      let total = 0;
      const north = lat + res / 2, west = lon - res / 2;
      for (let a = 0; a < k; a++) {
        for (let b = 0; b < k; b++) {
          const subLat = north - (a + 0.5) * SUB, subLon = west + (b + 0.5) * SUB;
          const la = Math.floor(subLat), lo = Math.floor(subLon);
          const h = tileHist(la, lo);
          if (!h) continue;
          const sy = Math.floor((la + 1 - subLat) / SUB), sx = Math.floor((subLon - lo) / SUB);
          const o = (sy * NSUB + sx) * NBINS;
          for (let bin = 0; bin < NBINS; bin++) {
            acc[bin] += h[o + bin];
            total += h[o + bin];
          }
        }
      }
      land8[i] = Math.round((255 * total) / pxPerCell);
      if (total > 0) for (let bin = 0; bin < NBINS; bin++) hist8[bin * n + i] = Math.round((255 * acc[bin]) / total);
      if (index) gridKm[i] = index.distanceKm(lat, lon, maxKm);
      if (tx) {
        txIndex.forEach((t, k) => {
          tx.lineKm[k * n + i] = t.lines.count ? t.lines.distanceKm(lat, lon, maxKm) : Infinity;
          tx.subKm[k * n + i] = t.subs.count ? t.subs.distanceKm(lat, lon, maxKm) : Infinity;
        });
      }
    });
    const buf = encodeScreenBlock(Uint32Array.from(list, (c) => c.idx), gridKm, land8, hist8, tx);
    writeFileSync(join(outDir, 'screening', `${bid}.bin.gz`), gzipSync(buf, { level: 9 }));
    written += n;
  }
  const blocksPresent = [...byBlock.keys()].sort();
  const metaPath = join(outDir, 'screening.json');
  const prev = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : null;
  const allBlocks = [...new Set([...(prev?.blocks ?? []), ...blocksPresent])].sort();
  writeFileSync(
    metaPath,
    JSON.stringify(
      {
        version: 1,
        generated: new Date().toISOString(),
        resolution: res,
        pixelsPerDegree: P,
        landCover: LAND_COVER.map((c) => ({ code: c.code, name: c.name })),
        slopeLimits: SLOPE_LIMITS,
        gridDistance: !args['skip-grid'] || !!prev?.gridDistance,
        transmissionDistance: txIndex ? TX_KV : prev?.transmissionDistance ?? null,
        protectedAreas: !args['skip-protected'] || !!prev?.protectedAreas,
        sources: {
          protectedAreas: 'OpenStreetMap contributors (ODbL), boundary=protected_area / national_park, leisure=nature_reserve',
          landCover: 'ESA WorldCover 10 m 2021 v200 (CC BY 4.0), © ESA WorldCover project / Copernicus Sentinel data',
          slope: 'Copernicus DEM GLO-90 (© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the EU and ESA)',
          grid: 'gridfinder, Arderne et al. (2020), Predictive mapping of the global power system using open data, Scientific Data 7:19 (CC BY 4.0)',
          transmission: 'OpenStreetMap contributors (ODbL), power=line/minor_line/cable and power=substation with a voltage tag',
        },
        blocks: allBlocks,
      },
      null,
      1
    )
  );
  log(`${res}°: wrote screening layers for ${written} cells in ${blocksPresent.length} blocks -> ${outDir}/screening`);
}

// Flag the grids that have screening layers in the index read by the page.
const indexPath = join(gridsDir, 'index.json');
if (existsSync(indexPath)) {
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  for (const d of index.datasets) d.screening = existsSync(join(gridsDir, d.path, 'screening.json'));
  writeFileSync(indexPath, JSON.stringify(index, null, 1));
}
