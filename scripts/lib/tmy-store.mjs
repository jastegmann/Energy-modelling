// Compact gzip'd binary storage of a parsed TMY (about 45 kB per location).
// Layout: "TMY1" | uint32 header length | header JSON | int32 time deltas (min)
//         | uint16 ghi*10 | uint16 dni*10 | uint16 dhi*10 | int16 t2m*100 | uint16 ws*100

import { gzipSync, gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

const MAGIC = 'TMY1';
const clampU16 = (v) => Math.max(0, Math.min(65535, Math.round(v)));
const clampI16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v)));

export function encodeTmy(tmy, extraHeader = {}) {
  const n = tmy.time.length;
  const header = Buffer.from(JSON.stringify({ ...extraHeader, meta: tmy.meta, n }), 'utf8');
  const buf = Buffer.alloc(8 + header.length + n * 4 + n * 2 * 5);
  buf.write(MAGIC, 0, 'ascii');
  buf.writeUInt32LE(header.length, 4);
  header.copy(buf, 8);
  let o = 8 + header.length;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const m = Math.round(tmy.time[i] / 60000);
    buf.writeInt32LE(m - prev, o);
    prev = m;
    o += 4;
  }
  for (const [key, scale, signed] of [['ghi', 10], ['dni', 10], ['dhi', 10], ['t2m', 100, true], ['ws', 100]]) {
    const a = tmy[key];
    for (let i = 0; i < n; i++) {
      if (signed) buf.writeInt16LE(clampI16(a[i] * scale), o);
      else buf.writeUInt16LE(clampU16(a[i] * scale), o);
      o += 2;
    }
  }
  return gzipSync(buf, { level: 6 });
}

export function decodeTmy(gz) {
  const buf = gunzipSync(gz);
  if (buf.toString('ascii', 0, 4) !== MAGIC) throw new Error('Not a TMY1 file');
  const hl = buf.readUInt32LE(4);
  const header = JSON.parse(buf.toString('utf8', 8, 8 + hl));
  const n = header.n;
  let o = 8 + hl;
  const time = new Float64Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) {
    m += buf.readInt32LE(o);
    time[i] = m * 60000;
    o += 4;
  }
  const read = (scale, signed) => {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      a[i] = (signed ? buf.readInt16LE(o) : buf.readUInt16LE(o)) / scale;
      o += 2;
    }
    return a;
  };
  const tmy = { meta: header.meta, time };
  tmy.ghi = read(10);
  tmy.dni = read(10);
  tmy.dhi = read(10);
  tmy.t2m = read(100, true);
  tmy.ws = read(100);
  return { header, tmy };
}

export function writeTmyFile(path, tmy, extraHeader) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, encodeTmy(tmy, extraHeader));
  renameSync(tmp, path); // atomic: an interrupted run never leaves a partial file
}

export function readTmyFile(path) {
  return decodeTmy(readFileSync(path));
}
