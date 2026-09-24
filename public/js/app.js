// Solar Yield Map: UI wiring.

import { DEFAULT_PARAMS, PARAM_INFO } from './model/losses.js';
import { FIXED_GCRS, EW_GCRS, TRACKER_GCRS, TRACKER_LIMITS } from './model/configs.js';
import { loadGrid, computeValues, cellAt } from './grid-data.js';
import { createHeatLayer } from './heat-layer.js';
import { VARIABLES, buildLut, cssGradient, niceTicks, autoRange } from './colors.js';
import { LocationCard, mountLabel } from './location.js';

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
map.on('moveend', writeHash);

let grid = null;
let values = null;
let range = [0, 1];
let card = null;
let marker = null;
let seq = 0;

async function refreshMap() {
  if (!grid) return;
  const my = ++seq;
  const loading = setTimeout(() => ($('loading').hidden = false), 150);
  try {
    const mount = currentMount();
    const v = await computeValues(grid, mount, state.params, state.variable);
    if (my !== seq) return;
    values = v;
    const meta = VARIABLES[state.variable];
    range = state.scaleMode === 'auto' ? autoRange(values) : meta.range;
    const lut = buildLut(meta.ramp);
    const colors = new Uint32Array(grid.M);
    const [lo, hi] = range;
    for (let i = 0; i < grid.M; i++) {
      const x = values[i];
      if (Number.isFinite(x)) colors[i] = lut[Math.max(0, Math.min(255, Math.round(((x - lo) / (hi - lo)) * 255)))];
    }
    const g = grid.manifest.grid;
    map.getPane('heat').classList.toggle('smooth', state.smooth);
    heat.setData({ nx: g.nx, ny: g.ny, res: g.resolution, gridIndex: grid.gridIndex, colors, values, lut, lo, hi, smooth: state.smooth });
    renderLegend(meta, mount);
  } catch (e) {
    console.error(e);
    showBanner(`Could not compute the map: ${e.message}`, true);
  } finally {
    clearTimeout(loading);
    if (my === seq) $('loading').hidden = true;
  }
}

function renderLegend(meta, mount) {
  $('legend').hidden = false;
  $('legend-title').textContent = `${meta.label} (${meta.unit})`;
  $('legend-bar').style.background = cssGradient(meta.ramp);
  const [lo, hi] = range;
  $('legend-ticks').innerHTML = niceTicks(lo, hi, 5)
    .filter((t) => t >= lo && t <= hi)
    .map((t) => `<span style="left:${((t - lo) / (hi - lo)) * 100}%">${t.toLocaleString('en-US')}</span>`)
    .join('');
  const what = state.variable === 'ghi' ? 'Horizontal plane' : mountLabel(mount);
  $('legend-note').textContent = `${what} · ${grid.manifest.grid.resolution}° grid${state.scaleMode === 'fixed' ? ' · values beyond the range are clamped' : ''}`;
}

function showBanner(html, warn = false) {
  const b = $('data-banner');
  b.innerHTML = html;
  b.classList.toggle('warn', warn);
  b.hidden = false;
}

// Hover read-out.
let hoverFrame = 0;
map.on('mousemove', (e) => {
  if (!grid || !values) return;
  cancelAnimationFrame(hoverFrame);
  hoverFrame = requestAnimationFrame(() => {
    const { lat, lng } = e.latlng;
    const lon = ((((lng + 180) % 360) + 360) % 360) - 180;
    const pos = cellAt(grid, lat, lon);
    const chip = $('hover');
    if (pos < 0 || !Number.isFinite(values[pos])) return (chip.hidden = true);
    const meta = VARIABLES[state.variable];
    chip.innerHTML = `<b>${values[pos].toLocaleString('en-US', { maximumFractionDigits: meta.digits })}</b> ${meta.unit} &nbsp;<span class="muted">${lat.toFixed(2)}°, ${lon.toFixed(2)}°</span>`;
    chip.hidden = false;
  });
});
map.on('mouseout', () => ($('hover').hidden = true));

const pinIcon = L.divIcon({ className: 'pin', html: '<div class="pin-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
function openPoint(lat, lon) {
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  if (marker) marker.setLatLng([lat, lon]);
  else marker = L.marker([lat, lon], { icon: pinIcon, keyboard: false }).addTo(map);
  card.open(lat, lon);
  writeHash();
}
map.on('click', (e) => openPoint(e.latlng.lat, e.latlng.lng));

// ---------------------------------------------------------------- start
(async () => {
  syncControls();
  $('loading').hidden = false;
  try {
    grid = await loadGrid();
  } catch (e) {
    console.error(e);
    showBanner(`The precomputed grid could not be loaded: ${e.message}`, true);
  }
  $('loading').hidden = true;
  card = new LocationCard({
    grid,
    getState,
    onClose: () => {
      marker?.remove();
      marker = null;
      writeHash();
    },
  });
  if (!grid) {
    showBanner(
      'No precomputed grid found, so the heatmap is empty. Build it with <code>npm run fetch</code> and <code>npm run build-grid</code> (see README). You can still click the map to analyse any location.'
    );
  } else {
    const m = grid.manifest;
    if (m.synthetic) {
      showBanner('<b>Synthetic demo data.</b> This grid was built from made-up weather, not PVGIS. Run <code>npm run fetch</code> and <code>npm run build-grid</code> for real results.', true);
    }
    $('data-source').textContent = `Grid: ${m.count.toLocaleString('en-US')} land cells at ${m.grid.resolution}°, ${m.source}${m.pvgis?.years ? `, ${m.pvgis.years[0]}–${m.pvgis.years[1]}` : ''}. Built ${m.generated.slice(0, 10)}.`;
    await refreshMap();
  }
  if (initial.point) openPoint(initial.point[0], initial.point[1]);
})();
