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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadLandCells, selectCells, cellCenter, parseBbox } from './lib/grid.mjs';
import { readLines } from './lib/gpkg-lines.mjs';
import { clipPolyline } from './lib/lines.mjs';
import { LineTiler, areaBox } from './lib/line-tiles.mjs';

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
const { west, south, east, north } = areaBox(
  { bbox: args.bbox, region: args.region, countries: args.countries, res: Number(args.res), margin: Number(args.margin) },
  { loadLandCells, selectCells, cellCenter, parseBbox }
);
const box = { west, south, east, north };
console.log(`Area: lon ${west.toFixed(1)}…${east.toFixed(1)}, lat ${south.toFixed(1)}…${north.toFixed(1)}; reading ${gpkgPath}`);

const tiler = new LineTiler(LINE_LEVELS);
let features = 0, points = 0;
const t0 = Date.now();
readLines(gpkgPath, box, (pts) => {
  features++;
  points += pts.length / 2;
  for (const part of clipPolyline(pts, west, south, east, north)) tiler.add(part);
  if (features % 20000 === 0) process.stdout.write(`\r${features.toLocaleString('en-US')} lines read`);
});
process.stdout.write('\n');
console.log(`${features.toLocaleString('en-US')} lines, ${points.toLocaleString('en-US')} points in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

const outDir = args.out ?? join(ROOT, 'public', 'data', 'gridlines');
mkdirSync(outDir, { recursive: true });
const levels = tiler.write(outDir);
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
