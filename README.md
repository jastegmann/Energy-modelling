# Solar Yield Map

A website that shows, on an OpenStreetMap world map, the photovoltaic **specific yield (kWh/kWp)** for all
land areas. The yield comes from **PVGIS** typical-meteorological-year (TMY) irradiance, run through a
**PVsyst-style model** with **Perez transposition**.

- **Left panel:** choose the mounting structure: fixed tilt facing the equator, fixed east–west, or a
  single-axis tracker (horizontal N–S axis, tracking east to west, with or without backtracking). You can
  also set the row spacing (GCR), albedo, IAM, thermal parameters and system losses. The heatmap updates
  instantly.
- **Map:** a heatmap on a precomputed global 0.5° grid (≈67,000 land cells) of specific yield, performance
  ratio, in-plane irradiation, GHI or optimal tilt. Hover to read values.
- **Click any location:** the site fetches that point's TMY from PVGIS live and runs the full hourly
  simulation. It shows the annual yield, PR, monthly yields, a PVsyst-like loss diagram, a comparison of
  all mounting types, and where the data came from.

```
┌───────────────┬────────────────────────────────────────────────┐
│ Inputs panel  │  OpenStreetMap + yield heatmap    ┌──────────┐ │
│ · map layer   │                                   │ Location │ │
│ · mounting    │           (click on land)  ●      │ details  │ │
│ · optics/     │                                   │ monthly, │ │
│   thermal     │                                   │ losses,  │ │
│ · losses      │   [legend]                        │ compare  │ │
└───────────────┴───────────────────────────────────┴──────────┘─┘
```

## Quick start

Requirements: **Node.js 20+** (22 recommended). The site needs no npm packages at run time.

```bash
npm start                 # http://localhost:8080
```

Clicking the map works straight away, because the local server relays each request to the PVGIS API.
The PVGIS API cannot be called directly from a browser, which is why a server is needed. The global
heatmap needs a one-off precomputation:

```bash
npm run fetch             # download PVGIS TMY for all 0.5° land cells (resumable)
npm run build-grid        # run the model for every cell × mounting configuration
npm start
```

| Step | Work | Typical time | Disk |
|---|---|---|---|
| `npm run fetch` (0.5°) | ≈67k PVGIS requests at ≤20 req/s | 2–5 h, depends on PVGIS response times | ≈3 GB in `cache/` |
| `npm run build-grid` | 67k cells × 117 configurations | ≈15–40 min, depends on CPU cores | ≈40–80 MB in `public/data/grid/` |

Tips:
- **Try a region first:** `npm run fetch -- --bbox -10,35,30,60`, then
  `npm run build-grid -- --bbox -10,35,30,60`. The bbox is `lonMin,latMin,lonMax,latMax`.
- **Quick coarse world map:** `npm run fetch -- --res 2 && npm run build-grid -- --res 2` needs about 4,800
  requests. 1° and 2° land masks are included.
- The fetch can be stopped with Ctrl‑C and restarted at any time. Cells already in `cache/` are skipped.
  Failed cells are listed in `cache/tmy/<res>/failed.json`, and you can retry them with `--retry-failed`.
- Behind an HTTP proxy, run the scripts and the server with `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21 / 24).
- To see the UI without PVGIS: `npm run build-grid -- --synthetic --res 2` builds a grid from made‑up
  weather. The site then shows a prominent "synthetic data" warning.

### Hosting

`public/` is a static site. The heatmap works on any static host, e.g. GitHub Pages, after you remove
`public/data/grid/` from `.gitignore` and commit the grid. Live location analysis needs `server.mjs` (or
an equivalent relay) running on the same origin. Without it, clicking the map shows the precomputed
grid-cell values instead.

The base map uses the public OpenStreetMap tile servers. Their
[tile usage policy](https://operations.osmfoundation.org/policies/tiles/) is fine for personal and light
use. For a heavily used deployment, switch the tile URL in `public/js/app.js` to a commercial or
self-hosted OSM tile provider.

Server environment variables: `PORT` (8080), `HOST` (127.0.0.1; use `0.0.0.0` to expose it), `PVGIS_BASE`,
`POINT_CACHE`.

## Methodology

The chain follows the PVsyst simulation. Every step runs hourly on the 8,760 hours of the PVGIS TMY.

### 1. Weather data: PVGIS TMY

`GET https://re.jrc.ec.europa.eu/api/v5_3/tmy?lat=…&lon=…&usehorizon=1&outputformat=json` returns hourly
global horizontal `G(h)`, direct normal `Gb(n)` and diffuse horizontal `Gd(h)` irradiance, air temperature
`T2m` and wind speed `WS10m`. The radiation database PVGIS picks is PVGIS‑SARAH3 where satellite data
exist, and NSRDB or ERA5 elsewhere; the location card shows which one was used. With `usehorizon=1`,
PVGIS removes direct light when the sun is behind the terrain horizon.

PVGIS supplies the diffuse fraction, so no decomposition model is needed.

**Time alignment.** PVGIS time stamps are whole hours in UTC, but the irradiance values refer to a
database-dependent instant (e.g. the satellite scan time). PVGIS computed `Gb(n) = (G(h) − Gd(h)) / cos Z`
with its own sun position, so the ratio `(G(h) − Gd(h)) / Gb(n)` reveals the solar zenith PVGIS used. For
each location we fit the time offset (±90 min, 1‑min resolution) that best reproduces it. Unlike
correlating GHI with the sun, this is not biased by cloud patterns. The fitted offset is shown on the
location card. When a site has too little direct sun to fit, the grid-wide median for its database is used.

### 2. Sun position
NOAA / Meeus algorithm, accurate to about 0.01° (validated against pvlib's SPA).

### 3. Transposition: Perez et al. (1990)
Sky diffuse is split into three components:
- an **isotropic** part, `DHI (1−F1)(1+cos β)/2`
- a **circumsolar** part, `DHI F1 a/b`
- a **horizon band**, `DHI F2 sin β`

Here `a = max(0, cos AOI)` and `b = max(cos 85°, cos Z)`. The brightness coefficients F1 and F2 come from
the sky clearness ε (8 bins) and brightness Δ. Δ uses Kasten–Young air mass and extraterrestrial
irradiance from Spencer's formula. The coefficient set is the 1990 "all sites composite", the one PVsyst
uses. The implementation matches `pvlib.irradiance.perez` to 1e‑6.

Ground-reflected irradiance is `albedo · GHI · (1 − cos β)/2`, or the row view factor described below.

### 4. Mounting structures
- **Fixed tilt:** equator-facing, i.e. azimuth 0°, which faces south in the northern hemisphere and north
  in the southern. Any tilt from 0–60° on the map (interpolated between 5° layers) and any value in the
  location analysis. **Optimal tilt** finds the tilt that maximises the full-chain specific yield: per grid
  cell on the map, by golden-section search for a clicked location.
- **East–west:** back-to-back pairs facing azimuth ±90°, each face carrying half of the kWp.
- **Single-axis tracker:** horizontal N–S axis. The rotation follows the sun
  (`R = atan2(s_E, s_U)`) within the rotation limit. With backtracking (Lorenzo et al. 2011), the angle is
  reduced whenever `cos R / GCR < 1` so rows never shade each other. Validated against
  `pvlib.tracking.singleaxis`.

### 5. Near shading: PVsyst "unlimited rows" model
With a ground coverage ratio (GCR = collector width / row pitch) the array is modelled as infinitely long
rows, in 2‑D:
- **Beam shading (linear):** the shaded fraction of the collector width is
  `fs = max(0, 1 − p sin ψ / sin(ψ + β))`, with `p = 1/GCR` and ψ the sun's profile angle. It applies to
  beam and circumsolar light.
- **Diffuse shading:** the isotropic sky and horizon band are scaled by the ratio of the row's sky view
  factor to the free-field value `(1+cos β)/2`. The row's view factor is computed with Hottel's crossed
  strings: `(1 + p − √((p − cos β)² + sin² β))/2`.
- **Albedo shading:** ground reflection uses the view factor to the ground strip between rows.

For east–west pairs, the "row pitch" is the ridge-to-ridge distance and the visible ground is the gap
between pairs. "Isolated" means one row with an unobstructed view (GCR → 0).

### 6. Incidence angle modifier (IAM)
ASHRAE model `IAM = 1 − b₀ (1/cos θ − 1)`, with PVsyst's default b₀ = 0.05, for beam and circumsolar light.
Isotropic sky, horizon band and ground light get the IAM integrated over the directions the plane sees
(as in PVsyst). These are tabulated by tilt and agree with pvlib's `marion_diffuse` to about 0.001.

### 7. Soiling
A constant fraction of the effective irradiance.

### 8. Thermal model and temperature loss
The PVsyst thermal balance: `(Uc + Uv·WS) (T_cell − T_amb) = α · G_POA · (1 − η)`. The defaults are the
PVsyst free-standing values: Uc = 29 W/m²K, Uv = 0, α = 0.9, η = 20 %. The DC power is then
`P = G_eff/1000 · P_nom · (1 + γ (T_cell − 25 °C))`, with γ = −0.35 %/K by default.

### 9. System losses
LID / degradation, module quality, mismatch, DC wiring (annual), inverter efficiency, AC
wiring / transformer and unavailability are applied as constant factors, in the PVsyst loss-diagram order.

**Specific yield** = AC energy / installed DC kWp. **PR** = specific yield / GlobInc, the in-plane
irradiation before shading and IAM, with GlobInc taken in kWh/m², i.e. peak-sun hours.

### How the heatmap applies your inputs instantly
For each land cell and each of 117 mounting configurations, `build-grid` runs the hourly model at the
reference albedo (0.2) and b₀ (0.05) and stores eight annual sums:
- incident sky and ground light
- effective sky and ground light
- IAM losses
- the irradiance-weighted ambient temperature
- the irradiance-weighted in-plane irradiance

The configurations are 13 fixed tilts × 4 GCRs, 6 east–west tilts × 4 GCRs, and 4 tracker limits ×
(isolated + 5 GCRs × backtracking on/off). Because the temperature correction is linear in `T_cell`,
these sums reproduce the hourly result exactly for any thermal and loss parameters (with Uv = 0).
Albedo, b₀ and the wind term are applied linearly; the error is under 0.3 % (see the tests). The
location analysis always runs the full hourly model with your exact inputs.

### Differences from a full PVsyst simulation
The model does not include:
- a one-diode module model, so there is no explicit low-irradiance loss (use "module quality" to account
  for it)
- an inverter efficiency curve or clipping (the DC/AC ratio is not modelled)
- electrical (string-wise) shading effects, only linear shading
- bifacial gain
- spectral correction
- far-shading beyond the PVGIS terrain horizon

The results are meant for resource screening and comparing mounting options. They do not replace a
detailed site design.

### References
- PVGIS API: <https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis/using-pvgis-5/api-non-interactive-service_en>
- Perez, R., Ineichen, P., Seals, R., Michalsky, J., Stewart, R. (1990). *Modeling daylight availability and irradiance components from direct and global irradiance.* Solar Energy 44(5), 271–289.
- Lorenzo, E., Narvarte, L., Muñoz, J. (2011). *Tracking and back-tracking.* Progress in Photovoltaics 19(6), 747–753.
- Marion, B. (2017). *Numerical method for angle-of-incidence correction factors for diffuse radiation incident photovoltaic modules.* Solar Energy 147, 344–348.
- PVsyst help: transposition models, near shadings (unlimited sheds/trackers), IAM, array thermal losses.
- Holmgren, W., Hansen, C., Mikofski, M. (2018). *pvlib python.* JOSS 3(29), 884 (used as the validation reference).

## Project layout

```
server.mjs                  static server + PVGIS relay (/api/tmy)
public/                     the website (no build step)
  index.html, css/app.css
  js/app.js                 UI wiring, map, URL state
  js/heat-layer.js          Leaflet canvas layer painting the grid
  js/grid-data.js           loading/decoding the grid, heatmap evaluation
  js/grid-codec.js          compact grid file encoding
  js/location.js            location card (live hourly simulation)
  js/pvgis.js               PVGIS TMY parsing and time alignment
  js/model/                 solar position, Perez, IAM, geometry, simulation, losses, grid configs
  vendor/leaflet/           Leaflet 1.9.4 (BSD-2-Clause)
scripts/
  build-land-mask.mjs       land cells from Natural Earth (world-atlas)
  fetch-tmy.mjs             resumable, rate-limited PVGIS download
  build-grid.mjs            multi-threaded grid precomputation
  dev/mock-pvgis.mjs        mock PVGIS server with SYNTHETIC data (tests, offline development)
  dev/make-pvlib-fixtures.py  pvlib reference values for the tests
data/land-cells-*.json      land masks (0.5°, 1°, 2°)
test/                       node:test suite (model vs pvlib, pipeline end-to-end)
```

## Development

```bash
npm test                                  # model validation + end-to-end pipeline tests (offline)
npm run mock-pvgis                        # mock PVGIS on :8091 (synthetic data)
PVGIS_BASE=http://localhost:8091/api/v5_3 npm start
npm install && npm run land-mask -- --res 0.5   # regenerate a land mask (needs devDependencies)
pip install pvlib && python scripts/dev/make-pvlib-fixtures.py   # regenerate reference values
```

## Data and licences
- Irradiance and weather: PVGIS © European Union, 2001–2026. Reuse is authorised provided the source is
  acknowledged.
- Map tiles and data: © OpenStreetMap contributors (ODbL).
- Land mask: Natural Earth (public domain) via `world-atlas`.
