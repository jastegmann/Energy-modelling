// Solar Yield Map: UI wiring.

import { DEFAULT_PARAMS, PARAM_INFO } from './model/losses.js';
import { FIXED_GCRS, EW_GCRS, TRACKER_GCRS, TRACKER_LIMITS } from './model/configs.js';
import { loadDatasets, blockResults, cellStages, pickValue } from './grid-data.js';
import { createHeatLayer } from './heat-layer.js';
import { VARIABLES, buildLut, cssGradient, niceTicks, autoRange } from './colors.js';
import { LocationCard, mountLabel } from './location.js';
import { countryList, collectCells, summaryHtml, toCsv, download } from './screening.js';

const L = window.L;
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- state
const DEFAULT_STATE = {
  mountType: 'fixed',
  fixed: { tilt: 25, gcr: 0, optimal: false },
  ew: { tilt: 10, gcr: 0 },
  tracker: { limit: 60, gcr: 0.35, backtrack: true },
  variable: 'yield',
  scaleMode: 'fixed',
  opacity: 0.75,
  smooth: false,
};
const state = structuredClone(DEFAULT_STATE);
state.params = { ...DEFAULT_PARAMS };

function currentMount() {
  if (state.mountType === 'fixed') return { type: 'fixed', ...state.fixed };
  if (state.mountType === 'ew') return { type: 'ew', ...state.ew };
  return { type: 'tracker', ...state.tracker };
}
const getState = () => ({ ...state, mount: currentMount() });

// URL hash <-> state, so that a view can be bookmarked or shared.
function writeHash() {
  const q = new URLSearchParams();
  q.set('m', state.mountType);
  q.set('f', `${state.fixed.tilt},${state.fixed.gcr},${state.fixed.optimal ? 1 : 0}`);
  q.set('ew', `${state.ew.tilt},${state.ew.gcr}`);
  q.set('trk', `${state.tracker.limit},${state.tracker.gcr},${state.tracker.backtrack ? 1 : 0}`);
  q.set('v', state.variable);
  if (state.scaleMode !== 'fixed') q.set('scale', state.scaleMode);
  const changed = Object.keys(DEFAULT_PARAMS).filter((k) => state.params[k] !== DEFAULT_PARAMS[k]);
  if (changed.length) q.set('p', changed.map((k) => `${k}:${state.params[k]}`).join(','));
  if (map) {
    const c = map.getCenter();
    q.set('view', `${c.lat.toFixed(2)},${c.lng.toFixed(2)},${map.getZoom()}`);
  }
  if (card?.point) q.set('pt', `${card.point.lat.toFixed(4)},${card.point.lon.toFixed(4)}`);
  history.replaceState(null, '', `#${q}`);
}

function readHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  const nums = (s) => (s ?? '').split(',').map(Number);
  if (['fixed', 'ew', 'tracker'].includes(q.get('m'))) state.mountType = q.get('m');
  if (q.has('f')) {
    const [t, g, o] = nums(q.get('f'));
    if (t >= 0 && t <= 60) state.fixed.tilt = t;
    if (FIXED_GCRS.includes(g)) state.fixed.gcr = g;
    state.fixed.optimal = o === 1;
  }
  if (q.has('ew')) {
    const [t, g] = nums(q.get('ew'));
    if (t >= 5 && t <= 30) state.ew.tilt = t;
    if (EW_GCRS.includes(g)) state.ew.gcr = g;
  }
  if (q.has('trk')) {
    const [l, g, b] = nums(q.get('trk'));
    if (TRACKER_LIMITS.includes(l)) state.tracker.limit = l;
    if (TRACKER_GCRS.includes(g)) state.tracker.gcr = g;
    state.tracker.backtrack = b !== 0;
  }
  if (VARIABLES[q.get('v')]) state.variable = q.get('v');
  if (q.get('scale') === 'auto') state.scaleMode = 'auto';
  for (const kv of (q.get('p') ?? '').split(',').filter(Boolean)) {
    const [k, v] = kv.split(':');
    if (k in DEFAULT_PARAMS && Number.isFinite(+v)) state.params[k] = +v;
  }
  const view = nums(q.get('view'));
  const pt = nums(q.get('pt'));
  return {
    view: view.length === 3 && view.every(Number.isFinite) ? view : null,
    point: pt.length === 2 && pt.every(Number.isFinite) ? pt : null,
  };
}

// ---------------------------------------------------------------- controls
const gcrLabel = (g, isolated) => (g > 0 ? `GCR ${g.toFixed(2)}` : isolated);
function fillSelect(el, items) {
  el.innerHTML = items.map(([v, label]) => `<option value="${v}">${label}</option>`).join('');
}
fillSelect($('fixed-gcr'), FIXED_GCRS.map((g) => [g, gcrLabel(g, 'Isolated row (no mutual shading)')]));
fillSelect($('ew-gcr'), EW_GCRS.map((g) => [g, gcrLabel(g, 'Isolated pair (no mutual shading)')]));
fillSelect($('trk-gcr'), TRACKER_GCRS.map((g) => [g, gcrLabel(g, 'Isolated tracker (no mutual shading)')]));
fillSelect($('trk-limit'), TRACKER_LIMITS.map((l) => [l, `±${l}°`]));

for (const box of document.querySelectorAll('.params')) {
  box.innerHTML = box.dataset.params
    .split(',')
    .map((k) => {
      const i = PARAM_INFO[k];
      return `<label class="param"><span>${i.label}</span>
        <input type="number" data-param="${k}" min="${i.min}" max="${i.max}" step="${i.step}"><span class="unit">${i.unit}</span></label>`;
    })
    .join('');
}

const HINTS = {
  fixed: 'Equator-facing (azimuth 0°: south-facing in the northern hemisphere, north-facing in the southern). The map interpolates between 5° tilt steps.',
  ew: 'Back-to-back pairs facing east and west (azimuth ±90°). Each face carries half of the installed kWp.',
  tracker: 'Horizontal north–south axis, rotating from east to west. GCR sets the row spacing used for backtracking and shading.',
};

function syncControls() {
  document.querySelectorAll('.segmented button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mount === state.mountType)));
  document.querySelectorAll('.mount-opts').forEach((d) => (d.hidden = d.dataset.for !== state.mountType));
  $('mount-hint').textContent = HINTS[state.mountType];
  $('fixed-opt').checked = state.fixed.optimal;
  $('fixed-tilt-field').hidden = state.fixed.optimal;
  $('fixed-tilt').value = state.fixed.tilt;
  $('fixed-tilt-out').textContent = `${state.fixed.tilt}°`;
  $('fixed-gcr').value = state.fixed.gcr;
  $('ew-tilt').value = state.ew.tilt;
  $('ew-tilt-out').textContent = `${state.ew.tilt}°`;
  $('ew-gcr').value = state.ew.gcr;
  $('trk-limit').value = state.tracker.limit;
  $('trk-gcr').value = state.tracker.gcr;
  $('trk-bt').checked = state.tracker.backtrack;
  $('trk-bt').disabled = !(state.tracker.gcr > 0);
  const optOk = state.mountType === 'fixed' && state.fixed.optimal;
  if (state.variable === 'opttilt' && !optOk) state.variable = 'yield';
  $('variable').querySelector('[value="opttilt"]').disabled = !optOk;
  $('variable').value = state.variable;
  $('scale-mode').value = state.scaleMode;
  $('opacity').value = Math.round(state.opacity * 100);
  $('opacity-out').textContent = `${Math.round(state.opacity * 100)}%`;
  $('smooth').checked = state.smooth;
  document.querySelectorAll('[data-param]').forEach((el) => {
    if (document.activeElement !== el) el.value = state.params[el.dataset.param];
  });
}

let pending = null;
function changed({ map: redrawMap = true } = {}) {
  syncControls();
  writeHash();
  clearTimeout(pending);
  pending = setTimeout(() => {
    if (redrawMap) refreshMap();
    card?.update();
  }, 120);
}

document.querySelectorAll('.segmented button').forEach((b) =>
  b.addEventListener('click', () => {
    state.mountType = b.dataset.mount;
    changed();
  })
);
$('fixed-opt').addEventListener('change', (e) => ((state.fixed.optimal = e.target.checked), changed()));
$('fixed-tilt').addEventListener('input', (e) => ((state.fixed.tilt = +e.target.value), changed()));
$('fixed-gcr').addEventListener('change', (e) => ((state.fixed.gcr = +e.target.value), changed()));
$('ew-tilt').addEventListener('input', (e) => ((state.ew.tilt = +e.target.value), changed()));
$('ew-gcr').addEventListener('change', (e) => ((state.ew.gcr = +e.target.value), changed()));
$('trk-limit').addEventListener('change', (e) => ((state.tracker.limit = +e.target.value), changed()));
$('trk-gcr').addEventListener('change', (e) => ((state.tracker.gcr = +e.target.value), changed()));
$('trk-bt').addEventListener('change', (e) => ((state.tracker.backtrack = e.target.checked), changed()));
$('variable').addEventListener('change', (e) => ((state.variable = e.target.value), changed()));
$('scale-mode').addEventListener('change', (e) => ((state.scaleMode = e.target.value), changed()));
$('opacity').addEventListener('input', (e) => {
  state.opacity = e.target.value / 100;
  heat.setOpacity(state.opacity);
  syncControls();
});
$('smooth').addEventListener('change', (e) => {
  state.smooth = e.target.checked;
  changed();
});
document.querySelectorAll('[data-param]').forEach((el) =>
  el.addEventListener('input', () => {
    const k = el.dataset.param;
    const i = PARAM_INFO[k];
    const v = parseFloat(el.value);
    if (!Number.isFinite(v)) return;
    state.params[k] = Math.min(i.max, Math.max(i.min, v));
    changed();
  })
);
// Show the clamped value once the field loses focus.
document.querySelectorAll('[data-param]').forEach((el) => el.addEventListener('change', () => (el.value = state.params[el.dataset.param])));
$('reset').addEventListener('click', () => {
  Object.assign(state, structuredClone(DEFAULT_STATE));
  state.params = { ...DEFAULT_PARAMS };
  heat.setOpacity(state.opacity);
  changed();
});
$('panel-open').addEventListener('click', () => $('panel').classList.add('open'));
$('panel-close').addEventListener('click', () => $('panel').classList.remove('open'));

// ---------------------------------------------------------------- map
const initial = readHash();
const map = L.map('map', { worldCopyJump: true, minZoom: 2, maxZoom: 12, zoomControl: true }).setView(
  initial.view ? [initial.view[0], initial.view[1]] : [25, 10],
  initial.view ? initial.view[2] : 3
);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
map.createPane('heat');
map.getPane('heat').style.zIndex = 350;
map.getPane('heat').classList.add('heat-pane');
const heat = createHeatLayer(L, { pane: 'heat', opacity: state.opacity }).addTo(map);
map.on('moveend', () => {
  writeHash();
  clearTimeout(moveTimer);
  moveTimer = setTimeout(refreshMap, 150); // load blocks that came into view
});
let moveTimer = 0;

let datasets = []; // coarse -> fine
let shown = []; // layers currently painted, fine -> coarse: {ds, results: Map(blockId -> results)}
let range = [0, 1];
let card = null;
let marker = null;
let seq = 0;

async function refreshMap() {
  if (!datasets.length) return;
  const my = ++seq;
  const loading = setTimeout(() => ($('loading').hidden = false), 200);
  try {
    const mount = currentMount();
    const zoom = map.getZoom();
    const b = map.getBounds().pad(0.25);
    const box = [Math.max(-90, b.getSouth()), b.getWest(), Math.min(90, b.getNorth()), b.getEast()];
    const layers = [];
    const lacking = [];
    for (const ds of datasets) {
      if (zoom < ds.minZoom) continue;
      if (!ds.supports(mount)) {
        lacking.push(ds.name);
        continue;
      }
      const ids = ds.blockIdsIn(...box);
      const parts = await Promise.all(
        ids.map(async (id) => {
          const block = await ds.block(id);
          return { block, results: await blockResults(block, mount, state.params) };
        })
      );
      if (my !== seq) return;
      if (parts.length) layers.push({ ds, parts });
    }
    if (my !== seq) return;

    const meta = VARIABLES[state.variable];
    for (const l of layers) {
      for (const p of l.parts) {
        p.values = new Float32Array(p.block.M);
        for (let i = 0; i < p.block.M; i++) p.values[i] = pickValue(p.results, state.variable, i);
      }
    }
    if (state.scaleMode === 'auto') {
      const sample = [];
      for (const l of layers) for (const p of l.parts) for (let i = 0; i < p.values.length; i += 7) sample.push(p.values[i]);
      range = autoRange(sample);
    } else range = meta.range;
    const lut = buildLut(meta.ramp);
    const [lo, hi] = range;
    const heatLayers = [];
    for (const l of [...layers].reverse()) {
      const ds = l.ds;
      const blocks = new Array(ds.nbx * ds.nby);
      for (const p of l.parts) {
        const colors = new Uint32Array(p.block.M);
        for (let i = 0; i < p.block.M; i++) {
          const x = p.values[i];
          if (Number.isFinite(x)) colors[i] = lut[Math.max(0, Math.min(255, Math.round(((x - lo) / (hi - lo)) * 255)))];
        }
        blocks[p.block.br * ds.nbx + p.block.bc] = { row0: p.block.row0, col0: p.block.col0, local: p.block.local, colors, values: p.values };
      }
      heatLayers.push({ res: ds.res, nx: ds.nx, ny: ds.ny, cpb: ds.cpb, nbx: ds.nbx, blocks });
    }
    shown = [...layers].reverse().map((l) => ({ ds: l.ds, values: new Map(l.parts.map((p) => [p.block.id, p.values])) }));
    map.getPane('heat').classList.toggle('smooth', state.smooth);
    heat.setData({ layers: heatLayers, lut, lo, hi, smooth: state.smooth });
    renderLegend(meta, mount, layers.map((l) => l.ds), lacking);
  } catch (e) {
    console.error(e);
    showBanner(`Could not compute the map: ${e.message}`, true);
  } finally {
    clearTimeout(loading);
    if (my === seq) $('loading').hidden = true;
  }
}

function renderLegend(meta, mount, used, lacking) {
  $('legend').hidden = false;
  $('legend-title').textContent = `${meta.label} (${meta.unit})`;
  $('legend-bar').style.background = cssGradient(meta.ramp);
  const [lo, hi] = range;
  $('legend-ticks').innerHTML = niceTicks(lo, hi, 5)
    .filter((t) => t >= lo && t <= hi)
    .map((t) => `<span style="left:${((t - lo) / (hi - lo)) * 100}%">${t.toLocaleString('en-US')}</span>`)
    .join('');
  const what = state.variable === 'ghi' ? 'Horizontal plane' : mountLabel(mount);
  const grids = used.length ? `${used.map((d) => d.name).reverse().join(' / ')} grid` : 'no grid data for this setting';
  const miss = lacking.length ? ` · ${lacking.join(', ')} grid lacks this layout` : '';
  $('legend-note').textContent = `${what} · ${grids}${miss}${state.scaleMode === 'fixed' ? ' · values beyond the range are clamped' : ''}`;
}

function showBanner(html, warn = false) {
  const b = $('data-banner');
  b.innerHTML = html;
  b.classList.toggle('warn', warn);
  b.hidden = false;
}

// Hover read-out from the finest grid shown at the cursor.
let hoverFrame = 0;
map.on('mousemove', (e) => {
  if (!shown.length) return;
  cancelAnimationFrame(hoverFrame);
  hoverFrame = requestAnimationFrame(() => {
    const { lat, lng } = e.latlng;
    const lon = ((((lng + 180) % 360) + 360) % 360) - 180;
    const chip = $('hover');
    for (const { ds, values } of shown) {
      const hit = ds.lookup(lat, lon);
      const v = hit && values.get(hit.block.id)?.[hit.pos];
      if (!Number.isFinite(v)) continue;
      const meta = VARIABLES[state.variable];
      chip.innerHTML = `<b>${v.toLocaleString('en-US', { maximumFractionDigits: meta.digits })}</b> ${meta.unit} &nbsp;<span class="muted">${lat.toFixed(2)}°, ${lon.toFixed(2)}° · ${ds.name}</span>`;
      chip.hidden = false;
      return;
    }
    chip.hidden = true;
  });
});
map.on('mouseout', () => ($('hover').hidden = true));

/** Precomputed values of the finest grid cell (holding this mounting) at a point. */
async function gridCell(lat, lon, mount, params) {
  for (const ds of [...datasets].reverse()) {
    if (!ds.supports(mount)) continue;
    const [id] = ds.blockIdsIn(lat, lon, lat, lon);
    if (!id) continue;
    await ds.block(id);
    const hit = ds.lookup(lat, lon);
    if (!hit) continue;
    return { stages: await cellStages(hit.block, mount, params, hit.pos), res: ds.res, center: ds.cellCenter(hit.block, hit.pos) };
  }
  return null;
}

const pinIcon = L.divIcon({ className: 'pin', html: '<div class="pin-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
function openPoint(lat, lon) {
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  if (marker) marker.setLatLng([lat, lon]);
  else marker = L.marker([lat, lon], { icon: pinIcon, keyboard: false }).addTo(map);
  card.open(lat, lon);
  writeHash();
}
map.on('click', (e) => openPoint(e.latlng.lat, e.latlng.lng));

// ---------------------------------------------------------------- screening
let countries = new Map();
let lastResult = null;
async function runScreening() {
  const out = $('scr-out');
  const v = $('scr-scope').value;
  const b = map.getBounds();
  const scope = v === 'view' ? { type: 'view', bounds: { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() } } : { type: 'country', id: Number(v) };
  const mount = currentMount();
  out.innerHTML = '<p class="scr-sum"><span class="spinner"></span>Evaluating cells…</p>';
  $('scr-rank').disabled = $('scr-csv').disabled = true;
  try {
    const res = await collectCells(datasets, scope, mount, state.params, (i, n) => {
      out.innerHTML = `<p class="scr-sum"><span class="spinner"></span>Evaluating cells… ${i}/${n} blocks</p>`;
    });
    lastResult = res && { ...res, mount, params: { ...state.params }, scope: v };
    out.innerHTML = res ? summaryHtml(res, countries, mount) : '<p class="scr-sum">No grid cells for this area and mounting. Fetch and build a grid that covers it first.</p>';
  } catch (e) {
    console.error(e);
    out.innerHTML = `<p class="scr-sum">Screening failed: ${e.message}</p>`;
  } finally {
    $('scr-rank').disabled = $('scr-csv').disabled = false;
  }
  return lastResult;
}
$('scr-rank').addEventListener('click', runScreening);
$('scr-csv').addEventListener('click', async () => {
  const res = lastResult?.scope === $('scr-scope').value ? lastResult : await runScreening();
  if (!res) return;
  const name = $('scr-scope').value === 'view' ? 'map-view' : (countries.get(Number($('scr-scope').value)) ?? 'country').replace(/[^\w.-]+/g, '_');
  download(`solar-yield-${name}-${res.ds.res}deg.csv`, toCsv(res, countries, res.mount, res.params));
});
$('scr-out').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-lat]');
  if (!tr) return;
  const lat = Number(tr.dataset.lat), lon = Number(tr.dataset.lon);
  map.setView([lat, lon], Math.max(map.getZoom(), 7));
  openPoint(lat, lon);
});
$('scr-out').addEventListener('keydown', (e) => e.key === 'Enter' && e.target.click());

// ---------------------------------------------------------------- start
(async () => {
  syncControls();
  $('loading').hidden = false;
  try {
    datasets = await loadDatasets();
  } catch (e) {
    console.error(e);
    showBanner(`The precomputed grid could not be loaded: ${e.message}`, true);
  }
  $('loading').hidden = true;
  card = new LocationCard({
    gridCell,
    shiftFallback: (db) => [...datasets].reverse().map((d) => d.manifest.shiftByDatabase?.[db]?.median).find(Number.isFinite),
    getState,
    onClose: () => {
      marker?.remove();
      marker = null;
      writeHash();
    },
  });
  if (!datasets.length) {
    showBanner(
      'No precomputed grid found, so the heatmap is empty. Build it with <code>npm run fetch</code> and <code>npm run build-grid</code> (see README). You can still click the map to analyse any location.'
    );
    $('screening').hidden = true;
  } else {
    if (datasets.some((d) => d.manifest.synthetic)) {
      showBanner('<b>Synthetic demo data.</b> This grid was built from made-up weather, not PVGIS. Run <code>npm run fetch</code> and <code>npm run build-grid</code> for real results.', true);
    }
    const list = countryList(datasets);
    countries = new Map(list);
    $('scr-scope').insertAdjacentHTML('beforeend', list.map(([id, name]) => `<option value="${id}">${name}</option>`).join(''));
    $('data-source').textContent = datasets
      .map((d) => {
        const m = d.manifest;
        return `${d.name} grid: ${m.count.toLocaleString('en-US')} land cells, ${m.source}${m.pvgis?.years ? ` ${m.pvgis.years[0]}–${m.pvgis.years[1]}` : ''}, built ${m.generated.slice(0, 10)}.`;
      })
      .join(' ');
    await refreshMap();
  }
  if (initial.point) openPoint(initial.point[0], initial.point[1]);
})();
