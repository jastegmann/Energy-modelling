"""Generate reference values with pvlib for the JavaScript model tests.

Usage (needs pvlib: pip install pvlib):
    python scripts/dev/make-pvlib-fixtures.py

Writes test/fixtures/pvlib-reference.json.
"""
import json
import pathlib
import subprocess

import numpy as np
import pandas as pd
import pvlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
rng = np.random.default_rng(42)
out = {"pvlib_version": pvlib.__version__}

# 1. Solar position (SPA) for random instants and places.
times = pd.to_datetime(rng.integers(1_500_000_000, 1_800_000_000, 40), unit="s", utc=True)
lats = rng.uniform(-70, 70, 40)
lons = rng.uniform(-180, 180, 40)
sp = []
for t, la, lo in zip(times, lats, lons):
    s = pvlib.solarposition.get_solarposition(pd.DatetimeIndex([t]), la, lo, method="nrel_numpy")
    sp.append({"timeMs": int(t.value // 1_000_000), "lat": la, "lon": lo,
               "zenith": float(s["zenith"].iloc[0]), "azimuth": float(s["azimuth"].iloc[0])})
out["solarPosition"] = sp

# 2. Perez components for random sky / geometry.
n = 400
zen = rng.uniform(0, 89, n)
saz = rng.uniform(0, 360, n)
tilt = rng.uniform(0, 90, n)
paz = rng.uniform(0, 360, n)
dhi = rng.uniform(5, 500, n)
dni = rng.uniform(0, 1000, n)
doy = rng.integers(1, 366, n)
dni_extra = pvlib.irradiance.get_extra_radiation(doy)
am = pvlib.atmosphere.get_relative_airmass(zen, "kastenyoung1989")
comp = pvlib.irradiance.perez(tilt, paz, dhi, dni, dni_extra, zen, saz, am, return_components=True)
aoi = pvlib.irradiance.aoi(tilt, paz, zen, saz)
out["perez"] = [
    {"zenith": zen[i], "solarAzimuth": saz[i], "tilt": tilt[i], "surfaceAzimuth": paz[i],
     "dhi": dhi[i], "dni": dni[i], "doy": int(doy[i]), "dniExtra": float(dni_extra[i]), "airmass": float(am[i]),
     "aoi": float(aoi[i]),
     "iso": float(comp["poa_isotropic"][i]), "cs": float(comp["poa_circumsolar"][i]),
     "hz": float(comp["poa_horizon"][i]), "sky": float(comp["poa_sky_diffuse"][i])}
    for i in range(n)
]

# 3. Single-axis tracker (horizontal N-S axis).
n = 300
zen = rng.uniform(0, 89, n)
saz = rng.uniform(0, 360, n)
gcr = rng.uniform(0.2, 0.6, n)
lim = rng.choice([45.0, 50.0, 55.0, 60.0], n)
bt = rng.integers(0, 2, n).astype(bool)
trk = []
for i in range(n):
    r = pvlib.tracking.singleaxis(np.array([zen[i]]), np.array([saz[i]]), axis_tilt=0, axis_azimuth=180,
                                  max_angle=lim[i], backtrack=bool(bt[i]), gcr=gcr[i])
    trk.append({"zenith": zen[i], "solarAzimuth": saz[i], "gcr": gcr[i], "limit": lim[i], "backtrack": bool(bt[i]),
                "theta": float(r["tracker_theta"][0]), "surfaceTilt": float(r["surface_tilt"][0]),
                "surfaceAzimuth": float(r["surface_azimuth"][0]), "aoi": float(r["aoi"][0])})
out["tracker"] = trk

# 4. IAM (ASHRAE) and Marion's integrated diffuse IAM.
angles = np.linspace(0, 90, 19)
out["iamAshrae"] = [{"aoi": float(a), "iam": float(pvlib.iam.ashrae(a, 0.05))} for a in angles]
tilts = np.array([1, 5, 10, 20, 30, 45, 60, 75, 90], dtype=float)
md = pvlib.iam.marion_diffuse("ashrae", tilts, b=0.05)
out["marionDiffuse"] = [{"tilt": float(t), "sky": float(md["sky"][i]), "horizon": float(md["horizon"][i]),
                         "ground": float(md["ground"][i])} for i, t in enumerate(tilts)]

# 5. Full chain on a synthetic weather year (fixed plane, isolated row).
LAT, LON, OFF, TILT = 45.0, 8.0, 10, 35.0
raw = subprocess.run(["node", str(ROOT / "scripts/dev/synthetic-tmy.mjs"), str(LAT), str(LON), str(OFF)],
                     check=True, capture_output=True, text=True).stdout
rows = json.loads(raw)["outputs"]["tmy_hourly"]
df = pd.DataFrame(rows)
idx = pd.DatetimeIndex(pd.to_datetime(df["time(UTC)"], format="%Y%m%d:%H%M", utc=True)) + pd.Timedelta(minutes=OFF)
ghi, dni, dhi = df["G(h)"].values, df["Gb(n)"].values, df["Gd(h)"].values
ta, ws = df["T2m"].values, df["WS10m"].values
spos = pvlib.solarposition.get_solarposition(idx, LAT, LON, method="nrel_numpy")
zen, saz = spos["zenith"].values, spos["azimuth"].values
day = (ghi > 0) & (zen < 89.4)
dni_extra = pvlib.irradiance.get_extra_radiation(idx).values
am = pvlib.atmosphere.get_relative_airmass(zen, "kastenyoung1989")
poa = pvlib.irradiance.get_total_irradiance(TILT, 180, zen, saz, dni, ghi, dhi, dni_extra=dni_extra, airmass=am,
                                            albedo=0.2, model="perez")
comp = pvlib.irradiance.perez(TILT, 180, dhi, dni, dni_extra, zen, saz, am, return_components=True)
aoi = pvlib.irradiance.aoi(TILT, 180, zen, saz)
iam_b = pvlib.iam.ashrae(aoi, 0.05)
mdt = pvlib.iam.marion_diffuse("ashrae", TILT, b=0.05)
beam = np.where(day, np.asarray(poa["poa_direct"]), 0)
iso = np.where(day, comp["poa_isotropic"], 0)
cs = np.where(day, comp["poa_circumsolar"], 0)
hz = np.where(day, comp["poa_horizon"], 0)
gnd = np.where(day, np.asarray(poa["poa_ground_diffuse"]), 0)
inc = beam + iso + cs + hz + gnd
eff = (beam + cs) * iam_b + iso * mdt["sky"] + hz * mdt["horizon"] + gnd * mdt["ground"]
tcell = pvlib.temperature.pvsyst_cell(inc, ta, ws, u_c=29.0, u_v=0.0, module_efficiency=0.20, alpha_absorption=0.9)
p_temp = eff * 0.98 * (1 - 0.0035 * (tcell - 25))
out["chain"] = {
    "lat": LAT, "lon": LON, "offsetMin": OFF, "tilt": TILT, "albedo": 0.2, "b0": 0.05, "soiling": 2.0,
    "ghi": float(ghi.sum() / 1000), "inc": float(inc.sum() / 1000), "beam": float(beam.sum() / 1000),
    "skyDiffuse": float((iso + cs + hz).sum() / 1000), "ground": float(gnd.sum() / 1000),
    "effMarion": float(eff.sum() / 1000), "temp": float(p_temp.sum() / 1000),
}

path = ROOT / "test/fixtures/pvlib-reference.json"
path.write_text(json.dumps(out, indent=1))
print("wrote", path)
