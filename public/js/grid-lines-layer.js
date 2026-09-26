// Map overlay of the gridfinder power-line network (tiles built by
// scripts/build-grid-lines.mjs), drawn as dark thin lines with a light halo
// so they stay readable over any heatmap colour.

import { loadBinary } from './grid-data.js';
import { decodeLines, lineTileId } from './grid-lines-codec.js';

const RAD = Math.PI / 180;
const TILE_CACHE_SIZE = 400;

/** Load public/data/gridlines/index.json; null if the overlay has not been built. */
export async function loadGridLinesIndex(base = 'data/gridlines/') {
  try {
    const r = await fetch(`${base}index.json`, { cache: 'no-cache' });
    if (!r.ok) return null;
    const index = await r.json();
    return index.version === 1 ? { ...index, base, levels: index.levels.map((l) => ({ ...l, tileSet: new Set(l.tiles) })) } : null;
  } catch {
    return null;
  }
}

export function createGridLinesLayer(L, index, options = {}) {
  const cache = new Map(); // `${level}/${id}` -> Promise<lines>
  function dataTile(li, id) {
    const key = `${li}/${id}`;
    let p = cache.get(key);
    if (p) {
      cache.delete(key);
      cache.set(key, p);
      return p;
    }
    const lv = index.levels[li];
    const [r, c] = id.split('_').map(Number);
    p = loadBinary(`${index.base}${lv.path}${id}.bin.gz`)
      .then((buf) => decodeLines(buf, c * lv.tileDeg, r * lv.tileDeg, lv.quantum))
      .catch(() => []);
    cache.set(key, p);
    if (cache.size > TILE_CACHE_SIZE) cache.delete(cache.keys().next().value);
    return p;
  }

  const GridLinesLayer = L.GridLayer.extend({
    createTile(coords, done) {
      const tile = L.DomUtil.create('canvas', 'leaflet-tile');
      const size = this.getTileSize();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      tile.width = size.x * dpr;
      tile.height = size.y * dpr;
      this._draw(tile, coords, size, dpr).then(
        () => done(null, tile),
        (e) => done(e, tile)
      );
      return tile;
    },

    async _draw(canvas, coords, size, dpr) {
      const z = coords.z;
      const li = index.levels.findIndex((l) => z >= l.minZoom && z <= l.maxZoom);
      if (li < 0) return;
      const lv = index.levels[li];
      const nTiles = 2 ** z;
      const world = size.x * nTiles;
      const x0 = (((coords.x % nTiles) + nTiles) % nTiles) * size.x; // wrap around the antimeridian
      const y0 = coords.y * size.y;
      // Tile bounds in degrees, plus a small margin so line halos are not cut at tile edges.
      const pad = 4 / size.x;
      const lonW = ((x0 / size.x - pad) / nTiles) * 360 - 180;
      const lonE = ((x0 / size.x + 1 + pad) / nTiles) * 360 - 180;
      const latOf = (yPix) => Math.atan(Math.sinh(Math.PI * (1 - (2 * yPix) / world))) / RAD;
      const latN = latOf(y0 - pad * size.y);
      const latS = latOf(y0 + (1 + pad) * size.y);
      const d = lv.tileDeg;
      const ids = [];
      for (let r = Math.floor(latS / d); r <= Math.floor(latN / d); r++) {
        for (let c = Math.floor(lonW / d); c <= Math.floor(lonE / d); c++) {
          const id = lineTileId(r, c);
          if (lv.tileSet.has(id)) ids.push(id);
        }
      }
      if (!ids.length) return;
      const groups = await Promise.all(ids.map((id) => dataTile(li, id)));

      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const lines of groups) {
        for (const pts of lines) {
          for (let i = 0; i < pts.length; i += 2) {
            const x = ((pts[i] + 180) / 360) * world - x0;
            const s = Math.sin(pts[i + 1] * RAD);
            const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world - y0;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
        }
      }
      const w = z <= 5 ? 0.9 : z <= 8 ? 1.2 : 1.6;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.lineWidth = w + 2;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(17, 17, 17, 0.9)';
      ctx.lineWidth = w;
      ctx.stroke();
    },
  });
  return new GridLinesLayer({ updateWhenZooming: false, keepBuffer: 1, ...options });
}

/** Top-right map control with an on/off switch. */
export function createGridLinesToggle(L, { checked, disabledReason, onChange }) {
  const Toggle = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const el = L.DomUtil.create('div', 'leaflet-control map-toggle');
      el.innerHTML = `<label class="switch-row"${disabledReason ? ` title="${disabledReason}"` : ''}>
        <input type="checkbox" role="switch" ${checked ? 'checked' : ''} ${disabledReason ? 'disabled' : ''}>
        <span class="switch" aria-hidden="true"></span>
        <span>Power grid</span>
      </label>`;
      L.DomEvent.disableClickPropagation(el);
      L.DomEvent.disableScrollPropagation(el);
      const input = el.querySelector('input');
      input.addEventListener('change', () => onChange(input.checked));
      this.input = input;
      return el;
    },
  });
  return new Toggle();
}
