// Polyline helpers for the power-line map tiles: simplification and clipping.

/** Douglas–Peucker simplification of [x0, y0, x1, y1, ...] with tolerance tol (same units). */
export function simplify(pts, tol) {
  const n = pts.length / 2;
  if (tol <= 0 || n <= 2) return pts;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = pts[2 * a], ay = pts[2 * a + 1];
    const dx = pts[2 * b] - ax, dy = pts[2 * b + 1] - ay;
    const len2 = dx * dx + dy * dy;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[2 * i] - ax, py = pts[2 * i + 1] - ay;
      const t = len2 > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
      const ex = px - t * dx, ey = py - t * dy;
      const d = ex * ex + ey * ey;
      if (d > best) (best = d), (bi = i);
    }
    if (best > tol2) {
      keep[bi] = 1;
      stack.push([a, bi], [bi, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[2 * i], pts[2 * i + 1]);
  return out;
}

/**
 * Clip a polyline to the rectangle [w, e] × [s, n]; returns the pieces inside
 * (each [x0, y0, x1, y1, ...]). Liang–Barsky per segment, joining consecutive pieces.
 */
export function clipPolyline(pts, w, s, e, n) {
  const pieces = [];
  let run = null;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const x0 = pts[i], y0 = pts[i + 1], x1 = pts[i + 2], y1 = pts[i + 3];
    const dx = x1 - x0, dy = y1 - y0;
    let t0 = 0, t1 = 1;
    let inside = true;
    for (const [p, q] of [[-dx, x0 - w], [dx, e - x0], [-dy, y0 - s], [dy, n - y0]]) {
      if (p === 0) {
        if (q < 0) inside = false;
      } else {
        const r = q / p;
        if (p < 0) t0 = Math.max(t0, r);
        else t1 = Math.min(t1, r);
      }
    }
    if (!inside || t0 >= t1) { // outside, or only touching a corner or edge
      if (run) pieces.push(run), (run = null);
      continue;
    }
    const ax = x0 + t0 * dx, ay = y0 + t0 * dy, bx = x0 + t1 * dx, by = y0 + t1 * dy;
    if (run && t0 === 0) run.push(bx, by);
    else {
      if (run) pieces.push(run);
      run = [ax, ay, bx, by];
    }
    if (t1 < 1) pieces.push(run), (run = null);
  }
  if (run) pieces.push(run);
  return pieces;
}
