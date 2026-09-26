// Compact tile format for power-line geometry (built by scripts/lib/line-tiles.mjs
// for build-grid-lines and build-power, drawn by power-layers.js).
//
// A tile file (gzip'd) is: uint32 magic "GLN1" or "GLN2", then a varint stream:
//   nLines, and per line: [class, for GLN2] nPoints, then (x, y) as zigzag varint
//   deltas in units of `quantum` degrees; the first point is relative to the
//   tile's south-west corner (west, south), later points to the previous point.

export const LINES_MAGIC = 0x314e4c47; // "GLN1": no classes
export const LINES_MAGIC_CLASSES = 0x324e4c47; // "GLN2": a class number per line

/**
 * Encode lines ([[lon, lat, lon, lat, ...], ...]) of one tile. A line may carry
 * a `cls` property (small integer, e.g. a voltage class), which is stored too.
 */
export function encodeLines(lines, west, south, quantum) {
  const withClass = lines.some((l) => l.cls !== undefined);
  const out = [];
  const varint = (v) => {
    while (v > 0x7f) {
      out.push((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(v);
  };
  const zz = (v) => varint(v < 0 ? -2 * v - 1 : 2 * v);
  const kept = [];
  for (const l of lines) {
    // Quantise and drop repeated points.
    const q = [];
    for (let i = 0; i + 1 < l.length; i += 2) {
      const x = Math.round((l[i] - west) / quantum);
      const y = Math.round((l[i + 1] - south) / quantum);
      if (q.length && q[q.length - 2] === x && q[q.length - 1] === y) continue;
      q.push(x, y);
    }
    if (q.length >= 4) {
      q.cls = l.cls ?? 0;
      kept.push(q);
    }
  }
  varint(kept.length);
  for (const q of kept) {
    if (withClass) varint(q.cls);
    varint(q.length / 2);
    let px = 0, py = 0;
    for (let i = 0; i < q.length; i += 2) {
      zz(q[i] - px);
      zz(q[i + 1] - py);
      px = q[i];
      py = q[i + 1];
    }
  }
  const buf = new Uint8Array(4 + out.length);
  new DataView(buf.buffer).setUint32(0, withClass ? LINES_MAGIC_CLASSES : LINES_MAGIC, true);
  buf.set(out, 4);
  return buf;
}

/** Decode a tile into an array of Float64Array [lon, lat, lon, lat, ...], each with a `cls` property. */
export function decodeLines(buf, west, south, quantum) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const magic = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, true);
  if (magic !== LINES_MAGIC && magic !== LINES_MAGIC_CLASSES) throw new Error('Not a grid-lines tile');
  const withClass = magic === LINES_MAGIC_CLASSES;
  let o = 4;
  const varint = () => {
    let v = 0, mul = 1, c;
    do {
      c = b[o++];
      v += (c & 0x7f) * mul;
      mul *= 128;
    } while (c & 0x80);
    return v;
  };
  const zz = () => {
    const v = varint();
    return v % 2 ? -(v + 1) / 2 : v / 2;
  };
  const n = varint();
  const lines = new Array(n);
  for (let k = 0; k < n; k++) {
    const cls = withClass ? varint() : 0;
    const m = varint();
    const pts = new Float64Array(2 * m);
    let x = 0, y = 0;
    for (let i = 0; i < m; i++) {
      x += zz();
      y += zz();
      pts[2 * i] = west + x * quantum;
      pts[2 * i + 1] = south + y * quantum;
    }
    pts.cls = cls;
    lines[k] = pts;
  }
  return lines;
}

/** Tile id and south-west corner for tile indices (row = floor(lat / deg), col = floor(lon / deg)). */
export const lineTileId = (row, col) => `${row}_${col}`;
