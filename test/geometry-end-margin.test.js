/**
 * Geometry end margin (Derek, 18 Oct 2026): an ordinary node (turnout,
 * diamond, slip, platform ...) may not sit within 25 m of the start or end of
 * the geometry it is on, on any of its kilometrages. End nodes are exempt.
 *
 * Why: a double slip exactly at km 0 was written by the Network Editor as two
 * turnouts 1 m either side, one of them at km -0.001, beyond the start of the
 * geometry - and the resolver stops with an error for a link that reaches
 * past a geometry end.
 *
 * Layout (metres): geometry A along y = 0 from x = 0 to x = 2000.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Net, ll, geometryCsv, writeSession, parseInfrastructureCsv, removeSession } from './helpers/synthNetwork.js';
import {
  generateInfrastructureForSections, allowedKmRange, clampAllKmToGeometry, keepNodesAwayFromGeometryEnds,
  GEOMETRY_END_MARGIN_M
} from '../backend/services/infrastructure/generator.js';
import { warningKind } from '../backend/utils/warningKinds.js';

const xOf = (row) => (Number(row.Longitude) - ll(0, 0).lon) / ((ll(1000, 0).lon - ll(0, 0).lon) / 1000);
const isEnd = (r) => [r['F Node'], r['T Node'], r['D Node'], r['X Node']].filter(Boolean).length === 1;

async function generate(net, geometry = { 'A.csv': geometryCsv('A', [[0, 0], [2000, 0]]) }) {
  const s = await writeSession({ geometry, net });
  try {
    const r = await generateInfrastructureForSections([], 'Test', s.geometryDir, s.bbox, null, s.sessionPath);
    return { rows: parseInfrastructureCsv(r.csv), warnings: r.warnings };
  } finally {
    await removeSession(s.sessionPath);
  }
}

function assertMargin(rows, minKm = 0, maxKm = 2) {
  for (const r of rows) {
    if (isEnd(r)) continue;
    const km = Number(r.Km1);
    assert.ok(km >= minKm + 0.025 - 1e-9 && km <= maxKm - 0.025 + 1e-9, `${r.Name} km ${r.Km1} is within 25 m of an end`);
  }
}

test('the margin is a named constant of 25 m', () => {
  assert.equal(GEOMETRY_END_MARGIN_M, 25);
});

test('allowedKmRange: 25 m in for ordinary nodes, rounded inwards to whole metres; the whole range for end nodes', () => {
  assert.deepEqual(allowedKmRange(0, 2, false), { lo: 0.025, hi: 1.975, margin: true });
  assert.deepEqual(allowedKmRange(0, 2, true), { lo: 0, hi: 2, margin: false });
  // Ends not on a whole metre: still at least 25 m in after writing 3 decimals.
  const r = allowedKmRange(12.3456, 13.0004, false);
  assert.equal(r.lo, 12.371);
  assert.equal(r.hi, 12.975);
  // Too short to leave any room: whole range (reported elsewhere).
  assert.equal(allowedKmRange(0, 0.04, false).margin, false);
});

test('a double-slip diamond exactly at the start of the geometry (km 0) is moved 25 m in', async () => {
  // Main line from x = -600 (OSM carries on before the geometry) to 2600;
  // a second track crosses it at x = 0 - exactly the geometry's start.
  const net = new Net()
    .point('W', -600, 0).point('X', 0, 0).point('J', 1000, 0).point('E', 2600, 0)
    .point('S', -100, -100).point('N', 100, 100).point('T1', 1100, -5).point('T2', 1400, -5);
  net.way(1, ['W', 'X']).way(2, ['X', 'J']).way(3, ['J', 'E']).way(4, ['S', 'X']).way(5, ['X', 'N']).way(6, ['J', 'T1', 'T2']);
  net.tag('X', { railway: 'switch', 'railway:switch': 'double_slip' });
  const { rows, warnings } = await generate(net);
  const diamond = rows.find(r => r['X Node']);
  assert.equal(diamond.Slip, 'DoubleSlip');
  assert.ok(Number(diamond.Km1) >= 0.025 && Number(diamond.Km1) <= 0.027, `km ${diamond.Km1}`); // 26 m: also 26.2 m from the end node at km 0
  assert.ok(Math.abs(xOf(diamond) - Number(diamond.Km1) * 1000) < 1, `diamond at x=${xOf(diamond).toFixed(1)}`);
  assertMargin(rows);
  const w = warnings.find(x => /^GEOMETRY END MARGIN/.test(x));
  assert.ok(w && w.includes(diamond.Name), w);
  assert.equal(warningKind(w), 'review');
});

test('two turnouts near the start stay in order and apart when moved in', async () => {
  // J0 at x = 5 and J1 at x = 20 on the main line, sidings to the south.
  const net = new Net()
    .point('W', -600, 0).point('J0', 5, 0).point('J1', 20, 0).point('E', 2600, 0)
    .point('S1', 60, -5).point('S2', 500, -5).point('T1', 70, -10).point('T2', 600, -10);
  net.way(1, ['W', 'J0']).way(2, ['J0', 'J1']).way(3, ['J1', 'E']).way(4, ['J0', 'S1', 'S2']).way(5, ['J1', 'T1', 'T2']);
  const { rows } = await generate(net);
  assertMargin(rows);
  const turnouts = rows.filter(r => r['D Node']);
  assert.equal(turnouts.length, 2);
  const kmOf = (r) => Number(r.Km1);
  // Which one was J0 (west): the one linked towards the west end node.
  const west = turnouts.find(r => rows.some(e => isEnd(e) && e.Km1 === '0.000' && [r['F Node'], r['T Node']].includes(e.Name)));
  const east = turnouts.find(r => r !== west);
  assert.ok(west && east);
  assert.ok(kmOf(west) >= 0.025, `west turnout km ${west.Km1}`);
  assert.ok(kmOf(east) - kmOf(west) >= 0.025, `order and spacing kept: ${west.Km1} then ${east.Km1}`);
  assert.ok(xOf(west) < xOf(east), 'positions in the same order');
});

test('a turnout well inside the geometry is not moved and no warning is given', async () => {
  const net = new Net().point('W', -600, 0).point('J', 1000, 0).point('E', 2600, 0).point('T1', 1100, -5).point('T2', 1400, -5);
  net.way(1, ['W', 'J']).way(2, ['J', 'E']).way(3, ['J', 'T1', 'T2']);
  const { rows, warnings } = await generate(net);
  const j = rows.find(r => r['D Node']);
  assert.equal(j.Km1, '1.000');
  assert.ok(Math.abs(xOf(j) - 1000) < 1);
  assert.ok(!warnings.some(w => /geometry end/i.test(w)), warnings.filter(w => /geometry end/i.test(w)).join('\n'));
});

test('end nodes still sit at the very ends of the geometry', async () => {
  const net = new Net().point('W', -600, 0).point('J', 1000, 0).point('E', 2600, 0).point('T1', 1100, -5).point('T2', 1400, -5);
  net.way(1, ['W', 'J']).way(2, ['J', 'E']).way(3, ['J', 'T1', 'T2']);
  const { rows } = await generate(net);
  const kms = rows.filter(isEnd).map(r => r.Km1);
  assert.ok(kms.includes('0.000') && kms.includes('2.000'), kms.join(', '));
});

test('no room: a turnout on a geometry under 50 m long is reported, not moved past its neighbours', () => {
  const geo = new Map([['A', [{ ...ll(0, 0), km: 0 }, { ...ll(40, 0), km: 0.04 }]]]);
  const t = { name: 'T', ...ll(20, 0), km: 0.02, region: 'A', fNode: 'P', tNode: 'Q', dNode: 'R' };
  clampAllKmToGeometry([t], geo);
  assert.equal(t.km, 0.02);
  const warnings = [];
  const r = keepNodesAwayFromGeometryEnds([t], geo, warnings);
  assert.equal(r.noRoom, 1);
  assert.ok(warnings.some(w => /^GEOMETRY END NO ROOM/.test(w) && w.includes('"T"')), warnings.join('\n'));
});

test('alias kilometrages keep the margin too', () => {
  const geo = new Map([
    ['A', [{ ...ll(0, 0), km: 0 }, { ...ll(2000, 0), km: 2 }]],
    ['B', [{ ...ll(1000, 0), km: 0 }, { ...ll(1000, 1000), km: 1 }]]
  ]);
  // A turnout where alternative B starts: km2 = B's first km.
  const t = { name: 'T', ...ll(1000, 0), km: 1, region: 'A', region2: 'B', km2: 0, fNode: 'P', tNode: 'Q', dNode: 'R' };
  const before = new Map([[t, { A: 1, B: 0 }]]);
  clampAllKmToGeometry([t], geo);
  assert.equal(t.km, 1);
  assert.equal(t.km2, 0.025);
  const warnings = [];
  keepNodesAwayFromGeometryEnds([t], geo, warnings, before);
  assert.ok(warnings.some(w => /^GEOMETRY END MARGIN/.test(w) && /B km 0\.000 -> 0\.025/.test(w)), warnings.join('\n'));
});
