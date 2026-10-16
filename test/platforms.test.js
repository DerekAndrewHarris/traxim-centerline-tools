/**
 * Platform nodes (October 2026): an island platform gets one platform node on
 * the track along EACH side; a side platform gets one; the same platform
 * mapped twice in OpenStreetMap gets one.
 *
 * Runs the real infrastructure generator on small made-up layouts (no
 * network: the OSM data comes from cache files, see helpers/synthNetwork.js).
 *
 * Layout used by most tests (metres; main line along y = 0):
 *
 *        L1 ---------- loop (y = +4.5) ---------- L2
 *       /                                            \
 *   W --J1 ------------- main (y = 0) -------------- J2 -- E
 *      x=600                                       x=1400
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Net, ll, geometryCsv, platform, rect, writeSession, parseInfrastructureCsv, removeSession
} from './helpers/synthNetwork.js';
import { generateInfrastructureForSections } from '../backend/services/infrastructure/generator.js';

function loopNet({ sidingUnderPlatform = false } = {}) {
  const net = new Net()
    .point('W', -300, 0).point('J1', 600, 0).point('J2', 1400, 0).point('E', 2300, 0)
    .point('L1', 650, 4.5).point('L2', 1350, 4.5);
  if (sidingUnderPlatform) {
    // A turnout on the main line part-way along the platform, with a siding
    // going off to the south: the main line under the platform is then two
    // OSM ways (J1-J3 and J3-J2), i.e. two different links.
    net.point('J3', 1050, 0).point('S1', 1100, -4).point('S2', 1300, -4);
    net.way(2, ['J1', 'J3']).way(5, ['J3', 'J2']).way(6, ['J3', 'S1', 'S2'], { railway: 'rail', service: 'siding' });
  } else {
    net.point('M1', 1000, 0);
    net.way(2, ['J1', 'M1', 'J2']);
  }
  net.way(1, ['W', 'J1']).way(3, ['J1', 'L1', 'L2', 'J2']).way(4, ['J2', 'E']);
  return net;
}

async function generate(net, platforms) {
  const s = await writeSession({
    geometry: { 'A_-_B.csv': geometryCsv('A - B', [[0, 0], [2000, 0]]) },
    net,
    platforms,
    stations: [{ id: '1', ...ll(1000, 20), name: 'Testa' }]
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
const onLoop = (row) => metresNorth(row) > 3;   // loop track is 4.5 m north
const onMain = (row) => Math.abs(metresNorth(row)) < 1;

for (const ref of ['1;2', null]) {
  test(`island platform at a passing loop gets one node on each track (ref ${ref ?? 'missing'})`, async () => {
    const { rows } = await generate(loopNet(), [platform(10, 'Island', rect(900, 1100, 0.9, 3.6), ref)]);
    const plats = platformRows(rows);
    assert.equal(plats.length, 2, 'two platform nodes');
    assert.equal(plats.filter(onMain).length, 1, 'one on the main line');
    assert.equal(plats.filter(onLoop).length, 1, 'one on the loop');
    // Each is linked into its own track: between the two turnouts, on different arms.
    const j = rows.filter(r => r['D Node']);
    assert.ok(j.length >= 2);
    for (const junction of j) {
      const viaArms = [junction['T Node'], junction['D Node']];
      assert.deepEqual(new Set(viaArms), new Set(plats.map(p => p.Name)), `${junction.Name} leads to both platform nodes`);
    }
  });
}

test('side platform gets exactly one node, on the track beside it', async () => {
  // South of the main line; the loop is on the far side, 5.5 m+ away.
  const { rows } = await generate(loopNet(), [platform(11, 'Side', rect(900, 1100, -3.6, -0.9), '1')]);
  const plats = platformRows(rows);
  assert.equal(plats.length, 1);
  assert.ok(onMain(plats[0]));
});

test('track split by a turnout under an island platform: still one node per track, not two on the same track', async () => {
  // The platform is nearer the main line (0.5 m) than the loop (1.5 m), so
  // both main-line ways are nearer than the loop. Before October 2026 the two
  // main-line ways counted as two "faces": both platform nodes went on the
  // main line, next to each other, and the loop got none.
  const { rows } = await generate(loopNet({ sidingUnderPlatform: true }),
    [platform(12, 'Island', rect(700, 1150, 0.5, 3.0), '1;2')]);
  const plats = platformRows(rows);
  assert.equal(plats.length, 2);
  assert.equal(plats.filter(onMain).length, 1, 'one on the main line');
  assert.equal(plats.filter(onLoop).length, 1, 'one on the loop');
});

test('the same platform mapped twice in OSM (two touching halves) gets one node on its track', async () => {
  const { rows, warnings } = await generate(loopNet(), [
    platform(13, 'Side', rect(900, 1000, -3.6, -0.9), '1'),
    platform(14, 'Side', rect(1000, 1100, -3.6, -0.9), '1')
  ]);
  assert.equal(platformRows(rows).length, 1);
  assert.ok(warnings.some(w => /already covered by platform node/.test(w)));
});

test('two separate platforms far apart on the same track both get a node', async () => {
  const { rows } = await generate(loopNet(), [
    platform(15, 'Side', rect(700, 800, -3.6, -0.9), '1'),
    platform(16, 'Side', rect(1200, 1300, -3.6, -0.9), '1')
  ]);
  assert.equal(platformRows(rows).length, 2);
});
