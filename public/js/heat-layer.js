// Leaflet layer that paints the grid values in Web Mercator, tile by tile,
// straight from the per-cell colours (no image reprojection needed). Several
// grids can be shown at once; where a finer grid has data it is drawn on top.
//
// setData({ layers: [{ res, nx, ny, cpb, nbx, blocks: Array(nbx*nby) of
//   { row0, col0, local, colors, values } }], lut, lo, hi, smooth })
// with layers ordered fine -> coarse.

const DEG = 180 / Math.PI;
/** Colour of a cell that is deliberately not shown: transparent, but hides coarser grids below. */
export const HIDDEN = 1;

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
      if (!d || !d.layers.length) {
        ctx.clearRect(0, 0, w, h);
        return;
      }
      const size = this.getTileSize();
      const scale = w / size.x;
      const world = size.x * 2 ** coords.z;
      const img = ctx.createImageData(w, h);
      const px = new Uint32Array(img.data.buffer);

      const lat = new Float64Array(h);
      for (let y = 0; y < h; y++) {
        const yw = coords.y * size.y + (y + 0.5) / scale;
        lat[y] = yw < 0 || yw > world ? NaN : Math.atan(Math.sinh(Math.PI * (1 - (2 * yw) / world))) * DEG;
      }
      const lon = new Float64Array(w);
      for (let x = 0; x < w; x++) {
        const xw = coords.x * size.x + (x + 0.5) / scale;
        const l = (xw / world) * 360 - 180;
        lon[x] = ((((l + 180) % 360) + 360) % 360) - 180;
      }

      const painted = new Uint8Array(w * h);
      const span = d.hi - d.lo || 1;
      for (const layer of d.layers) {
        const { res, nx, ny, cpb, nbx, blocks } = layer;
        // Grid row / column of every pixel row / column (fractional for smoothing).
        const fy = new Float64Array(h);
        for (let y = 0; y < h; y++) fy[y] = (90 - lat[y]) / res;
        const fx = new Float64Array(w);
        for (let x = 0; x < w; x++) fx[x] = (lon[x] + 180) / res;
        const valueAt = (row, col) => {
          if (row < 0 || row >= ny) return NaN;
          col = ((col % nx) + nx) % nx;
          const br = Math.floor(row / cpb), bc = Math.floor(col / cpb);
          const b = blocks[br * nbx + bc];
          if (!b) return NaN;
          const p = b.local[(row - b.row0) * cpb + (col - b.col0)];
          return p >= 0 ? b.values[p] : NaN;
        };
        for (let y = 0; y < h; y++) {
          const gy = fy[y];
          if (!(gy >= 0 && gy < ny)) continue;
          const row = Math.floor(gy);
          const br = Math.floor(row / cpb);
          const o = y * w;
          for (let x = 0; x < w; x++) {
            if (painted[o + x]) continue;
            const col = Math.min(nx - 1, Math.floor(fx[x]));
            const b = blocks[br * nbx + Math.floor(col / cpb)];
            if (!b) continue;
            const pos = b.local[(row - b.row0) * cpb + (col - b.col0)];
            if (pos < 0 || !b.colors[pos]) continue;
            painted[o + x] = 1;
            if (!d.smooth || b.colors[pos] === HIDDEN) {
              px[o + x] = b.colors[pos];
              continue;
            }
            // Bilinear interpolation over the valid neighbouring cells of this grid.
            const ty = gy - 0.5, tx = fx[x] - 0.5;
            const r0 = Math.floor(ty), c0 = Math.floor(tx);
            const wy = ty - r0, wx = tx - c0;
            let sum = 0, wsum = 0;
            for (let a = 0; a < 2; a++) {
              for (let c = 0; c < 2; c++) {
                const v = valueAt(r0 + a, c0 + c);
                if (!Number.isFinite(v)) continue;
                const ww = (a ? wy : 1 - wy) * (c ? wx : 1 - wx);
                sum += ww * v;
                wsum += ww;
              }
            }
            const t = wsum > 0 ? (sum / wsum - d.lo) / span : (b.values[pos] - d.lo) / span;
            px[o + x] = d.lut[Math.max(0, Math.min(255, Math.round(t * 255)))];
          }
        }
      }
      ctx.putImageData(img, 0, 0);
    },
  });
  return new HeatLayer({ updateWhenZooming: false, keepBuffer: 1, ...options });
}
