// Power infrastructure from OpenStreetMap (ODbL) via the Overpass API, per country:
// power lines (power=line / minor_line / cable) with their voltage, substations
// and power plants. Cached per country as JSON.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OVERPASS_MIRRORS, overpassJson } from './overpass.mjs';
import { parseVoltage, voltageClass, plantSource, parseCapacityMW } from '../../public/js/power.js';

const CACHE_VERSION = 1;

export function powerQuery(iso2) {
  return `[out:json][timeout:300][maxsize:536870912];
area["ISO3166-1"="${iso2}"]["admin_level"="2"]->.a;
way["power"~"^(line|minor_line|cable)$"](area.a);
out geom;
(
  nwr["power"="substation"](area.a);
  nwr["power"="plant"](area.a);
);
out tags center;`;
}

const round = (x) => Math.round(x * 1e6) / 1e6;

/**
 * Convert an Overpass response to
 * { lines: [{ k: kind, v: kV, c: class, p: [lon, lat, ...] }],
 *   substations: [{ lon, lat, v, c, name }], plants: [{ lon, lat, s: source index, mw, name }] }.
 */
export function overpassToPower(json) {
  const lines = [], substations = [], plants = [];
  for (const el of json.elements ?? []) {
    const t = el.tags ?? {};
    if (el.type === 'way' && el.geometry && ['line', 'minor_line', 'cable'].includes(t.power)) {
      const p = [];
      for (const g of el.geometry) if (g) p.push(round(g.lon), round(g.lat));
      if (p.length < 4) continue;
      const v = parseVoltage(t.voltage);
      lines.push({ k: t.power, v, c: voltageClass(v, t.power), p });
      continue;
    }
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const name = t.name ?? t['name:en'] ?? t.operator ?? '';
    if (t.power === 'substation') {
      const v = parseVoltage(t.voltage);
      substations.push({ lon: round(lon), lat: round(lat), v, c: voltageClass(v, 'line'), name });
    } else if (t.power === 'plant') {
      plants.push({ lon: round(lon), lat: round(lat), s: plantSource(t['plant:source'] ?? t['generator:source']), mw: parseCapacityMW(t['plant:output:electricity']), name });
    }
  }
  return { lines, substations, plants };
}

/** Power infrastructure of a country, from the cache or from Overpass (see overpassJson for `endpoint`). */
export async function powerData(iso2, { cacheDir, endpoint = OVERPASS_MIRRORS, log = console.log, attempts = 8 } = {}) {
  mkdirSync(cacheDir, { recursive: true });
  const file = join(cacheDir, `${iso2}.json`);
  if (existsSync(file)) {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    if (d.version === CACHE_VERSION) return d;
  }
  const d = { version: CACHE_VERSION, iso: iso2, fetched: new Date().toISOString(), ...overpassToPower(await overpassJson(powerQuery(iso2), { endpoint, log, attempts, label: `${iso2} power` })) };
  writeFileSync(file, JSON.stringify(d));
  return d;
}

/**
 * Power data of several countries (ISO2 codes). Countries that fail are listed
 * in `failed`; the others are returned merged (substations and plants de-duplicated
 * across borders, since the area queries overlap there).
 */
export async function powerDataFor(isos, opts = {}) {
  const log = opts.log ?? console.log;
  const out = { lines: [], substations: [], plants: [], failed: [] };
  const seen = new Set();
  const lineSeen = new Set();
  for (const iso of isos) {
    const t0 = Date.now();
    try {
      const d = await powerData(iso, opts);
      for (const l of d.lines) {
        const key = `${l.p[0]},${l.p[1]},${l.p[l.p.length - 2]},${l.p[l.p.length - 1]},${l.p.length}`;
        if (lineSeen.has(key)) continue;
        lineSeen.add(key);
        out.lines.push(l);
      }
      for (const [list, target] of [[d.substations, out.substations], [d.plants, out.plants]]) {
        for (const x of list) {
          const key = `${target === out.plants ? 'p' : 's'}${x.lon},${x.lat}`;
          if (seen.has(key)) continue;
          seen.add(key);
          target.push(x);
        }
      }
      log(`  power ${iso}: ${d.lines.length} lines, ${d.substations.length} substations, ${d.plants.length} plants (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    } catch (e) {
      log(`  power ${iso}: FAILED (${e.message})`);
      out.failed.push(iso);
    }
  }
  return out;
}
