// Map overlays of power infrastructure:
//   - line tiles (built by scripts/build-grid-lines.mjs for gridfinder and by
//     scripts/build-power.mjs for OpenStreetMap lines), drawn on canvas with a
//     style per class (voltage level);
//   - point layers for OpenStreetMap substations and power plants;
//   - the "Power infrastructure" panel in the top-right corner of the map.

import { loadBinary } from './grid-data.js';
import { decodeLines, lineTileId } from './grid-lines-codec.js';
import { VOLTAGE_CLASSES, PLANT_SOURCES } from './power.js';

const RAD = Math.PI / 180;
const TILE_CACHE_SIZE = 400;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Load an overlay's index.json; null if it has not been built. */
export async function loadOverlayIndex(base) {
  try {
    const r = await fetch(`${base}index.json`, { cache: 'no-cache' });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** Web Mercator pixel position of lon/lat at a zoom where the world is `world` pixels wide. */
const px = (lon, lat, world) => {
  const s = Math.sin(lat * RAD);
  return [((lon + 180) / 360) * world, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world];
};
const lonLatOfPixel = (x, y, world) => [(x / world) * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / world))) / RAD];

/** Tile bounds in degrees (with a small pixel margin), for a normalised tile x. */
function tileBounds(coords, size, padPx = 6) {
  const n = 2 ** coords.z, world = size.x * n;
  const x0 = (((coords.x % n) + n) % n) * size.x, y0 = coords.y * size.y;
  const [west, north] = lonLatOfPixel(x0 - padPx, y0 - padPx, world);
  const [east, south] = lonLatOfPixel(x0 + size.x + padPx, y0 + size.y + padPx, world);
  return { x0, y0, world, west, east, south, north };
}

function canvasTile(L, size) {
  const tile = L.DomUtil.create('canvas', 'leaflet-tile');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  tile.width = size.x * dpr;
  tile.height = size.y * dpr;
  const ctx = tile.getContext('2d');
  ctx.scale(dpr, dpr);
  return { tile, ctx };
}

/** Distance (px) from point p to segment a-b. */
function segDist(px0, py0, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px0 - ax) * dx + (py0 - ay) * dy) / len2)) : 0;
  return Math.hypot(px0 - ax - t * dx, py0 - ay - t * dy);
}

/**
 * Canvas layer for line tiles. `levels` come from an index.json (base: its folder).
 * style(cls, zoom) -> { color, width, dash } | null (null = hidden).
 */
export function createLineLayer(L, base, levels, style, options = {}) {
  const lv = levels.map((l) => ({ ...l, tileSet: new Set(l.tiles) }));
  const cache = new Map(); // `${level}/${id}` -> Promise<lines>
  const loaded = new Map(); // same keys -> lines, once loaded (for hit tests)
  function dataTile(li, id) {
    const key = `${li}/${id}`;
    let p = cache.get(key);
    if (p) {
      cache.delete(key);
      cache.set(key, p);
      return p;
    }
    const l = lv[li];
    const [r, c] = id.split('_').map(Number);
    p = loadBinary(`${base}${l.path}${id}.bin.gz`)
      .then((buf) => decodeLines(buf, c * l.tileDeg, r * l.tileDeg, l.quantum))
      .catch(() => [])
      .then((lines) => (loaded.set(key, lines), lines));
    cache.set(key, p);
    if (cache.size > TILE_CACHE_SIZE) {
      const old = cache.keys().next().value;
      cache.delete(old);
      loaded.delete(old);
    }
    return p;
  }
  const levelFor = (z) => lv.findIndex((l) => z >= l.minZoom && z <= l.maxZoom);
  function idsIn(li, b) {
    const d = lv[li].tileDeg, ids = [];
    for (let r = Math.floor(b.south / d); r <= Math.floor(b.north / d); r++) {
      for (let c = Math.floor(b.west / d); c <= Math.floor(b.east / d); c++) {
        const id = lineTileId(r, c);
        if (lv[li].tileSet.has(id)) ids.push(id);
      }
    }
    return ids;
  }

  const LineLayer = L.GridLayer.extend({
    createTile(coords, done) {
      const size = this.getTileSize();
      const { tile, ctx } = canvasTile(L, size);
      this._draw(ctx, coords, size).then(
        () => done(null, tile),
        (e) => done(e, tile)
      );
      return tile;
    },

    async _draw(ctx, coords, size) {
      const z = coords.z;
      const li = levelFor(z);
      if (li < 0) return;
      const b = tileBounds(coords, size);
      const ids = idsIn(li, b);
      if (!ids.length) return;
      const groups = await Promise.all(ids.map((id) => dataTile(li, id)));
      // One path per class; lower classes (higher index = lower voltage) are drawn first.
      const paths = new Map();
      for (const lines of groups) {
        for (const pts of lines) {
          if (!paths.has(pts.cls)) {
            const st = style(pts.cls, z);
            paths.set(pts.cls, st ? { st, path: new Path2D() } : null);
          }
          const entry = paths.get(pts.cls);
          if (!entry) continue;
          for (let i = 0; i < pts.length; i += 2) {
            const [x, y] = px(pts[i], pts[i + 1], b.world);
            if (i === 0) entry.path.moveTo(x - b.x0, y - b.y0);
            else entry.path.lineTo(x - b.x0, y - b.y0);
          }
        }
      }
      const order = [...paths.entries()].filter(([, e]) => e).sort((a, c) => c[0] - a[0]);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
      for (const [, { st, path }] of order) {
        ctx.lineWidth = st.width + 2;
        ctx.setLineDash([]);
        ctx.stroke(path);
      }
      for (const [, { st, path }] of order) {
        ctx.strokeStyle = st.color;
        ctx.lineWidth = st.width;
        ctx.setLineDash(st.dash ?? []);
        ctx.stroke(path);
      }
    },

    /** Nearest visible line within tolPx of a lat/lon at the map's zoom: { cls, px } or null (only loaded tiles). */
    hit(lat, lon, z, tolPx = 5) {
      const li = levelFor(z);
      if (li < 0) return null;
      const world = 256 * 2 ** z;
      const [mx, my] = px(lon, lat, world);
      let best = null;
      const pad = (tolPx / world) * 360 * 2;
      for (const id of idsIn(li, { west: lon - pad, east: lon + pad, south: lat - pad, north: lat + pad })) {
        const lines = loaded.get(`${li}/${id}`);
        if (!lines) continue;
        for (const pts of lines) {
          if (!style(pts.cls, z)) continue;
          let [ax, ay] = px(pts[0], pts[1], world);
          for (let i = 2; i < pts.length; i += 2) {
            const [bx, by] = px(pts[i], pts[i + 1], world);
            const dist = segDist(mx, my, ax, ay, bx, by);
            if (dist <= tolPx && (!best || dist < best.px)) best = { cls: pts.cls, px: dist };
            ax = bx;
            ay = by;
          }
        }
      }
      return best;
    },
  });
  return new LineLayer({ updateWhenZooming: false, keepBuffer: 1, ...options });
}

/**
 * Canvas layer for point symbols. items: arrays whose first two values are lon, lat.
 * symbol(item, zoom) -> { shape: 'square' | 'circle', r, color } | null (null = hidden).
 */
export function createPointLayer(L, items, symbol, options = {}) {
  const buckets = new Map(); // "row_col" (1°) -> [items]
  for (const it of items) {
    const k = `${Math.floor(it[1])}_${Math.floor(it[0])}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(it);
  }
  function* itemsIn(b) {
    for (let r = Math.floor(b.south); r <= Math.floor(b.north); r++) {
      for (let c = Math.floor(b.west); c <= Math.floor(b.east); c++) yield* buckets.get(`${r}_${c}`) ?? [];
    }
  }
  const PointLayer = L.GridLayer.extend({
    createTile(coords) {
      const size = this.getTileSize();
      const { tile, ctx } = canvasTile(L, size);
      const b = tileBounds(coords, size, 14);
      const drawn = [];
      for (const it of itemsIn(b)) {
        const s = symbol(it, coords.z);
        if (!s) continue;
        const [x, y] = px(it[0], it[1], b.world);
        drawn.push([s, x - b.x0, y - b.y0]);
      }
      drawn.sort((a, c) => c[0].r - a[0].r); // small symbols on top of large ones
      for (const [s, x, y] of drawn) {
        ctx.beginPath();
        if (s.shape === 'square') {
          // Substations: white square with a border in the voltage colour, so they stand out on their own lines.
          ctx.rect(x - s.r, y - s.r, 2 * s.r, 2 * s.r);
          ctx.fillStyle = '#fff';
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = s.color;
          ctx.stroke();
          ctx.lineWidth = 0.8;
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
          ctx.strokeRect(x - s.r - 1.4, y - s.r - 1.4, 2 * s.r + 2.8, 2 * s.r + 2.8);
        } else {
          ctx.arc(x, y, s.r, 0, 2 * Math.PI);
          ctx.fillStyle = s.color;
          ctx.fill();
          ctx.lineWidth = 1.2;
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
          ctx.stroke();
        }
      }
      return tile;
    },

    /** Nearest visible item under the cursor: { item, px } or null. */
    hit(lat, lon, z, tolPx = 4) {
      const world = 256 * 2 ** z;
      const [mx, my] = px(lon, lat, world);
      const pad = ((tolPx + 14) / world) * 360 * 2;
      let best = null;
      for (const it of itemsIn({ west: lon - pad, east: lon + pad, south: lat - pad, north: lat + pad })) {
        const s = symbol(it, z);
        if (!s) continue;
        const [x, y] = px(it[0], it[1], world);
        const dist = Math.hypot(x - mx, y - my) - s.r;
        if (dist <= tolPx && (!best || dist < best.px)) best = { item: it, px: dist };
      }
      return best;
    },
  });
  return new PointLayer({ updateWhenZooming: false, keepBuffer: 1, ...options });
}

/** Load a gzip'd JSON file (e.g. substations.json.gz). */
export async function loadJsonGz(url) {
  const buf = await loadBinary(url);
  return JSON.parse(new TextDecoder().decode(buf));
}

// ------------------------------------------------------------ styles

const zoomScale = (z) => (z <= 5 ? 0.6 : z <= 7 ? 0.8 : z <= 10 ? 1 : 1.2);

/** Style of OSM line class c (= voltage class * 2 + cable flag), given the hidden classes. */
export function osmLineStyle(hidden) {
  return (c, z) => {
    const vc = c >> 1;
    if (hidden.has(vc)) return null;
    const k = VOLTAGE_CLASSES[vc];
    return { color: k.color, width: k.width * zoomScale(z), dash: c & 1 ? [5, 4] : null };
  };
}

export const gridfinderStyle = (c, z) => ({ color: 'rgba(17, 17, 17, 0.9)', width: z <= 5 ? 0.9 : z <= 8 ? 1.2 : 1.6 });

/** Substation symbol: square in the voltage colour; lower voltages appear as you zoom in. */
export function substationSymbol(hidden) {
  return (it, z) => {
    const vc = it[2], kv = it[3];
    if (hidden.has(vc)) return null;
    const minKv = z <= 5 ? 220 : z <= 7 ? 66 : 0;
    if (kv < minKv || (minKv && !kv)) return null;
    return { shape: 'square', r: (kv >= 200 ? 4.5 : kv >= 60 ? 3.8 : 3) * (z <= 6 ? 0.8 : 1), color: VOLTAGE_CLASSES[vc].color };
  };
}

/** Power-plant symbol: circle in the source colour, area ~ capacity; small plants appear as you zoom in. */
export function plantSymbol(hiddenSources) {
  return (it, z) => {
    const src = it[2], mw = it[3];
    if (hiddenSources.has(src)) return null;
    const minMw = z <= 5 ? 100 : z <= 7 ? 10 : 0;
    if (minMw && !(mw >= minMw)) return null;
    return { shape: 'circle', r: 3 + Math.min(9, Math.sqrt(mw || 0) / 2.2), color: PLANT_SOURCES[src].color };
  };
}

/** Hover text for a hit. */
export function describeHit(kind, hit) {
  if (kind === 'line') {
    const k = VOLTAGE_CLASSES[hit.cls >> 1];
    return `Power ${hit.cls & 1 ? 'cable' : 'line'} · <b>${k.label}</b> <span class="muted">(OpenStreetMap)</span>`;
  }
  if (kind === 'gridfinder') return 'Predicted medium-voltage line <span class="muted">(gridfinder)</span>';
  const it = hit.item;
  if (kind === 'substation') {
    return `Substation${it[4] ? ` · ${esc(it[4])}` : ''} · <b>${it[3] ? `${+it[3].toFixed(1)} kV` : 'voltage unknown'}</b>`;
  }
  const src = PLANT_SOURCES[it[2]];
  return `${src.label} plant${it[4] ? ` · ${esc(it[4])}` : ''} · <b>${it[3] ? `${it[3].toLocaleString('en-US', { maximumFractionDigits: 1 })} MW` : 'capacity unknown'}</b>`;
}

// ------------------------------------------------------------ panel

/**
 * Top-right panel. `avail` = { osm: index | null, gridfinder: index | null };
 * `state` = { lines, substations, plants, gridfinder, hidden: Set, hiddenSources: Set, open };
 * onChange(state) is called after every change.
 */
export function createPowerPanel(L, avail, state, onChange) {
  const Panel = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const el = L.DomUtil.create('div', 'leaflet-control power-panel');
      const osm = avail.osm;
      const noOsm = osm ? '' : 'OpenStreetMap power data has not been built yet (npm run build-power)';
      const noGf = avail.gridfinder ? '' : 'gridfinder lines have not been built yet (npm run build-grid-lines)';
      const sw = (key, label, reason, extra = '') => `<label class="switch-row"${reason ? ` title="${reason}"` : ''}>
          <input type="checkbox" role="switch" data-layer="${key}" ${state[key] && !reason ? 'checked' : ''} ${reason ? 'disabled' : ''}>
          <span class="switch" aria-hidden="true"></span><span>${label}${extra}</span></label>`;
      const classes = osm
        ? VOLTAGE_CLASSES.map((k, i) => ({ k, i, info: osm.classes?.[i] ?? {} })).filter(({ info }) => info.km > 0 || info.substations > 0)
        : [];
      const fmtN = (x) => Math.round(x).toLocaleString('en-US');
      const classRows = classes
        .map(
          ({ k, i, info }) => `<label class="pp-row" title="${esc(k.range)}">
            <input type="checkbox" data-cls="${i}" ${state.hidden.has(i) ? '' : 'checked'}>
            <span class="pp-line" style="--c:${k.color};--w:${Math.max(2, k.width + 0.5)}px"></span>
            <span class="pp-name">${k.label}</span>
            <span class="pp-meta">${info.km ? `${fmtN(info.km)} km` : ''}${info.km && info.substations ? ' · ' : ''}${info.substations ? `${fmtN(info.substations)} sub.` : ''}</span>
          </label>`
        )
        .join('');
      const sources = osm ? PLANT_SOURCES.map((s, i) => ({ s, i, info: osm.sources?.[i] ?? {} })).filter(({ info }) => info.plants > 0) : [];
      const sourceRows = sources
        .map(
          ({ s, i, info }) => `<label class="pp-row">
            <input type="checkbox" data-src="${i}" ${state.hiddenSources.has(i) ? '' : 'checked'}>
            <span class="pp-dot" style="--c:${s.color}"></span>
            <span class="pp-name">${s.label}</span>
            <span class="pp-meta">${fmtN(info.plants)}${info.mw ? ` · ${fmtN(info.mw)} MW` : ''}</span>
          </label>`
        )
        .join('');
      el.innerHTML = `
        <button type="button" class="pp-head" aria-expanded="${state.open}">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 1 3 9h4l-1 6 6-8H8z"/></svg>
          <span>Power infrastructure</span><span class="pp-count"></span><span class="pp-caret" aria-hidden="true">▾</span>
        </button>
        <div class="pp-body" ${state.open ? '' : 'hidden'}>
          ${sw('lines', 'Power lines', noOsm, ' <span class="muted">OpenStreetMap</span>')}
          ${
            classes.length
              ? `<div class="pp-sub"><div class="pp-actions"><span>Voltage levels</span>
                  <button type="button" data-set="all">All</button><button type="button" data-set="tx">≥ 66 kV</button><button type="button" data-set="none">None</button></div>
                  <div class="pp-list">${classRows}</div>
                  <p class="pp-note">Dashed: underground or submarine cable. Levels apply to lines and substations.</p></div>`
              : ''
          }
          ${sw('substations', '<span class="pp-square" style="--c:#55534e;display:inline-block;vertical-align:-1px;margin-right:5px"></span>Substations', noOsm, ' <span class="muted">OpenStreetMap</span>')}
          ${sw('plants', 'Power plants', noOsm, ' <span class="muted">OpenStreetMap</span>')}
          ${sources.length ? `<div class="pp-sub"><div class="pp-list">${sourceRows}</div><p class="pp-note">Circle area ~ capacity. Small plants appear as you zoom in.</p></div>` : ''}
          ${sw('gridfinder', 'Predicted MV grid', noGf, ' <span class="muted">gridfinder</span>')}
          ${avail.gridfinder ? '<p class="pp-note" style="margin:-4px 0 0 36px">Thin black lines: modelled from satellite night lights, not surveyed.</p>' : ''}
          ${osm?.failed?.length ? `<p class="pp-note warn">Missing countries (download failed): ${osm.failed.join(', ')}</p>` : ''}
        </div>`;
      L.DomEvent.disableClickPropagation(el);
      L.DomEvent.disableScrollPropagation(el);
      const head = el.querySelector('.pp-head'), body = el.querySelector('.pp-body');
      const count = () => {
        const n = ['lines', 'substations', 'plants', 'gridfinder'].filter((k) => state[k]).length;
        el.querySelector('.pp-count').textContent = n ? `${n} on` : '';
      };
      count();
      head.addEventListener('click', () => {
        state.open = body.hidden;
        body.hidden = !state.open;
        head.setAttribute('aria-expanded', String(state.open));
        onChange(state, 'open');
      });
      el.addEventListener('change', (e) => {
        const t = e.target;
        if (t.dataset.layer) state[t.dataset.layer] = t.checked;
        else if (t.dataset.cls) t.checked ? state.hidden.delete(+t.dataset.cls) : state.hidden.add(+t.dataset.cls);
        else if (t.dataset.src) t.checked ? state.hiddenSources.delete(+t.dataset.src) : state.hiddenSources.add(+t.dataset.src);
        count();
        onChange(state, t.dataset.layer ?? (t.dataset.cls ? 'classes' : 'sources'));
      });
      el.querySelectorAll('[data-set]').forEach((btn) =>
        btn.addEventListener('click', () => {
          state.hidden.clear();
          classes.forEach(({ k, i }) => {
            const show = btn.dataset.set === 'all' || (btn.dataset.set === 'tx' && k.min >= 60);
            if (!show) state.hidden.add(i);
          });
          el.querySelectorAll('[data-cls]').forEach((cb) => (cb.checked = !state.hidden.has(+cb.dataset.cls)));
          onChange(state, 'classes');
        })
      );
      return el;
    },
  });
  return new Panel();
}
