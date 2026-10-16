/**
 * Platform numbers and platform faces (October 2026, after Derek's test at
 * La Spezia Centrale).
 *
 * Faults found there, each reproduced here on a small made-up layout:
 *  1. Platform numbers were made up from the order along the line (1, 2, 3
 *     in km order), ignoring OpenStreetMap's own numbers (ref "4 - 5"), so
 *     at a station whose platforms sit side by side the numbers came out in
 *     an arbitrary order.
 *  2. Which side of a platform a track is on was judged from the average of
 *     the outline's corner points. For a long, bent platform that point can
 *     lie outside the platform, beyond its own track; both the platform's
 *     track and a dock track then looked to be on the same side, the dock
 *     track was nearer, and platform 1's own track got no node at all.
 *  3. A dock (bay) track with no number of its own was given a guessed one.
 *  4. A track that only touches the end of a platform got a platform node.
 *  5. A second platform with the same number became "...32" (the duplicate
 *     suffix was glued onto the number).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Net, ll, geometryCsv, platform, rect, writeSession, parseInfrastructureCsv, removeSession
} from './helpers/synthNetwork.js';
import { generateInfrastructureForSections } from '../backend/services/infrastructure/generator.js';
import { parsePlatformNumbers, platformNumbersOf } from '../backend/services/infrastructure/platforms.js';

async function generate(net, platforms, { geometry = [[0, 0], [2000, 0]], station = [1000, -60] } = {}) {
  const s = await writeSession({
    geometry: { 'A_-_B.csv': geometryCsv('A - B', geometry) },
    net,
    platforms,
    stations: [{ id: '1', ...ll(station[0], station[1]), name: 'Testa' }]
  });
  try {
    const result = await generateInfrastructureForSections([], 'Test', s.geometryDir, s.bbox, null, s.sessionPath);
    return { rows: parseInfrastructureCsv(result.csv), warnings: result.warnings };
  } finally {
    await removeSession(s.sessionPath);
  }
}

const platformRows = (rows) => rows.filter(r => r['Signalled F'] === 'False' && r['Signalled T'] === 'False');
const metresNorth = (row) => (Number(row.Latitude) - ll(0, 0).lat) * 111320;
const nameAt = (rows, y) => {
  const r = platformRows(rows).find(p => Math.abs(metresNorth(p) - y) < 1.5);
  return r ? r.Name : null;
};

/**
 * Three parallel tracks through a station:
 *   north loop  y = +5   (Ja ... Jd)
 *   main        y =  0
 *   south loop  y = -5   (Jb ... Jc)
 */
function threeTrackNet() {
  return new Net()
    .point('W', -300, 0).point('Ja', 500, 0).point('Jb', 560, 0).point('M', 1000, 0)
    .point('Jc', 1440, 0).point('Jd', 1500, 0).point('E', 2300, 0)
    .point('N1', 560, 5).point('N2', 1440, 5)
    .point('S1', 620, -5).point('S2', 1380, -5)
    .way(1, ['W', 'Ja']).way(2, ['Ja', 'Jb']).way(3, ['Jb', 'M', 'Jc']).way(4, ['Jc', 'Jd']).way(5, ['Jd', 'E'])
    .way(6, ['Ja', 'N1', 'N2', 'Jd'])
    .way(7, ['Jb', 'S1', 'S2', 'Jc']);
}

test('ref "2 - 3" on an island: each track gets the number for its side, continuing from platform 1', async () => {
  // Platform 1 beside the south loop; island "2 - 3" between main and north
  // loop. The island has the lower OSM id and lies further west, so the old
  // km-order numbering called its tracks 1 and 2 and platform 1 "3".
  const { rows } = await generate(threeTrackNet(), [
    platform(10, 'Platform', rect(800, 1200, 1, 4), '2 - 3'),
    platform(11, 'Platform', rect(900, 1300, -8.5, -6), '1')
  ]);
  assert.equal(platformRows(rows).length, 3);
  assert.equal(nameAt(rows, -5), 'Testa 1');
  assert.equal(nameAt(rows, 0), 'Testa 2');
  assert.equal(nameAt(rows, 5), 'Testa 3');
});

test('the same layout mirrored: numbers run the other way across the station', async () => {
  const { rows } = await generate(threeTrackNet(), [
    platform(10, 'Platform', rect(800, 1200, -4, -1), '2-3'),
    platform(11, 'Platform', rect(900, 1300, 6, 8.5), '1')
  ]);
  assert.equal(nameAt(rows, 5), 'Testa 1');
  assert.equal(nameAt(rows, 0), 'Testa 2');
  assert.equal(nameAt(rows, -5), 'Testa 3');
});

test('a lone island "1;2": lower number on the track nearer the station point, with a warning', async () => {
  for (const [stationY, south, north] of [[-60, 'Testa 1', 'Testa 2'], [60, 'Testa 2', 'Testa 1']]) {
    const { rows, warnings } = await generate(threeTrackNet(), [platform(10, 'Platform', rect(800, 1200, -4, -1), '1;2')],
      { station: [1000, stationY] });
    assert.equal(nameAt(rows, -5), south, `station point at y=${stationY}`);
    assert.equal(nameAt(rows, 0), north, `station point at y=${stationY}`);
    assert.ok(warnings.some(w => /PLATFORM NUMBER ORDER ASSUMED/.test(w)));
  }
});

/**
 * La Spezia Centrale platform 1 (simplified from the real shapes): a long
 * platform beside track 1 that widens at its east end into a wedge between
 * track 1 and a dock track ending in a buffer stop part-way along it.
 * Coordinates in metres; track 1 bends north at the east end.
 */
function laSpeziaPlatform1() {
  const main = [[-600, -12], [-265, -12], [-60, -11.8], [110, -15.6], [137, -14.5], [165, -11.8], [192, -7.5],
    [221, -1.3], [245, 6], [275, 16], [297, 25]];
  const dock = [[93, -21.7], [119, -21.6], [142, -19.9], [164, -18.3], [196.5, -13.5], [222, -7.8], [247, -0.1], [275, 9], [310, 25]];
  const net = new Net();
  main.forEach(([x, y], i) => net.point(`m${i}`, x, y));
  dock.forEach(([x, y], i) => net.point(`d${i}`, x, y));
  net.point('J', 340, 42).point('E', 700, 190);
  net.way(1, [...main.map((_, i) => `m${i}`), 'J'])
    .way(2, ['J', 'E'])
    .way(3, [...dock.map((_, i) => `d${i}`), 'J'], { railway: 'rail', service: 'yard' });
  const outline = [[110, -16.8], [-156, -13.2], [-184, -13.3], [-213, -13.7], [-213, -16.6], [-184, -16.3], [-156, -16.1],
    [119, -20.6], [142, -19.4], [165, -16.7], [196, -12.1], [222, -6.5], [247, 1.4], [246, 4.7], [221, -2.4], [193, -8.6],
    [165, -12.8], [138, -15.6], [110, -16.8]];
  return { net, outline, main };
}

test('La Spezia platform 1: the node goes on track 1, and the dock track gets a provisional name, not a number', async () => {
  const { net, outline, main } = laSpeziaPlatform1();
  const { rows, warnings } = await generate(net, [platform(20, 'Platform', outline, '1')],
    { geometry: [...main, [340, 42], [700, 190]], station: [0, -60] });
  const plats = platformRows(rows);
  const onMain = plats.find(p => p.Name === 'Testa 1');
  assert.ok(onMain, 'a node called "Testa 1"');
  // "Testa 1" is on track 1: its neighbours are the track-1 end nodes, not the buffer stop.
  const bufferStop = rows.find(r => [r['F Node'], r['T Node'], r['D Node'], r['X Node']].filter(Boolean).length === 1 &&
    Math.abs(metresNorth(r) - (-21.7)) < 3);
  assert.ok(bufferStop, 'the dock track has its buffer-stop node');
  assert.notEqual(onMain['F Node'], bufferStop.Name);
  assert.notEqual(onMain['T Node'], bufferStop.Name);
  const dock = plats.find(p => p.Name !== 'Testa 1');
  assert.ok(dock, 'the dock face has a node too');
  assert.equal(dock.Name, 'Testa Unnumbered A');
  assert.ok([dock['F Node'], dock['T Node']].includes(bufferStop.Name), 'the provisional node is on the dock track');
  const w = warnings.find(x => /PLATFORMS NOT NUMBERED at Testa/.test(x));
  assert.ok(w && /bay \(dock\) platform/.test(w), 'warning says it is probably a bay platform');
});

test('a platform with no number in OSM gets a provisional name and a warning, not a guessed number', async () => {
  const { rows, warnings } = await generate(threeTrackNet(), [platform(10, 'Platform', rect(900, 1100, -8.5, -6), null)]);
  assert.deepEqual(platformRows(rows).map(r => r.Name), ['Testa Unnumbered A']);
  assert.ok(warnings.some(w => /PLATFORMS NOT NUMBERED at Testa/.test(w) && /no ref/.test(w)));
});

test('a merge keeps the OSM number: an unnumbered outline of the same platform does not win', async () => {
  // Two outlines of one platform on the south loop: the numbered one off-centre.
  const { rows, warnings } = await generate(threeTrackNet(), [
    platform(10, 'Platform', rect(700, 1100, -8.5, -6), '4'),
    platform(11, 'Platform', rect(850, 1150, -8.5, -6), null)
  ]);
  assert.deepEqual(platformRows(rows).map(r => r.Name), ['Testa 4']);
  assert.ok(warnings.some(w => /PLATFORMS MERGED/.test(w) && /ref "4"/.test(w)));
});

test('the same number on two tracks: "Testa 3" and "Testa 3 B" (never "Testa 32"), with a warning', async () => {
  const { rows, warnings } = await generate(threeTrackNet(), [
    platform(10, 'Platform', rect(800, 1200, -8.5, -6), '3'),
    platform(11, 'Platform', rect(800, 1200, 6, 8.5), '3')
  ]);
  assert.deepEqual(platformRows(rows).map(r => r.Name).sort(), ['Testa 3', 'Testa 3 B']);
  assert.ok(warnings.some(w => /PLATFORM NUMBER USED TWICE at Testa: platform 3/.test(w)));
});

test('a track that only touches the end of a platform does not get a platform node', async () => {
  // Side platform north of the north loop; a siding from the east ends
  // head-on against the platform's east end.
  const net = threeTrackNet();
  net.ways = net.ways.filter(w => w.id !== '5');
  net.point('Jx', 1800, 0).point('T1', 1600, 7.25).point('T2', 1101, 7.25)
    .way(5, ['Jd', 'Jx']).way(8, ['Jx', 'E']).way(9, ['Jx', 'T1', 'T2'], { railway: 'rail', service: 'siding' });
  const { rows } = await generate(net, [platform(10, 'Platform', rect(900, 1100, 6, 8.5), '1')]);
  const plats = platformRows(rows);
  assert.equal(plats.length, 1);
  assert.ok(Math.abs(metresNorth(plats[0]) - 5) < 1, 'on the north loop');
  assert.equal(plats[0].Name, 'Testa 1');
});

test('platform refs are split into their numbers', () => {
  assert.deepEqual(parsePlatformNumbers('4 - 5'), ['4', '5']);
  assert.deepEqual(parsePlatformNumbers('4-5'), ['4', '5']);
  assert.deepEqual(parsePlatformNumbers('4;5'), ['4', '5']);
  assert.deepEqual(parsePlatformNumbers('4/5'), ['4', '5']);
  assert.deepEqual(parsePlatformNumbers('2 e 3'), ['2', '3']);
  assert.deepEqual(parsePlatformNumbers('1'), ['1']);
  assert.deepEqual(parsePlatformNumbers('1A'), ['1A']);
  assert.deepEqual(parsePlatformNumbers('Binario 3'), ['3']);
  assert.deepEqual(parsePlatformNumbers(''), []);
  assert.deepEqual(parsePlatformNumbers(null), []);
  // Name only when it is just a number; local_ref when there is no ref.
  assert.deepEqual(platformNumbersOf({ name: 'Platform', ref: null }), []);
  assert.deepEqual(platformNumbersOf({ name: '2° banchina', ref: null }), []);
  assert.deepEqual(platformNumbersOf({ name: 'binario 2 e 3', ref: null }), ['2', '3']);
  assert.deepEqual(platformNumbersOf({ name: 'Platform', ref: null, local_ref: '7' }), ['7']);
});
