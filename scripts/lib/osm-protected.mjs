// Protected areas from OpenStreetMap (ODbL) via the Overpass API, per country.
// Kept: boundary=protected_area (nature protection classes, i.e. protect_class
// 1–19 and 97–99, or no class), boundary=national_park and leisure=nature_reserve.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const OVERPASS = 'https://overpass-api.de/api/interpreter';

export function protectedQuery(iso2) {
  return `[out:json][timeout:900][maxsize:2000000000];
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

/** Protected areas of a country, from the cache or from Overpass. */
export async function protectedAreas(iso2, { cacheDir, endpoint = OVERPASS, log = console.log } = {}) {
  mkdirSync(cacheDir, { recursive: true });
  const file = join(cacheDir, `${iso2}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'solar-yield-map (screening layers)' },
        body: `data=${encodeURIComponent(protectedQuery(iso2))}`,
      });
      if ((r.status === 429 || r.status >= 500) && attempt < 5) {
        log(`  Overpass busy (HTTP ${r.status}) for ${iso2}, retrying in ${30 * (attempt + 1)} s`);
        await new Promise((res) => setTimeout(res, 30000 * (attempt + 1)));
        continue;
      }
      if (!r.ok) throw new Error(`Overpass HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const areas = overpassToAreas(await r.json());
      writeFileSync(file, JSON.stringify(areas));
      return areas;
    } catch (e) {
      if (attempt >= 5) throw e;
      log(`  Overpass error for ${iso2} (${e.message}), retrying`);
      await new Promise((res) => setTimeout(res, 30000 * (attempt + 1)));
    }
  }
}
