// Colour scales for the heatmap. "heat" is an analogous yellow-orange-red ramp
// (ColorBrewer YlOrRd, monotonic lightness) for energy and irradiation; "blue" is
// a single-hue ramp for ratios and angles.

export const RAMPS = {
  heat: ['#ffffcc', '#ffeda0', '#fed976', '#feb24c', '#fd8d3c', '#fc4e2a', '#e31a1c', '#bd0026', '#800026'],
  blue: ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'],
};

export const VARIABLES = {
  yield: { label: 'Specific yield', unit: 'kWh/kWp', ramp: 'heat', range: [600, 2600], digits: 0 },
  pr: { label: 'Performance ratio', unit: '%', ramp: 'blue', range: [72, 90], digits: 1 },
  poa: { label: 'In-plane irradiation (GlobInc)', unit: 'kWh/m²', ramp: 'heat', range: [700, 3300], digits: 0 },
  ghi: { label: 'Global horizontal irradiation', unit: 'kWh/m²', ramp: 'heat', range: [600, 2700], digits: 0 },
  opttilt: { label: 'Optimal tilt', unit: '°', ramp: 'blue', range: [0, 50], digits: 1 },
  suitable: { label: 'Suitable land after filters', unit: '%', ramp: 'blue', range: [0, 100], digits: 0 },
  grid: { label: 'Distance to power grid', unit: 'km', ramp: 'blue', range: [0, 100], digits: 1 },
};

const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** 256-entry lookup table of packed RGBA (little-endian, for ImageData Uint32 views). */
export function buildLut(name, n = 256) {
  const stops = RAMPS[name].map(hexRgb);
  const lut = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * (stops.length - 1);
    const k = Math.min(Math.floor(x), stops.length - 2);
    const f = x - k;
    const [r, g, b] = [0, 1, 2].map((c) => Math.round(stops[k][c] + (stops[k + 1][c] - stops[k][c]) * f));
    lut[i] = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
  }
  return lut;
}

export function cssGradient(name) {
  const s = RAMPS[name];
  return `linear-gradient(90deg, ${s.map((c, i) => `${c} ${((i / (s.length - 1)) * 100).toFixed(1)}%`).join(', ')})`;
}

/** "Nice" tick values spanning [lo, hi]. */
export function niceTicks(lo, hi, count = 5) {
  const span = hi - lo;
  const raw = span / (count - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? raw;
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(+v.toFixed(6));
  return ticks;
}

/** Robust data range (2nd..98th percentile), rounded outward. */
export function autoRange(values) {
  const v = Array.from(values).filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return [0, 1];
  let lo = v[Math.floor(v.length * 0.02)];
  let hi = v[Math.floor(v.length * 0.98)];
  if (hi - lo < 1e-9) hi = lo + 1;
  const mag = 10 ** Math.floor(Math.log10(hi - lo) - 1);
  return [Math.floor(lo / mag) * mag, Math.ceil(hi / mag) * mag];
}
