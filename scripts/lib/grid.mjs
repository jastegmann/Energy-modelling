// Helpers for the regular lat/lon grid used by the land mask, the fetch and
// the build scripts.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function loadLandCells(res) {
  const path = join(ROOT, 'data', `land-cells-${res}.json`);
  if (!existsSync(path)) {
    throw new Error(`Land mask ${path} not found. Create it with: npm run land-mask -- --res ${res}`);
  }
  const d = JSON.parse(readFileSync(path, 'utf8'));
  const cells = [];
  for (let i = 0; i < d.cells.length; i += 2) cells.push({ idx: d.cells[i], mask: d.cells[i + 1] });
  return { ...d, cells };
}

export function cellCenter(idx, res, nx) {
  const row = Math.floor(idx / nx);
  const col = idx % nx;
  return { row, col, lat: 90 - (row + 0.5) * res, lon: -180 + (col + 0.5) * res };
}

/** Land sample points of a cell, nearest to the centre first. */
export function landSamples(cell, res, nx, S) {
  const { row, col } = cellCenter(cell.idx, res, nx);
  const pts = [];
  for (let a = 0; a < S; a++) {
    for (let b = 0; b < S; b++) {
      if (!(cell.mask & (1 << (a * S + b)))) continue;
      const lat = 90 - (row + (a + 0.5) / S) * res;
      const lon = -180 + (col + (b + 0.5) / S) * res;
      const d = (a - (S - 1) / 2) ** 2 + (b - (S - 1) / 2) ** 2;
      pts.push({ lat: +lat.toFixed(4), lon: +lon.toFixed(4), d });
    }
  }
  return pts.sort((p, q) => p.d - q.d);
}

export function cachePath(cacheDir, idx, nx) {
  return join(cacheDir, String(Math.floor(idx / nx)).padStart(3, '0'), `${idx}.tmy.gz`);
}

/** Parse "lonMin,latMin,lonMax,latMax". */
export function parseBbox(s) {
  if (!s) return null;
  const v = s.split(',').map(Number);
  if (v.length !== 4 || v.some((x) => !Number.isFinite(x))) throw new Error(`Bad --bbox "${s}"`);
  return { lonMin: v[0], latMin: v[1], lonMax: v[2], latMax: v[3] };
}

export function inBbox(p, b) {
  return !b || (p.lon >= b.lonMin && p.lon <= b.lonMax && p.lat >= b.latMin && p.lat <= b.latMax);
}
