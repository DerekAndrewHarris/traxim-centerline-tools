/**
 * End nodes (October 2026): an end node that lies beyond the start or end of
 * its geometry (where the OSM data was cut off, at the edge of the searched
 * area) is put at the end of the geometry, at its minimum or maximum km.
 * End nodes inside the geometry (e.g. the end of a siding) stay where they are.
 *
 * Layout (metres): geometry from x = 0 to x = 2000 along y = 0; the OSM track
 * carries on to x = -600 and x = 2600. Turnouts at x = 100 and x = 1900 with
 * sidings to the south ending at x = 400 and x = 1600.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Net, ll, geometryCsv, writeSession, parseInfrastructureCsv, removeSession } from './helpers/synthNetwork.js';
import {
  generateInfrastructureForSections, clampAllKmToGeometry, clampEndNodesToGeometry
} from '../backend/services/infrastructure/generator.js';

const xOf = (row) => (Number(row.Longitude) - ll(0, 0).lon) / ((ll(1000, 0).lon - ll(0, 0).lon) / 1000);

async function generate() {
  const net = new Net().point('W', -600, 0).point('J1', 100, 0).point('J2', 1900, 0).point('E', 2600, 0)
    .point('S1', 150, -4).point('S2', 400, -4).point('T1', 1850, -4).point('T2', 1600, -4);
  net.way(1, ['W', 'J1']).way(2, ['J1', 'J2']).way(3, ['J2', 'E']).way(4, ['J1', 'S1', 'S2']).way(5, ['J2', 'T1', 'T2']);
  const s = await writeSession({ geometry: { 'A.csv': geometryCsv('A', [[0, 0], [2000, 0]]) }, net });
  try {
    const r = await generateInfrastructureForSections([], 'Test', s.geometryDir, s.bbox, null, s.sessionPath);
    return { rows: parseInfrastructureCsv(r.csv), warnings: r.warnings };
  } finally {
    await removeSession(s.sessionPath);
  }
}

test('end nodes beyond the geometry are put at its first and last kilometrage and position', async () => {
  const { rows, warnings } = await generate();
  const ends = rows.filter(r => r['F Node'] && !r['T Node'] && !r['D Node']);
  const outer = ends.filter(r => Number(r.Km1) === 0 || Number(r.Km1) === 2);
  assert.equal(outer.length, 2, 'one end node at each end of the line');
  for (const row of outer) {
    const expectedX = Number(row.Km1) === 0 ? 0 : 2000;
    assert.ok(Math.abs(xOf(row) - expectedX) < 1, `${row.Name} at x=${xOf(row).toFixed(0)}, expected ${expectedX}`);
  }
  assert.ok(warnings.some(w => /End nodes: 2 end node/.test(w)));
  // Every kilometrage within the geometry's range.
  for (const row of rows) assert.ok(Number(row.Km1) >= 0 && Number(row.Km1) <= 2.0, `${row.Name} km ${row.Km1}`);
});

test('end nodes inside the geometry (sidings) stay where they are', async () => {
  const { rows } = await generate();
  const sidingEnds = rows.filter(r => r['F Node'] && !r['T Node'] && !r['D Node'] && Number(r.Km1) > 0 && Number(r.Km1) < 2);
  assert.equal(sidingEnds.length, 2);
  const xs = sidingEnds.map(xOf).sort((a, b) => a - b);
  assert.ok(Math.abs(xs[0] - 400) < 1 && Math.abs(xs[1] - 1600) < 1);
});

test('clampEndNodesToGeometry leaves nodes with more than one link alone', () => {
  const geo = new Map([['A', [{ ...ll(0, 0), km: 0 }, { ...ll(1000, 0), km: 1 }]]]);
  const through = { name: 'X', ...ll(-300, 0), km: 0, region: 'A', fNode: 'P', tNode: 'Q' };
  const end = { name: 'Y', ...ll(1300, 0), km: 1, region: 'A', fNode: 'P' };
  assert.equal(clampEndNodesToGeometry([through, end], geo), 1);
  assert.equal(through.lon, ll(-300, 0).lon);
  assert.equal(end.lon, ll(1000, 0).lon);
  assert.equal(end.km, 1);
});

test('clampAllKmToGeometry keeps alias kilometrages in range too', () => {
  const geo = new Map([['A', [{ lat: 0, lon: 0, km: 0 }, { lat: 0, lon: 1, km: 5 }]], ['B', [{ lat: 0, lon: 0, km: 2 }, { lat: 0, lon: 1, km: 3 }]]]);
  const n = { region: 'A', km: -0.4, region2: 'B', km2: 3.7, region3: null, km3: null };
  clampAllKmToGeometry([n], geo);
  assert.equal(n.km, 0);
  assert.equal(n.km2, 3);
});
