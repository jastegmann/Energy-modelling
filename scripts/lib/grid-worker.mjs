// Worker thread for build-grid.mjs: runs the hourly model for every grid
// configuration of a batch of cells and returns the annual sums.

import { parentPort, workerData } from 'node:worker_threads';
import { readTmyFile } from './tmy-store.mjs';
import { estimateTimeShift, parsePvgisTmy } from '../../public/js/pvgis.js';
import { prepareHourly, simulate } from '../../public/js/model/simulate.js';
import { DEFAULT_PARAMS, REF_ALBEDO, REF_B0 } from '../../public/js/model/losses.js';
import { CONFIG_FIELDS, STATIC_FIELDS } from '../../public/js/model/configs.js';

const { configs } = workerData;
const REF = { ...DEFAULT_PARAMS, albedo: REF_ALBEDO, b0: REF_B0 };
const NF = CONFIG_FIELDS.length;
const NS = STATIC_FIELDS.length;

let synthetic = null;
async function loadTmy(cell) {
  if (cell.synthetic) {
    synthetic ??= {
      gen: (await import('../dev/synthetic-tmy.mjs')).syntheticPvgisTmy,
      db: (await import('../dev/mock-pvgis.mjs')).mockDatabase,
    };
    return { tmy: parsePvgisTmy(synthetic.gen(cell.lat, cell.lon, synthetic.db(cell.lat, cell.lon))), header: { synthetic: true } };
  }
  return readTmyFile(cell.path);
}

parentPort.on('message', async ({ batch, fallbackShift }) => {
  const n = batch.length;
  const values = new Float64Array(configs.length * NF * n);
  const stat = new Float64Array(NS * n);
  const info = [];
  for (let c = 0; c < n; c++) {
    const cell = batch[c];
    try {
      const { tmy, header } = await loadTmy(cell);
      const est = estimateTimeShift(tmy);
      const db = tmy.meta.radiationDb ?? 'unknown';
      let shift = est.shift;
      if (shift === null && fallbackShift) shift = fallbackShift[db] ?? 0;
      if (shift === null) {
        info.push({ idx: cell.idx, db, needsFallback: true });
        continue;
      }
      const h = prepareHourly(tmy, shift);
      for (let k = 0; k < configs.length; k++) {
        const f = simulate(h, configs[k], REF).fields;
        for (let j = 0; j < NF; j++) values[(k * NF + j) * n + c] = f[CONFIG_FIELDS[j].name];
      }
      let w = 0, ww = 0, tSum = 0;
      for (let i = 0; i < tmy.ghi.length; i++) {
        const g2 = tmy.ghi[i] * tmy.ghi[i];
        w += g2;
        ww += g2 * tmy.ws[i];
        tSum += tmy.t2m[i];
      }
      const s = { ghi: h.ghiAnnual, dhi: h.dhiAnnual, tMean: tSum / tmy.t2m.length, wind: w > 0 ? ww / w : 0, shift, db: 0, elevation: tmy.meta.elevation ?? 0 };
      for (let j = 0; j < NS; j++) stat[j * n + c] = s[STATIC_FIELDS[j].name];
      info.push({
        idx: cell.idx,
        ok: true,
        db,
        shift,
        shiftEstimated: est.shift !== null,
        shiftRmse: est.rmse,
        synthetic: !!header.synthetic,
        source: header.source,
        years: [tmy.meta.yearMin, tmy.meta.yearMax],
      });
    } catch (e) {
      info.push({ idx: cell.idx, error: String(e.message ?? e) });
    }
  }
  parentPort.postMessage({ values, stat, info }, [values.buffer, stat.buffer]);
});
