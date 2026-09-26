// Cut polylines into map tiles at several levels of detail and write them in
// the format of public/js/grid-lines-codec.js.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { simplify, clipPolyline } from './lines.mjs';
import { encodeLines, lineTileId } from '../../public/js/grid-lines-codec.js';

/**
 * Levels: [{ tileDeg, tol (simplification, degrees), quantum (stored coordinate
 * step, degrees), minZoom, maxZoom, keep?: (cls) => boolean }].
 */
export class LineTiler {
  constructor(levels) {
    this.levels = levels;
    this.tiles = levels.map(() => new Map()); // tileId -> [lines]
  }

  /** Add a polyline [lon, lat, ...]; `cls` (optional) is stored per line. */
  add(pts, cls) {
    this.levels.forEach((lv, li) => {
      if (cls !== undefined && lv.keep && !lv.keep(cls)) return;
      const line = simplify(pts, lv.tol);
      let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
      for (let i = 0; i < line.length; i += 2) {
        w = Math.min(w, line[i]);
        e = Math.max(e, line[i]);
        s = Math.min(s, line[i + 1]);
        n = Math.max(n, line[i + 1]);
      }
      const d = lv.tileDeg;
      for (let r = Math.floor(s / d); r <= Math.floor(n / d); r++) {
        for (let c = Math.floor(w / d); c <= Math.floor(e / d); c++) {
          const pieces = clipPolyline(line, c * d, r * d, (c + 1) * d, (r + 1) * d);
          if (!pieces.length) continue;
          if (cls !== undefined) for (const p of pieces) p.cls = cls;
          const id = lineTileId(r, c);
          if (!this.tiles[li].has(id)) this.tiles[li].set(id, []);
          this.tiles[li].get(id).push(...pieces);
        }
      }
    });
  }

  /** Write the tiles to outDir/L<i>/ (replacing what was there); returns the level list for index.json. */
  write(outDir, log = console.log) {
    return this.levels.map((lv, li) => {
      const dir = join(outDir, `L${li}`);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      let bytes = 0;
      const ids = [...this.tiles[li].keys()].sort();
      for (const id of ids) {
        const [r, c] = id.split('_').map(Number);
        const buf = gzipSync(encodeLines(this.tiles[li].get(id), c * lv.tileDeg, r * lv.tileDeg, lv.quantum), { level: 9 });
        writeFileSync(join(dir, `${id}.bin.gz`), buf);
        bytes += buf.length;
      }
      log(`  level ${li} (zoom ${lv.minZoom}–${Math.min(lv.maxZoom, 19)}): ${ids.length} tiles, ${(bytes / 1e6).toFixed(1)} MB`);
      return { path: `L${li}/`, tileDeg: lv.tileDeg, quantum: lv.quantum, minZoom: lv.minZoom, maxZoom: lv.maxZoom, tiles: ids };
    });
  }
}

/** Bounding box of an area given by --bbox, or by --region / --countries on a land mask. */
export function areaBox({ bbox, region, countries, res = 0.1, margin = 1 }, { loadLandCells, selectCells, cellCenter, parseBbox }) {
  if (bbox) {
    const b = parseBbox(bbox);
    return { west: b.lonMin, south: b.latMin, east: b.lonMax, north: b.latMax };
  }
  if (!region && !countries) return { west: -180, south: -90, east: 180, north: 90 };
  const land = loadLandCells(res);
  const cells = selectCells(land, { region, countries });
  if (!cells.length) throw new Error('No land cells in the selected area.');
  const box = { west: 180, south: 90, east: -180, north: -90 };
  for (const c of cells) {
    const { lat, lon } = cellCenter(c.idx, res, land.nx);
    box.west = Math.min(box.west, lon - margin);
    box.east = Math.max(box.east, lon + margin);
    box.south = Math.min(box.south, lat - margin);
    box.north = Math.max(box.north, lat + margin);
  }
  return { ...box, cells, land };
}
