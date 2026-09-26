// Power infrastructure from OpenStreetMap: voltage levels, power-plant sources
// and tag parsing, shared by the build scripts and the page.

/**
 * Voltage levels of power lines and substations, highest first. A line's level is
 * the first whose `min` (kV) is not above its highest voltage. `range` is shown
 * as a tooltip; the last two classes hold lines without a voltage tag.
 */
export const VOLTAGE_CLASSES = [
  { id: 'kv765', label: '765 kV', range: '≥ 600 kV', min: 600, color: '#00a3b4', width: 2.6 },
  { id: 'kv500', label: '500 kV', range: '450–599 kV', min: 450, color: '#1c5bd0', width: 2.5 },
  { id: 'kv400', label: '400 kV', range: '380–449 kV', min: 380, color: '#6f3fc6', width: 2.4 },
  { id: 'kv330', label: '330 kV', range: '300–379 kV', min: 300, color: '#b23aae', width: 2.3 },
  { id: 'kv275', label: '275 kV', range: '250–299 kV', min: 250, color: '#d6336c', width: 2.2 },
  { id: 'kv220', label: '220 kV', range: '200–249 kV', min: 200, color: '#d42a2a', width: 2.1 },
  { id: 'kv150', label: '150–161 kV', range: '140–199 kV', min: 140, color: '#e8590c', width: 1.9 },
  { id: 'kv132', label: '132 kV', range: '115–139 kV', min: 115, color: '#f08c00', width: 1.8 },
  { id: 'kv110', label: '110 kV', range: '100–114 kV', min: 100, color: '#c29a00', width: 1.7 },
  { id: 'kv88', label: '88–90 kV', range: '80–99 kV', min: 80, color: '#8fa300', width: 1.6 },
  { id: 'kv66', label: '66 kV', range: '60–79 kV', min: 60, color: '#4f9a1c', width: 1.5 },
  { id: 'kv45', label: '45–50 kV', range: '40–59 kV', min: 40, color: '#2b9348', width: 1.4 },
  { id: 'kv33', label: '33 kV', range: '25–39 kV', min: 25, color: '#199e96', width: 1.3 },
  { id: 'kv22', label: '20–22 kV', range: '15–24 kV', min: 15, color: '#3f88c5', width: 1.2 },
  { id: 'kv11', label: '6.6–15 kV', range: '5–14 kV', min: 5, color: '#6f7fd6', width: 1.1 },
  { id: 'lv', label: '< 5 kV', range: 'below 5 kV', min: 0.001, color: '#8c8a99', width: 1 },
  { id: 'unk', label: 'Unknown (line)', range: 'power=line or cable without a voltage tag', min: null, color: '#55534e', width: 1.3 },
  { id: 'unkminor', label: 'Unknown (minor line)', range: 'power=minor_line without a voltage tag', min: null, color: '#9a978d', width: 1 },
];
export const CLASS_UNKNOWN = VOLTAGE_CLASSES.findIndex((c) => c.id === 'unk');
export const CLASS_UNKNOWN_MINOR = VOLTAGE_CLASSES.findIndex((c) => c.id === 'unkminor');

/** Voltage thresholds (kV) of the distance-to-transmission screening layer. */
export const TX_KV = [33, 66, 132, 220, 330];

/** Highest voltage (kV) in an OSM voltage tag ("400000;132000", "132 kV", "33000"); 0 if none. */
export function parseVoltage(tag) {
  if (!tag) return 0;
  let best = 0;
  for (const part of String(tag).split(/[;,/]/)) {
    const m = part.trim().match(/^(\d+(?:\.\d+)?)\s*(kv|v)?$/i);
    if (!m) continue;
    let v = Number(m[1]);
    const unit = m[2]?.toLowerCase();
    // OSM uses volts; plain numbers below 1000 are almost always kV typed by mistake.
    v = unit === 'kv' || (!unit && v < 1000) ? v : v / 1000;
    if (v > best && v < 2000) best = v;
  }
  return best;
}

/** Voltage class index of a line (kind: line | minor_line | cable) or substation. */
export function voltageClass(kv, kind = 'line') {
  if (kv > 0) {
    for (let i = 0; i < VOLTAGE_CLASSES.length; i++) if (VOLTAGE_CLASSES[i].min !== null && kv >= VOLTAGE_CLASSES[i].min) return i;
  }
  return kind === 'minor_line' ? CLASS_UNKNOWN_MINOR : CLASS_UNKNOWN;
}

/** Power-plant energy sources (OSM plant:source), with a fallback "other". */
export const PLANT_SOURCES = [
  { id: 'solar', label: 'Solar', color: '#f2b705' },
  { id: 'wind', label: 'Wind', color: '#4cc9f0' },
  { id: 'hydro', label: 'Hydro', color: '#1d4ed8' },
  { id: 'geothermal', label: 'Geothermal', color: '#b45309' },
  { id: 'biomass', label: 'Biomass / biogas', color: '#15803d' },
  { id: 'gas', label: 'Gas', color: '#7c7c7c' },
  { id: 'oil', label: 'Oil / diesel', color: '#4b3b2f' },
  { id: 'coal', label: 'Coal', color: '#1f1f1f' },
  { id: 'nuclear', label: 'Nuclear', color: '#9d4edd' },
  { id: 'battery', label: 'Battery storage', color: '#e5383b' },
  { id: 'other', label: 'Other / unknown', color: '#a8a29e' },
];
const SOURCE_ALIASES = { biogas: 'biomass', waste: 'biomass', diesel: 'oil', gasoil: 'oil', fuel_oil: 'oil', natural_gas: 'gas', lng: 'gas', water: 'hydro', battery: 'battery' };

/** Source index from plant:source / generator:source (first recognised value). */
export function plantSource(tag) {
  for (const s of String(tag ?? '').toLowerCase().split(/[;,]/).map((x) => x.trim())) {
    const id = SOURCE_ALIASES[s] ?? s;
    const i = PLANT_SOURCES.findIndex((p) => p.id === id);
    if (i >= 0) return i;
  }
  return PLANT_SOURCES.length - 1;
}

/** Electrical capacity in MW from "50 MW", "1.2 GW", "500 kW", "30"; 0 if unknown. */
export function parseCapacityMW(tag) {
  const m = String(tag ?? '').trim().match(/^(\d+(?:[.,]\d+)?)\s*(gw|mw|kw|w|mwp|kwp)?$/i);
  if (!m) return 0;
  const v = Number(m[1].replace(',', '.'));
  const unit = (m[2] ?? 'mw').toLowerCase().replace(/p$/, '');
  return unit === 'gw' ? v * 1000 : unit === 'kw' ? v / 1000 : unit === 'w' ? v / 1e6 : v;
}
