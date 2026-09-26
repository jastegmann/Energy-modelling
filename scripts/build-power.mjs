#!/usr/bin/env node
// Download power infrastructure from OpenStreetMap (ODbL) and build the map
// overlays: power lines coloured by voltage, substations and power plants,
// written to public/data/osm-power/.
//
//   npm run build-power -- --region africa
//   npm run build-power -- --countries "Kenya,Tanzania"
//
// Data is fetched per country via Overpass and cached in cache/screening/osm-power/
// (also used by build-screening for the distance-to-transmission layer). Countries
// that fail are reported; run the command again to retry them.

import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { ROOT, loadLandCells, selectCells, cellCenter, parseBbox } from './lib/grid.mjs';
import { ISO2 } from './lib/regions.mjs';
import { LineTiler, areaBox } from './lib/line-tiles.mjs';
import { OVERPASS_MIRRORS } from './lib/overpass.mjs';
import { powerDataFor } from './lib/osm-power.mjs';
import { VOLTAGE_CLASSES, PLANT_SOURCES, CLASS_UNKNOWN_MINOR } from '../public/js/power.js';

const LV = VOLTAGE_CLASSES.findIndex((c) => c.id === 'lv');

/**
 * Levels of detail. Line tiles store class * 2 + (1 for underground/submarine cables).
 * Zoomed out only the higher voltages are kept, so the overview stays light.
 */
export const POWER_LEVELS = [
  { tileDeg: 10, tol: 0.01, quantum: 0.001, minZoom: 0, maxZoom: 6, keep: (c) => (VOLTAGE_CLASSES[c >> 1].min ?? 0) >= 60 },
  { tileDeg: 2, tol: 0.001, quantum: 0.0001, minZoom: 7, maxZoom: 9, keep: (c) => c >> 1 !== LV && c >> 1 !== CLASS_UNKNOWN_MINOR },
  { tileDeg: 1, tol: 0, quantum: 0.00001, minZoom: 10, maxZoom: 99 },
];

const { values: args } = parseArgs({
  options: {
    res: { type: 'string', default: '0.1' },
    region: { type: 'string' },
    countries: { type: 'string' },
    overpass: { type: 'string' },
    cache: { type: 'string' },
    out: { type: 'string' },
  },
});
if (!args.region && !args.countries) {
  console.error('Choose an area: --region africa or --countries "Kenya,Tanzania".');
  process.exit(1);
}

const area = areaBox({ region: args.region, countries: args.countries, res: Number(args.res) }, { loadLandCells, selectCells, cellCenter, parseBbox });
const isos = [...new Set(area.cells.map((c) => ISO2[c.country]).filter(Boolean))].sort();
const missing = [...new Set(area.cells.map((c) => c.country))].filter((c) => !ISO2[c]);
if (missing.length) console.log(`No OpenStreetMap country code for ids ${missing.join(', ')}; skipped.`);
console.log(`${isos.length} countries: ${isos.join(' ')}`);

const cacheDir = join(args.cache ?? join(ROOT, 'cache', 'screening'), 'osm-power');
const endpoint = args.overpass ? args.overpass.split(',').map((u) => u.trim()).filter(Boolean) : OVERPASS_MIRRORS;
const data = await powerDataFor(isos, { cacheDir, endpoint });

// Lines.
const tiler = new LineTiler(POWER_LEVELS);
const km = new Float64Array(VOLTAGE_CLASSES.length);
for (const l of data.lines) {
  tiler.add(l.p, l.c * 2 + (l.k === 'cable' ? 1 : 0));
  for (let i = 0; i + 3 < l.p.length; i += 2) {
    const dx = (l.p[i + 2] - l.p[i]) * 111.32 * Math.cos((l.p[i + 1] * Math.PI) / 180), dy = (l.p[i + 3] - l.p[i + 1]) * 110.57;
    km[l.c] += Math.hypot(dx, dy);
  }
}
const outDir = args.out ?? join(ROOT, 'public', 'data', 'osm-power');
mkdirSync(outDir, { recursive: true });
console.log(`${data.lines.length.toLocaleString('en-US')} lines:`);
const levels = tiler.write(join(outDir, 'lines'));
for (const l of levels) l.path = `lines/${l.path}`;

// Substations and plants: one small file each.
const json = (x) => gzipSync(Buffer.from(JSON.stringify(x)), { level: 9 });
writeFileSync(join(outDir, 'substations.json.gz'), json(data.substations.map((s) => [s.lon, s.lat, s.c, s.v, s.name])));
writeFileSync(join(outDir, 'plants.json.gz'), json(data.plants.map((p) => [p.lon, p.lat, p.s, Math.round(p.mw * 100) / 100, p.name])));

const subCount = new Array(VOLTAGE_CLASSES.length).fill(0);
for (const s of data.substations) subCount[s.c]++;
const plantCount = new Array(PLANT_SOURCES.length).fill(0), plantMW = new Array(PLANT_SOURCES.length).fill(0);
for (const p of data.plants) (plantCount[p.s]++, (plantMW[p.s] += p.mw));
writeFileSync(
  join(outDir, 'index.json'),
  JSON.stringify({
    version: 1,
    generated: new Date().toISOString(),
    attribution: 'Power lines, substations, plants © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    countries: isos.filter((i) => !data.failed.includes(i)),
    failed: data.failed,
    classes: VOLTAGE_CLASSES.map((c, i) => ({ id: c.id, km: Math.round(km[i]), substations: subCount[i] })),
    sources: PLANT_SOURCES.map((s, i) => ({ id: s.id, plants: plantCount[i], mw: Math.round(plantMW[i]) })),
    lines: { levels },
    substations: { path: 'substations.json.gz', count: data.substations.length },
    plants: { path: 'plants.json.gz', count: data.plants.length },
  })
);
console.log(`${data.substations.length.toLocaleString('en-US')} substations, ${data.plants.length.toLocaleString('en-US')} power plants`);
console.log(`Wrote ${outDir}`);
if (data.failed.length) {
  console.log(`\nOpenStreetMap power data could not be downloaded for ${data.failed.join(', ')} (Overpass busy). The others are cached; run the same command again later to add these.`);
  process.exitCode = 1;
}
