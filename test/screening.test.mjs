// Site-screening layers: raster, polygon, grid-distance helpers and the
// build-screening pipeline against the SYNTHETIC mock data sources.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { slopeDegrees, readArea } from '../scripts/lib/raster.mjs';
import { assembleRings, overpassToAreas } from '../scripts/lib/osm-protected.mjs';
import { readLines, SegmentIndex } from '../scripts/lib/gpkg-lines.mjs';
import { createMockScreeningSources, makeGridGpkg, mockOverpass, mockLandCover } from '../scripts/dev/mock-screening-sources.mjs';
import {
  NBINS, LAND_COVER, DEFAULT_FILTERS, binIndex, encodeScreenBlock, decodeScreenBlock, alignScreen, evaluateFilters, protectedShare,
} from '../public/js/screening-layers.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'solar-screen-test-'));
let srv, base;

before(async () => {
  srv = createMockScreeningSources();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => {
  srv.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('slope of an inclined plane', () => {
  const n = 50, pxDeg = 1 / 600, north = 0.5;
  const z = new Float32Array(n * n);
  const grade = 0.1; // 10 % towards the east
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) z[y * n + x] = x * pxDeg * 111320 * Math.cos(((north - (y + 0.5) * pxDeg) * Math.PI) / 180) * grade;
  const s = slopeDegrees(z, n, n, north, pxDeg);
  const expected = (Math.atan(grade) * 180) / Math.PI;
  assert.ok(Math.abs(s[25 * n + 25] - expected) < 0.01, `${s[25 * n + 25]} vs ${expected}`);
});

test('multipolygon rings are assembled from split ways', () => {
  const sq = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
  const rings = assembleRings([sq.slice(0, 3), sq.slice(2).reverse()]);
  assert.equal(rings.length, 1);
  assert.equal(rings[0].length, 5);
  const areas = overpassToAreas(mockOverpass());
  assert.ok(areas.length > 100 && areas.every((a) => a.rings.length === 1 && a.rings[0].length === 33));
  // Cultural sites (protect_class 22) are not nature protection.
  assert.equal(overpassToAreas({ elements: [{ type: 'way', id: 1, tags: { boundary: 'protected_area', protect_class: '22' }, geometry: sq.map(([lon, lat]) => ({ lat, lon })) }] }).length, 0);
});

test('GeoPackage lines and nearest-line distance', () => {
  const path = join(tmp, 'grid.gpkg');
  makeGridGpkg(path, { west: 30, south: -5, east: 40, north: 5 });
  const idx = new SegmentIndex(0.25);
  const n = readLines(path, { west: 33, south: -2, east: 37, north: 2 }, (pts) => idx.addLine(pts));
  assert.ok(n > 0 && idx.count > 0);
  // Horizontal lines every 1.5° of latitude (… -1.5, 0, 1.5 …), vertical every 2° of longitude.
  assert.ok(Math.abs(idx.distanceKm(0.3, 35) - 0.3 * 110.57) < 0.5);
  assert.ok(Math.abs(idx.distanceKm(0.75, 35.9) - 0.1 * 111.32 * Math.cos((0.75 * Math.PI) / 180)) < 0.5);
  assert.equal(idx.distanceKm(0.3, 35, 10), Infinity);
});

test('screening block codec and filter evaluation', () => {
  const cells = Uint32Array.from([5, 9]);
  const land = Uint8Array.from([255, 128]);
  const hist = new Uint8Array(NBINS * 2);
  const grass = LAND_COVER.findIndex((c) => c.code === 30);
  const tree = LAND_COVER.findIndex((c) => c.code === 10);
  hist[binIndex(0, grass, 0) * 2 + 0] = 153; // cell 0: 60 % flat grassland
  hist[binIndex(1, grass, 0) * 2 + 0] = 51; //          20 % protected grassland
  hist[binIndex(0, tree, 4) * 2 + 0] = 51; //           20 % steep forest
  hist[binIndex(0, grass, 2) * 2 + 1] = 255; // cell 1: grassland 5–10°, half of the cell is land
  const buf = encodeScreenBlock(cells, Float32Array.from([3.2, NaN]), land, hist);
  const sc = decodeScreenBlock(buf.buffer);
  assert.deepEqual([...sc.cells], [5, 9]);
  assert.ok(Math.abs(sc.gridKm[0] - 3.2) < 1e-6 && Number.isNaN(sc.gridKm[1]));
  const al = alignScreen(sc, Uint32Array.from([9, 7, 5]));
  assert.deepEqual([...al.valid], [1, 0, 1]);
  const r = evaluateFilters(al, { ...DEFAULT_FILTERS, maxSlope: 10, minSuitable: 10 });
  assert.ok(Math.abs(r.suitable[2] - 0.6) < 0.01);
  assert.ok(Math.abs(r.suitable[0] - 128 / 255) < 0.01);
  assert.deepEqual([...r.pass], [1, 2, 1]);
  const strict = evaluateFilters(al, { ...DEFAULT_FILTERS, maxSlope: 3, maxGridKm: 2 });
  assert.equal(strict.pass[0], 0); // too steep
  assert.equal(strict.pass[2], 0); // too far from the grid
  const noProt = evaluateFilters(al, { ...DEFAULT_FILTERS, excludeProtected: false });
  assert.ok(Math.abs(noProt.suitable[2] - 0.8) < 0.01);
  assert.ok(Math.abs(protectedShare(al)[2] - 0.2) < 0.01);
});

test('windowed COG reads match the source raster', async () => {
  const url = `${base}/worldcover/ESA_WorldCover_10m_2021_v200_N00E036_Map.tif`;
  const a = await readArea(url, { west: 36, south: 0, east: 37, north: 1 }, 100, 100, 'nearest');
  let agree = 0;
  for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) if (a[y * 100 + x] === mockLandCover(1 - (y + 0.5) / 100, 36 + (x + 0.5) / 100)) agree++;
  assert.ok(agree > 9500, `${agree}/10000`);
  assert.equal(await readArea(`${base}/nothing/here.tif`, { west: 0, south: 0, east: 1, north: 1 }, 10, 10), null);
});

test('build-screening writes layers that reflect the sources', async () => {
  const grids = join(tmp, 'grids');
  const gpkg = join(tmp, 'grid2.gpkg');
  makeGridGpkg(gpkg, { west: 30, south: -5, east: 40, north: 5 });
  const r = await new Promise((resolve) => {
    const p = spawn(
      'node',
      [
        '--disable-warning=ExperimentalWarning', 'scripts/build-screening.mjs', '--res', '0.1', '--bbox=36,0,37,1', '--grids', grids,
        '--cache', join(tmp, 'cache'), '--worldcover-base', `${base}/worldcover`, '--dem-base', `${base}/dem`,
        '--overpass', `${base}/overpass`, '--gridfinder', gpkg,
      ],
      { cwd: ROOT }
    );
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (status) => resolve({ status, out }));
  });
  assert.equal(r.status, 0, r.out);
  const files = readdirSync(join(grids, '0.1', 'screening'));
  assert.equal(files.length, 1);
  const raw = gunzipSync(readFileSync(join(grids, '0.1', 'screening', files[0])));
  const sc = decodeScreenBlock(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
  assert.equal(sc.n, 100); // 10 × 10 cells of 0.1° in the 1° box
  sc.valid = new Uint8Array(sc.n).fill(1);
  const prot = protectedShare(sc);
  // Mock protected circles (r = 0.3°) sit at odd lat/lon; (0.95 N, 36.95 E) is 0.07° from (1, 37).
  const at = (lat, lon) => sc.cells.indexOf(Math.floor((90 - lat) / 0.1) * 3600 + Math.floor((lon + 180) / 0.1));
  assert.ok(prot[at(0.95, 36.95)] > 0.95);
  assert.ok(prot[at(0.25, 36.25)] < 0.01);
  // Grid lines at 0° N and 36° E.
  assert.ok(Math.abs(sc.gridKm[at(0.55, 36.85)] - 0.55 * 110.57) < 1.5);
  assert.ok(sc.land.every((v) => v === 255));
  const meta = JSON.parse(readFileSync(join(grids, '0.1', 'screening.json'), 'utf8'));
  assert.deepEqual(meta.blocks, [files[0].replace('.bin.gz', '')]);
});
