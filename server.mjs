#!/usr/bin/env node
// Local web server: serves the site from public/ and relays single-location
// TMY requests to PVGIS (the PVGIS API cannot be called from a browser).
//
//   npm start                     -> http://localhost:8080
//   PORT=3000 HOST=0.0.0.0 npm start
//   PVGIS_BASE=http://localhost:8091/api/v5_3 npm start   (mock server for development)
//
// Behind an HTTP proxy, run with NODE_USE_ENV_PROXY=1 (Node >= 22.21 / 24).

import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize, extname, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { PVGIS_BASE, tmyUrl, parsePvgisTmy, pvgisErrorMessage, tmyToJSON } from './public/js/pvgis.js';
import { readTmyFile, writeTmyFile } from './scripts/lib/tmy-store.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const CACHE = process.env.POINT_CACHE ?? join(ROOT, 'cache', 'points');
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '127.0.0.1';
const BASE = (process.env.PVGIS_BASE ?? PVGIS_BASE).replace(/\/$/, '');
const MAX_IN_FLIGHT = 4;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.gz': 'application/octet-stream', // decompressed by the page itself
  '.md': 'text/markdown; charset=utf-8',
};

function sendJson(req, res, status, body) {
  let buf = Buffer.from(JSON.stringify(body));
  const headers = { 'content-type': MIME['.json'], 'cache-control': 'no-store' };
  if (buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
    buf = gzipSync(buf);
    headers['content-encoding'] = 'gzip';
  }
  res.writeHead(status, headers);
  res.end(buf);
}

// --- PVGIS relay -----------------------------------------------------------
let inFlight = 0;
const queue = [];
const pending = new Map();
const acquire = () => (inFlight < MAX_IN_FLIGHT ? (inFlight++, Promise.resolve()) : new Promise((r) => queue.push(r)));
const release = () => (queue.length ? queue.shift()() : inFlight--);

async function fetchTmy(lat, lon) {
  const key = `${lat.toFixed(3)}_${lon.toFixed(3)}`;
  const file = join(CACHE, `${key}.tmy.gz`);
  if (existsSync(file)) return { ...readTmyFile(file), cached: true };
  if (pending.has(key)) return pending.get(key);
  const p = (async () => {
    await acquire();
    try {
      const url = tmyUrl(lat, lon, { base: BASE });
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 120000);
      let r, text;
      try {
        r = await fetch(url, { signal: ctrl.signal });
        text = await r.text();
      } catch (e) {
        const err = new Error(`Could not reach PVGIS (${e.cause?.code ?? e.name}). Check your internet connection or proxy settings.`);
        err.status = 502;
        throw err;
      } finally {
        clearTimeout(timer);
      }
      if (!r.ok) {
        const err = new Error(pvgisErrorMessage(text));
        err.status = r.status === 429 ? 429 : r.status >= 500 ? 502 : 400;
        throw err;
      }
      const json = JSON.parse(text);
      const tmy = parsePvgisTmy(json);
      const header = { source: BASE, synthetic: BASE !== PVGIS_BASE || json?.meta?.synthetic === true, fetched: new Date().toISOString() };
      writeTmyFile(file, tmy, header);
      return { tmy, header, cached: false };
    } finally {
      release();
      pending.delete(key);
    }
  })();
  pending.set(key, p);
  return p;
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/health') return sendJson(req, res, 200, { ok: true, pvgis: BASE, official: BASE === PVGIS_BASE });
  if (url.pathname === '/api/tmy') {
    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    if (!(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) return sendJson(req, res, 400, { error: 'lat/lon out of range' });
    try {
      const { tmy, header, cached } = await fetchTmy(lat, lon);
      return sendJson(req, res, 200, { ...tmyToJSON(tmy), source: header.source, synthetic: !!header.synthetic, cached });
    } catch (e) {
      console.warn(`TMY ${lat},${lon}: ${e.message}`);
      return sendJson(req, res, e.status ?? 500, { error: e.message });
    }
  }
  return sendJson(req, res, 404, { error: 'Unknown API endpoint' });
}

// --- Static files -----------------------------------------------------------
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const path = normalize(join(PUBLIC, rel));
  if (!path.startsWith(PUBLIC + sep) || !existsSync(path) || !statSync(path).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('Not found');
  }
  const ext = extname(path);
  const isData = path.includes(`${sep}data${sep}`);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': statSync(path).size,
    'cache-control': isData ? 'public, max-age=300' : 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(path).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  serveStatic(req, res, url);
});

server.listen(PORT, HOST, () => {
  console.log(`Solar yield map on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`PVGIS relay -> ${BASE}${BASE === PVGIS_BASE ? '' : '  (NOT the official PVGIS API)'}`);
  if (!existsSync(join(PUBLIC, 'data', 'grid', 'manifest.json'))) {
    console.log('No precomputed grid yet: run "npm run fetch" and "npm run build-grid" for the global heatmap.');
  }
});
