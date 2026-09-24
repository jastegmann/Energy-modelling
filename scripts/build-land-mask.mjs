#!/usr/bin/env node
// Build the list of land cells of the global grid from Natural Earth land polygons
// (npm package world-atlas). Each cell is sampled on an S×S sub-grid; a cell is
// "land" if any sample is on land. The sample bitmask is kept so that the fetch
// script can query PVGIS at a land point for coastal cells.
//
//   node scripts/build-land-mask.mjs [--res 0.5] [--samples 5] [--lat-min -60] [--lat-max 84] [--scale 50m]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { feature } from 'topojson-client';

const { values: args } = parseArgs({
  options: {
    res: { type: 'string', default: '0.5' },
    samples: { type: 'string', default: '5' },
    'lat-min': { type: 'string', default: '-60' },
    'lat-max': { type: 'string', default: '84' },
    scale: { type: 'string', default: '50m' },
    out: { type: 'string' },
  },
});

const res = Number(args.res);
const S = Number(args.samples);
const latMin = Number(args['lat-min']);
const latMax = Number(args['lat-max']);
const nx = Math.round(360 / res);
const ny = Math.round(180 / res);
const out = args.out ?? new URL(`../data/land-cells-${res}.json`, import.meta.url).pathname;

const require = createRequire(import.meta.url);
const topo = JSON.parse(readFileSync(require.resolve(`world-atlas/land-${args.scale}.json`), 'utf8'));
const land = feature(topo, topo.objects.land);

// Collect polygon edges. Rings crossing the antimeridian are "unwrapped" so
// that their longitudes are continuous (they may then extend beyond ±180°);
// holes are shifted into the frame of their outer ring.
const unwrap = (ring, ref) => {
  const outRing = [];
  let prev = null;
  for (const [lon, lat] of ring) {
    let x = lon;
    if (prev !== null) {
      while (x - prev > 180) x -= 360;
      while (x - prev < -180) x += 360;
    } else if (ref !== undefined) {
      while (x - ref > 180) x -= 360;
      while (x - ref < -180) x += 360;
    }
    outRing.push([x, lat]);
    prev = x;
  }
  const first = outRing[0][0];
  const last = outRing[outRing.length - 1][0];
  if (Math.abs(last - first) > 180) {
    // The ring encircles a pole (Antarctica): close it along the pole.
    const pole = outRing.reduce((s, p) => s + p[1], 0) < 0 ? -90 : 90;
    outRing.push([last, pole], [first, pole], outRing[0]);
  }
  return outRing;
};
const polygons = [];
for (const f of land.features) {
  const g = f.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for (const poly of polys) {
    const edges = []; // [lat1, lon1, lat2, lon2]
    let latLo = Infinity, latHi = -Infinity, ref;
    for (const ring of poly) {
      const u = unwrap(ring, ref);
      if (ref === undefined) ref = u[0][0];
      for (let i = 0; i < u.length - 1; i++) {
        const [lon1, lat1] = u[i];
        const [lon2, lat2] = u[i + 1];
        latLo = Math.min(latLo, lat1);
        latHi = Math.max(latHi, lat1);
        if (lat1 !== lat2) edges.push([lat1, lon1, lat2, lon2]);
      }
    }
    polygons.push({ edges, latLo, latHi });
  }
}

// Scan-line rasterisation (even-odd rule per polygon) on the sample grid.
const sx = nx * S;
const syRows = ny * S;
const rowMask = new Uint8Array(sx);
const cellMasks = new Map(); // idx -> bitmask
const t0 = Date.now();
for (let r = 0; r < syRows; r++) {
  const lat = 90 - ((r + 0.5) / S) * res;
  const cellRow = Math.floor(r / S);
  const cellLat = 90 - (cellRow + 0.5) * res;
  if (cellLat < latMin || cellLat > latMax) continue;
  rowMask.fill(0);
  for (const poly of polygons) {
    if (lat < poly.latLo || lat > poly.latHi) continue;
    const xs = [];
    for (const [la1, lo1, la2, lo2] of poly.edges) {
      if ((la1 <= lat && la2 > lat) || (la2 <= lat && la1 > lat)) {
        xs.push(lo1 + ((lat - la1) / (la2 - la1)) * (lo2 - lo1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.ceil(((xs[k] + 180) / res) * S - 0.5);
      const c1 = Math.floor(((xs[k + 1] + 180) / res) * S - 0.5);
      for (let c = c0; c <= c1; c++) rowMask[((c % sx) + sx) % sx] = 1;
    }
  }
  const a = r % S;
  for (let c = 0; c < sx; c++) {
    if (!rowMask[c]) continue;
    const idx = cellRow * nx + Math.floor(c / S);
    const bit = a * S + (c % S);
    cellMasks.set(idx, (cellMasks.get(idx) ?? 0) | (1 << bit));
  }
}

const cells = [...cellMasks.entries()].sort((a, b) => a[0] - b[0]);
mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
writeFileSync(
  out,
  JSON.stringify({
    resolution: res,
    nx,
    ny,
    subsamples: S,
    latMin,
    latMax,
    source: `Natural Earth 1:${args.scale} land polygons (world-atlas), public domain`,
    note: 'cells = flat [index, sampleBitmask, ...]; index = row*nx+col, row 0 at 90°N, col 0 at 180°W; bit = a*S+b (a from north, b from west)',
    count: cells.length,
    cells: cells.flat(),
  })
);
console.log(`${cells.length} land cells at ${res}° (lat ${latMin}..${latMax}) in ${((Date.now() - t0) / 1000).toFixed(1)} s -> ${out}`);
