/**
 * Follow-up changes after the first real agent test (16 Oct 2026):
 * date-stamped download names, the KML in the download, "serious problems"
 * (no elevation data), the maximum-gradient setting, and the elevation
 * service's handling of HTTP 429 "too many requests".
 *
 * Run with:  npm test
 * No network: the elevation service's fetch and sleep are replaced.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { makeOutputStamp, stampedName, safeFileBase, isValidOutputStamp } = await import('../backend/utils/outputNames.js');
const { buildGeometryKml, readGeometryCSV } = await import('../backend/utils/kmlGenerator.js');
const pipeline = await import('../backend/services/generation/pipeline.js');
const { applyGradientEnvelopeSmoothing, DEFAULT_RULING_GRADIENT } = await import('../backend/services/geometry/processor.js');
const elevation = await import('../backend/services/elevation.js');

// ── Date-stamped names ──────────────────────────────────────────────────────

test('stamp: yyyy-MM-dd_HHmmss like the Network Editor, in the chosen time zone', () => {
  const moment = new Date('2026-10-15T22:30:12Z');
  assert.equal(makeOutputStamp(moment, 'UTC'), '2026-10-15_223012');
  assert.equal(makeOutputStamp(moment, 'Australia/Sydney'), '2026-10-16_093012');
  assert.equal(makeOutputStamp(new Date('2026-01-02T03:04:05Z'), 'UTC'), '2026-01-02_030405');
  assert.ok(isValidOutputStamp(makeOutputStamp()));
});

test('stamp: FILE_STAMP_TIME_ZONE is used, an invalid one falls back to UTC', () => {
  const moment = new Date('2026-10-15T22:30:12Z');
  process.env.FILE_STAMP_TIME_ZONE = 'Australia/Sydney';
  assert.equal(makeOutputStamp(moment), '2026-10-16_093012');
  process.env.FILE_STAMP_TIME_ZONE = 'Not/AZone';
  assert.equal(makeOutputStamp(moment), '2026-10-15_223012');
  delete process.env.FILE_STAMP_TIME_ZONE;
  assert.equal(makeOutputStamp(moment), '2026-10-15_223012');
});

test('stamped names keep the file type words the Controller looks for', () => {
  const stamp = '2026-10-16_093012';
  assert.equal(stampedName('Infrastructure.csv', stamp), 'Infrastructure_2026-10-16_093012.csv');
  assert.equal(stampedName('Regions.csv', stamp), 'Regions_2026-10-16_093012.csv');
  assert.equal(stampedName('Geometry.kmz', stamp), 'Geometry_2026-10-16_093012.kmz');
  assert.equal(stampedName('Regions.csv', null), 'Regions.csv', 'no stamp: unchanged');
  assert.equal(stampedName('Regions.csv', '../x'), 'Regions.csv', 'anything that is not a stamp is ignored');
  assert.ok(/infrastructure/i.test(stampedName('Infrastructure.csv', stamp)));
  assert.ok(/regions/i.test(stampedName('Regions.csv', stamp)));
});

test('labels made safe for file names', () => {
  assert.equal(safeFileBase('Genova - La Spezia'), 'Genova-La-Spezia');
  assert.equal(safeFileBase('Test route'), 'Test-route');
  assert.equal(safeFileBase('../../etc/passwd'), 'etcpasswd');
  assert.equal(safeFileBase('<>:"|?*'), 'Traxim-files');
  assert.equal(safeFileBase(''), 'Traxim-files');
});

// ── KML ─────────────────────────────────────────────────────────────────────

test('KML from a geometry folder: one line per route file, kilometre posts, no diagnostics', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-kml-'));
  try {
    fs.writeFileSync(path.join(dir, 'Genova_-_Pisa.csv'),
      '#region name,latitude,longitude,elevation,kilometerage,raw_elevation\n' +
      'Genova - Pisa,44.4,8.9,10,0,10\nGenova - Pisa,44.41,8.91,11.5,0.135,12\n');
    fs.writeFileSync(path.join(dir, 'Genova_-_Pisa_alt1.csv'),
      '#region name,latitude,longitude,elevation,kilometerage,raw_elevation\n' +
      'Genova - Pisa_alt1,44.5,8.95,0,0,0\nGenova - Pisa_alt1,44.51,8.96,0,0.2,0\n');
    fs.writeFileSync(path.join(dir, 'Genova_-_Pisa_wayids.csv'), 'Index,WayId\n0,123\n');
    fs.writeFileSync(path.join(dir, 'Genova_-_Pisa_topology.json'), '{}');

    const built = await buildGeometryKml(dir);
    assert.equal(built.routeCount, 2);
    const { kml } = built;
    assert.match(kml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
    assert.match(kml, /<name>Genova - Pisa<\/name>/);
    assert.match(kml, /<name>Genova - Pisa alt1<\/name>/, 'named like the website does (underscores as spaces)');
    assert.match(kml, /8\.90000000,44\.40000000,0\.000/);
    assert.match(kml, /<altitudeMode>clampToGround<\/altitudeMode>/);
    assert.match(kml, /<name>Posts<\/name>/);
    assert.match(kml, /<name>km 0\.135<\/name>/);
    assert.ok(!/123/.test(kml.replace(/<coordinates>[^<]*<\/coordinates>/g, '')), 'the wayids file is not a route');
    assert.equal(await buildGeometryKml(path.join(dir, 'missing')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readGeometryCSV reads the Traxim layout (name first) and plain lat,lon', () => {
  const named = readGeometryCSV('#h\nA <B> & C,44.4,8.9,10,0.5\n', 'x');
  assert.deepEqual(named, [{ latitude: 44.4, longitude: 8.9, altitude: 10, chainage: 0.5 }]);
  const plain = readGeometryCSV('44.4,8.9,10\n', 'x');
  assert.deepEqual(plain, [{ latitude: 44.4, longitude: 8.9, altitude: 10 }]);
});

// ── Serious problems ────────────────────────────────────────────────────────

const ok = { ok: true, reason: null };
const no429 = { ok: false, reason: 'Elevation batch 1 failed after 2 retries: Open-Elevation API returned 429 (too many requests)' };

test('serious problems: none when every route has elevation data', () => {
  assert.deepEqual(pipeline.describeSeriousProblems([
    { section: 'A - B', elevation: ok, alternativeElevation: [{ route: 'A - B_alt1', ok: true }] }
  ]), []);
  assert.deepEqual(pipeline.describeSeriousProblems([]), []);
  assert.deepEqual(pipeline.describeSeriousProblems([{ section: 'old result without elevation info' }]), []);
});

test('serious problems: no elevation data anywhere -> one clear message, with the 429 advice', () => {
  const problems = pipeline.describeSeriousProblems([
    { section: 'A - B', elevation: no429, alternativeElevation: [{ route: 'A - B_alt1', ok: false, reason: 'circuit open' }] },
    { section: 'B - C', elevation: no429 }
  ]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^Geometry: no elevation data, all altitudes are 0, so the geometry files cannot be used as they are/);
  assert.match(problems[0], /Infrastructure, Regions, Speedboards and the KMZ do not use elevation and are not affected/);
  assert.match(problems[0], /429/);
  assert.match(problems[0], /Wait 15-30 minutes and generate the files again/);
});

test('serious problems: some routes without elevation, and legs that failed', () => {
  const problems = pipeline.describeSeriousProblems([
    { section: 'A - B', elevation: ok, alternativeElevation: [{ route: 'A - B_alt1', ok: false, reason: 'timeout' }] },
    { section: 'B - C', elevation: ok },
    { section: 'C - D', error: 'No railway ways found' }
  ]);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /^Geometry: no elevation data for 1 of 3 routes \(A - B_alt1\)/);
  assert.match(problems[0], /are not affected/);
  assert.match(problems[0], /Try generating the files again later/);
  assert.match(problems[1], /^Geometry, Regions and Infrastructure: geometry could not be generated for 1 of 3 legs: C - D \(No railway ways found\)/);
  assert.equal(new Set(problems).size, problems.length, 'no problem repeated');
});

// ── Maximum gradient ────────────────────────────────────────────────────────

test('maximum gradient: default 2.5% (1 in 40, Derek 16 Oct 2026), range 1-6', () => {
  assert.equal(DEFAULT_RULING_GRADIENT, 0.025);
  assert.equal(pipeline.MAX_GRADIENT_DEFAULT_PERCENT, 2.5);
  assert.equal(pipeline.parseMaxGradientPercent(undefined), 2.5);
  assert.equal(pipeline.parseMaxGradientPercent(null), 2.5);
  assert.equal(pipeline.parseMaxGradientPercent(''), 2.5);
  assert.throws(() => pipeline.parseMaxGradientPercent(7), /default 2\.5, i\.e\. 1 in 40/);
  assert.equal(pipeline.parseMaxGradientPercent(4), 4, 'the old default can still be chosen');
  assert.equal(pipeline.parseMaxGradientPercent(3.3), 3.3);
  assert.equal(pipeline.parseMaxGradientPercent('2.5'), 2.5);
  assert.equal(pipeline.parseMaxGradientPercent(1), 1);
  assert.equal(pipeline.parseMaxGradientPercent(6), 6);
  for (const bad of [0.99, 6.01, -1, 'abc', true, {}, [], NaN]) {
    assert.throws(() => pipeline.parseMaxGradientPercent(bad), /between 1 and 6/, JSON.stringify(bad));
  }
});

test('maximum gradient: smoothing uses the given limit; the default behaviour is unchanged', () => {
  // A 10 m spike every 25 m stretch: 40% locally.
  const raw = [0, 0, 10, 0, 0];
  const chainage = [0, 25, 50, 75, 100];
  const byDefault = applyGradientEnvelopeSmoothing(raw, chainage);
  const explicitDefault = applyGradientEnvelopeSmoothing(raw, chainage, 0.025);
  assert.deepEqual(byDefault, explicitDefault, 'default = 2.5%');
  const at2 = applyGradientEnvelopeSmoothing(raw, chainage, 0.02);
  const at6 = applyGradientEnvelopeSmoothing(raw, chainage, 0.06);
  const steepest = (profile) => Math.max(...profile.slice(1).map((h, i) => Math.abs(h - profile[i]) / 25));
  assert.ok(steepest(at2.smoothed) <= 0.02 + 1e-9);
  assert.ok(steepest(at6.smoothed) <= 0.06 + 1e-9);
  assert.ok(at2.maxAdjustmentM > at6.maxAdjustmentM, 'a lower limit changes the profile more');
  // A profile that is already within the limit is left alone.
  const gentle = applyGradientEnvelopeSmoothing([0, 0.5, 1, 1.5], [0, 25, 50, 75], 0.03);
  assert.equal(gentle.adjustedCount, 0);
});

// ── Elevation service: HTTP 429 ─────────────────────────────────────────────

function response(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, statusText: '', headers, json: async () => body };
}

let sleeps;
let clock;
beforeEach(() => {
  elevation.resetElevationServiceState();
  sleeps = [];
  clock = 1_000_000;
  elevation.elevationDeps.sleep = async (ms) => { sleeps.push(ms); clock += ms; };
  elevation.elevationDeps.now = () => clock;
});

const points = Array.from({ length: 10 }, (_, i) => ({ lat: 44 + i * 0.001, lon: 9 }));

test('retry delays: long waits after 429 (or the service\'s Retry-After, capped), short otherwise', () => {
  const tooMany = Object.assign(new Error('429'), { status: 429 });
  assert.equal(elevation.retryDelayMs(tooMany, 0), 10000);
  assert.equal(elevation.retryDelayMs(tooMany, 1), 30000);
  assert.equal(elevation.retryDelayMs(Object.assign(new Error('429'), { status: 429, retryAfterMs: 5000 }), 0), 5000);
  assert.equal(elevation.retryDelayMs(Object.assign(new Error('429'), { status: 429, retryAfterMs: 3600000 }), 0), 60000);
  assert.equal(elevation.retryDelayMs(new Error('timeout'), 0), 1000);
  assert.equal(elevation.retryDelayMs(new Error('timeout'), 1), 2000);
});

test('429 then success: waits, retries and returns real elevations', async () => {
  let calls = 0;
  elevation.elevationDeps.fetch = async (url, options) => {
    calls++;
    if (calls === 1) return response(429, null, { 'retry-after': '7' });
    const { locations } = JSON.parse(options.body);
    return response(200, { results: locations.map((l, i) => ({ elevation: 100 + i })) });
  };
  const result = await elevation.fetchElevations(points);
  assert.equal(result.degraded, undefined);
  assert.equal(calls, 2);
  assert.ok(sleeps.includes(7000), `waited for Retry-After: ${sleeps}`);
  assert.equal(result[0].elevation, 100);
  assert.ok(result.every(r => r.elevation >= 100));
});

test('429 every time: gives up after 2 retries, reports why, and stops asking for a while', async () => {
  let calls = 0;
  elevation.elevationDeps.fetch = async () => { calls++; return response(429, null); };
  const first = await elevation.fetchElevations(points);
  assert.equal(first.degraded, true);
  assert.match(first.degradedReason, /429/);
  assert.ok(first.every(r => r.elevation === 0));
  assert.equal(calls, 3, 'one try and two retries');
  assert.ok(sleeps.includes(10000) && sleeps.includes(30000), `backoff waits: ${sleeps}`);

  // Circuit open: the next route does not call the service at all.
  const second = await elevation.fetchElevations(points);
  assert.equal(second.degraded, true);
  assert.match(second.degradedReason, /circuit open/);
  assert.equal(calls, 3);
});

test('requests are paced: at most one per second', async () => {
  const times = [];
  elevation.elevationDeps.fetch = async (url, options) => {
    times.push(clock);
    const { locations } = JSON.parse(options.body);
    return response(200, { results: locations.map(() => ({ elevation: 5 })) });
  };
  // 900 points -> 113 samples -> 2 batches
  const many = Array.from({ length: 900 }, (_, i) => ({ lat: 44 + i * 0.0001, lon: 9 }));
  await elevation.fetchElevations(many);
  assert.equal(times.length, 2);
  assert.ok(times[1] - times[0] >= 1000, `gap ${times[1] - times[0]} ms`);
});
