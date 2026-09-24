// Leaflet layer that paints the grid values in Web Mercator, tile by tile,
// straight from the per-cell colours (no image reprojection needed).

const DEG = 180 / Math.PI;

export function createHeatLayer(L, options = {}) {
  const HeatLayer = L.GridLayer.extend({
    initialize(opts) {
      L.GridLayer.prototype.initialize.call(this, opts);
      this._data = null;
    },

    setData(data) {
      this._data = data;
      this.refresh();
    },

    /** Repaint the existing tiles in place (no flicker). */
    refresh() {
      if (!this._map) return;
      for (const key in this._tiles) {
        const t = this._tiles[key];
        this._paint(t.el, t.coords);
      }
    },

    createTile(coords) {
      const tile = L.DomUtil.create('canvas', 'leaflet-tile');
      const size = this.getTileSize();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      tile.width = size.x * dpr;
      tile.height = size.y * dpr;
      this._paint(tile, coords);
      return tile;
    },

    _paint(canvas, coords) {
      const ctx = canvas.getContext('2d');
      const w = canvas.width;
      const h = canvas.height;
      const d = this._data;
      if (!d) {
        ctx.clearRect(0, 0, w, h);
        return;
      }
      const size = this.getTileSize();
      const scale = w / size.x;
      const world = size.x * 2 ** coords.z;
      const { nx, ny, res, gridIndex, colors, values, lut, lo, hi, smooth } = d;
      const img = ctx.createImageData(w, h);
      const px = new Uint32Array(img.data.buffer);

      // Fractional grid coordinates of every pixel row / column.
      const fy = new Float64Array(h);
      for (let y = 0; y < h; y++) {
        const yw = coords.y * size.y + (y + 0.5) / scale;
        if (yw < 0 || yw > world) { fy[y] = NaN; continue; }
        const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * yw) / world))) * DEG;
        fy[y] = (90 - lat) / res;
      }
      const fx = new Float64Array(w);
      for (let x = 0; x < w; x++) {
        const xw = coords.x * size.x + (x + 0.5) / scale;
        let lon = (xw / world) * 360 - 180;
        lon = ((((lon + 180) % 360) + 360) % 360) - 180;
        fx[x] = (lon + 180) / res;
      }

      const span = hi - lo || 1;
      for (let y = 0; y < h; y++) {
        const gy = fy[y];
        if (!(gy >= 0 && gy < ny)) continue;
        const row = Math.floor(gy);
        const o = y * w;
        for (let x = 0; x < w; x++) {
          const gx = fx[x];
          const col = Math.min(nx - 1, Math.floor(gx));
          const pos = gridIndex[row * nx + col];
          if (pos < 0) continue;
          if (!smooth) {
            px[o + x] = colors[pos];
            continue;
          }
          // Bilinear interpolation over the valid neighbouring cells.
          const ty = gy - 0.5, tx = gx - 0.5;
          const r0 = Math.floor(ty), c0 = Math.floor(tx);
          const wy = ty - r0, wx = tx - c0;
          let sum = 0, wsum = 0;
          for (let a = 0; a < 2; a++) {
            const rr = r0 + a;
            if (rr < 0 || rr >= ny) continue;
            for (let b = 0; b < 2; b++) {
              const cc = (((c0 + b) % nx) + nx) % nx;
              const p = gridIndex[rr * nx + cc];
              if (p < 0) continue;
              const v = values[p];
              if (!Number.isFinite(v)) continue;
              const ww = (a ? wy : 1 - wy) * (b ? wx : 1 - wx);
              sum += ww * v;
              wsum += ww;
            }
          }
          if (wsum <= 0) continue;
          const t = (sum / wsum - lo) / span;
          px[o + x] = lut[Math.max(0, Math.min(255, Math.round(t * 255)))];
        }
      }
      ctx.putImageData(img, 0, 0);
    },
  });
  return new HeatLayer({ updateWhenZooming: false, keepBuffer: 1, ...options });
}
