// End-to-end tests of the data pipeline against the mock PVGIS server:
// fetch-tmy -> build-grid -> browser-side evaluation, plus the server relay.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { packFields, unpackFields } from '../public/js/grid-codec.js';
import { encodeTmy, decodeTmy, readTmyFile } from '../scripts/lib/tmy-store.mjs';
import { parsePvgisTmy, estimateTimeShift } from '../public/js/pvgis.js';
import { syntheticPvgisTmy } from '../scripts/dev/synthetic-tmy.mjs';
import { createMockPvgis } from '../scripts/dev/mock-pvgis.mjs';
import { loadGrid, computeValues, cellAt } from '../public/js/grid-data.js';
import { prepareHourly, simulate } from '../public/js/model/simulate.js';
import { DEFAULT_PARAMS } from '../public/js/model/losses.js';
import { cachePath } from '../scripts/lib/grid.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'solar-map-test-'));
let mock, mockUrl;

// Async so that the in-process mock server keeps answering while the scripts run.
function run(args) {
  return new Promise((resolve) => {
    const p = spawn('node', args, { cwd: ROOT });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

before(async () => {
  mock = createMockPvgis();
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  mockUrl = `http://127.0.0.1:${mock.address().port}/api/v5_3`;
});
after(() => {
  mock.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('grid codec round-trips int16 and uint16 fields', () => {
  const fields = [
    { name: 'a', type: 'uint16', scale: 0.1 },
    { name: 'b', type: 'int16', scale: 0.01 },
  ];
  const M = 1000;
  const val = (j, m) => (j === 0 ? (m * 37.3) % 6000 : Math.sin(m) * 300);
  const out = unpackFields(packFields(fields, M, val).buffer, fields, M);
  for (let m = 0; m < M; m++) {
    assert.ok(Math.abs(out.a[m] - val(0, m)) <= 0.05 + 1e-6);
    assert.ok(Math.abs(out.b[m] - val(1, m)) <= 0.005 + 1e-6);
  }
});

test('TMY store round-trips a PVGIS year', () => {
  const tmy = parsePvgisTmy(syntheticPvgisTmy(47.3, 8.5, { offsetMin: 10 }));
  const { tmy: back, header } = decodeTmy(encodeTmy(tmy, { idx: 42 }));
  assert.equal(header.idx, 42);
  assert.deepEqual(back.meta, tmy.meta);
  for (const k of ['ghi', 'dni', 'dhi', 't2m', 'ws']) {
    for (let i = 0; i < tmy.time.length; i += 97) assert.ok(Math.abs(back[k][i] - tmy[k][i]) < 0.06, k);
  }
  assert.deepEqual(Array.from(back.time), Array.from(tmy.time));
  assert.equal(estimateTimeShift(back).shift, 10);
});

test('fetch -> build -> browser evaluation reproduces the hourly model', async () => {
  const cache = join(tmp, 'cache');
  const out = join(tmp, 'grid');
  const bbox = '6,45,8,47'; // Alps / Switzerland, SARAH-like mock data
  const f = await run(['scripts/fetch-tmy.mjs', '--base', mockUrl, '--bbox', bbox, '--cache', cache, '--rate', '500']);
  assert.equal(f.status, 0, f.stderr + f.stdout);
  assert.match(f.stdout, /Done: \d+ fetched, 0 failed/);
  const b = await run(['scripts/build-grid.mjs', '--cache', cache, '--out', out, '--bbox', bbox, '--workers', '2']);
  assert.equal(b.status, 0, b.stderr + b.stdout);
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.synthetic, true);
  assert.equal(manifest.configs.length, 117);
  assert.equal(manifest.shiftByDatabase['PVGIS-SARAH3'].median, 10);

  // Load the grid the way the browser does (fetch of relative URLs).
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const p = join(out, String(url).replace(/^grid\//, ''));
    if (!existsSync(p)) return new Response('not found', { status: 404 });
    return new Response(readFileSync(p));
  };
  try {
    const grid = await loadGrid('grid/');
    assert.equal(grid.M, manifest.count);
    const mounts = [
      { type: 'fixed', tilt: 35, gcr: 0.4 },
      { type: 'fixed', tilt: 32, gcr: 0 }, // interpolated between 30° and 35°
      { type: 'ew', tilt: 10, gcr: 0.85 },
      { type: 'tracker', limit: 55, gcr: 0.35, backtrack: true },
    ];
    const pos = cellAt(grid, 46.25, 7.25);
    assert.ok(pos >= 0);
    const { tmy } = readTmyFile(cachePath(cache, grid.cells[pos], 720));
    const h = prepareHourly(tmy, estimateTimeShift(tmy).shift);
    for (const m of mounts) {
      const v = await computeValues(grid, m, DEFAULT_PARAMS, 'yield');
      const exact = simulate(h, m, DEFAULT_PARAMS).yield;
      const tol = m.tilt === 32 ? 0.005 : 0.001; // interpolation vs quantisation only
      assert.ok(Math.abs(v[pos] / exact - 1) < tol, `${JSON.stringify(m)}: grid ${v[pos]} vs hourly ${exact}`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('server relays PVGIS TMY requests and reports sea points', async () => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const srv = spawn('node', ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), PVGIS_BASE: mockUrl, POINT_CACHE: join(tmp, 'points') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      srv.stdout.on('data', (d) => /Solar yield map on/.test(d) && resolve());
      srv.on('exit', (c) => reject(new Error(`server exited ${c}`)));
    });
    const base = `http://127.0.0.1:${port}`;
    const land = await fetch(`${base}/api/tmy?lat=-23.51&lon=133.87`);
    assert.equal(land.status, 200);
    const j = await land.json();
    assert.equal(j.ghi.length, 8760);
    assert.equal(j.synthetic, true);
    const sea = await fetch(`${base}/api/tmy?lat=0&lon=-30`);
    assert.equal(sea.status, 400);
    assert.match((await sea.json()).error, /sea/i);
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Solar Yield Map/);
    assert.equal((await fetch(`${base}/../package.json`)).status, 404);
  } finally {
    srv.kill();
  }
});
