// Compact tile format for power-line geometry (built by scripts/build-grid-lines.mjs,
// drawn by grid-lines-layer.js).
//
// A tile file (gzip'd) is: uint32 magic "GLN1", then a varint stream:
//   nLines, and per line: nPoints, then (x, y) as zigzag varint deltas in units
//   of `quantum` degrees; the first point is relative to the tile's south-west
//   corner (west, south), later points to the previous point.

export const LINES_MAGIC = 0x314e4c47; // "GLN1"

/** Encode lines ([[lon, lat, lon, lat, ...], ...]) of one tile. */
export function encodeLines(lines, west, south, quantum) {
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
    if (q.length >= 4) kept.push(q);
  }
  varint(kept.length);
  for (const q of kept) {
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
  new DataView(buf.buffer).setUint32(0, LINES_MAGIC, true);
  buf.set(out, 4);
  return buf;
}

/** Decode a tile into an array of Float64Array [lon, lat, lon, lat, ...]. */
export function decodeLines(buf, west, south, quantum) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, true) !== LINES_MAGIC) throw new Error('Not a grid-lines tile');
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
    const m = varint();
    const pts = new Float64Array(2 * m);
    let x = 0, y = 0;
    for (let i = 0; i < m; i++) {
      x += zz();
      y += zz();
      pts[2 * i] = west + x * quantum;
      pts[2 * i + 1] = south + y * quantum;
    }
    lines[k] = pts;
  }
  return lines;
}

/** Tile id and south-west corner for tile indices (row = floor(lat / deg), col = floor(lon / deg)). */
export const lineTileId = (row, col) => `${row}_${col}`;
