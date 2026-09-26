// Helpers for the regular lat/lon grid used by the land mask, the fetch and
// the build scripts.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { REGIONS } from './regions.mjs';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Land cells of a grid: [{idx, mask, country}], plus the mask metadata. */
export function loadLandCells(res) {
  const base = join(ROOT, 'data', `land-cells-${res}.json`);
  const path = [base, `${base}.gz`].find(existsSync);
  if (!path) {
    throw new Error(`Land mask for ${res}° not found. Create it with: npm install && npm run land-mask -- --res ${res} [--region africa]`);
  }
  const raw = readFileSync(path);
  const d = JSON.parse((path.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8'));
  const cells = [];
  for (let i = 0; i < d.cells.length; i += 3) cells.push({ idx: d.cells[i], mask: d.cells[i + 1], country: d.cells[i + 2] });
  return { ...d, cells };
}

/**
 * Filter land cells by bounding box, region ("africa") and/or country names
 * (comma-separated, Natural Earth spelling, case-insensitive).
 */
export function selectCells(land, { bbox, region, countries } = {}) {
  let ids = null;
  if (region) {
    const r = REGIONS[region.toLowerCase()];
    if (!r) throw new Error(`Unknown region "${region}" (supported: ${Object.keys(REGIONS).join(', ')})`);
    ids = new Set(r);
  }
  if (countries) {
    const byName = new Map(Object.entries(land.countries).map(([id, name]) => [name.toLowerCase(), Number(id)]));
    const wanted = new Set();
    for (const w of countries.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)) {
      const id = byName.get(w) ?? (land.countries[w] ? Number(w) : undefined);
      if (id === undefined) {
        const close = [...byName.keys()].filter((n) => n.includes(w.slice(0, 4))).slice(0, 5);
        throw new Error(`Country "${w}" is not in the ${land.resolution}° land mask.${close.length ? ` Did you mean: ${close.join(', ')}?` : ''}`);
      }
      wanted.add(id);
    }
    ids = ids ? new Set([...wanted].filter((x) => ids.has(x))) : wanted;
  }
  return land.cells.filter((c) => (!ids || ids.has(c.country)) && inBbox(cellCenter(c.idx, land.resolution, land.nx), bbox));
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

/**
 * Indices of all cells with a cached TMY file. Lists each row directory once,
 * which is far faster than checking every cell's file on slow (e.g. Windows
 * or cloud-synced) file systems.
 */
export function cachedCells(cacheDir) {
  const found = new Set();
  if (!existsSync(cacheDir)) return found;
  for (const row of readdirSync(cacheDir, { withFileTypes: true })) {
    if (!row.isDirectory()) continue;
    for (const f of readdirSync(join(cacheDir, row.name))) {
      if (f.endsWith('.tmy.gz')) found.add(Number(f.slice(0, -7)));
    }
  }
  return found;
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
