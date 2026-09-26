// Protected areas from OpenStreetMap (ODbL) via the Overpass API, per country.
// Kept: boundary=protected_area (nature protection classes, i.e. protect_class
// 1–19 and 97–99, or no class), boundary=national_park and leisure=nature_reserve.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const OVERPASS = 'https://overpass-api.de/api/interpreter';
/** Public Overpass instances, tried in turn when one is busy. */
export const OVERPASS_MIRRORS = [OVERPASS, 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

export function protectedQuery(iso2) {
  return `[out:json][timeout:300][maxsize:536870912];
area["ISO3166-1"="${iso2}"]["admin_level"="2"]->.a;
(
  way["boundary"="protected_area"](area.a);
  relation["boundary"="protected_area"](area.a);
  way["boundary"="national_park"](area.a);
  relation["boundary"="national_park"](area.a);
  way["leisure"="nature_reserve"](area.a);
  relation["leisure"="nature_reserve"](area.a);
);
out geom;`;
}

function keep(tags = {}) {
  if (tags.boundary !== 'protected_area') return true;
  const c = Number(tags.protect_class);
  return !tags.protect_class || (c >= 1 && c <= 19) || (c >= 97 && c <= 99);
}

const key = (p) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;

/** Join way geometries (arrays of [lon, lat]) into closed rings. */
export function assembleRings(ways) {
  const rings = [];
  const open = [];
  for (const w of ways) {
    if (w.length < 2) continue;
    if (key(w[0]) === key(w[w.length - 1])) rings.push(w);
    else open.push(w.slice());
  }
  while (open.length) {
    let ring = open.pop();
    let grown = true;
    while (grown && key(ring[0]) !== key(ring[ring.length - 1])) {
      grown = false;
      const end = key(ring[ring.length - 1]);
      const start = key(ring[0]);
      for (let i = 0; i < open.length; i++) {
        const w = open[i];
        if (key(w[0]) === end) ring = ring.concat(w.slice(1));
        else if (key(w[w.length - 1]) === end) ring = ring.concat(w.slice(0, -1).reverse());
        else if (key(w[w.length - 1]) === start) ring = w.slice(0, -1).concat(ring);
        else if (key(w[0]) === start) ring = w.slice(1).reverse().concat(ring);
        else continue;
        open.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (ring.length >= 4) rings.push(ring); // unclosed rings are closed implicitly by the rasteriser
  }
  return rings;
}

/** Convert an Overpass JSON response to a list of areas, each a list of rings. */
export function overpassToAreas(json) {
  const areas = [];
  for (const el of json.elements ?? []) {
    if (!keep(el.tags)) continue;
    if (el.type === 'way' && el.geometry) {
      const ring = el.geometry.map((p) => [p.lon, p.lat]);
      if (ring.length >= 4) areas.push({ id: `w${el.id}`, name: el.tags?.name ?? '', rings: [ring] });
    } else if (el.type === 'relation' && el.members) {
      const ways = el.members.filter((m) => m.type === 'way' && m.geometry && (m.role === 'outer' || m.role === 'inner' || m.role === '')).map((m) => m.geometry.map((p) => [p.lon, p.lat]));
      const rings = assembleRings(ways);
      if (rings.length) areas.push({ id: `r${el.id}`, name: el.tags?.name ?? '', rings });
    }
  }
  return areas;
}

/**
 * Protected areas of a country, from the cache or from Overpass. `endpoint` is
 * one URL or a list; on a busy server or an error the next one is tried.
 * Modest timeout/maxsize values get a slot sooner on busy public servers.
 */
export async function protectedAreas(iso2, { cacheDir, endpoint = OVERPASS_MIRRORS, log = console.log, attempts = 8 } = {}) {
  mkdirSync(cacheDir, { recursive: true });
  const file = join(cacheDir, `${iso2}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const endpoints = [endpoint].flat();
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const url = endpoints[attempt % endpoints.length];
    const host = new URL(url).host;
    // Move on to the next server quickly; back off once every server has been tried.
    const last = attempt === attempts - 1;
    const wait = last ? 0 : (attempt + 1) % endpoints.length ? 5 : Math.min(120, 30 * 2 ** Math.floor(attempt / endpoints.length));
    const next = last ? 'giving up' : `next try in ${wait} s`;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'solar-yield-map (screening layers)' },
        body: `data=${encodeURIComponent(protectedQuery(iso2))}`,
        signal: AbortSignal.timeout(420000),
      });
      if (r.ok) {
        const json = await r.json();
        // Overpass reports a query timeout or memory limit as a remark with HTTP 200.
        if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark)) throw new Error(json.remark.slice(0, 200));
        const areas = overpassToAreas(json);
        writeFileSync(file, JSON.stringify(areas));
        return areas;
      }
      lastError = new Error(`HTTP ${r.status}: ${(await r.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)}`);
      if (!(r.status === 429 || r.status >= 500)) throw lastError;
      log(`  Overpass ${host} busy (HTTP ${r.status}) for ${iso2}; ${next}`);
    } catch (e) {
      if (e === lastError) throw e;
      lastError = e;
      log(`  Overpass ${host} error for ${iso2} (${e.message}); ${next}`);
    }
    if (wait) await new Promise((res) => setTimeout(res, wait * 1000));
  }
  throw lastError;
}
