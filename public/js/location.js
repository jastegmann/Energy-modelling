// Location card: live hourly simulation for a clicked point (PVGIS TMY via the
// local server), with a fallback to the precomputed grid cell.

import { tmyFromJSON, estimateTimeShift } from './pvgis.js';
import { prepareHourly, simulate, optimalTilt } from './model/simulate.js';
import { lossBreakdown } from './model/losses.js';
import { niceTicks } from './colors.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const coord = (lat, lon) => `${Math.abs(lat).toFixed(3)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(3)}° ${lon >= 0 ? 'E' : 'W'}`;

export function mountLabel(m) {
  const rows = (g) => (g > 0 ? `GCR ${g.toFixed(2)}` : 'isolated rows');
  if (m.type === 'fixed') return m.optimal ? `Fixed, optimal tilt, ${rows(m.gcr)}` : `Fixed tilt ${fmt(m.tilt, 0)}°, ${rows(m.gcr)}`;
  if (m.type === 'ew') return `East–West ${fmt(m.tilt, 0)}°, ${rows(m.gcr)}`;
  return `Tracker ±${m.limit}°, ${m.gcr > 0 ? `${m.backtrack ? 'backtracking' : 'no backtracking'}, GCR ${m.gcr.toFixed(2)}` : 'isolated rows'}`;
}

export class LocationCard {
  /**
   * @param gridCell   async (lat, lon, mount, params) => {stages, res, center} | null
   * @param shiftFallback  (radiationDb) => minutes, used when the offset cannot be fitted
   */
  constructor({ gridCell, screenCell, shiftFallback, getState, onClose }) {
    this.gridCell = gridCell;
    this.screenCell = screenCell;
    this.shiftFallback = shiftFallback;
    this.getState = getState;
    this.el = document.getElementById('loc');
    this.title = document.getElementById('loc-title');
    this.sub = document.getElementById('loc-sub');
    this.status = document.getElementById('loc-status');
    this.body = document.getElementById('loc-body');
    this.showTable = false;
    document.getElementById('loc-close').addEventListener('click', () => {
      this.close();
      onClose?.();
    });
    this.seq = 0;
  }

  close() {
    this.el.hidden = true;
    this.el.parentElement.classList.remove('card-open');
    this.point = null;
    this.hourly = null;
    this.seq++;
  }

  async open(lat, lon) {
    const seq = ++this.seq;
    this.point = { lat, lon };
    this.hourly = null;
    this.tmyMeta = null;
    this.error = null;
    this.el.hidden = false;
    this.el.parentElement.classList.add('card-open');
    this.title.textContent = coord(lat, lon);
    this.sub.textContent = '';
    this.setStatus('<span class="spinner"></span>Fetching the PVGIS typical meteorological year…');
    const request = fetch(`api/tmy?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`);
    request.catch(() => {}); // handled below
    await this.renderGridCell();
    try {
      const r = await request;
      const j = await r.json().catch(() => ({}));
      if (seq !== this.seq) return;
      if (!r.ok) {
        const msg = r.status === 404 ? 'Live analysis needs the local server (npm start).' : j.error || `HTTP ${r.status}`;
        throw new Error(msg);
      }
      const tmy = tmyFromJSON(j);
      const est = estimateTimeShift(tmy);
      const db = tmy.meta.radiationDb;
      const fallback = this.shiftFallback?.(db) ?? 0;
      const shift = est.shift ?? fallback;
      this.hourly = prepareHourly(tmy, shift);
      this.tmyMeta = { ...tmy.meta, shift, shiftEstimated: est.shift !== null, synthetic: j.synthetic, cached: j.cached, source: j.source };
      this.setStatus(j.synthetic ? '<b>Synthetic test data</b> from a mock PVGIS server, not real irradiance.' : '');
      this.status.classList.toggle('warn', !!j.synthetic);
      this.update();
    } catch (e) {
      if (seq !== this.seq) return;
      this.error = e.message;
      this.setStatus(`${esc(e.message)}${this.hasCell ? ' Showing the precomputed grid cell instead.' : ''}`, true);
    }
  }

  setStatus(html, isError = false) {
    this.status.innerHTML = html;
    this.status.classList.toggle('error', isError);
    this.status.classList.remove('warn');
  }

  /** Re-render with the current inputs. */
  update() {
    if (!this.point) return;
    if (this.hourly) this.renderLive();
    else this.renderGridCell();
  }

  async renderGridCell() {
    const { lat, lon } = this.point;
    const st = this.getState();
    const seq = this.seq;
    const cell = this.gridCell ? await this.gridCell(lat, lon, st.mount, st.params) : null;
    if (seq !== this.seq || this.hourly) return;
    this.hasCell = !!cell;
    if (!cell) {
      this.body.innerHTML = '';
      return;
    }
    const { stages, res, center: c } = cell;
    this.sub.textContent = `${mountLabel(st.mount)} · precomputed ${res}° grid cell (centre ${coord(c.lat, c.lon)})`;
    const tilt = stages.tilt;
    this.body.innerHTML =
      this.tilesHtml(stages.avail, stages.avail / stages.inc, stages.inc, stages.ghi, tilt) +
      section('Loss diagram (annual)', lossTable(lossBreakdown(stages)));
    this.appendScreening(seq);
  }

  renderLive() {
    const st = this.getState();
    const h = this.hourly;
    const p = st.params;
    let main;
    let tilt;
    const fixedMount = { type: 'fixed', tilt: st.fixed.tilt, gcr: st.fixed.gcr };
    const opt = optimalTilt(h, { type: 'fixed', gcr: st.fixed.gcr }, p);
    if (st.mount.type === 'fixed' && st.mount.optimal) {
      main = opt.result;
      tilt = opt.tilt;
    } else {
      main = simulate(h, st.mount, p);
    }
    const compare = [
      { label: `Fixed, optimal tilt (${fmt(opt.tilt, 1)}°)`, r: opt.result, cur: st.mount.type === 'fixed' && st.mount.optimal },
      { label: `Fixed, tilt ${fmt(st.fixed.tilt)}°`, r: simulate(h, fixedMount, p), cur: st.mount.type === 'fixed' && !st.mount.optimal },
      { label: `East–West, ${fmt(st.ew.tilt)}°`, r: simulate(h, { type: 'ew', ...st.ew }, p), cur: st.mount.type === 'ew' },
      { label: `Tracker ±${st.tracker.limit}°${st.tracker.gcr > 0 && st.tracker.backtrack ? ', backtracking' : ''}`, r: simulate(h, { type: 'tracker', ...st.tracker }, p), cur: st.mount.type === 'tracker' },
    ];
    const m = this.tmyMeta;
    this.sub.textContent = `${mountLabel(st.mount)} · hourly simulation`;
    const ref = opt.result.yield;
    const cmp = `<table class="t"><thead><tr><th>Mounting (current rows setting)</th><th>kWh/kWp</th><th>PR</th><th>vs opt.</th></tr></thead><tbody>${compare
      .map(
        (c) =>
          `<tr class="${c.cur ? 'cur' : ''}"><td>${esc(c.label)}</td><td>${fmt(c.r.yield)}</td><td>${fmt(c.r.pr * 100, 1)}%</td><td class="${c.r.yield >= ref ? 'pos' : 'neg'}">${c.r.yield >= ref ? '+' : ''}${fmt((c.r.yield / ref - 1) * 100, 1)}%</td></tr>`
      )
      .join('')}</tbody></table>`;
    const years = m.yearMin ? `${m.yearMin}–${m.yearMax}` : '–';
    const prov = `<dl class="provenance">
      <dt>Source</dt><dd>${m.synthetic ? '<b>SYNTHETIC test data (mock PVGIS)</b>' : 'PVGIS 5.3 TMY'}${m.cached ? ' (cached)' : ''}</dd>
      <dt>Radiation data</dt><dd>${esc(m.radiationDb ?? '–')}, years ${esc(years)}</dd>
      <dt>Meteo data</dt><dd>${esc(m.meteoDb ?? '–')}</dd>
      <dt>Elevation</dt><dd>${m.elevation != null ? `${fmt(m.elevation)} m` : '–'}</dd>
      <dt>Horizon</dt><dd>${m.useHorizon ? `terrain horizon included (${esc(m.horizonDb ?? 'DEM')})` : 'not included'}</dd>
      <dt>Time offset</dt><dd>${m.shift >= 0 ? '+' : ''}${m.shift} min ${m.shiftEstimated ? '(fitted to PVGIS beam data)' : '(database default)'}</dd>
      <dt>Annual mean temp.</dt><dd>${fmt(h.taMonthly.reduce((a, b) => a + b, 0) / 12, 1)} °C</dd>
    </dl>`;
    this.body.innerHTML =
      this.tilesHtml(main.yield, main.pr, main.stages.inc, main.stages.ghi, tilt) +
      section('Monthly specific yield', monthlyChart(main.monthly, this.showTable), `<button type="button" data-act="table">${this.showTable ? 'Chart' : 'Table'}</button>`) +
      section('Loss diagram (annual)', lossTable(main.losses)) +
      section('Mounting comparison at this location', cmp) +
      section('Weather data', prov);
    this.body.querySelector('[data-act="table"]')?.addEventListener('click', () => {
      this.showTable = !this.showTable;
      this.renderLive();
    });
    attachChartHover(this.body.querySelector('.chart'), main.monthly);
    this.appendScreening(this.seq);
  }

  /** Screening layers of the grid cell under the point, if built. */
  async appendScreening(seq) {
    if (!this.screenCell || !this.point) return;
    const st = this.getState();
    const info = await this.screenCell(this.point.lat, this.point.lon, st.filters);
    if (!info || seq !== this.seq) return;
    const lc = info.landCover
      .map((share, i) => ({ share, name: info.names[i] }))
      .filter((x) => x.share >= 0.01)
      .sort((a, b) => b.share - a.share)
      .map((x) => `${esc(x.name)} ${fmt(x.share * 100)}%`)
      .join(', ');
    const html = `<dl class="provenance">
      <dt>Suitable land</dt><dd><b>${fmt(info.suitable * 100)}%</b> of the cell (${fmt(info.suitable * info.area)} km² of ${fmt(info.area)} km²) · ${info.pass ? 'passes' : 'fails'} the filters</dd>
      <dt>Protected</dt><dd>${fmt(info.protected * 100)}% of the land</dd>
      <dt>Land cover</dt><dd>${lc || '–'}</dd>
      <dt>Slope</dt><dd>${info.slope.map((v, i) => `${info.slopeLabels[i]} ${fmt(v * 100)}%`).join(', ')}</dd>
      <dt>Power grid</dt><dd>${Number.isFinite(info.gridKm) ? `${fmt(info.gridKm, 1)} km to the nearest line (gridfinder)` : 'no line within range'}</dd>
    </dl>`;
    this.body.querySelector('.loc-screen')?.remove();
    this.body.insertAdjacentHTML('beforeend', `<div class="loc-screen">${section(`Site screening (${info.res}° grid cell)`, html)}</div>`);
  }

  tilesHtml(yieldV, pr, inc, ghi, tilt) {
    return `<div class="tiles">
      <div class="tile hero"><div class="k">Specific yield</div><div class="v">${fmt(yieldV)}<small>kWh/kWp</small></div></div>
      <div class="tile"><div class="k">Perf. ratio</div><div class="v">${fmt(pr * 100, 1)}<small>%</small></div></div>
      <div class="tile"><div class="k">GlobInc</div><div class="v">${fmt(inc)}<small>kWh/m²</small></div></div>
      <div class="tile wide"><span>GHI ${fmt(ghi)} kWh/m²</span><span>Transposition ${inc >= ghi ? '+' : ''}${fmt((inc / ghi - 1) * 100, 1)}%</span>${
        tilt != null ? `<span>Optimal tilt ${fmt(tilt, 1)}°</span>` : ''
      }</div>
    </div>`;
  }
}

function section(title, html, action = '') {
  return `<div class="loc-section"><h3><span>${title}</span>${action}</h3>${html}</div>`;
}

function lossTable(rows) {
  return `<table class="t"><thead><tr><th>Stage</th><th>Change</th><th>Value</th></tr></thead><tbody>${rows
    .map((r) => {
      const change = r.kind === 'step' ? `${r.pct >= 0 ? '+' : ''}${fmt(r.pct, 1)}%` : '';
      return `<tr class="${r.kind === 'level' ? 'level' : ''}"><td>${esc(r.label)}</td><td class="${r.pct > 0 ? 'pos' : 'neg'}">${change}</td><td>${fmt(r.value)} <span class="muted">${r.unit}</span></td></tr>`;
    })
    .join('')}</tbody></table>`;
}

function monthlyChart(monthly, asTable) {
  if (asTable) {
    return `<table class="t"><thead><tr><th>Month</th><th>GHI</th><th>GlobInc</th><th>kWh/kWp</th><th>PR</th></tr></thead><tbody>${monthly
      .map((m, i) => `<tr><td>${MONTHS[i]}</td><td>${fmt(m.ghi)}</td><td>${fmt(m.inc)}</td><td>${fmt(m.yield, 1)}</td><td>${fmt(m.pr * 100, 1)}%</td></tr>`)
      .join('')}</tbody></table>`;
  }
  const W = 368, H = 150, L = 30, R = 4, T = 8, B = 18;
  const max = Math.max(...monthly.map((m) => m.yield), 1);
  const ticks = niceTicks(0, max * 1.05, 4);
  const top = ticks[ticks.length - 1] || max;
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const bw = (W - L - R) / 12;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly specific yield in kWh/kWp">`;
  for (const t of ticks) {
    s += `<line class="${t === 0 ? 'baseline' : 'gridline'}" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/>`;
    s += `<text class="tick" x="${L - 4}" y="${y(t) + 3}" text-anchor="end">${t}</text>`;
  }
  monthly.forEach((m, i) => {
    const x = L + i * bw + 3;
    const w = bw - 6;
    const y0 = y(Math.max(0, m.yield));
    const hgt = Math.max(0, H - B - y0);
    const r = Math.min(4, w / 2, hgt);
    // Rounded data end at the top, square at the baseline.
    const d = `M${x},${H - B} V${y0 + r} Q${x},${y0} ${x + r},${y0} H${x + w - r} Q${x + w},${y0} ${x + w},${y0 + r} V${H - B} Z`;
    s += `<path class="bar" data-i="${i}" d="${d}"/>`;
    s += `<rect class="bar-hit" data-i="${i}" x="${L + i * bw}" y="${T}" width="${bw}" height="${H - T - B}"/>`;
    s += `<text class="tick" x="${x + w / 2}" y="${H - 5}" text-anchor="middle">${MONTHS[i][0]}</text>`;
  });
  return `<div class="chart">${s}</svg></div>`;
}

function attachChartHover(chart, monthly) {
  if (!chart) return;
  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.hidden = true;
  chart.appendChild(tip);
  const svg = chart.querySelector('svg');
  const bars = chart.querySelectorAll('.bar');
  chart.addEventListener('mousemove', (e) => {
    const t = e.target.closest('.bar-hit');
    bars.forEach((b) => b.classList.remove('hl'));
    if (!t) return (tip.hidden = true);
    const i = +t.dataset.i;
    bars[i].classList.add('hl');
    const m = monthly[i];
    tip.innerHTML = `<b>${MONTHS[i]}</b> · ${fmt(m.yield, 1)} kWh/kWp · PR ${fmt(m.pr * 100, 1)}%`;
    const box = svg.getBoundingClientRect();
    const bb = bars[i].getBoundingClientRect();
    tip.style.left = `${bb.left - box.left + bb.width / 2}px`;
    tip.style.top = `${Math.max(12, bb.top - box.top)}px`;
    tip.hidden = false;
  });
  chart.addEventListener('mouseleave', () => {
    tip.hidden = true;
    bars.forEach((b) => b.classList.remove('hl'));
  });
}
