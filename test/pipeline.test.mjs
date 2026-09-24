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
import { Dataset, blockResults } from '../public/js/grid-data.js';
import { collectCells, toCsv } from '../public/js/screening.js';
import { prepareHourly, simulate } from '../public/js/model/simulate.js';
import { DEFAULT_PARAMS } from '../public/js/model/losses.js';
import { cachePath, loadLandCells, selectCells } from '../scripts/lib/grid.mjs';

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
  const sel = ['--countries', 'Switzerland'];
  const f = await run(['scripts/fetch-tmy.mjs', '--base', mockUrl, ...sel, '--cache', cache, '--rate', '500']);
  assert.equal(f.status, 0, f.stderr + f.stdout);
  const expected = selectCells(loadLandCells(0.5), { countries: 'Switzerland' }).length;
  assert.match(f.stdout, new RegExp(`Done: ${expected} fetched, 0 failed`));
  const b = await run(['scripts/build-grid.mjs', '--cache', cache, '--out', out, '--workers', '2']);
  assert.equal(b.status, 0, b.stderr + b.stdout);
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, 2);
  assert.equal(manifest.synthetic, true);
  assert.equal(manifest.configs.length, 117);
  assert.equal(manifest.shiftByDatabase['PVGIS-SARAH3'].median, 10);
  assert.ok(manifest.count >= expected); // blocks also hold cached cells of neighbouring countries, if any

  // A second build reuses the unchanged blocks.
  const again = await run(['scripts/build-grid.mjs', '--cache', cache, '--out', out, '--workers', '2']);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).blocks[0].sig, manifest.blocks[0].sig);

  // Load the grid the way the browser does (fetch of relative URLs).
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const p = join(out, String(url).replace(/^grid\//, ''));
    if (!existsSync(p)) return new Response('not found', { status: 404 });
    return new Response(readFileSync(p));
  };
  try {
    const ds = new Dataset('grid/', manifest);
    const [id] = ds.blockIdsIn(46.75, 8.25, 46.75, 8.25);
    const block = await ds.block(id);
    const hit = ds.lookup(46.75, 8.25);
    assert.ok(hit && hit.block === block);
    const mounts = [
      { type: 'fixed', tilt: 35, gcr: 0.4 },
      { type: 'fixed', tilt: 32, gcr: 0 }, // interpolated between 30° and 35°
      { type: 'ew', tilt: 10, gcr: 0.85 },
      { type: 'tracker', limit: 55, gcr: 0.35, backtrack: true },
    ];
    const { tmy } = readTmyFile(cachePath(cache, block.cells[hit.pos], 720));
    const h = prepareHourly(tmy, estimateTimeShift(tmy).shift);
    for (const m of mounts) {
      const v = (await blockResults(block, m, DEFAULT_PARAMS)).yield[hit.pos];
      const exact = simulate(h, m, DEFAULT_PARAMS).yield;
      const tol = m.tilt === 32 ? 0.005 : 0.001; // interpolation vs quantisation only
      assert.ok(Math.abs(v / exact - 1) < tol, `${JSON.stringify(m)}: grid ${v} vs hourly ${exact}`);
    }

    // Screening: all Swiss cells, ranked by specific yield.
    const swiss = 756;
    const res = await collectCells([ds], { type: 'country', id: swiss }, mounts[0], DEFAULT_PARAMS);
    assert.equal(res.rows.length, expected);
    assert.ok(res.rows.every((r, i) => r.country === swiss && (i === 0 || r.yield <= res.rows[i - 1].yield)));
    const csv = toCsv(res, new Map([[swiss, 'Switzerland']]), mounts[0], DEFAULT_PARAMS).split('\n');
    const header = csv.findIndex((l) => l.startsWith('rank,'));
    assert.equal(csv.length, header + 1 + expected);
    assert.match(csv[header + 1], /^1,\d+\.\d+,\d+\.\d+,Switzerland,/);
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
