#!/usr/bin/env node
// Build the list of land cells of a grid from Natural Earth 1:50m country
// polygons (npm package world-atlas). Each cell is sampled on an S×S sub-grid;
// a cell is "land" if any sample falls in a country. The sample bitmask is kept
// so that the fetch script can query PVGIS at a land point for coastal cells,
// and each cell gets the country covering most of its land samples.
//
//   node scripts/build-land-mask.mjs --res 0.5                   # whole world
//   node scripts/build-land-mask.mjs --res 0.1 --region africa
//   node scripts/build-land-mask.mjs --res 0.05 --countries "Kenya,Tanzania"
//
// Output: data/land-cells-<res>.json (world, res >= 0.5) or
//         data/land-cells-<res>.json.gz (finer grids / regions)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { feature } from 'topojson-client';
import { AFRICA, UNNAMED_IDS } from './lib/regions.mjs';

const { values: args } = parseArgs({
  options: {
    res: { type: 'string', default: '0.5' },
    samples: { type: 'string', default: '5' },
    'lat-min': { type: 'string', default: '-60' },
    'lat-max': { type: 'string', default: '84' },
    region: { type: 'string' },
    countries: { type: 'string' },
    out: { type: 'string' },
  },
});

const res = Number(args.res);
const S = Number(args.samples);
const latMin = Number(args['lat-min']);
const latMax = Number(args['lat-max']);
const nx = Math.round(360 / res);
const ny = Math.round(180 / res);

const require = createRequire(import.meta.url);
const topo = JSON.parse(readFileSync(require.resolve('world-atlas/countries-50m.json'), 'utf8'));
const features = feature(topo, topo.objects.countries).features.map((f) => ({
  id: f.id ? Number(f.id) : UNNAMED_IDS[f.properties.name] ?? 999,
  name: f.properties.name,
  geometry: f.geometry,
}));

// Optional restriction to a region or a list of countries.
let keep = null;
if (args.region) {
  if (args.region.toLowerCase() !== 'africa') throw new Error(`Unknown region "${args.region}" (supported: africa)`);
  keep = new Set(AFRICA);
}
if (args.countries) {
  const wanted = args.countries.split(',').map((s) => s.trim().toLowerCase());
  keep ??= new Set();
  for (const w of wanted) {
    const f = features.find((x) => x.name.toLowerCase() === w || String(x.id) === w);
    if (!f) throw new Error(`Unknown country "${w}". Names follow Natural Earth, e.g. "Dem. Rep. Congo", "S. Sudan", "Côte d'Ivoire".`);
    keep.add(f.id);
  }
}
const used = keep ? features.filter((f) => keep.has(f.id)) : features;

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
for (const f of used) {
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
    polygons.push({ edges, latLo, latHi, country: f.id });
  }
}
const regionLo = Math.max(latMin, Math.min(...polygons.map((p) => p.latLo)) - res);
const regionHi = Math.min(latMax, Math.max(...polygons.map((p) => p.latHi)) + res);

// Scan-line rasterisation (even-odd rule per polygon) on the sample grid,
// one cell row (S sample rows) at a time.
const sx = nx * S;
const sampleCountry = new Uint16Array(sx * S); // S sample rows of the current cell row
const out = []; // flat [idx, mask, country, ...]
const t0 = Date.now();
for (let cellRow = 0; cellRow < ny; cellRow++) {
  const cellLat = 90 - (cellRow + 0.5) * res;
  if (cellLat < regionLo || cellLat > regionHi) continue;
  sampleCountry.fill(0);
  for (let a = 0; a < S; a++) {
    const lat = 90 - (cellRow + (a + 0.5) / S) * res;
    for (const poly of polygons) {
      if (lat < poly.latLo || lat > poly.latHi) continue;
      const xs = [];
      for (const [la1, lo1, la2, lo2] of poly.edges) {
        if ((la1 <= lat && la2 > lat) || (la2 <= lat && la1 > lat)) {
          xs.push(lo1 + ((lat - la1) / (la2 - la1)) * (lo2 - lo1));
        }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.ceil(((xs[k] + 180) / res) * S - 0.5);
        const c1 = Math.floor(((xs[k + 1] + 180) / res) * S - 0.5);
        for (let c = c0; c <= c1; c++) sampleCountry[a * sx + (((c % sx) + sx) % sx)] = poly.country;
      }
    }
  }
  for (let col = 0; col < nx; col++) {
    let mask = 0;
    for (let a = 0; a < S; a++) {
      for (let b = 0; b < S; b++) if (sampleCountry[a * sx + col * S + b]) mask |= 1 << (a * S + b);
    }
    if (!mask) continue;
    // Country covering most of the cell's land samples.
    const counts = new Map();
    for (let a = 0; a < S; a++) {
      for (let b = 0; b < S; b++) {
        const c = sampleCountry[a * sx + col * S + b];
        if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
      }
    }
    let country = 0, best = 0;
    for (const [c, n] of counts) if (n > best) (best = n), (country = c);
    out.push(cellRow * nx + col, mask, country);
  }
}

const countries = {};
for (let i = 2; i < out.length; i += 3) countries[out[i]] ??= features.find((f) => f.id === out[i]).name;
const region = args.countries ? `countries: ${args.countries}` : args.region ? args.region.toLowerCase() : 'world';
const json = JSON.stringify({
  resolution: res,
  nx,
  ny,
  subsamples: S,
  latMin,
  latMax,
  region,
  source: 'Natural Earth 1:50m admin-0 countries (world-atlas), public domain',
  note: 'cells = flat [index, sampleBitmask, countryId, ...]; index = row*nx+col, row 0 at 90°N, col 0 at 180°W; bit = a*S+b (a from north, b from west); countryId = ISO 3166-1 numeric (9xx for unnamed Natural Earth units)',
  countries,
  count: out.length / 3,
  cells: out,
});
mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
const gz = res < 0.5 || region !== 'world';
const path = args.out ?? new URL(`../data/land-cells-${res}.json${gz ? '.gz' : ''}`, import.meta.url).pathname;
writeFileSync(path, gz ? gzipSync(json, { level: 9 }) : json);
console.log(`${out.length / 3} land cells in ${Object.keys(countries).length} countries at ${res}° (${region}) in ${((Date.now() - t0) / 1000).toFixed(1)} s -> ${path}`);
