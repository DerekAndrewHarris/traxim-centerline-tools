/**
 * Speedboards.csv from OpenStreetMap speed tags (October 2026).
 *
 * Synthetic geometry and ways (metres, line along y = 0 from x = 0 to 2000,
 * geometry points every 25 m). No network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { ll, geometryCsv, writeSession, removeSession } from './helpers/synthNetwork.js';
import {
  parseSpeedKmh, waySpeeds, regionSpeedboards, buildSpeedboardsCsv, generateSpeedboards, SPEED_CLASS
} from '../backend/services/speedboards/generator.js';
import { writeSpeedboards } from '../backend/services/generation/pipeline.js';
import { parseGeometryCsv } from '../backend/services/infrastructure/generator.js';

const points = parseGeometryCsv(geometryCsv('A', [[0, 0], [2000, 0]])).points;
const way = (id, fromX, toX, tags, y = 0) => ({
  id: String(id), nodes: [], tags: { railway: 'rail', ...tags },
  coords: [ll(fromX, y), ll(toX, y)]
});

/**
 * Reads a Speedboards CSV the way the resolver does (TraximCore
 * Process/InputSpeedboards.cs): header rows up to "#TrainClasses", then data
 * rows; strs[i + 3] for every KMDirectionSection column (so a short row
 * would crash it), double.TryParse on the value.
 */
function readLikeResolver(csv) {
  const lines = csv.split('\n');
  if (lines[lines.length - 1] === '') lines.pop(); // ReadLine does not return a last empty line
  const header = [], data = [];
  let inHeader = true;
  for (const line of lines) {
    const tmp = line.split(',').map(s => s.trim());
    if (inHeader) {
      if (!tmp[0].startsWith('#')) header.push(tmp);
      if (tmp[0] === '#TrainClasses') inHeader = false;
    } else if (!tmp[0].startsWith('#')) {
      data.push(tmp);
    }
  }
  const classes = header.filter(h => h[0] === 'KMDirectionSection').map(h => ({ name: h[1], direction: h[2].toLowerCase() }));
  const boards = [];
  for (const strs of data) {
    assert.ok(strs[0] !== '' && strs.length >= 1, 'no blank data row');
    const km = Number(strs[1]);
    assert.ok(Number.isFinite(km), `km parses: ${strs[1]}`);
    classes.forEach((c, i) => {
      assert.ok(strs.length > i + 3, `row has a column for ${c.name} ${c.direction}: ${strs.join(',')}`);
      const v = strs[i + 3];
      if (v !== '' && Number.isFinite(Number(v))) boards.push({ region: strs[0], km, speed: Number(v), ...c, type: strs[2] === 'FrontOfTrain' ? 'FrontOfTrain' : 'WholeOfTrain' });
    });
  }
  return { classes, boards };
}
const boardsOf = (read, direction) => read.boards.filter(b => b.direction === direction).sort((a, b) => a.km - b.km);

test('OSM speed values: km/h by default, mph and knots converted (rounded down), lists use the lowest', () => {
  assert.equal(parseSpeedKmh('100'), 100);
  assert.equal(parseSpeedKmh('60 km/h'), 60);
  assert.equal(parseSpeedKmh('75 mph'), 120);   // 120.7 rounded down
  assert.equal(parseSpeedKmh('125mph'), 201);
  assert.equal(parseSpeedKmh('100;80'), 80);
  for (const v of ['none', 'signals', '0', '', undefined, 'walk']) assert.equal(parseSpeedKmh(v), null, String(v));
});

test('forward/backward tags beat maxspeed for their direction', () => {
  assert.deepEqual(waySpeeds({ maxspeed: '100' }), { forward: 100, backward: 100 });
  assert.deepEqual(waySpeeds({ maxspeed: '100', 'maxspeed:backward': '80' }), { forward: 100, backward: 80 });
  assert.deepEqual(waySpeeds({ 'maxspeed:forward': '90' }), { forward: 90, backward: null });
});

test('a speed change: the lower speed starts at or before the change in both directions', () => {
  const ways = [way(1, 0, 1000, { maxspeed: '100' }), way(2, 1000, 2000, { maxspeed: '60' })];
  const read = readLikeResolver(buildSpeedboardsCsv([{ region: 'A', ...regionSpeedboards(points, ways) }]));
  const inc = boardsOf(read, 'increasing');
  const dec = boardsOf(read, 'decreasing');
  // Increasing: 100 from the start, 60 from (at or just before) km 1.0.
  assert.deepEqual(inc.map(b => b.speed), [100, 60]);
  assert.equal(inc[0].km, 0);
  assert.ok(inc[1].km <= 1.0 && inc[1].km >= 0.975, `60 board at ${inc[1].km}`);
  // Decreasing: 60 from the far end, back up to 100 only once past km 1.0.
  const decDesc = [...dec].sort((a, b) => b.km - a.km);
  assert.deepEqual(decDesc.map(b => b.speed), [60, 100]);
  assert.equal(decDesc[0].km, 2);
  assert.ok(decDesc[1].km <= 1.0 && decDesc[1].km >= 0.975, `100 board at ${decDesc[1].km}`);
  assert.ok(read.boards.every(b => b.name === SPEED_CLASS && b.type === 'WholeOfTrain'));
});

test('direction: a way drawn against the km uses its backward speed for increasing km', () => {
  const ways = [way(1, 2000, 0, { 'maxspeed:forward': '80', 'maxspeed:backward': '120' })];
  const read = readLikeResolver(buildSpeedboardsCsv([{ region: 'A', ...regionSpeedboards(points, ways) }]));
  assert.deepEqual(boardsOf(read, 'increasing').map(b => b.speed), [120]);
  assert.deepEqual(boardsOf(read, 'decreasing').map(b => b.speed), [80]);
});

test('sidings and yards are not used; tracks further than 15 m are not used', () => {
  const ways = [
    way(1, 0, 2000, { maxspeed: '30', service: 'siding' }, 4),
    way(2, 0, 2000, { maxspeed: '200' }, 40)
  ];
  const result = regionSpeedboards(points, ways);
  assert.equal(result.rows.length, 0);
  assert.equal(result.pointsWithData, 0);
});

test('track with no speed data: no board there; the first speed found applies from the start', () => {
  const ways = [way(1, 500, 1500, { maxspeed: '90' })];
  const read = readLikeResolver(buildSpeedboardsCsv([{ region: 'A', ...regionSpeedboards(points, ways) }]));
  assert.deepEqual(boardsOf(read, 'increasing').map(b => [b.km, b.speed]), [[0, 90]]);
  assert.deepEqual(boardsOf(read, 'decreasing').map(b => [b.km, b.speed]), [[2, 90]]);
});

test('file layout: header rows, #TrainClasses, five columns per row, km as in the geometry file, no blank lines', () => {
  const csv = buildSpeedboardsCsv([{ region: 'La Spezia - Sestri Levante', rows: [{ km: '0.00000', inc: 100, dec: null }, { km: '1.25000', inc: null, dec: 80 }] }]);
  const lines = csv.split('\n');
  assert.equal(lines.pop(), '', 'ends with one newline');
  assert.ok(lines.every(l => l.length > 0), 'no blank lines');
  assert.ok(lines.includes(`KMDirectionSection,${SPEED_CLASS},increasing`));
  assert.ok(lines.includes(`KMDirectionSection,${SPEED_CLASS},decreasing`));
  assert.ok(lines.includes('#TrainClasses'));
  assert.ok(lines.indexOf('#TrainClasses') < lines.indexOf('La Spezia - Sestri Levante,0.00000,,100,'));
  assert.ok(lines.includes('La Spezia - Sestri Levante,1.25000,,,80'));
  for (const l of lines.filter(l => !l.startsWith('#') && !l.startsWith('KMDirectionSection'))) assert.equal(l.split(',').length, 5);
  for (const l of lines.filter(l => l.startsWith('#'))) assert.ok(!l.includes('"'), 'no quotes in comment rows');
});

test('no speed data anywhere: a valid header-only file, flagged with the Auto-Curve Speed Limiting advice', () => {
  const result = generateSpeedboards([{ region: 'A', points }], []);
  assert.equal(result.noSpeedData, true);
  assert.equal(result.boardCount, 0);
  const read = readLikeResolver(result.csv);
  assert.equal(read.classes.length, 2);
  assert.equal(read.boards.length, 0);
  assert.match(result.warnings[0], /NO SPEED DATA/);
  assert.match(result.warnings[0], /Auto-Curve Speed Limiting/);
});

test('some routes with data, some without: both said', () => {
  const result = generateSpeedboards(
    [{ region: 'A', points }, { region: 'B', points }],
    [way(1, 0, 2000, { maxspeed: '100' })]
  );
  // Both regions share the same coordinates here, so give B no ways by using a far-away copy.
  const resultB = generateSpeedboards(
    [{ region: 'A', points }, { region: 'B', points: points.map(p => ({ ...p, lat: p.lat + 1 })) }],
    [way(1, 0, 2000, { maxspeed: '100' })]
  );
  assert.equal(result.regionsWithData, 2);
  assert.equal(resultB.regionsWithData, 1);
  assert.ok(resultB.warnings.some(w => /1 route\(s\) have no speed data.*B/.test(w)));
});

test('writeSpeedboards: Speedboards.csv in the session folder from the geometry files on disk', async () => {
  const s = await writeSession({
    geometry: { 'A.csv': geometryCsv('A', [[0, 0], [2000, 0]]), 'A_wayids.csv': 'Index,WayId\n' },
    net: { topology: () => ({ ways: [], taggedNodes: [] }) }
  });
  try {
    const summary = await writeSpeedboards(s.sessionPath, s.geometryDir, ['A'], [way(1, 0, 2000, { maxspeed: '120' })]);
    assert.equal(summary.file, 'Speedboards.csv');
    assert.equal(summary.noSpeedData, false);
    const csv = await fs.readFile(path.join(s.sessionPath, 'Speedboards.csv'), 'utf-8');
    const read = readLikeResolver(csv);
    assert.deepEqual(read.boards.map(b => [b.region, b.km, b.speed, b.direction]).sort(),
      [['A', 0, 120, 'increasing'], ['A', 2, 120, 'decreasing']]);
  } finally {
    await removeSession(s.sessionPath);
  }
});
