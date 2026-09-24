// Read line geometries (e.g. the gridfinder power-grid network) from a
// GeoPackage with Node's built-in SQLite, and find distances to them.

import { DatabaseSync } from 'node:sqlite';

/**
 * Parse a GeoPackage geometry blob; calls onLine(Float64Array [x0,y0,x1,y1,...])
 * for every (multi)linestring part.
 */
export function parseGpkgGeometry(buf, onLine) {
  if (buf[0] !== 0x47 || buf[1] !== 0x50) throw new Error('Not a GeoPackage geometry');
  const flags = buf[3];
  if (flags & 0x10) return; // empty geometry
  const envBytes = [0, 32, 48, 48, 64][(flags >> 1) & 7] ?? 0;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 8 + envBytes;
  const readGeom = () => {
    const le = view.getUint8(o) === 1;
    o += 1;
    let type = view.getUint32(o, le);
    o += 4;
    let dims = 2;
    if (type & 0xc0000000) {
      dims += (type & 0x80000000 ? 1 : 0) + (type & 0x40000000 ? 1 : 0);
      type &= 0x0fffffff;
    }
    if (type > 3000) (dims = 4), (type -= 3000);
    else if (type > 2000) (dims = 3), (type -= 2000);
    else if (type > 1000) (dims = 3), (type -= 1000);
    if (type === 2) {
      const n = view.getUint32(o, le);
      o += 4;
      const pts = new Float64Array(2 * n);
      for (let i = 0; i < n; i++) {
        pts[2 * i] = view.getFloat64(o, le);
        pts[2 * i + 1] = view.getFloat64(o + 8, le);
        o += 8 * dims;
      }
      onLine(pts);
    } else if (type === 5 || type === 7) {
      const n = view.getUint32(o, le);
      o += 4;
      for (let i = 0; i < n; i++) readGeom();
    } else if (type === 1) {
      o += 8 * dims;
    } else {
      throw new Error(`Unsupported WKB geometry type ${type}`);
    }
  };
  readGeom();
}

/** Stream the lines of the first feature table inside a lon/lat box into onLine(). */
export function readLines(path, { west, south, east, north }, onLine) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const g = db.prepare('SELECT table_name, column_name, srs_id FROM gpkg_geometry_columns').all()[0];
    if (!g) throw new Error(`${path}: no feature table`);
    if (g.srs_id !== 4326) console.warn(`${path}: SRS ${g.srs_id}, expected 4326 (lon/lat); distances may be wrong`);
    const t = g.table_name, c = g.column_name;
    const pk = db.prepare(`PRAGMA table_info("${t}")`).all().find((r) => r.pk)?.name ?? 'fid';
    const rtree = `rtree_${t}_${c}`;
    const hasRtree = db.prepare('SELECT name FROM sqlite_master WHERE name = ?').all(rtree).length > 0;
    const stmt = hasRtree
      ? db.prepare(`SELECT f."${c}" AS g FROM "${t}" f JOIN "${rtree}" r ON f."${pk}" = r.id WHERE r.maxx >= ? AND r.minx <= ? AND r.maxy >= ? AND r.miny <= ?`)
      : db.prepare(`SELECT "${c}" AS g FROM "${t}"`);
    let n = 0;
    for (const r of hasRtree ? stmt.iterate(west, east, south, north) : stmt.iterate()) {
      if (r.g) parseGpkgGeometry(r.g, onLine);
      n++;
    }
    return n;
  } finally {
    db.close();
  }
}

/**
 * Spatial index of line segments on a regular bucket grid, answering
 * "distance (km) to the nearest line" for points.
 */
export class SegmentIndex {
  constructor(bucketDeg = 0.25) {
    this.b = bucketDeg;
    this.coords = new Float32Array(1 << 20);
    this.count = 0;
    this.buckets = new Map(); // key -> array of segment numbers
  }

  addLine(pts) {
    for (let i = 0; i + 3 < pts.length; i += 2) this.addSegment(pts[i], pts[i + 1], pts[i + 2], pts[i + 3]);
  }

  addSegment(x1, y1, x2, y2) {
    if (4 * (this.count + 1) > this.coords.length) {
      const bigger = new Float32Array(this.coords.length * 2);
      bigger.set(this.coords);
      this.coords = bigger;
    }
    const s = this.count++;
    this.coords.set([x1, y1, x2, y2], 4 * s);
    const b = this.b;
    const c0 = Math.floor(Math.min(x1, x2) / b), c1 = Math.floor(Math.max(x1, x2) / b);
    const r0 = Math.floor(Math.min(y1, y2) / b), r1 = Math.floor(Math.max(y1, y2) / b);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const k = r * 100000 + c;
        const list = this.buckets.get(k);
        if (list) list.push(s);
        else this.buckets.set(k, [s]);
      }
    }
  }

  /** Distance in km from (lat, lon) to the nearest segment, up to maxKm (else Infinity). */
  distanceKm(lat, lon, maxKm = 500) {
    const kx = 111.32 * Math.cos((lat * Math.PI) / 180);
    const ky = 110.57;
    const r0 = Math.floor(lat / this.b), c0 = Math.floor(lon / this.b);
    const cs = this.coords;
    let best = Infinity;
    const maxRing = Math.ceil(maxKm / (Math.min(kx, ky) * this.b)) + 1;
    for (let ring = 0; ring <= maxRing; ring++) {
      // Everything in this ring is at least (ring - 1) buckets away.
      if (best < Infinity && (ring - 1) * this.b * Math.min(kx, ky) > best) break;
      for (let r = r0 - ring; r <= r0 + ring; r++) {
        const edge = r === r0 - ring || r === r0 + ring;
        for (let c = c0 - ring; c <= c0 + ring; c += edge ? 1 : 2 * ring || 1) {
          const segs = this.buckets.get(r * 100000 + c);
          if (!segs) continue;
          for (const s of segs) {
            const ax = (cs[4 * s] - lon) * kx, ay = (cs[4 * s + 1] - lat) * ky;
            const dx = (cs[4 * s + 2] - lon) * kx - ax, dy = (cs[4 * s + 3] - lat) * ky - ay;
            const len2 = dx * dx + dy * dy;
            const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
            const d = Math.hypot(ax + t * dx, ay + t * dy);
            if (d < best) best = d;
          }
        }
      }
    }
    return best <= maxKm ? best : Infinity;
  }
}
