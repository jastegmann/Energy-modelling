#!/usr/bin/env node
// Mock of the PVGIS TMY endpoint serving SYNTHETIC data, for offline tests and
// development. Mimics the response format, the "over the sea" error and
// (with --flaky) occasional rate-limit errors.
//
//   node scripts/dev/mock-pvgis.mjs [--port 8091] [--flaky 0.1]
//   node scripts/fetch-tmy.mjs --base http://localhost:8091/api/v5_3 --bbox 5,44,10,48

import http from 'node:http';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { syntheticPvgisTmy } from './synthetic-tmy.mjs';
import { loadLandCells } from '../lib/grid.mjs';

/** Radiation database and time-stamp offset (min) that the mock pretends to use. */
export function mockDatabase(lat, lon) {
  if (lon > -30 && lon < 70 && lat > -40 && lat < 65) return { db: 'PVGIS-SARAH3', offsetMin: 10 };
  if (lon <= -30 && lat > -25 && lat < 60) return { db: 'PVGIS-NSRDB', offsetMin: 0 };
  return { db: 'PVGIS-ERA5', offsetMin: 30 };
}

export function createMockPvgis({ flaky = 0 } = {}) {
  const land = loadLandCells(0.5);
  const masks = new Map(land.cells.map((c) => [c.idx, c.mask]));
  const S = land.subsamples;
  const isLand = (lat, lon) => {
    const y = ((90 - lat) / 0.5) * S;
    const x = ((lon + 180) / 0.5) * S;
    const row = Math.floor(y / S), col = Math.floor(x / S);
    const a = Math.min(S - 1, Math.floor(y - row * S)), b = Math.min(S - 1, Math.floor(x - col * S));
    const m = masks.get(row * land.nx + col);
    return m !== undefined && (m & (1 << (a * S + b))) !== 0;
  };
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, body) => {
      const buf = Buffer.from(JSON.stringify(body));
      const gz = /gzip/.test(req.headers['accept-encoding'] ?? '');
      res.writeHead(status, { 'content-type': 'application/json', ...(gz ? { 'content-encoding': 'gzip' } : {}) });
      res.end(gz ? gzipSync(buf) : buf);
    };
    if (!/\/tmy$/.test(url.pathname)) return send(404, { message: 'Not found', status: 404 });
    if (flaky && Math.random() < flaky) return send(429, { message: 'Too many requests', status: 429 });
    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return send(400, { message: 'Invalid coordinates', status: 400 });
    if (!isLand(lat, lon)) return send(400, { message: 'Location over the sea. Please, select another location', status: 400 });
    send(200, syntheticPvgisTmy(lat, lon, mockDatabase(lat, lon)));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { port: { type: 'string', default: '8091' }, flaky: { type: 'string', default: '0' } } });
  createMockPvgis({ flaky: Number(values.flaky) }).listen(Number(values.port), () =>
    console.log(`Mock PVGIS (SYNTHETIC data) on http://localhost:${values.port}/api/v5_3/tmy`)
  );
}
