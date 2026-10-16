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
import { generateInfrastructureForSections, mergeClosePlatformNodes, PLATFORM_MIN_SPACING_M } from '../backend/services/infrastructure/generator.js';

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
  assert.ok(warnings.some(w => /PLATFORMS MERGED/.test(w)));
});

test('two separate platforms far apart on the same track both get a node', async () => {
  const { rows } = await generate(loopNet(), [
    platform(15, 'Side', rect(700, 800, -3.6, -0.9), '1'),
    platform(16, 'Side', rect(1200, 1300, -3.6, -0.9), '1')
  ]);
  assert.equal(platformRows(rows).length, 2);
});

// ── Platform sanity check: nodes closer than 250 m on one track are merged ──

test('the minimum platform spacing is a named constant of 250 m', () => {
  assert.equal(PLATFORM_MIN_SPACING_M, 250);
});

test('La Spezia case: three OSM ways all called "4 - 5" give one node on each track', async () => {
  // The real island plus two unclear outlines with the same name and ref,
  // roughly on top of it (different lengths, slightly shifted).
  const { rows, warnings } = await generate(loopNet(), [
    platform(20, 'Railway Platform 4 - 5', rect(900, 1100, 0.9, 3.6), '4;5'),
    platform(21, 'Railway Platform 4 - 5', rect(950, 1060, 1.0, 3.5), '4;5'),
    platform(22, 'Railway Platform 4 - 5', rect(880, 1130, 0.8, 3.7), '4;5')
  ]);
  const plats = platformRows(rows);
  assert.equal(plats.length, 2, 'two platform nodes in all');
  assert.equal(plats.filter(onMain).length, 1, 'one on the main line');
  assert.equal(plats.filter(onLoop).length, 1, 'one on the loop');
  assert.equal(warnings.filter(w => /PLATFORMS MERGED/.test(w)).length, 2, 'one merge reported per track');
  // Still linked properly: every link is reciprocal.
  const byName = new Map(rows.map(r => [r.Name, r]));
  for (const r of rows) {
    for (const arm of ['F Node', 'T Node', 'D Node', 'X Node']) {
      if (!r[arm]) continue;
      const other = byName.get(r[arm]);
      assert.ok(other, `${r.Name} links to existing node ${r[arm]}`);
      assert.ok(['F Node', 'T Node', 'D Node', 'X Node'].some(a => other[a] === r.Name), `${r[arm]} links back to ${r.Name}`);
    }
  }
});

test('Viareggio case: one way for the island and one line for each face give one node on each track', async () => {
  const { rows, warnings } = await generate(loopNet(), [
    platform(30, 'Viareggio 2 - 3', rect(900, 1100, 0.9, 3.6), '2;3'),
    platform(31, 'Viareggio 2', [[900, 0.9], [1100, 0.9]], '2'),   // face along the main line
    platform(32, 'Viareggio 3', [[900, 3.6], [1100, 3.6]], '3')    // face along the loop
  ]);
  const plats = platformRows(rows);
  assert.equal(plats.length, 2);
  assert.equal(plats.filter(onMain).length, 1);
  assert.equal(plats.filter(onLoop).length, 1);
  assert.equal(warnings.filter(w => /PLATFORMS MERGED/.test(w)).length, 2);
});

test('one platform with two numbers (1A / 1B) on one track becomes one node', async () => {
  const { rows, warnings } = await generate(loopNet(), [
    platform(40, 'Testa 1A', rect(860, 990, -3.6, -0.9), '1A'),
    platform(41, 'Testa 1B', rect(1000, 1130, -3.6, -0.9), '1B')
  ]);
  const plats = platformRows(rows);
  assert.equal(plats.length, 1);
  const w = warnings.find(x => /PLATFORMS MERGED/.test(x));
  assert.ok(w && /Testa 1A/.test(w) && /Testa 1B/.test(w), 'the merge names both OSM platforms');
});

test('platform nodes 300 m apart on one track are both kept', async () => {
  const { rows, warnings } = await generate(loopNet(), [
    platform(50, 'North end', rect(700, 800, -3.6, -0.9), '1'),
    platform(51, 'South end', rect(1000, 1100, -3.6, -0.9), '1')
  ]);
  assert.equal(platformRows(rows).length, 2);
  assert.ok(!warnings.some(x => /PLATFORMS MERGED/.test(x)));
});

test('the kept node is the one nearest the centre of the merged platforms', () => {
  // A straight track: E1 - P1 - P2 - P3 - E2 along x (metres), P2 nearest the middle.
  const at = (x) => ll(x, 0);
  const n = (name, x, extra = {}) => ({ name, ...at(x), ...extra });
  const plat = (name, x, from, to, id) => n(name, x, {
    railwayType: 'platform', _platformGeometry: [at(from), at(to)], _platformOsmId: String(id)
  });
  const nodes = [
    n('E1', 0, { tNode: 'P1', tOnBranch: 'F' }),
    plat('P1 B', 100, 50, 150, 1),
    plat('P1 A', 180, 120, 240, 2),
    plat('P1', 260, 200, 300, 3),
    n('E2', 1000, { fNode: 'P1', fOnBranch: 'T' })
  ];
  // Chain links: E1 -> "P1 B" -> "P1 A" -> "P1" -> E2
  nodes[0].tNode = 'P1 B';
  Object.assign(nodes[1], { fNode: 'E1', fOnBranch: 'T', tNode: 'P1 A', tOnBranch: 'F' });
  Object.assign(nodes[2], { fNode: 'P1 B', fOnBranch: 'T', tNode: 'P1', tOnBranch: 'F' });
  Object.assign(nodes[3], { fNode: 'P1 A', fOnBranch: 'T', tNode: 'E2', tOnBranch: 'F' });
  const warnings = [];
  const removed = mergeClosePlatformNodes(nodes, warnings);
  assert.equal(removed, 2);
  // The middle one (at 180 m; the platforms span 50-300 m, centre 175 m) is kept.
  assert.deepEqual(nodes.map(x => x.name), ['E1', 'P1 A', 'E2']);
  const kept = nodes[1];
  assert.equal(nodes[0].tNode, 'P1 A');
  assert.equal(nodes[0].tOnBranch, 'F');
  assert.equal(kept.fNode, 'E1');
  assert.equal(kept.tNode, 'E2');
  assert.equal(nodes[2].fNode, 'P1 A');
  assert.equal(nodes[2].fOnBranch, 'T');
  assert.equal(warnings.length, 1);
});

test('platforms either side of a turnout are not merged', () => {
  const at = (x) => ll(x, 0);
  const nodes = [
    { name: 'P1', ...at(100), railwayType: 'platform', fNode: 'E1', fOnBranch: 'T', tNode: 'J', tOnBranch: 'F' },
    { name: 'J', ...at(150), railwayType: 'junction', fNode: 'P1', fOnBranch: 'T', tNode: 'P2', tOnBranch: 'F', dNode: 'S', dOnBranch: 'F' },
    { name: 'P2', ...at(200), railwayType: 'platform', fNode: 'J', fOnBranch: 'T', tNode: 'E2', tOnBranch: 'F' },
    { name: 'E1', ...at(0), tNode: 'P1', tOnBranch: 'F' },
    { name: 'E2', ...at(400), fNode: 'P2', fOnBranch: 'T' },
    { name: 'S', ...ll(300, -10), fNode: 'J', fOnBranch: 'D' }
  ];
  assert.equal(mergeClosePlatformNodes(nodes, []), 0);
  assert.equal(nodes.length, 6);
});

// ── La Spezia test run, 16 October 2026 ──

test('platform node goes beside the middle of a long platform, not at its end, when OSM splits the track there', async () => {
  // La Spezia Centrale "2 - 3" (OSM way 617064909): the track beside the
  // platform is two OSM ways; the one that only runs along the platform's
  // east END was a few centimetres nearer the platform edge, so the node went
  // on it, at the platform's tip (150 m from its middle here), and the
  // platform merge measured the wrong distance.
  const net = new Net()
    .point('W', -300, 0).point('J1', 600, 0).point('A', 1050, 0).point('J2', 1400, 0).point('E', 2300, 0)
    .point('L1', 650, 4.5).point('L2', 1350, 4.5)
    .way(1, ['W', 'J1']).way(2, ['J1', 'A']).way(5, ['A', 'J2']).way(3, ['J1', 'L1', 'L2', 'J2']).way(4, ['J2', 'E']);
  // Outline 700-1100 m, its track edge 1.4 m from the track at the west end
  // and 0.8 m at the east end, so way 5 (1050-1400 m) is "nearest".
  const outline = [[700, -1.4], [1100, -0.8], [1100, -3.6], [700, -3.6], [700, -1.4]];
  const { rows } = await generate(net, [platform(70, 'Long', outline, '1')]);
  const plats = platformRows(rows);
  assert.equal(plats.length, 1);
  const x = (Number(plats[0].Longitude) - ll(0, 0).lon) * 111320 * Math.cos(ll(0, 0).lat * Math.PI / 180);
  assert.ok(Math.abs(x - 900) < 60, `node at ${x.toFixed(0)} m, expected beside the platform middle (900 m)`);
});
