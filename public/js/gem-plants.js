// Global Energy Monitor (GEM) power-plant trackers: technology and status
// classes, shared by scripts/build-gem-plants.mjs and the map layer.

/** Technologies shown on the map (colour per technology). */
export const GEM_TECHS = [
  { id: 'solar', label: 'Solar PV', color: '#f2b705' },
  { id: 'csp', label: 'Solar thermal (CSP)', color: '#f77f00' },
  { id: 'wind', label: 'Wind', color: '#4cc9f0' },
  { id: 'hydro', label: 'Hydropower', color: '#1d4ed8' },
  { id: 'coal', label: 'Coal', color: '#1f1f1f' },
  { id: 'gas', label: 'Gas', color: '#7c7c7c' },
  { id: 'oil', label: 'Oil / diesel', color: '#6b4f3a' },
  { id: 'nuclear', label: 'Nuclear', color: '#9d4edd' },
  { id: 'bio', label: 'Bioenergy', color: '#15803d' },
  { id: 'geo', label: 'Geothermal', color: '#c2410c' },
];
const TECH = Object.fromEntries(GEM_TECHS.map((t, i) => [t.id, i]));

/**
 * Status classes. `on`: shown by default. Drawn as: filled symbol (operating),
 * ring (in development), faded (inactive).
 */
export const GEM_STATUSES = [
  { id: 'operating', label: 'Operating', style: 'filled', on: true },
  { id: 'construction', label: 'Construction', style: 'ring', on: true },
  { id: 'pre-construction', label: 'Pre-construction', style: 'ring', on: true },
  { id: 'announced', label: 'Announced', style: 'ring', on: true },
  { id: 'shelved', label: 'Shelved', style: 'faded', on: false },
  { id: 'mothballed', label: 'Mothballed', style: 'faded', on: false },
  { id: 'cancelled', label: 'Cancelled', style: 'faded', on: false },
  { id: 'retired', label: 'Retired', style: 'faded', on: false },
];

/** Status index from GEM's status text ("operating", "cancelled - inferred 4 y", "shelved - inferred 2 y", ...); -1 if unknown. */
export function gemStatus(text) {
  const s = String(text ?? '').toLowerCase().split(' - ')[0].trim();
  return GEM_STATUSES.findIndex((x) => x.id === s);
}

/**
 * Technology index from GEM's type, technology and fuel columns. `hint` is used
 * when a file has no type column (e.g. a single-technology tracker): a word
 * such as "coal", "solar", "wind" from its title or file name.
 */
export function gemTech(type, technology, fuel, hint = '') {
  const t = String(type || hint).toLowerCase();
  const tech = String(technology ?? '').toLowerCase();
  const f = String(fuel ?? '').toLowerCase();
  if (t.includes('solar')) return tech.includes('thermal') ? TECH.csp : TECH.solar;
  if (t.includes('wind')) return TECH.wind;
  if (t.includes('hydro')) return TECH.hydro;
  if (t.includes('coal')) return TECH.coal;
  if (t.includes('nuclear')) return TECH.nuclear;
  if (t.includes('bio')) return TECH.bio;
  if (t.includes('geothermal')) return TECH.geo;
  if (t.includes('oil') || t.includes('gas')) {
    // Classified by the first-listed (main) fuel; internal-combustion units without a fuel are almost always diesel/HFO.
    if (f.startsWith('fossil liquids')) return TECH.oil;
    if (f.startsWith('fossil gas')) return TECH.gas;
    if (/(^|\W)(oil|diesel)/.test(f)) return TECH.oil;
    return tech.includes('internal combustion') ? TECH.oil : TECH.gas;
  }
  return -1;
}
