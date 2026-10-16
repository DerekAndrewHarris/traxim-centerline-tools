/**
 * Self-hosted elevation (October 2026): Copernicus DEM GLO-30 tiles,
 * downloaded once into a cache folder and read locally with bilinear
 * interpolation (backend/services/elevation.js).
 *
 * No network: the download is replaced by a tiny synthetic GeoTIFF made here
 * (10 x 10 grid points, 0.1 degree apart, laid out like a Copernicus tile:
 * pixel-is-point, top-left grid point at the tile's north-west corner).
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeArrayBuffer } from 'geotiff';

const elevation = await import('../backend/services/elevation.js');

// Elevation at grid point (col, row) of the fixture: a plane, so bilinear
// interpolation must give exact values anywhere between grid points.
const plane = (col, row) => 100 + 10 * col + 2 * row;

/** A synthetic 1 x 1 degree tile with south-west corner (latFloor, lonFloor). */
function fixtureTile(latFloor, lonFloor, valueAt = plane) {
  const w = 10, h = 10;
  const values = new Float32Array(w * h);
  for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) values[row * w + col] = valueAt(col, row);
  return Buffer.from(writeArrayBuffer(values, {
    width: w, height: h, BitsPerSample: [32], SampleFormat: [3],
    ModelPixelScale: [0.1, 0.1, 0], ModelTiepoint: [0, 0, 0, lonFloor, latFloor + 1, 0],
    GeographicTypeGeoKey: 4326, GTModelTypeGeoKey: 2, GTRasterTypeGeoKey: 2
  }));
}

function response(status, bytes) {
  if (status !== 200) return new Response(null, { status });
  return new Response(bytes, { status, headers: { 'content-length': String(bytes.length) } });
}

let dir;
let fetched;           // URLs requested
let serve;             // url -> Response (or throws)
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-dem-'));
  process.env.ELEVATION_CACHE_DIR = dir;
  delete process.env.ELEVATION_DEM_URL;
  elevation.resetElevationServiceState();
  fetched = [];
  serve = (url) => {
    const m = /_([NS])(\d\d)_00_([EW])(\d\d\d)_00_DEM\.tif$/.exec(url);
    const lat = (m[1] === 'N' ? 1 : -1) * Number(m[2]);
    const lon = (m[3] === 'E' ? 1 : -1) * Number(m[4]);
    return response(200, fixtureTile(lat, lon));
  };
  elevation.elevationDeps.fetch = async (url) => { fetched.push(url); return serve(url); };
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.ELEVATION_CACHE_DIR;
});

const cachedFiles = () => fs.readdirSync(dir);

test('tile names and URLs follow the Copernicus layout (south-west corner)', () => {
  const t = elevation.tileFor(44.1, 9.8);
  assert.equal(t.name, 'Copernicus_DSM_COG_10_N44_00_E009_00_DEM');
  assert.equal(t.url, 'https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N44_00_E009_00_DEM/Copernicus_DSM_COG_10_N44_00_E009_00_DEM.tif');
  assert.equal(elevation.tileFor(-0.5, -0.5).name, 'Copernicus_DSM_COG_10_S01_00_W001_00_DEM');
  assert.equal(elevation.tileFor(51.5, -0.1).name, 'Copernicus_DSM_COG_10_N51_00_W001_00_DEM');
  assert.equal(elevation.tileFor(-33.9, 151.2).name, 'Copernicus_DSM_COG_10_S34_00_E151_00_DEM');
});

test('the default cache folder is /var/lib/traxim-elevation, overridable with ELEVATION_CACHE_DIR', () => {
  assert.equal(elevation.DEFAULT_CACHE_DIR, '/var/lib/traxim-elevation');
  assert.equal(elevation.cacheDir(), dir);
});

test('bilinear interpolation between the four surrounding grid points', async () => {
  // Grid point (col, row) is at lon 9 + col/10, lat 45 - row/10.
  const pts = [
    { lat: 44.9, lon: 9.1 },    // grid point (1,1)
    { lat: 44.7, lon: 9.4 },    // grid point (4,3)
    { lat: 44.65, lon: 9.45 },  // between (4,3),(5,3),(4,4),(5,4): col 4.5, row 3.5
    { lat: 44.62, lon: 9.13 }   // col 1.3, row 3.8
  ];
  const r = await elevation.fetchElevations(pts);
  assert.equal(r.degraded, undefined);
  const expect = [plane(1, 1), plane(4, 3), plane(4.5, 3.5), plane(1.3, 3.8)];
  r.forEach((p, i) => assert.ok(Math.abs(p.elevation - expect[i]) < 1e-3, `point ${i}: ${p.elevation} vs ${expect[i]}`));
  assert.equal(r[0].lat, 44.9);
});

test('points beyond the last grid point use the edge value (no extrapolation)', async () => {
  // South-east corner area of the tile: col > 9, row > 9.
  const r = await elevation.fetchElevations([{ lat: 44.01, lon: 9.99 }]);
  assert.ok(Math.abs(r[0].elevation - plane(9, 9)) < 1e-3);
});

test('a tile is downloaded once, cached on disk, and reused', async () => {
  const pts = [{ lat: 44.5, lon: 9.5 }];
  await elevation.fetchElevations(pts);
  assert.equal(fetched.length, 1);
  assert.deepEqual(cachedFiles(), ['Copernicus_DSM_COG_10_N44_00_E009_00_DEM.tif'], 'only the finished tile, no temporary file');
  await elevation.fetchElevations(pts);
  elevation.resetElevationServiceState(); // as after a restart: memory empty, disk cache kept
  const again = await elevation.fetchElevations(pts);
  assert.equal(fetched.length, 1, 'no second download');
  assert.ok(Math.abs(again[0].elevation - plane(5, 5)) < 1e-3);
});

test('two jobs needing the same tile at once share one download', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const plain = serve;
  serve = async (url) => { await gate; return plain(url); };
  const a = elevation.fetchElevations([{ lat: 44.5, lon: 9.5 }]);
  const b = elevation.fetchElevations([{ lat: 44.2, lon: 9.2 }]);
  await new Promise(r => setTimeout(r, 20));
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(fetched.length, 1);
  assert.equal(ra.degraded, undefined);
  assert.equal(rb.degraded, undefined);
});

test('a route across two tiles uses both', async () => {
  const r = await elevation.fetchElevations([{ lat: 44.5, lon: 9.95 }, { lat: 44.5, lon: 10.05 }]);
  assert.equal(fetched.length, 2);
  assert.ok(r.every(p => p.elevation > 0));
});

test('a square with no tile (all sea, HTTP 404) gives elevation 0, not an error', async () => {
  serve = () => response(404);
  const r = await elevation.fetchElevations([{ lat: 43.5, lon: 9.5 }, { lat: 43.6, lon: 9.6 }]);
  assert.equal(r.degraded, undefined);
  assert.deepEqual(r.map(p => p.elevation), [0, 0]);
  assert.deepEqual(cachedFiles(), []);
  await elevation.fetchElevations([{ lat: 43.5, lon: 9.5 }]);
  assert.equal(fetched.length, 1, '404 remembered while the service runs');
});

test('a download that fails: elevation 0, degraded with the reason, nothing left in the cache, not retried at once', async () => {
  serve = () => response(503);
  const r = await elevation.fetchElevations([{ lat: 44.5, lon: 9.5 }]);
  assert.equal(r.degraded, true);
  assert.match(r.degradedReason, /elevation tile N44 E009 could not be downloaded \(HTTP 503\)/);
  assert.ok(r.every(p => p.elevation === 0));
  assert.deepEqual(cachedFiles(), []);
  const again = await elevation.fetchElevations([{ lat: 44.5, lon: 9.5 }]);
  assert.match(again.degradedReason, /not retried yet/);
  assert.equal(fetched.length, 1);
});

test('an incomplete or wrong download is rejected and not cached', async () => {
  // Shorter than its Content-Length says.
  serve = () => new Response(fixtureTile(44, 9).subarray(0, 1200), { status: 200, headers: { 'content-length': '5000' } });
  let r = await elevation.fetchElevations([{ lat: 44.5, lon: 9.5 }]);
  assert.equal(r.degraded, true);
  assert.match(r.degradedReason, /incomplete/);
  assert.deepEqual(cachedFiles(), []);

  // A valid GeoTIFF, but for the wrong square.
  elevation.resetElevationServiceState();
  serve = () => response(200, fixtureTile(10, 20));
  r = await elevation.fetchElevations([{ lat: 44.5, lon: 9.5 }]);
  assert.equal(r.degraded, true);
  assert.match(r.degradedReason, /not the expected 1-degree square/);
  assert.deepEqual(cachedFiles(), []);

  // Not a GeoTIFF at all.
  elevation.resetElevationServiceState();
  serve = () => response(200, Buffer.alloc(4096, 0x41));
  r = await elevation.fetchElevations([{ lat: 44.5, lon: 9.5 }]);
  assert.equal(r.degraded, true);
  assert.deepEqual(cachedFiles(), []);
});

test('a damaged file in the cache is downloaded again', async () => {
  fs.writeFileSync(path.join(dir, 'Copernicus_DSM_COG_10_N44_00_E009_00_DEM.tif'), Buffer.alloc(4096, 0x42));
  const r = await elevation.fetchElevations([{ lat: 44.5, lon: 9.5 }]);
  assert.equal(r.degraded, undefined);
  assert.equal(fetched.length, 1);
  assert.ok(Math.abs(r[0].elevation - plane(5, 5)) < 1e-3);
});

test('no-data grid points are left out of the interpolation', async () => {
  serve = () => response(200, fixtureTile(44, 9, (col, row) => (col === 5 && row === 5 ? -32767 : 50)));
  const r = await elevation.fetchElevations([{ lat: 44.55, lon: 9.45 }, { lat: 44.5, lon: 9.5 }]);
  assert.ok(Math.abs(r[0].elevation - 50) < 1e-6, 'the three valid corners');
  assert.ok(Math.abs(r[1].elevation - 50) < 1e-6, 'exactly on the no-data point: a valid neighbour');
});
