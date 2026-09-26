#!/usr/bin/env node
// Build map tiles of the gridfinder power-line network (Arderne et al. 2020,
// CC BY 4.0) for the "Power grid" map overlay, into public/data/gridlines/.
// Three levels of detail: simplified when zoomed out, full geometry when zoomed in.
//
//   npm run build-grid-lines -- --region africa
//   npm run build-grid-lines -- --countries "Kenya,Tanzania"
//   npm run build-grid-lines -- --bbox=-20,-36,55,38 --gridfinder path/to/grid.gpkg
//
// Uses the grid.gpkg that build-screening downloaded (cache/screening/gridfinder/),
// or --gridfinder <path>. --region/--countries use the land mask of --res (default 0.1)
// to find the area.

import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { ROOT, loadLandCells, selectCells, cellCenter, parseBbox } from './lib/grid.mjs';
import { readLines } from './lib/gpkg-lines.mjs';
import { simplify, clipPolyline } from './lib/lines.mjs';
import { encodeLines, lineTileId } from '../public/js/grid-lines-codec.js';

/**
 * Levels of detail. tol: simplification tolerance (degrees); quantum: coordinate
 * step stored (degrees); zoom range of the web map each level is drawn at.
 */
export const LINE_LEVELS = [
  { tileDeg: 10, tol: 0.01, quantum: 0.001, minZoom: 0, maxZoom: 6 },
  { tileDeg: 2, tol: 0.001, quantum: 0.0001, minZoom: 7, maxZoom: 9 },
  { tileDeg: 1, tol: 0, quantum: 0.00001, minZoom: 10, maxZoom: 99 },
];

const { values: args } = parseArgs({
  options: {
    gridfinder: { type: 'string' },
    res: { type: 'string', default: '0.1' },
    bbox: { type: 'string' },
    region: { type: 'string' },
    countries: { type: 'string' },
    out: { type: 'string' },
    margin: { type: 'string', default: '1' },
  },
});

const gpkgPath = args.gridfinder ?? join(ROOT, 'cache', 'screening', 'gridfinder', 'grid.gpkg');
if (!existsSync(gpkgPath)) {
  console.error(`${gpkgPath} not found. Run "npm run build-screening" first (it downloads grid.gpkg), or download it from https://zenodo.org/records/3628142 and pass --gridfinder <path>.`);
  process.exit(1);
}

// Area to build.
let box = { west: -180, south: -90, east: 180, north: 90 };
if (args.bbox) {
  const b = parseBbox(args.bbox);
  box = { west: b.lonMin, south: b.latMin, east: b.lonMax, north: b.latMax };
} else if (args.region || args.countries) {
  const res = Number(args.res);
  const land = loadLandCells(res);
  const cells = selectCells(land, { region: args.region, countries: args.countries });
  if (!cells.length) {
    console.error('No land cells in the selected area.');
    process.exit(1);
  }
  const m = Number(args.margin);
  box = { west: 180, south: 90, east: -180, north: -90 };
  for (const c of cells) {
    const { lat, lon } = cellCenter(c.idx, res, land.nx);
    box.west = Math.min(box.west, lon - m);
    box.east = Math.max(box.east, lon + m);
    box.south = Math.min(box.south, lat - m);
    box.north = Math.max(box.north, lat + m);
  }
}
console.log(`Area: lon ${box.west.toFixed(1)}…${box.east.toFixed(1)}, lat ${box.south.toFixed(1)}…${box.north.toFixed(1)}; reading ${gpkgPath}`);

const tiles = LINE_LEVELS.map(() => new Map()); // tileId -> [lines]
let features = 0, points = 0;
const t0 = Date.now();
readLines(gpkgPath, box, (pts) => {
  features++;
  points += pts.length / 2;
  const clipped = clipPolyline(pts, box.west, box.south, box.east, box.north);
  for (const part of clipped) {
    LINE_LEVELS.forEach((lv, li) => {
      const line = simplify(part, lv.tol);
      let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
      for (let i = 0; i < line.length; i += 2) {
        w = Math.min(w, line[i]);
        e = Math.max(e, line[i]);
        s = Math.min(s, line[i + 1]);
        n = Math.max(n, line[i + 1]);
      }
      const d = lv.tileDeg;
      for (let r = Math.floor(s / d); r <= Math.floor(n / d); r++) {
        for (let c = Math.floor(w / d); c <= Math.floor(e / d); c++) {
          const pieces = clipPolyline(line, c * d, r * d, (c + 1) * d, (r + 1) * d);
          if (!pieces.length) continue;
          const id = lineTileId(r, c);
          if (!tiles[li].has(id)) tiles[li].set(id, []);
          tiles[li].get(id).push(...pieces);
        }
      }
    });
  }
  if (features % 20000 === 0) process.stdout.write(`\r${features.toLocaleString('en-US')} lines read`);
});
process.stdout.write('\n');
console.log(`${features.toLocaleString('en-US')} lines, ${points.toLocaleString('en-US')} points in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

const outDir = args.out ?? join(ROOT, 'public', 'data', 'gridlines');
rmSync(outDir, { recursive: true, force: true });
const levels = LINE_LEVELS.map((lv, li) => {
  const dir = join(outDir, `L${li}`);
  mkdirSync(dir, { recursive: true });
  let bytes = 0;
  const ids = [...tiles[li].keys()].sort();
  for (const id of ids) {
    const [r, c] = id.split('_').map(Number);
    const buf = gzipSync(encodeLines(tiles[li].get(id), c * lv.tileDeg, r * lv.tileDeg, lv.quantum), { level: 9 });
    writeFileSync(join(dir, `${id}.bin.gz`), buf);
    bytes += buf.length;
  }
  console.log(`  level ${li} (zoom ${lv.minZoom}–${Math.min(lv.maxZoom, 19)}): ${ids.length} tiles, ${(bytes / 1e6).toFixed(1)} MB`);
  return { path: `L${li}/`, tileDeg: lv.tileDeg, quantum: lv.quantum, minZoom: lv.minZoom, maxZoom: lv.maxZoom, tiles: ids };
});
writeFileSync(
  join(outDir, 'index.json'),
  JSON.stringify({
    version: 1,
    name: 'gridfinder',
    description: 'Predicted medium-voltage power grid (gridfinder)',
    attribution: 'Power grid: <a href="https://gridfinder.org" target="_blank" rel="noopener">gridfinder</a> (Arderne et al. 2020, CC BY 4.0)',
    generated: new Date().toISOString(),
    bbox: box,
    levels,
  })
);
console.log(`Wrote ${outDir}`);
