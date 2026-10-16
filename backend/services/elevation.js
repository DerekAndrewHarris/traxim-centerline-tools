/**
 * Elevation Service (self-hosted, October 2026)
 *
 * Altitudes come from the Copernicus DEM GLO-30 (30 m) elevation model,
 * read from 1 x 1 degree tiles kept on this server. It replaces the public
 * Open-Elevation API, which refused this server outright (HTTP 429 on the
 * first request of a run, so every altitude came out as 0).
 *
 * Data: Copernicus DEM GLO-30 Public, as Cloud-Optimised GeoTIFFs in the AWS
 * open-data bucket "copernicus-dem-30m" (free, no key; see
 * https://copernicus-dem-30m.s3.amazonaws.com/readme.html). One file per
 * 1-degree square, named after its south-west corner, e.g.
 *   Copernicus_DSM_COG_10_N44_00_E009_00_DEM/Copernicus_DSM_COG_10_N44_00_E009_00_DEM.tif
 * ("10" = 1 arc-second, about 30 m). Squares that are all sea have no file
 * (HTTP 404): the readme says to take their height as 0, and so do we.
 * Licence: Copernicus DEM, free for the general public; attribution:
 * "Copernicus DEM (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space
 * GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA".
 *
 * How it works:
 *  - The first time a tile is needed it is downloaded (about 20-40 MB) into
 *    the cache folder, ELEVATION_CACHE_DIR (default /var/lib/traxim-elevation),
 *    and kept there; later runs read it from disk.
 *  - Downloads are safe when two jobs need the same tile at once (one
 *    download, both wait for it), are written to a temporary file and only
 *    renamed into place once complete and checked (size, and that it opens
 *    as a GeoTIFF covering the right square), so a half-written tile is
 *    never used.
 *  - Every point is looked up (no sub-sampling), with bilinear
 *    interpolation between the four surrounding 30 m grid points.
 *  - If a tile cannot be downloaded or read, the whole route gets
 *    elevation 0 with degraded = true and the reason, which the geometry
 *    step reports as a serious problem (as before).
 *
 * The smoothing (maximum gradient) and the tunnel/bridge handling in the
 * geometry step use these elevations exactly as they used the old service's.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

// The geotiff package (npm, version pinned in package.json) is loaded when
// first needed, so the service still starts if it has not been installed on
// the server yet; elevation then reports a clear serious problem instead.
let geotiffModule = null;
async function loadGeotiff() {
  if (!geotiffModule) {
    try {
      geotiffModule = await import('geotiff');
    } catch (error) {
      throw Object.assign(new Error('the geotiff package is not installed on the server (run npm ci in the File Generator folder)'), { code: 'NO_GEOTIFF' });
    }
  }
  return geotiffModule;
}

/** Default cache folder on the server (must be writable by the service, see the deployment notes). */
export const DEFAULT_CACHE_DIR = '/var/lib/traxim-elevation';
/** Where the tiles are downloaded from (overridable for testing or a mirror). */
export const DEFAULT_DEM_BASE_URL = 'https://copernicus-dem-30m.s3.amazonaws.com';

// Size sanity checks for a downloaded tile. Real GLO-30 tiles are about
// 1-45 MB (smaller at high latitudes and where there is a lot of sea).
const MIN_TILE_BYTES = 1024;
const MAX_TILE_BYTES = 150 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
// After a failed download, don't try the same tile again for this long
// (a job with many legs would otherwise retry, and wait, for every leg).
const FAILED_TILE_RETRY_AFTER_MS = 2 * 60 * 1000;
// Decoded 1024 x 1024 blocks kept in memory (4 MB each).
const MAX_CACHED_BLOCKS = 32;
// Values at or below this are "no data" (Copernicus has none on land; this is a guard).
const NO_DATA_BELOW = -1000;

/** Replaceable in tests (no network). */
export const elevationDeps = {
  fetch: (...args) => globalThis.fetch(...args),
  now: () => Date.now()
};

export function cacheDir() {
  return process.env.ELEVATION_CACHE_DIR || DEFAULT_CACHE_DIR;
}

function demBaseUrl() {
  return (process.env.ELEVATION_DEM_URL || DEFAULT_DEM_BASE_URL).replace(/\/+$/, '');
}

// ── In-process state ──────────────────────────────────────────────────────
const inFlight = new Map();     // tile name -> Promise<string|null> (download in progress)
const missingTiles = new Set(); // tile names known to have no file (sea), this process only
const failedTiles = new Map();  // tile name -> { at, message }
const blockCache = new Map();   // `${tile}|${bx}|${by}` -> { data, x0, y0, w, h } (LRU by insertion order)

/** Tests only: forget everything held in memory. */
export function resetElevationServiceState() {
  inFlight.clear();
  missingTiles.clear();
  failedTiles.clear();
  blockCache.clear();
}

/**
 * The tile covering a point: named after the south-west corner of its
 * 1-degree square.
 * @returns {{name: string, latFloor: number, lonFloor: number, url: string}}
 */
export function tileFor(lat, lon) {
  const latFloor = Math.floor(lat);
  const lonFloor = Math.floor(lon);
  const ns = latFloor >= 0 ? 'N' : 'S';
  const ew = lonFloor >= 0 ? 'E' : 'W';
  const name = `Copernicus_DSM_COG_10_${ns}${String(Math.abs(latFloor)).padStart(2, '0')}_00_` +
               `${ew}${String(Math.abs(lonFloor)).padStart(3, '0')}_00_DEM`;
  return { name, latFloor, lonFloor, url: `${demBaseUrl()}/${name}/${name}.tif` };
}

/** Short form for messages, e.g. "N44 E009". */
function shortName(tile) {
  const m = /_([NS]\d\d)_00_([EW]\d\d\d)_00_/.exec(tile.name);
  return m ? `${m[1]} ${m[2]}` : tile.name;
}

/**
 * Open a tile file and check it is a GeoTIFF covering the expected square.
 * @returns {Promise<{tiff, image, geo}>}
 */
async function openTile(filePath, tile) {
  const { fromFile } = await loadGeotiff();
  const tiff = await fromFile(filePath);
  try {
    const image = await tiff.getImage();
    const width = image.getWidth();
    const height = image.getHeight();
    if (width < 2 || height < 2) throw new Error(`tile is only ${width} x ${height} pixels`);
    const [west, south, east, north] = image.getBoundingBox();
    const tol = 0.01;
    if (Math.abs(west - tile.lonFloor) > tol || Math.abs(south - tile.latFloor) > tol ||
        Math.abs(east - (tile.lonFloor + 1)) > tol || Math.abs(north - (tile.latFloor + 1)) > tol) {
      throw new Error(`tile covers ${west},${south} to ${east},${north}, not the expected 1-degree square`);
    }
    const [ox, oy] = image.getOrigin();
    const [rx, ry] = image.getResolution();
    // PixelIsPoint (2, as Copernicus uses): the origin is the centre of the
    // top-left pixel. PixelIsArea (1, the GeoTIFF default): its corner.
    const isPoint = image.getGeoKeys()?.GTRasterTypeGeoKey === 2;
    const half = isPoint ? 0 : 0.5;
    const noData = image.getGDALNoData();
    const blockW = image.isTiled ? image.getTileWidth() : 512;
    const blockH = image.isTiled ? image.getTileHeight() : 512;
    return { tiff, image, geo: { ox, oy, rx, ry, half, width, height, noData, blockW, blockH } };
  } catch (error) {
    try { tiff.close(); } catch { /* ignore */ }
    throw error;
  }
}

/** Download a tile into the cache folder. Resolves to its path, or null if there is no such tile (sea). */
async function downloadTile(tile, progressCallback) {
  const dir = cacheDir();
  const finalPath = path.join(dir, `${tile.name}.tif`);
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (error) {
    throw new Error(`the elevation cache folder ${dir} cannot be created (${error.code || error.message})`);
  }

  if (progressCallback) progressCallback(null, `Downloading elevation tile ${shortName(tile)} (first use; about 20-40 MB)`);
  console.log(`[Elevation] Downloading ${tile.url}`);
  const response = await elevationDeps.fetch(tile.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (response.status === 404) {
    console.log(`[Elevation] No tile ${tile.name} (all sea): elevation 0 there`);
    return null;
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > 0 && (declared < MIN_TILE_BYTES || declared > MAX_TILE_BYTES)) {
    throw new Error(`unexpected tile size ${declared} bytes`);
  }

  const tmpPath = path.join(dir, `${tile.name}.tif.part-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    let written = 0;
    const counter = async function* (source) {
      for await (const chunk of source) {
        written += chunk.length;
        if (written > MAX_TILE_BYTES) throw new Error(`tile larger than ${MAX_TILE_BYTES} bytes`);
        yield chunk;
      }
    };
    try {
      await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(tmpPath, { mode: 0o644 }));
    } catch (error) {
      if (error.code === 'EACCES' || error.code === 'EROFS' || error.code === 'EPERM') {
        throw new Error(`the elevation cache folder ${dir} is not writable (${error.code})`);
      }
      throw error;
    }
    if (written < MIN_TILE_BYTES) throw new Error(`download too small (${written} bytes)`);
    if (Number.isFinite(declared) && declared > 0 && written !== declared) {
      throw new Error(`download incomplete (${written} of ${declared} bytes)`);
    }
    // Must open as a GeoTIFF for the right square before it is used.
    const opened = await openTile(tmpPath, tile);
    opened.tiff.close();
    await fsp.rename(tmpPath, finalPath); // atomic: other readers see the whole file or none
    console.log(`[Elevation] Cached ${finalPath} (${(written / 1048576).toFixed(1)} MB)`);
    return finalPath;
  } finally {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
  }
}

/**
 * Path of a cached tile, downloading it if needed; null for a sea tile.
 * One download per tile at a time, however many jobs ask.
 */
async function ensureTile(tile, progressCallback) {
  const finalPath = path.join(cacheDir(), `${tile.name}.tif`);
  if (missingTiles.has(tile.name)) return null;
  if (fs.existsSync(finalPath)) return finalPath;

  const failed = failedTiles.get(tile.name);
  if (failed && elevationDeps.now() - failed.at < FAILED_TILE_RETRY_AFTER_MS) {
    throw new Error(`elevation tile ${shortName(tile)} could not be downloaded a moment ago (${failed.message}); not retried yet`);
  }

  if (!inFlight.has(tile.name)) {
    const p = downloadTile(tile, progressCallback)
      .then((result) => {
        failedTiles.delete(tile.name);
        if (result === null) missingTiles.add(tile.name);
        return result;
      })
      .catch((error) => {
        failedTiles.set(tile.name, { at: elevationDeps.now(), message: error.message });
        throw new Error(`elevation tile ${shortName(tile)} could not be downloaded (${error.message})`);
      })
      .finally(() => inFlight.delete(tile.name));
    inFlight.set(tile.name, p);
  }
  return inFlight.get(tile.name);
}

/** Open a cached tile; a cached file that does not open is deleted and downloaded again once. */
async function openCachedTile(tile, progressCallback) {
  let filePath = await ensureTile(tile, progressCallback);
  if (filePath === null) return null;
  try {
    return await openTile(filePath, tile);
  } catch (error) {
    if (error.code === 'NO_GEOTIFF') throw error; // not the file's fault: keep it
    console.warn(`[Elevation] Cached tile ${filePath} is unreadable (${error.message}); downloading it again`);
    await fsp.rm(filePath, { force: true }).catch(() => {});
    for (const key of [...blockCache.keys()]) if (key.startsWith(`${tile.name}|`)) blockCache.delete(key);
    filePath = await ensureTile(tile, progressCallback);
    if (filePath === null) return null;
    try {
      return await openTile(filePath, tile);
    } catch (error2) {
      throw new Error(`elevation tile ${shortName(tile)} cannot be read (${error2.message})`);
    }
  }
}

function cacheBlock(key, block) {
  blockCache.delete(key);
  blockCache.set(key, block);
  while (blockCache.size > MAX_CACHED_BLOCKS) blockCache.delete(blockCache.keys().next().value);
}

/**
 * Elevations for the points that fall in one tile, by bilinear interpolation
 * between the four surrounding grid points. Writes into `out` at `indices`.
 */
async function sampleTile(tile, points, indices, out, progressCallback) {
  const opened = await openCachedTile(tile, progressCallback);
  if (opened === null) {
    for (const i of indices) out[i] = 0; // sea tile
    return;
  }
  const { tiff, image, geo } = opened;
  try {
    const { ox, oy, rx, ry, half, width, height, noData, blockW, blockH } = geo;
    // Fractional pixel position (column, row) of each point, clamped to the grid.
    const pos = indices.map(i => {
      const col = (points[i].lon - ox) / rx - half;
      const row = (points[i].lat - oy) / ry - half;
      return {
        col: Math.min(Math.max(col, 0), width - 1),
        row: Math.min(Math.max(row, 0), height - 1)
      };
    });

    // Load every block the four corners need (once each).
    const needed = new Set();
    for (const { col, row } of pos) {
      const c0 = Math.floor(col), r0 = Math.floor(row);
      for (const c of [c0, Math.min(c0 + 1, width - 1)]) {
        for (const r of [r0, Math.min(r0 + 1, height - 1)]) {
          needed.add(`${Math.floor(c / blockW)}|${Math.floor(r / blockH)}`);
        }
      }
    }
    for (const b of needed) {
      const key = `${tile.name}|${b}`;
      if (blockCache.has(key)) { cacheBlock(key, blockCache.get(key)); continue; }
      const [bx, by] = b.split('|').map(Number);
      const x0 = bx * blockW, y0 = by * blockH;
      const x1 = Math.min(x0 + blockW, width), y1 = Math.min(y0 + blockH, height);
      const rasters = await image.readRasters({ window: [x0, y0, x1, y1], samples: [0] });
      cacheBlock(key, { data: rasters[0], x0, y0, w: x1 - x0 });
    }

    const valueAt = (c, r) => {
      const block = blockCache.get(`${tile.name}|${Math.floor(c / blockW)}|${Math.floor(r / blockH)}`);
      const v = block.data[(r - block.y0) * block.w + (c - block.x0)];
      if (!Number.isFinite(v) || v <= NO_DATA_BELOW || (noData !== null && v === noData)) return null;
      return v;
    };

    pos.forEach(({ col, row }, k) => {
      const c0 = Math.floor(col), r0 = Math.floor(row);
      const c1 = Math.min(c0 + 1, width - 1), r1 = Math.min(r0 + 1, height - 1);
      const fx = col - c0, fy = row - r0;
      const corners = [
        [valueAt(c0, r0), (1 - fx) * (1 - fy)],
        [valueAt(c1, r0), fx * (1 - fy)],
        [valueAt(c0, r1), (1 - fx) * fy],
        [valueAt(c1, r1), fx * fy]
      ];
      // No-data corners are left out (weights renormalised); none valid -> 0.
      let sum = 0, weight = 0;
      for (const [v, w] of corners) if (v !== null) { sum += v * w; weight += w; }
      const anyValid = corners.some(([v]) => v !== null);
      out[indices[k]] = weight > 1e-12 ? sum / weight
        : anyValid ? corners.find(([v]) => v !== null)[0] : 0;
    });
  } finally {
    try { tiff.close(); } catch { /* ignore */ }
  }
}

/**
 * Elevations for an array of points.
 *
 * Never throws: if the data cannot be had, every point gets elevation 0 and
 * the returned array has degraded = true and degradedReason, which the
 * geometry step turns into a serious problem.
 *
 * @param {Array<{lat: number, lon: number}>} points
 * @param {Function} progressCallback - optional (percent, message)
 * @returns {Promise<Array<{lat: number, lon: number, elevation: number}>>}
 */
export async function fetchElevations(points, progressCallback = null) {
  if (!points || points.length === 0) return [];

  const report = (pct, msg) => { if (progressCallback) progressCallback(pct, msg); };
  try {
    await loadGeotiff(); // fail fast (before any download) if it is not installed
    // Group the points by tile.
    const byTile = new Map();
    points.forEach((p, i) => {
      const tile = tileFor(p.lat, p.lon);
      if (!byTile.has(tile.name)) byTile.set(tile.name, { tile, indices: [] });
      byTile.get(tile.name).indices.push(i);
    });

    report(0, `Reading elevations for ${points.length} points from ${byTile.size} elevation tile(s)`);
    const elevations = new Array(points.length).fill(0);
    let done = 0;
    for (const { tile, indices } of byTile.values()) {
      await sampleTile(tile, points, indices, elevations,
        (pct, msg) => report(Math.round((done / byTile.size) * 90), msg));
      done++;
      report(Math.round((done / byTile.size) * 90), `Elevation tile ${shortName(tile)} read`);
    }
    report(100, `Elevation data complete (${points.length} points)`);
    return points.map((p, i) => ({ lat: p.lat, lon: p.lon, elevation: elevations[i] }));
  } catch (error) {
    console.error('[Elevation] Failed:', error.message);
    report(100, 'Elevation data unavailable - using elevation = 0');
    const fallback = points.map(p => ({ lat: p.lat, lon: p.lon, elevation: 0 }));
    fallback.degraded = true;
    fallback.degradedReason = error.message;
    return fallback;
  }
}

export default { fetchElevations, tileFor, cacheDir };
