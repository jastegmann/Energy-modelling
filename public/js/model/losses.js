// Model parameters, the PVsyst-style loss chain, and the fast evaluation of the
// loss chain from precomputed annual sums (used for the global heatmap).

/** Reference albedo and IAM b0 at which the grid sums are precomputed. */
export const REF_ALBEDO = 0.2;
export const REF_B0 = 0.05;

/** Default parameters. Percentages are in %, gamma in %/K. */
export const DEFAULT_PARAMS = Object.freeze({
  albedo: REF_ALBEDO,
  b0: REF_B0, // ASHRAE IAM coefficient
  uc: 29, // W/m²K, PVsyst default for free-standing arrays
  uv: 0, // W/m²K per m/s
  alpha: 0.9, // absorption coefficient
  effStc: 20, // module efficiency at STC, %
  gamma: -0.35, // power temperature coefficient, %/K
  soiling: 2.0,
  lid: 1.0,
  quality: 0.0,
  mismatch: 1.0,
  dcWiring: 1.0,
  inverterEff: 98.0,
  acLoss: 0.5,
  unavailability: 0.0,
});

/** Parameter metadata for the UI. */
export const PARAM_INFO = {
  albedo: { label: 'Ground albedo', unit: '', min: 0, max: 0.9, step: 0.01 },
  b0: { label: 'IAM coefficient b₀ (ASHRAE)', unit: '', min: 0, max: 0.2, step: 0.005 },
  uc: { label: 'Thermal loss factor Uc', unit: 'W/m²K', min: 5, max: 60, step: 0.5 },
  uv: { label: 'Thermal loss factor Uv', unit: 'W/m²K·m/s', min: 0, max: 10, step: 0.1 },
  alpha: { label: 'Absorption coefficient α', unit: '', min: 0.5, max: 1, step: 0.01 },
  effStc: { label: 'Module efficiency', unit: '%', min: 5, max: 30, step: 0.1 },
  gamma: { label: 'Power temperature coefficient', unit: '%/K', min: -0.6, max: 0, step: 0.01 },
  soiling: { label: 'Soiling', unit: '%', min: 0, max: 20, step: 0.1 },
  lid: { label: 'LID / degradation', unit: '%', min: 0, max: 10, step: 0.1 },
  quality: { label: 'Module quality', unit: '%', min: -3, max: 5, step: 0.1 },
  mismatch: { label: 'Mismatch', unit: '%', min: 0, max: 5, step: 0.1 },
  dcWiring: { label: 'DC wiring (annual)', unit: '%', min: 0, max: 5, step: 0.1 },
  inverterEff: { label: 'Inverter efficiency', unit: '%', min: 90, max: 99.5, step: 0.1 },
  acLoss: { label: 'AC wiring / transformer', unit: '%', min: 0, max: 5, step: 0.1 },
  unavailability: { label: 'Unavailability', unit: '%', min: 0, max: 10, step: 0.1 },
};

/** Constant-factor losses applied after the temperature correction. */
export function systemStages(eTemp, p) {
  const lid = eTemp * (1 - p.lid / 100);
  const quality = lid * (1 - p.quality / 100);
  const mismatch = quality * (1 - p.mismatch / 100);
  const dcWiring = mismatch * (1 - p.dcWiring / 100);
  const inverter = dcWiring * (p.inverterEff / 100);
  const ac = inverter * (1 - p.acLoss / 100);
  const avail = ac * (1 - p.unavailability / 100);
  return { lid, quality, mismatch, dcWiring, inverter, ac, avail };
}

/** Overall factor of systemStages(). */
export function systemFactor(p) {
  return systemStages(1, p).avail;
}

/**
 * Loss chain from the precomputed annual sums of one grid cell and configuration.
 * Exact for the reference albedo/b0 and Uv = 0; otherwise the albedo and b0
 * effects are applied linearly and the wind term uses an irradiance-weighted mean.
 * @param {object} f  {incSky, incGnd1, effSky, iamLSky, effGnd1, iamLGnd1, Tw, Gw}
 * @param {object} p  parameters
 * @param {number} ghi   annual GHI, kWh/m²
 * @param {number} wind  irradiance-weighted wind speed, m/s
 */
export function stagesFromFields(f, p, ghi = NaN, wind = 0) {
  const s = p.b0 / REF_B0;
  const shdSky = f.effSky + f.iamLSky;
  const shdGnd1 = f.effGnd1 + f.iamLGnd1;
  const effSky = Math.max(0, shdSky - s * f.iamLSky);
  const effGnd1 = Math.max(0, shdGnd1 - s * f.iamLGnd1);
  const inc = f.incSky + p.albedo * f.incGnd1;
  const shd = shdSky + p.albedo * shdGnd1;
  const eff = effSky + p.albedo * effGnd1;
  const shdRef = shdSky + REF_ALBEDO * shdGnd1;
  const gw = shdRef > 0 ? (f.Gw * shd) / shdRef : 0;
  const u = p.uc + p.uv * wind;
  const tcell = f.Tw + (p.alpha * (1 - p.effStc / 100) * gw) / u;
  const soiled = eff * (1 - p.soiling / 100);
  const temp = soiled * (1 + (p.gamma / 100) * (tcell - 25));
  return { ghi, inc, shd, eff, soiled, temp, tcell, ...systemStages(temp, p) };
}

/** Specific yield (kWh/kWp) only; the hot path of the heatmap. */
export function yieldFromFields(f, p, wind = 0, sysFactor = systemFactor(p)) {
  return stagesFromFields(f, p, NaN, wind).temp * sysFactor;
}

/**
 * Loss-diagram rows from a stages object. Percentages are relative to the
 * previous stage, as in the PVsyst loss diagram.
 */
export function lossBreakdown(st) {
  const rows = [];
  const pct = (cur, prev) => (prev > 0 ? (cur / prev - 1) * 100 : 0);
  rows.push({ key: 'ghi', label: 'Global horizontal irradiation', value: st.ghi, unit: 'kWh/m²', kind: 'level' });
  rows.push({ key: 'inc', label: 'Global incident in plane', value: st.inc, unit: 'kWh/m²', pct: pct(st.inc, st.ghi), kind: 'step' });
  rows.push({ key: 'shd', label: 'Near shadings & row view factor', value: st.shd, unit: 'kWh/m²', pct: pct(st.shd, st.inc), kind: 'step' });
  rows.push({ key: 'eff', label: 'IAM factor', value: st.eff, unit: 'kWh/m²', pct: pct(st.eff, st.shd), kind: 'step' });
  rows.push({ key: 'soiled', label: 'Soiling', value: st.soiled, unit: 'kWh/m²', pct: pct(st.soiled, st.eff), kind: 'step' });
  rows.push({ key: 'nominal', label: 'Array nominal energy (at STC)', value: st.soiled, unit: 'kWh/kWp', kind: 'level' });
  const steps = [
    ['temp', 'Temperature', st.soiled],
    ['lid', 'LID / degradation', st.temp],
    ['quality', 'Module quality', st.lid],
    ['mismatch', 'Mismatch', st.quality],
    ['dcWiring', 'DC wiring', st.mismatch],
    ['inverter', 'Inverter', st.dcWiring],
    ['ac', 'AC wiring / transformer', st.inverter],
    ['avail', 'Unavailability', st.ac],
  ];
  for (const [key, label, prev] of steps) {
    rows.push({ key, label, value: st[key], unit: 'kWh/kWp', pct: pct(st[key], prev), kind: 'step' });
  }
  rows.push({ key: 'yield', label: 'Specific yield', value: st.avail, unit: 'kWh/kWp', kind: 'level' });
  return rows;
}
