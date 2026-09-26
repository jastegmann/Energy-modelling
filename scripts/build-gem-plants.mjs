#!/usr/bin/env node
// Power plants from Global Energy Monitor trackers (CC BY 4.0) for the map
// overlay "Power plants (GEM)", written to public/data/gem-plants/.
//
//   npm run build-gem-plants                                  # every .xlsx in cache/screening/Powerplants/
//   npm run build-gem-plants -- --file "path/to/Global_Integrated_Power_September_2026.xlsx"
//   npm run build-gem-plants -- --region all                  # every region (default: Africa)
//
// The data sheet and its columns are found by their headers, so the Global
// Integrated Power Tracker and the single-technology trackers can be combined;
// units in several files are counted once (GEM unit/phase ID). Units at the same
// site are merged into one plant per technology and status.

import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { ROOT } from './lib/grid.mjs';
import { GEM_TECHS, GEM_STATUSES, gemStatus, gemTech } from '../public/js/gem-plants.js';

const { values: args } = parseArgs({
  options: {
    file: { type: 'string', multiple: true },
    dir: { type: 'string' },
    region: { type: 'string', default: 'Africa' },
    out: { type: 'string' },
  },
});

let ExcelJS;
try {
  ExcelJS = createRequire(import.meta.url)('exceljs');
} catch (e) {
  console.error(`Reading Excel files needs the "exceljs" package: run "npm install" first.\n(${e.message})`);
  process.exit(1);
}

const dir = args.dir ?? join(ROOT, 'cache', 'screening', 'Powerplants');
const files = args.file?.length ? args.file : existsSync(dir) ? readdirSync(dir).filter((f) => /\.xlsx$/i.test(f) && !f.startsWith('~$')).map((f) => join(dir, f)) : [];
if (!files.length) {
  console.error(`No .xlsx files found in ${dir}. Put the GEM tracker files there or pass --file <path>.`);
  process.exit(1);
}

// Column names differ a little between trackers; each field lists the accepted names (lower case).
const COLUMNS = {
  type: ['type'],
  country: ['country/area', 'country', 'country/area 1 (hydropower only)'],
  region: ['region'],
  plant: ['plant / project name', 'plant name', 'project name', 'plant/project name'],
  unit: ['unit / phase name', 'unit name', 'phase name', 'unit/phase name'],
  mw: ['capacity (mw)', 'capacity mw', 'capacity'],
  status: ['status'],
  start: ['start year'],
  technology: ['technology', 'combustion technology', 'turbine/engine technology'],
  fuel: ['fuel (combustion only)', 'fuel'],
  lat: ['latitude'],
  lon: ['longitude'],
  accuracy: ['location accuracy'],
  owner: ['owner(s)', 'owner', 'parent(s)', 'parent'],
  location: ['gem location id'],
  unitId: ['gem unit/phase id', 'gem unit id', 'gem phase id'],
  url: ['gem.wiki url', 'wiki url', 'gem wiki page (eng)', 'wiki url (eng)'],
};
const TECH_WORDS = ['solar', 'wind', 'hydro', 'coal', 'nuclear', 'bioenergy', 'geothermal', 'oil', 'gas'];

const text = (v) => {
  if (v == null) return '';
  if (typeof v === 'object') return v.richText ? v.richText.map((r) => r.text).join('') : v.text ?? v.result ?? (v instanceof Date ? v.toISOString() : '');
  return String(v).trim();
};
const num = (v) => {
  const x = typeof v === 'number' ? v : parseFloat(text(v).replace(/,/g, ''));
  return Number.isFinite(x) ? x : NaN;
};
const clean = (s) => (s === '--' ? '' : s);

const units = new Map(); // unit id -> unit
let skipped = { region: 0, coords: 0, tech: 0, status: 0, dup: 0 };
const wantRegion = args.region.toLowerCase();
for (const file of files) {
  const hint = TECH_WORDS.find((w) => basename(file).toLowerCase().includes(w)) ?? '';
  console.log(`Reading ${basename(file)} ...`);
  const t0 = Date.now();
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(file, { sharedStrings: 'cache', hyperlinks: 'ignore', styles: 'ignore', worksheets: 'emit' });
  let used = 0;
  for await (const ws of reader) {
    let col = null;
    for await (const row of ws) {
      const vals = row.values; // 1-based
      if (!col) {
        const names = vals.map((v) => text(v).toLowerCase());
        const find = (list) => list.map((n) => names.indexOf(n)).find((i) => i > 0) ?? -1;
        const c = Object.fromEntries(Object.entries(COLUMNS).map(([k, list]) => [k, find(list)]));
        if (c.lat > 0 && c.lon > 0 && c.mw > 0 && c.status > 0) col = c;
        if (row.number > 20 && !col) break; // not a data sheet
        continue;
      }
      const get = (k) => (col[k] > 0 ? vals[col[k]] : undefined);
      if (wantRegion !== 'all' && col.region > 0 && text(get('region')).toLowerCase() !== wantRegion) {
        skipped.region++;
        continue;
      }
      const lat = num(get('lat')), lon = num(get('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        skipped.coords++;
        continue;
      }
      const tech = gemTech(text(get('type')), text(get('technology')), text(get('fuel')), hint);
      const status = gemStatus(text(get('status')));
      if (tech < 0) (skipped.tech++, 0);
      if (status < 0) (skipped.status++, 0);
      if (tech < 0 || status < 0) continue;
      const plant = clean(text(get('plant')));
      const unitName = clean(text(get('unit')));
      const id = text(get('unitId')) || `${plant}|${unitName}|${lat}|${lon}|${tech}`;
      if (units.has(id)) {
        skipped.dup++;
        continue;
      }
      const start = num(get('start'));
      units.set(id, {
        location: text(get('location')) || `${lat.toFixed(4)},${lon.toFixed(4)}`,
        lat,
        lon,
        tech,
        status,
        mw: num(get('mw')),
        plant,
        unit: unitName,
        country: text(get('country')),
        start: Number.isFinite(start) ? Math.round(start) : null,
        exact: text(get('accuracy')).toLowerCase() !== 'approximate',
        owner: text(get('owner')),
        url: text(get('url')),
      });
      used++;
    }
  }
  console.log(`  ${used.toLocaleString('en-US')} units (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
console.log(
  `${units.size.toLocaleString('en-US')} units in ${args.region}; skipped: ${skipped.region} other regions, ${skipped.coords} without coordinates, ` +
    `${skipped.tech} unknown technology, ${skipped.status} unknown status, ${skipped.dup} duplicates`
);

// One plant per site, technology and status.
const plants = new Map();
for (const u of units.values()) {
  const key = `${u.location}|${u.tech}|${u.status}`;
  let p = plants.get(key);
  if (!p) {
    p = { lat: u.lat, lon: u.lon, tech: u.tech, status: u.status, mw: 0, names: new Set(), country: u.country, start: null, exact: u.exact, owners: new Set(), url: u.url, units: [] };
    plants.set(key, p);
  }
  if (Number.isFinite(u.mw)) p.mw += u.mw;
  if (u.plant) p.names.add(u.plant);
  if (u.owner) p.owners.add(u.owner);
  if (u.start && (!p.start || u.start < p.start)) p.start = u.start;
  p.exact &&= u.exact;
  p.url ||= u.url;
  p.units.push([u.unit, Number.isFinite(u.mw) ? Math.round(u.mw * 10) / 10 : null, u.start]);
}

// Items: [lon, lat, tech, status, MW, name, country, first start year, exact location (1/0), owner, wiki URL, units [[name, MW, start]]].
const r5 = (x) => Math.round(x * 1e5) / 1e5;
const items = [...plants.values()]
  .sort((a, b) => b.mw - a.mw)
  .map((p) => [
    r5(p.lon), r5(p.lat), p.tech, p.status, Math.round(p.mw * 10) / 10, [...p.names].join(' / '), p.country, p.start, p.exact ? 1 : 0,
    [...p.owners].join('; ').slice(0, 200), p.url, p.units.length > 1 ? p.units : [],
  ]);

const outDir = args.out ?? join(ROOT, 'public', 'data', 'gem-plants');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'plants.json.gz'), gzipSync(Buffer.from(JSON.stringify(items)), { level: 9 }));
const stat = (key, n) => {
  const count = new Array(n).fill(0), mw = new Array(n).fill(0);
  for (const p of plants.values()) (count[p[key]]++, (mw[p[key]] += p.mw || 0));
  return { count, mw: mw.map(Math.round) };
};
const techs = stat('tech', GEM_TECHS.length), statuses = stat('status', GEM_STATUSES.length);
writeFileSync(
  join(outDir, 'index.json'),
  JSON.stringify({
    version: 1,
    generated: new Date().toISOString(),
    region: args.region,
    files: files.map((f) => basename(f)),
    attribution: 'Power plants: <a href="https://globalenergymonitor.org/" target="_blank" rel="noopener">Global Energy Monitor</a> trackers (CC BY 4.0)',
    plants: { path: 'plants.json.gz', count: items.length, units: units.size },
    techs: GEM_TECHS.map((t, i) => ({ id: t.id, plants: techs.count[i], mw: techs.mw[i] })),
    statuses: GEM_STATUSES.map((s, i) => ({ id: s.id, plants: statuses.count[i], mw: statuses.mw[i] })),
  })
);
console.log(`${items.length.toLocaleString('en-US')} plants:`);
for (const [i, t] of GEM_TECHS.entries()) if (techs.count[i]) console.log(`  ${t.label.padEnd(20)} ${String(techs.count[i]).padStart(5)} plants ${String(techs.mw[i].toLocaleString('en-US')).padStart(9)} MW`);
console.log(`Wrote ${outDir}`);
