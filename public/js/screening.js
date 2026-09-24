// Site screening: rank the grid cells of a country or of the current map view
// by specific yield for the current inputs, and export them as CSV.

import { blockResults, blockFilters } from './grid-data.js';
import { cellAreaKm2 } from './screening-layers.js';
import { mountLabel } from './location.js';

const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Union of the countries of all grids, sorted by name: [[id, name]]. */
export function countryList(datasets) {
  const all = new Map();
  for (const ds of datasets) for (const [id, name] of Object.entries(ds.manifest.countries ?? {})) all.set(Number(id), name);
  return [...all.entries()].sort((a, b) => a[1].localeCompare(b[1]));
}

/**
 * Cells of the finest grid that covers the scope and holds the selected
 * mounting, with their annual results, sorted by specific yield (descending).
 * With filters, and screening layers built for that grid, only cells passing
 * the filters are returned.
 * @param scope  {type: 'view', bounds: {south, west, north, east}} | {type: 'country', id}
 */
export async function collectCells(datasets, scope, mount, params, filters, onProgress) {
  const fine = [...datasets].sort((a, b) => a.res - b.res).filter((ds) => ds.supports(mount));
  for (const ds of fine) {
    const b = scope.bounds;
    const ids = scope.type === 'country' ? ds.blockIdsWithCountry(scope.id) : ds.blockIdsIn(b.south, b.west, b.north, b.east);
    if (!ids.length) continue;
    const rows = [];
    let n = 0, total = 0;
    const screened = !!(filters && ds.screening);
    for (const id of ids) {
      const block = await ds.block(id);
      const r = await blockResults(block, mount, params);
      const fr = screened ? await blockFilters(block, filters) : null;
      const { country, elevation } = block.stat;
      for (let i = 0; i < block.M; i++) {
        const c = ds.cellCenter(block, i);
        if (scope.type === 'country' ? country[i] !== scope.id : !inView(c, b)) continue;
        if (!Number.isFinite(r.yield[i])) continue;
        total++;
        if (fr && fr.pass[i] !== 1) continue;
        const area = cellAreaKm2(c.lat, ds.res);
        rows.push({
          lat: c.lat,
          lon: c.lon,
          country: country[i],
          yield: r.yield[i],
          pr: r.pr[i],
          poa: r.poa[i],
          ghi: r.ghi[i],
          tilt: r.tilt ? r.tilt[i] : null,
          elevation: elevation[i],
          area,
          suitable: fr ? 100 * fr.suitable[i] : null,
          suitableKm2: fr ? fr.suitable[i] * area : null,
          protected: fr ? 100 * fr.protected[i] : null,
          gridKm: fr ? fr.gridKm[i] : null,
        });
      }
      onProgress?.(++n, ids.length);
    }
    if (!total) continue;
    rows.sort((a, b2) => b2.yield - a.yield);
    return { ds, rows, total, screened };
  }
  return null;
}

function inView(c, b) {
  if (c.lat < b.south || c.lat > b.north) return false;
  if (b.east - b.west >= 360) return true;
  const lon = ((((c.lon - b.west) % 360) + 360) % 360) + b.west;
  return lon <= b.east;
}

export function summaryHtml(result, countries, mount, top = 15) {
  const { ds, rows, total, screened } = result;
  const filt = screened
    ? `<b>${rows.length.toLocaleString('en-US')}</b> of ${total.toLocaleString('en-US')} cells at ${ds.res}° pass the filters`
    : `<b>${rows.length.toLocaleString('en-US')}</b> cells at ${ds.res}° (no screening layers for this grid, so filters are not applied)`;
  if (!rows.length) return `<p class="scr-sum">${filt}. Relax the filters to see results.</p>`;
  const ys = rows.map((r) => r.yield);
  const median = ys[Math.floor(ys.length / 2)];
  const land = screened ? rows.reduce((s, r) => s + r.suitableKm2, 0) : 0;
  const head = `<p class="scr-sum">${filt} · ${esc(mountLabel(mount))}<br>
    Specific yield: best <b>${fmt(ys[0])}</b>, median ${fmt(median)}, lowest ${fmt(ys[ys.length - 1])} kWh/kWp${
      screened ? `<br>Suitable land in these cells: ${fmt(land)} km²` : ''
    }</p>`;
  const cols = screened
    ? '<th>#</th><th>Lat, lon</th><th>kWh/kWp</th><th>Suitable</th><th>Grid</th>'
    : '<th>#</th><th>Lat, lon</th><th>Country</th><th>kWh/kWp</th><th>PR</th>';
  const body = rows
    .slice(0, top)
    .map((r, i) => {
      const cells = screened
        ? `<td>${fmt(r.yield)}</td><td>${fmt(r.suitableKm2)} km²</td><td>${Number.isFinite(r.gridKm) ? `${fmt(r.gridKm, 1)} km` : '–'}</td>`
        : `<td>${esc(countries.get(r.country) ?? '')}</td><td>${fmt(r.yield)}</td><td>${fmt(r.pr, 1)}%</td>`;
      return `<tr data-lat="${r.lat}" data-lon="${r.lon}" tabindex="0" title="${esc(countries.get(r.country) ?? '')}"><td>${i + 1}</td><td>${r.lat.toFixed(2)}, ${r.lon.toFixed(2)}</td>${cells}</tr>`;
    })
    .join('');
  return `${head}<table class="t scr-table"><thead><tr>${cols}</tr></thead><tbody>${body}</tbody></table>
    <p class="muted scr-note">Top ${Math.min(top, rows.length)} shown. Click a row to analyse it; the CSV contains all ${rows.length.toLocaleString('en-US')} cells.</p>`;
}

export function toCsv(result, countries, mount, params) {
  const { ds, rows } = result;
  const lines = [
    `# Solar Yield Map export, ${new Date().toISOString()}`,
    `# Mounting: ${mountLabel(mount)}; grid ${ds.res} deg; source: ${ds.manifest.source}`,
    `# Parameters: ${Object.entries(params).map(([k, v]) => `${k}=${v}`).join('; ')}`,
    `# Filters: ${result.screened ? JSON.stringify(result.filters ?? {}) : 'not applied (no screening layers for this grid)'}`,
    'rank,lat,lon,country,specific_yield_kWh_per_kWp,performance_ratio_pct,globinc_kWh_per_m2,ghi_kWh_per_m2,optimal_tilt_deg,elevation_m,cell_area_km2,suitable_land_pct,suitable_land_km2,protected_pct,grid_distance_km',
  ];
  const q = (s) => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  rows.forEach((r, i) => {
    lines.push(
      [
        i + 1, r.lat.toFixed(3), r.lon.toFixed(3), q(countries.get(r.country) ?? ''), r.yield.toFixed(1), r.pr.toFixed(2), r.poa.toFixed(1), r.ghi.toFixed(1),
        r.tilt != null ? r.tilt.toFixed(1) : '', r.elevation, r.area.toFixed(1),
        r.suitable != null ? r.suitable.toFixed(1) : '', r.suitableKm2 != null ? r.suitableKm2.toFixed(2) : '',
        r.protected != null ? r.protected.toFixed(1) : '', Number.isFinite(r.gridKm) ? r.gridKm.toFixed(1) : '',
      ].join(',')
    );
  });
  return lines.join('\n');
}

export function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
