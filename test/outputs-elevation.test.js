/**
 * Follow-up changes after the first real agent test (16 Oct 2026):
 * date-stamped download names, the KML in the download, "serious problems"
 * (no elevation data) and the maximum-gradient setting. (The elevation
 * data itself is tested in elevation-dem.test.js.)
 *
 * Run with:  npm test
 * No network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { makeOutputStamp, stampedName, safeFileBase, isValidOutputStamp } = await import('../backend/utils/outputNames.js');
const { buildGeometryKml, readGeometryCSV } = await import('../backend/utils/kmlGenerator.js');
const pipeline = await import('../backend/services/generation/pipeline.js');
const { applyGradientEnvelopeSmoothing, DEFAULT_RULING_GRADIENT } = await import('../backend/services/geometry/processor.js');

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
const noTile = { ok: false, reason: 'elevation tile N44 E009 could not be downloaded (HTTP 503)' };

test('serious problems: none when every route has elevation data', () => {
  assert.deepEqual(pipeline.describeSeriousProblems([
    { section: 'A - B', elevation: ok, alternativeElevation: [{ route: 'A - B_alt1', ok: true }] }
  ]), []);
  assert.deepEqual(pipeline.describeSeriousProblems([]), []);
  assert.deepEqual(pipeline.describeSeriousProblems([{ section: 'old result without elevation info' }]), []);
});

test('serious problems: no elevation data anywhere -> one clear message, with the elevation-tile advice', () => {
  const problems = pipeline.describeSeriousProblems([
    { section: 'A - B', elevation: noTile, alternativeElevation: [{ route: 'A - B_alt1', ok: false, reason: 'elevation tile N44 E009 could not be downloaded a moment ago (HTTP 503); not retried yet' }] },
    { section: 'B - C', elevation: noTile }
  ]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^Geometry: no elevation data, all altitudes are 0, so the geometry files cannot be used as they are/);
  assert.match(problems[0], /Infrastructure, Regions, Speedboards and the KMZ do not use elevation and are not affected/);
  assert.match(problems[0], /N44 E009/);
  assert.match(problems[0], /Copernicus DEM tiles/);
  assert.match(problems[0], /tell the Traxim administrator/);
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

// ── Huge smoothing corrections: probably a tunnel OSM does not mark ─────────
// Test run 16 Oct 2026: smoothing moved one point on Levanto - La Spezia alt2
// by 286.6 m. Smoothing already limits the gradient, but the user was not
// told that the raw data there was nonsense.

test('a smoothing correction far above the normal DEM error gives a needs-review warning with route, km range and size', async () => {
  const { largeSmoothingCorrectionWarnings, ELEVATION_REVIEW_THRESHOLD_M } = await import('../backend/services/geometry/processor.js');
  const { warningKind } = await import('../backend/utils/warningKinds.js');
  assert.equal(ELEVATION_REVIEW_THRESHOLD_M, 50);
  // 10 km at 25 m spacing, flat at 20 m, with the hillside above an unmarked
  // tunnel (up to 320 m) from km 4.0 to km 5.0.
  const chainage = [], raw = [];
  for (let m = 0; m <= 10000; m += 25) {
    chainage.push(m);
    raw.push(m >= 4000 && m <= 5000 ? 20 + 300 * Math.sin(Math.PI * (m - 4000) / 1000) : 20);
  }
  const { smoothed, maxAdjustmentM } = applyGradientEnvelopeSmoothing(raw, chainage, DEFAULT_RULING_GRADIENT);
  assert.ok(maxAdjustmentM > 100);
  const w = largeSmoothingCorrectionWarnings('Levanto - La Spezia_alt2', raw, smoothed, chainage);
  assert.equal(w.length, 1, 'one warning for the one stretch');
  assert.match(w[0], /Levanto - La Spezia_alt2/);
  assert.match(w[0], /km 4\.\d to 4\.\d|km 4\.\d to 5\.0/);
  assert.match(w[0], /up to \d{3}\.\d m/);
  assert.match(w[0], /probably a tunnel not marked in OpenStreetMap/);
  assert.equal(warningKind(w[0]), 'review');
});

test('normal DEM noise (corrections under 50 m) gives no elevation check warning', async () => {
  const { largeSmoothingCorrectionWarnings } = await import('../backend/services/geometry/processor.js');
  const chainage = [], raw = [];
  for (let m = 0; m <= 5000; m += 25) {
    chainage.push(m);
    raw.push(m === 2500 ? 60 : 20); // one 40 m spike
  }
  const { smoothed } = applyGradientEnvelopeSmoothing(raw, chainage, DEFAULT_RULING_GRADIENT);
  assert.deepEqual(largeSmoothingCorrectionWarnings('A', raw, smoothed, chainage), []);
});
