# Solar Yield Map

A website that shows, on an OpenStreetMap world map, the photovoltaic **specific yield (kWh/kWp)** for all
land areas. The yield comes from **PVGIS** typical-meteorological-year (TMY) irradiance, run through a
**PVsyst-style model** with **Perez transposition**.

- **Left panel:** choose the mounting structure: fixed tilt facing the equator, fixed east–west, or a
  single-axis tracker (horizontal N–S axis, tracking east to west, with or without backtracking). You can
  also set the row spacing (GCR), albedo, IAM, thermal parameters and system losses. The heatmap updates
  instantly.
- **Map:** a heatmap of specific yield, performance ratio, in-plane irradiation, GHI or optimal tilt on
  precomputed grids. You can combine several resolutions, e.g. a 0.5° world grid, a 0.1° Africa grid and
  0.05° grids for selected countries. The finest grid available is drawn on top, and grids load in blocks
  as they come into view. Hover to read values.
- **Click any location:** the site fetches that point's TMY from PVGIS live and runs the full hourly
  simulation. It shows the annual yield, PR, monthly yields, a PVsyst-like loss diagram, a comparison of
  all mounting types, and where the data came from.
- **Site screening:** filter land by protected areas, land cover, slope and distance to the power grid.
  Then rank all grid cells of a country, or of the current map view, by specific yield for the current
  inputs. You can jump to any of the top cells and export every cell as CSV.

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

Requirements: **Node.js 22.13+** (24 recommended). The site needs no npm packages at run time.

```bash
npm start                 # http://localhost:8080
```

Clicking the map works straight away, because the local server relays each request to the PVGIS API.
The PVGIS API cannot be called directly from a browser, which is why a server is needed. The heatmap
needs a one-off precomputation per resolution: `fetch` downloads the PVGIS data, and `build-grid` runs
the model.

```bash
npm run fetch                               # world, 0.5°
npm run build-grid

npm run fetch -- --res 0.1 --region africa  # Africa, 0.1°
npm run build-grid -- --res 0.1

npm run fetch -- --res 0.05 --countries "Kenya,Tanzania"   # detailed country grids, 0.05°
npm run build-grid -- --res 0.05
npm start
```

| Grid | PVGIS requests | Fetch time* | Build time** | Cache | Grid files |
|---|---|---|---|---|---|
| World 0.5° | ≈ 67,000 | 3–6 h | 30–90 min | ≈ 3 GB | ≈ 60–90 MB |
| Africa 0.5° (`--region africa`) | ≈ 10,600 | 30–60 min | 5–15 min | ≈ 0.5 GB | ≈ 10–15 MB |
| Africa 0.1° | ≈ 258,000 | 12–24 h | 1–3 h | ≈ 12 GB | ≈ 80–120 MB |
| Africa 0.05° | ≈ 1,030,000 | 2–5 days | 5–12 h | ≈ 46 GB | ≈ 300–450 MB |
| Kenya 0.05° | ≈ 19,000 | 1–2 h | 10–20 min | ≈ 0.9 GB | ≈ 5–10 MB |

\* PVGIS allows at most 30 requests/s; the default stays at ≤ 20/s, and actual throughput depends on
PVGIS response times. \*\* Depends on the number of CPU cores.

Grids finer than 0.5° use the **standard configuration set** (39 of the 117 mounting layouts) to keep the
files small:
- fixed tilt 0–60° with isolated rows or GCR 0.4
- east–west 5–20° isolated or at GCR 0.85
- trackers ±55°/±60°, isolated or backtracking at GCR 0.35/0.4

For any other layout the map falls back to the next coarser grid, and the legend says so. Use
`--configs full` to build all 117.

Tips:
- **Select an area** with `--region africa`, `--countries "Kenya,Nigeria"` (Natural Earth names, e.g.
  "Dem. Rep. Congo", "Côte d'Ivoire", "S. Sudan") or `--bbox=lonMin,latMin,lonMax,latMax`. Always attach
  `--bbox` with `=`, because a leading minus sign would otherwise be read as a new option.
- **Land masks** for the world (0.5°, 1°, 2°) and for Africa (0.1°, 0.05°) are included. For other areas at
  0.1° or 0.05°, run `npm install` and then `npm run land-mask -- --res 0.05 --countries "Chile"`.
- **Incremental builds:** `build-grid` stores each grid in blocks (30° / 10° / 5°). Blocks whose cells have
  not changed are reused, so after fetching another country only the new blocks are computed. Use
  `--force` to recompute everything, or `--clean` to start the dataset from scratch.
- The fetch can be stopped with Ctrl‑C and restarted at any time. Cells already in `cache/` are skipped.
  Failed cells are listed in `cache/tmy/<res>/failed.json`, and you can retry them with `--retry-failed`.
- Behind an HTTP proxy, run the scripts and the server with `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21 / 24).
- To see the UI without PVGIS: `npm run build-grid -- --synthetic --res 2` builds a grid from made‑up
  weather. The site then shows a prominent "synthetic data" warning.

### Site-screening layers (optional)

The screening filters (protected areas, land cover, slope, distance to the power grid) need a second
precomputation for each grid you built:

```bash
npm install                                              # once: installs the GeoTIFF reader
npm run build-screening -- --res 0.1 --region africa
npm run build-screening -- --res 0.05 --countries "Kenya"
```

| Layer | Source | Licence | How it is read |
|---|---|---|---|
| Protected areas | OpenStreetMap: `boundary=protected_area` (nature classes 1–19, 97–99), `boundary=national_park`, `leisure=nature_reserve` | ODbL, commercial use allowed with attribution | Overpass API, one query per country |
| Land cover | ESA WorldCover 10 m 2021 v200 | CC BY 4.0 | Cloud-optimised GeoTIFFs; only the ~150 m overview is read |
| Slope | Copernicus DEM GLO-90 | Free, including commercial use (Copernicus licence) | Cloud-optimised GeoTIFFs, ~185 m overview |
| Distance to grid | gridfinder (Arderne et al. 2020), modelled medium-voltage network | CC BY 4.0 | `grid.gpkg` from Zenodo |

For every grid cell, the script stores the share of the cell's land in each combination of:
- protected yes/no
- 11 land-cover classes
- 5 slope classes (0–3°, 3–5°, 5–10°, 10–15°, >15°)

It also stores the distance from the cell centre to the nearest gridfinder line. The page combines these
with your filter choices exactly: for example, "not protected, not forest or built-up, slope ≤ 10°". The
map can show **suitable land (%)** or **distance to grid**, or hide cells that fail the filters. Rankings
and CSV exports then include only passing cells, with suitable area (km²), protected share and grid
distance.

Notes:
- **Time and data volume:** for all of Africa, expect about 3,000 one-degree tiles, a few GB of downloads
  and 1–3 hours. Results are cached per tile in `cache/screening/`, so the script can be stopped and
  restarted, and other resolutions reuse them.
- **gridfinder download:** the network is downloaded once from Zenodo. If that fails, download `grid.gpkg`
  from <https://zenodo.org/records/3628142> and pass `--gridfinder path/to/grid.gpkg`.
- **Overpass limits:** Overpass is a shared public service. Large countries can take several minutes. When
  a server is busy (HTTP 429/504) the script retries and switches between public instances (overpass-api.de,
  overpass.kumi.systems, overpass.private.coffee). Countries that still fail are reported at the end; the rest
  are cached, so running the command again retries only those. `--overpass url1,url2` sets the instances.
- **Limitations:**
  - gridfinder lines are *predicted*, not surveyed.
  - OpenStreetMap protected-area coverage varies by country.
  - Land cover and slope at ~150–185 m are meant for screening, not site design.
- **Attribution** when publishing results: © OpenStreetMap contributors; ESA WorldCover project 2021 /
  Contains modified Copernicus Sentinel data (2021); Copernicus DEM © DLR e.V. 2010–2014 and © Airbus
  Defence and Space GmbH 2014–2018, provided under COPERNICUS by the EU and ESA; gridfinder, Arderne et
  al. (2020), Scientific Data 7:19.

### Hosting

**GitHub Pages:** `.github/workflows/pages.yml` runs the tests and publishes `public/` on every push to
`main`. First, enable it once under the repository's Settings → Pages → Source: **GitHub Actions**. Then
build the grids locally, remove `public/data/grids/` from `.gitignore`, and commit them. GitHub Pages
sites are limited to about 1 GB. The 0.5° world grid, the 0.1° Africa grid and several 0.05° countries fit
comfortably. A 0.05° grid of all of Africa also fits, but it makes the repository large and slow to push.


`public/` is a static site. The heatmap and screening work on any static host, e.g. GitHub Pages, once the
grids in `public/data/grids/` are committed. Live location analysis needs `server.mjs` (or
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
  js/grid-data.js           grids (datasets and blocks): loading, evaluation
  js/grid-codec.js          compact grid file encoding
  js/location.js            location card (live hourly simulation)
  js/screening.js           ranking by country / map view, CSV export
  js/screening-layers.js    screening layer format and filter evaluation
  js/pvgis.js               PVGIS TMY parsing and time alignment
  js/model/                 solar position, Perez, IAM, geometry, simulation, losses, grid configs
  vendor/leaflet/           Leaflet 1.9.4 (BSD-2-Clause)
scripts/
  build-land-mask.mjs       land cells and countries from Natural Earth (world-atlas)
  lib/regions.mjs           country groupings (Africa)
  fetch-tmy.mjs             resumable, rate-limited PVGIS download
  build-grid.mjs            multi-threaded grid precomputation
  build-screening.mjs       protected areas, land cover, slope, grid distance per cell
  lib/raster.mjs            windowed reads of cloud-optimised GeoTIFFs
  lib/osm-protected.mjs     OpenStreetMap protected areas via Overpass
  lib/gpkg-lines.mjs        GeoPackage lines and nearest-line distances
  dev/mock-pvgis.mjs        mock PVGIS server with SYNTHETIC data (tests, offline development)
  dev/mock-screening-sources.mjs  SYNTHETIC WorldCover/DEM tiles, Overpass and gridfinder stand-ins
  dev/make-pvlib-fixtures.py  pvlib reference values for the tests
data/land-cells-*.json[.gz]  land masks with country per cell (world 0.5°/1°/2°, Africa 0.1°/0.05°)
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
- Land mask and countries: Natural Earth (public domain) via `world-atlas`.
- Screening layers: see the attribution list under "Site-screening layers".
