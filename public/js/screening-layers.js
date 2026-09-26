// Screening layers per grid cell (built by scripts/build-screening.mjs):
// a joint histogram of the cell's land area over
//   protected (OpenStreetMap) × land cover (ESA WorldCover) × slope class (Copernicus DEM),
// plus the distance to the nearest gridfinder power line and to the nearest
// OpenStreetMap line and substation of at least each voltage in TX_KV. Any
// combination of filters can therefore be evaluated exactly in the browser.

import { TX_KV } from './power.js';

export { TX_KV };
const NT = TX_KV.length;

export const LAND_COVER = [
  { code: 10, name: 'Tree cover', allow: false },
  { code: 20, name: 'Shrubland', allow: true },
  { code: 30, name: 'Grassland', allow: true },
  { code: 40, name: 'Cropland', allow: true },
  { code: 50, name: 'Built-up', allow: false },
  { code: 60, name: 'Bare / sparse vegetation', allow: true },
  { code: 70, name: 'Snow and ice', allow: false },
  { code: 80, name: 'Permanent water', allow: false },
  { code: 90, name: 'Herbaceous wetland', allow: false },
  { code: 95, name: 'Mangroves', allow: false },
  { code: 100, name: 'Moss and lichen', allow: true },
];
/** Upper limits (degrees) of the slope classes; the last class is everything steeper. */
export const SLOPE_LIMITS = [3, 5, 10, 15];
const NL = LAND_COVER.length;
const NS = SLOPE_LIMITS.length + 1;
export const NBINS = 2 * NL * NS;
export const binIndex = (prot, lc, slope) => (prot * NL + lc) * NS + slope;
export const SCREEN_MAGIC = 0x31524353; // "SCR1"
export const SCREEN_MAGIC_TX = 0x32524353; // "SCR2": SCR1 + distances to OSM lines and substations

const packKm = (x) => (Number.isFinite(x) ? Math.min(65534, Math.round(x * 10)) : 65535);
const unpackKm = (u) => (u === 65535 ? NaN : u / 10);

/**
 * Block file layout (before gzip): uint32 magic, uint32 n, uint32 cells[n],
 * uint16 gridKm*10[n] (65535 = unknown), uint8 land[n] (share of the cell that
 * is land, /255), uint8 hist[NBINS][n] (share of the land part in each bin, /255),
 * and for SCR2: uint16 lineKm*10[NT][n], uint16 subKm*10[NT][n] (distances to the
 * nearest OSM line / substation of at least TX_KV[k]).
 * `tx` = { lineKm: Float32Array(NT * n), subKm: Float32Array(NT * n) } or null.
 */
export function encodeScreenBlock(cells, gridKm, land, hist, tx = null) {
  const n = cells.length;
  const base = 8 + 4 * n + 2 * n + n + NBINS * n;
  const pad = tx ? (2 - (base % 2)) % 2 : 0;
  const buf = new ArrayBuffer(base + pad + (tx ? 4 * NT * n : 0));
  const v = new DataView(buf);
  v.setUint32(0, tx ? SCREEN_MAGIC_TX : SCREEN_MAGIC, true);
  v.setUint32(4, n, true);
  new Uint32Array(buf, 8, n).set(cells);
  const g = new Uint16Array(buf, 8 + 4 * n, n);
  for (let i = 0; i < n; i++) g[i] = packKm(gridKm[i]);
  new Uint8Array(buf, 8 + 6 * n, n).set(land);
  new Uint8Array(buf, 8 + 7 * n, NBINS * n).set(hist); // bin-major
  if (tx) {
    const t = new Uint16Array(buf, base + pad, 2 * NT * n);
    for (let k = 0; k < NT * n; k++) {
      t[k] = packKm(tx.lineKm[k]);
      t[NT * n + k] = packKm(tx.subKm[k]);
    }
  }
  return new Uint8Array(buf);
}

export function decodeScreenBlock(buf) {
  const v = new DataView(buf);
  const magic = v.getUint32(0, true);
  if (magic !== SCREEN_MAGIC && magic !== SCREEN_MAGIC_TX) throw new Error('Not a screening block');
  const n = v.getUint32(4, true);
  const g = new Uint16Array(buf, 8 + 4 * n, n);
  const gridKm = new Float32Array(n);
  for (let i = 0; i < n; i++) gridKm[i] = unpackKm(g[i]);
  const lineKm = new Float32Array(NT * n).fill(NaN), subKm = new Float32Array(NT * n).fill(NaN);
  const hasTx = magic === SCREEN_MAGIC_TX;
  if (hasTx) {
    const base = 8 + 4 * n + 2 * n + n + NBINS * n;
    const t = new Uint16Array(buf.slice(base + ((2 - (base % 2)) % 2), base + ((2 - (base % 2)) % 2) + 4 * NT * n));
    for (let k = 0; k < NT * n; k++) {
      lineKm[k] = unpackKm(t[k]);
      subKm[k] = unpackKm(t[NT * n + k]);
    }
  }
  return {
    n,
    cells: new Uint32Array(buf, 8, n),
    gridKm,
    land: new Uint8Array(buf, 8 + 6 * n, n),
    hist: new Uint8Array(buf, 8 + 7 * n, NBINS * n),
    lineKm,
    subKm,
    hasTx,
  };
}

/** Distance (km) from cell i to the nearest OSM line or substation ('line' | 'sub') of at least kv. */
export function txDistance(sc, target, kv, i) {
  const k = TX_KV.indexOf(kv);
  if (k < 0) return NaN;
  return (target === 'sub' ? sc.subKm : sc.lineKm)[k * sc.n + i];
}

/** Default screening filters. */
export const DEFAULT_FILTERS = Object.freeze({
  excludeProtected: true,
  landCover: LAND_COVER.map((c) => c.allow),
  maxSlope: 10, // degrees, one of SLOPE_LIMITS, or 0 for no limit
  maxGridKm: 0, // 0 = no limit
  txTarget: 'line', // distance to an OSM 'line' or 'sub'station ...
  txKv: 132, // ... of at least this voltage (one of TX_KV) ...
  txMaxKm: 0, // ... at most this far (km); 0 = no limit
  minSuitable: 10, // % of the cell
  hideFailing: false,
});

/** Mask of the histogram bins allowed by the filters. */
function allowedBins(f) {
  const ok = new Uint8Array(NBINS);
  const slopeMax = f.maxSlope > 0 ? SLOPE_LIMITS.indexOf(f.maxSlope) : NS - 1;
  for (let p = 0; p < 2; p++) {
    if (p === 1 && f.excludeProtected) continue;
    for (let l = 0; l < NL; l++) {
      if (!f.landCover[l]) continue;
      for (let s = 0; s <= slopeMax; s++) ok[binIndex(p, l, s)] = 1;
    }
  }
  return ok;
}

/**
 * Suitable share (0–1) of every cell's area, and whether the cell passes all
 * filters (pass: 1 = yes, 0 = no, 2 = unknown because the cell has no layers). `sc` is a decoded block aligned to the grid block (see alignScreen).
 */
export function evaluateFilters(sc, f) {
  const n = sc.n;
  const ok = allowedBins(f);
  const suitable = new Float32Array(n);
  const pass = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!sc.valid[i]) {
      suitable[i] = NaN;
      pass[i] = 2; // unknown: no screening data for this cell
      continue;
    }
    let s = 0;
    for (let b = 0; b < NBINS; b++) if (ok[b]) s += sc.hist[b * n + i];
    suitable[i] = (sc.land[i] / 255) * Math.min(1, s / 255);
    const gridOk = !(f.maxGridKm > 0) || sc.gridKm[i] <= f.maxGridKm;
    const txOk = !(f.txMaxKm > 0) || txDistance(sc, f.txTarget, f.txKv, i) <= f.txMaxKm;
    pass[i] = gridOk && txOk && suitable[i] * 100 >= f.minSuitable ? 1 : 0;
  }
  return { suitable, pass };
}

/**
 * Re-order a decoded screening block to the cell order of a grid block.
 * Cells without screening data get valid = 0.
 */
export function alignScreen(sc, gridCells) {
  const M = gridCells.length;
  const pos = new Map();
  for (let i = 0; i < sc.n; i++) pos.set(sc.cells[i], i);
  const out = {
    n: M,
    gridKm: new Float32Array(M).fill(NaN),
    land: new Uint8Array(M),
    hist: new Uint8Array(NBINS * M),
    lineKm: new Float32Array(NT * M).fill(NaN),
    subKm: new Float32Array(NT * M).fill(NaN),
    hasTx: sc.hasTx,
    valid: new Uint8Array(M),
  };
  for (let m = 0; m < M; m++) {
    const i = pos.get(gridCells[m]);
    if (i === undefined) continue;
    out.valid[m] = 1;
    out.gridKm[m] = sc.gridKm[i];
    out.land[m] = sc.land[i];
    for (let b = 0; b < NBINS; b++) out.hist[b * M + m] = sc.hist[b * sc.n + i];
    for (let k = 0; k < NT; k++) {
      out.lineKm[k * M + m] = sc.lineKm[k * sc.n + i];
      out.subKm[k * M + m] = sc.subKm[k * sc.n + i];
    }
  }
  return out;
}

/** Protected share (0–1) of the land in each cell. */
export function protectedShare(sc) {
  const out = new Float32Array(sc.n);
  for (let i = 0; i < sc.n; i++) {
    let s = 0;
    for (let b = binIndex(1, 0, 0); b < NBINS; b++) s += sc.hist[b * sc.n + i];
    out[i] = sc.valid[i] ? Math.min(1, s / 255) : NaN;
  }
  return out;
}

/** Area of a grid cell in km². */
export function cellAreaKm2(lat, res) {
  return (res * 111.32) * (res * 110.57) * Math.cos((lat * Math.PI) / 180);
}
