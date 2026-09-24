// Windowed reads from cloud-optimised GeoTIFFs (COG) over HTTP range requests.
// Only the internal overview closest to the requested resolution is read, so
// continental coverage needs a small fraction of the full-resolution download.

import { fromUrl } from 'geotiff';

const opened = new Map(); // url -> Promise<{tiff, images}|null>, small LRU

async function open(url) {
  if (opened.has(url)) {
    const p = opened.get(url);
    opened.delete(url);
    opened.set(url, p);
    return p;
  }
  const p = (async () => {
    // A missing tile (e.g. open ocean) is not an error.
    const head = await fetch(url, { method: 'HEAD' }).catch((e) => {
      throw new Error(`${url}: ${e.cause?.code ?? e.message}`);
    });
    if (head.status === 404 || head.status === 403) return null;
    if (!head.ok) throw new Error(`${url}: HTTP ${head.status}`);
    const tiff = await fromUrl(url, { allowFullFile: false });
    const n = await tiff.getImageCount();
    const images = [];
    for (let i = 0; i < n; i++) images.push(await tiff.getImage(i));
    const [west, south, east, north] = images[0].getBoundingBox();
    return { tiff, images, west, south, east, north };
  })();
  opened.set(url, p);
  p.catch(() => opened.delete(url));
  if (opened.size > 12) opened.delete(opened.keys().next().value);
  return p;
}

/**
 * Read the area [west, south, east, north] (degrees) resampled to width × height
 * pixels (row 0 at north), from the coarsest overview that is still at least as
 * fine as the requested resolution.
 * @returns {Promise<TypedArray|null>} null if the file does not exist
 */
export async function readArea(url, { west, south, east, north }, width, height, resampleMethod = 'nearest') {
  const src = await open(url);
  if (!src) return null;
  const pxPerDegWanted = width / (east - west);
  const full = src.images[0];
  let image = full;
  for (const img of src.images) {
    const ppd = img.getWidth() / (src.east - src.west);
    if (ppd >= pxPerDegWanted && img.getWidth() < image.getWidth()) image = img;
  }
  const ppdX = image.getWidth() / (src.east - src.west);
  const ppdY = image.getHeight() / (src.north - src.south);
  const x0 = Math.max(0, Math.round((west - src.west) * ppdX));
  const x1 = Math.min(image.getWidth(), Math.round((east - src.west) * ppdX));
  const y0 = Math.max(0, Math.round((src.north - north) * ppdY));
  const y1 = Math.min(image.getHeight(), Math.round((src.north - south) * ppdY));
  if (x1 <= x0 || y1 <= y0) return null;
  const r = await image.readRasters({ window: [x0, y0, x1, y1], width, height, resampleMethod, interleave: false });
  return r[0];
}

/** ESA WorldCover 2021 v200, 3°×3° tiles named after their south-west corner. */
export const WORLDCOVER = {
  base: 'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map',
  url(lat, lon, base = WORLDCOVER.base) {
    const la = Math.floor(lat / 3) * 3;
    const lo = Math.floor(lon / 3) * 3;
    const name = `${la < 0 ? 'S' : 'N'}${String(Math.abs(la)).padStart(2, '0')}${lo < 0 ? 'W' : 'E'}${String(Math.abs(lo)).padStart(3, '0')}`;
    return `${base}/ESA_WorldCover_10m_2021_v200_${name}_Map.tif`;
  },
  classes: [10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100],
  names: ['Tree cover', 'Shrubland', 'Grassland', 'Cropland', 'Built-up', 'Bare / sparse vegetation', 'Snow and ice', 'Permanent water', 'Herbaceous wetland', 'Mangroves', 'Moss and lichen'],
};

/** Copernicus DEM GLO-90, 1°×1° tiles named after their south-west corner. */
export const COPDEM = {
  base: 'https://copernicus-dem-90m.s3.amazonaws.com',
  url(lat, lon, base = COPDEM.base) {
    const la = Math.floor(lat);
    const lo = Math.floor(lon);
    const name = `Copernicus_DSM_COG_30_${la < 0 ? 'S' : 'N'}${String(Math.abs(la)).padStart(2, '0')}_00_${lo < 0 ? 'W' : 'E'}${String(Math.abs(lo)).padStart(3, '0')}_00_DEM`;
    return `${base}/${name}/${name}.tif`;
  },
};

/**
 * Slope in degrees (Horn's method) of an elevation grid in geographic
 * coordinates; edges are handled by clamping.
 */
export function slopeDegrees(z, width, height, north, pxDeg) {
  const out = new Float32Array(width * height);
  const dy = pxDeg * 110574;
  for (let y = 0; y < height; y++) {
    const lat = north - (y + 0.5) * pxDeg;
    const dx = pxDeg * 111320 * Math.cos((lat * Math.PI) / 180);
    const ym = Math.max(0, y - 1) * width, yc = y * width, yp = Math.min(height - 1, y + 1) * width;
    for (let x = 0; x < width; x++) {
      const xm = Math.max(0, x - 1), xp = Math.min(width - 1, x + 1);
      const gx = (z[ym + xp] + 2 * z[yc + xp] + z[yp + xp] - z[ym + xm] - 2 * z[yc + xm] - z[yp + xm]) / (8 * dx);
      const gy = (z[yp + xm] + 2 * z[yp + x] + z[yp + xp] - z[ym + xm] - 2 * z[ym + x] - z[ym + xp]) / (8 * dy);
      out[yc + x] = (Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI;
    }
  }
  return out;
}
