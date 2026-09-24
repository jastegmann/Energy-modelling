// Encoding of the precomputed grid files ("u16-delta-shuffle"): every field is
// quantised to 16 bits (value = raw * scale), delta-encoded along the cell order
// and byte-shuffled (all low bytes, then all high bytes). Neighbouring cells have
// similar values, which makes the gzip'd files ~30-40 % smaller.

export const GRID_ENCODING = 'u16-delta-shuffle';

/** @param get (fieldIndex, cellIndex) => value */
export function packFields(fields, M, get) {
  const n = fields.length * M;
  const words = new Uint16Array(n);
  fields.forEach((f, j) => {
    const lo = f.type === 'int16' ? -32768 : 0;
    const hi = f.type === 'int16' ? 32767 : 65535;
    let prev = 0;
    for (let m = 0; m < M; m++) {
      const v = get(j, m);
      const q = Math.max(lo, Math.min(hi, Math.round((Number.isFinite(v) ? v : 0) / f.scale))) & 0xffff;
      words[j * M + m] = (q - prev) & 0xffff;
      prev = q;
    }
  });
  const out = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) {
    out[i] = words[i] & 0xff;
    out[n + i] = words[i] >> 8;
  }
  return out;
}

/** @returns {Object<string, Float32Array>} */
export function unpackFields(buf, fields, M) {
  const n = fields.length * M;
  const bytes = new Uint8Array(buf);
  if (bytes.length !== n * 2) throw new Error(`Grid file has ${bytes.length} bytes, expected ${n * 2}`);
  const words = new Uint16Array(n);
  for (let i = 0; i < n; i++) words[i] = bytes[i] | (bytes[n + i] << 8);
  const out = {};
  fields.forEach((f, j) => {
    let acc = 0;
    for (let m = 0; m < M; m++) {
      acc = (acc + words[j * M + m]) & 0xffff;
      words[j * M + m] = acc;
    }
    const raw = f.type === 'int16' ? new Int16Array(words.buffer, j * M * 2, M) : words.subarray(j * M, (j + 1) * M);
    const a = new Float32Array(M);
    for (let m = 0; m < M; m++) a[m] = raw[m] * f.scale;
    out[f.name] = a;
  });
  return out;
}
