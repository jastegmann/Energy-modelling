#!/usr/bin/env node
// SYNTHETIC stand-ins for the screening data sources, for tests and offline
// development (they are not real data):
//   GET  /worldcover/ESA_WorldCover_10m_2021_v200_<tile>_Map.tif   (3° GeoTIFF tiles)
//   GET  /dem/<name>/<name>.tif                                     (1° GeoTIFF tiles)
//   POST /overpass                                                  (protected-area circles)
// and makeGridGpkg() writes a GeoPackage with a regular "power line" lattice.
//
//   node scripts/dev/mock-screening-sources.mjs [--port 8092]
//   node scripts/build-screening.mjs --res 0.1 --countries Kenya \
//     --worldcover-base http://localhost:8092/worldcover --dem-base http://localhost:8092/dem \
//     --overpass http://localhost:8092/overpass --gridfinder cache/mock-grid.gpkg

import http from 'node:http';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { writeArrayBuffer } from 'geotiff';

/** Synthetic land-cover code at a point. */
export function mockLandCover(lat, lon) {
  const v = Math.sin(lon * 3.1) * Math.cos(lat * 2.7) + 0.5 * Math.sin((lat + lon) * 9);
  if (Math.hypot(((lat % 1) + 1) % 1 - 0.8, ((lon % 1) + 1) % 1 - 0.8) < 0.05) return 80; // small lakes
  if (Math.hypot(((lat % 1) + 1) % 1 - 0.2, ((lon % 1) + 1) % 1 - 0.7) < 0.03) return 50; // towns
  if (v > 0.9) return 10;
  if (v > 0.3) return 20;
  if (v > -0.3) return 30;
  if (v > -0.8) return 40;
  return 60;
}

/** Synthetic elevation (m): rolling plains with a few steep ridges. */
export function mockElevation(lat, lon) {
  const ridge = Math.max(0, 1 - Math.abs(((lon * 2) % 1 + 1) % 1 - 0.5) * 30); // ~0.03° wide steep ridges every 0.5°
  return 800 + 300 * Math.sin(lat * 2) * Math.cos(lon * 1.5) + 600 * ridge * (0.5 + 0.5 * Math.sin(lat * 3));
}

async function tiff(west, north, deg, ppd, fn, float) {
  const n = Math.round(deg * ppd);
  const data = float ? new Float32Array(n * n) : new Uint8Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) data[y * n + x] = fn(north - (y + 0.5) / ppd, west + (x + 0.5) / ppd);
  return Buffer.from(
    await writeArrayBuffer(data, {
      width: n,
      height: n,
      ModelPixelScale: [1 / ppd, 1 / ppd, 0],
      ModelTiepoint: [0, 0, 0, west, north, 0],
      GeographicTypeGeoKey: 4326,
      GTModelTypeGeoKey: 2,
      BitsPerSample: [float ? 32 : 8],
      SampleFormat: [float ? 3 : 1],
    })
  );
}

const parseTile = (s) => {
  const m = s.match(/([NS])(\d+)(?:_00)?_?([EW])(\d+)/);
  return m && { lat: (m[1] === 'S' ? -1 : 1) * Number(m[2]), lon: (m[3] === 'W' ? -1 : 1) * Number(m[4]) };
};

/** Protected-area circles on a 2° lattice, as an Overpass JSON response. */
export function mockOverpass() {
  const elements = [];
  let id = 1;
  for (let lat = -35; lat <= 37; lat += 2) {
    for (let lon = -17; lon <= 51; lon += 2) {
      const pts = Array.from({ length: 33 }, (_, i) => {
        const a = (i / 32) * 2 * Math.PI;
        return { lat: lat + 0.3 * Math.sin(a), lon: lon + 0.3 * Math.cos(a) };
      });
      // Split each ring into two ways to exercise multipolygon assembly.
      elements.push({
        type: 'relation',
        id: id++,
        tags: { boundary: 'protected_area', protect_class: '2', name: `Mock park ${id}` },
        members: [
          { type: 'way', role: 'outer', geometry: pts.slice(0, 17) },
          { type: 'way', role: 'outer', geometry: pts.slice(16).reverse() },
        ],
      });
    }
  }
  return { elements };
}

/** GeoPackage with power lines every 1.5° of latitude and 2° of longitude. */
export function makeGridGpkg(path, { west, south, east, north }) {
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE gpkg_geometry_columns (table_name TEXT, column_name TEXT, geometry_type_name TEXT, srs_id INTEGER, z INTEGER, m INTEGER);
    INSERT INTO gpkg_geometry_columns VALUES ('grid', 'geom', 'LINESTRING', 4326, 0, 0);
    CREATE TABLE grid (fid INTEGER PRIMARY KEY, geom BLOB);`);
  const ins = db.prepare('INSERT INTO grid (geom) VALUES (?)');
  const blob = (pts) => {
    const b = Buffer.alloc(8 + 9 + 16 * pts.length);
    b.write('GP', 0, 'ascii');
    b[2] = 0;
    b[3] = 1; // little endian, no envelope
    b.writeInt32LE(4326, 4);
    b[8] = 1;
    b.writeUInt32LE(2, 9);
    b.writeUInt32LE(pts.length, 13);
    pts.forEach(([x, y], i) => {
      b.writeDoubleLE(x, 17 + 16 * i);
      b.writeDoubleLE(y, 25 + 16 * i);
    });
    return b;
  };
  for (let lat = Math.ceil(south / 1.5) * 1.5; lat <= north; lat += 1.5) ins.run(blob([[west, lat], [east, lat]]));
  for (let lon = Math.ceil(west / 2) * 2; lon <= east; lon += 2) ins.run(blob([[lon, south], [lon, north]]));
  db.close();
}

export function createMockScreeningSources() {
  const cache = new Map();
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/overpass') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(mockOverpass()));
      }
      let buf = cache.get(url.pathname);
      if (!buf) {
        const t = parseTile(url.pathname.split('/').pop());
        if (!t) return res.writeHead(404).end();
        if (url.pathname.startsWith('/worldcover/')) buf = await tiff(t.lon, t.lat + 3, 3, 200, mockLandCover, false);
        else if (url.pathname.startsWith('/dem/')) buf = await tiff(t.lon, t.lat + 1, 1, 300, mockElevation, true);
        else return res.writeHead(404).end();
        cache.set(url.pathname, buf);
      }
      const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'content-length': buf.length, 'accept-ranges': 'bytes' });
        return res.end();
      }
      if (range) {
        const s = Number(range[1]);
        const e = range[2] ? Math.min(Number(range[2]), buf.length - 1) : buf.length - 1;
        res.writeHead(206, { 'content-range': `bytes ${s}-${e}/${buf.length}`, 'content-length': e - s + 1, 'accept-ranges': 'bytes' });
        return res.end(buf.subarray(s, e + 1));
      }
      res.writeHead(200, { 'content-length': buf.length });
      res.end(buf);
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { port: { type: 'string', default: '8092' }, gpkg: { type: 'string' } } });
  if (values.gpkg) makeGridGpkg(values.gpkg, { west: -20, south: -36, east: 55, north: 38 });
  createMockScreeningSources().listen(Number(values.port), () => console.log(`Mock screening sources (SYNTHETIC) on http://localhost:${values.port}`));
}
