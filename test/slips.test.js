/**
 * Slips (October 2026): a crossing (diamond) whose OSM node is tagged
 * railway=switch + railway:switch=double_slip / single_slip is marked in
 * column AP ("Slip") of the Infrastructure file for the Network Editor;
 * a plain crossing stays a plain diamond with AP empty. The diamond itself
 * (links, F/T/D/X) is the same either way.
 *
 * Layout (metres): line A along y = 0 from x = 0 to 2000; a second track
 * crosses it at X = (1000, 0), from (900, -100) to (1100, 100) - the two
 * share the OSM node X, as a crossing does in OSM.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Net, geometryCsv, writeSession, parseInfrastructureCsv, removeSession } from './helpers/synthNetwork.js';
import { generateInfrastructureForSections, markSlipDiamonds } from '../backend/services/infrastructure/generator.js';

async function generate(crossingTags) {
  const net = new Net()
    .point('W', 0, 0).point('X', 1000, 0).point('E', 2000, 0)
    .point('S', 900, -100).point('N', 1100, 100);
  net.way(1, ['W', 'X']).way(2, ['X', 'E']).way(3, ['S', 'X']).way(4, ['X', 'N']);
  if (crossingTags) net.tag('X', crossingTags);
  const s = await writeSession({ geometry: { 'A.csv': geometryCsv('A', [[0, 0], [2000, 0]]) }, net });
  try {
    const r = await generateInfrastructureForSections([], 'Test', s.geometryDir, s.bbox, null, s.sessionPath);
    return { csv: r.csv, rows: parseInfrastructureCsv(r.csv), warnings: r.warnings };
  } finally {
    await removeSession(s.sessionPath);
  }
}

const diamondOf = (rows) => rows.filter(r => r['X Node']);

test('header ends with the Network Editor columns Notes (AN), Angled Legs (AO), Slip (AP)', async () => {
  const { csv } = await generate(null);
  const header = csv.split('\n')[2].replace(/^#/, '').split(',');
  assert.equal(header[39], 'Notes');
  assert.equal(header[40], 'Angled Legs');
  assert.equal(header[41], 'Slip');
  // Every node row has all 42 columns (the resolver needs at least 37).
  for (const line of csv.split('\n').slice(3).filter(Boolean)) assert.equal(line.split(',').length, 42);
});

test('double slip: diamond marked DoubleSlip in column AP', async () => {
  const { rows, warnings } = await generate({ railway: 'switch', 'railway:switch': 'double_slip' });
  const d = diamondOf(rows);
  assert.equal(d.length, 1);
  assert.equal(d[0]._fields[41], 'DoubleSlip');
  assert.equal(d[0].Slip, 'DoubleSlip');
  assert.ok(d[0]['F Node'] && d[0]['T Node'] && d[0]['D Node'] && d[0]['X Node'], 'still a full diamond');
  assert.ok(warnings.some(w => /1 double slip/.test(w)));
  // Nothing else is marked.
  assert.equal(rows.filter(r => r.Slip).length, 1);
});

test('single slip: marked SingleSlip', async () => {
  const { rows } = await generate({ railway: 'switch', 'railway:switch': 'single_slip' });
  assert.equal(diamondOf(rows)[0].Slip, 'SingleSlip');
});

for (const tags of [null, { railway: 'railway_crossing' }, { railway: 'switch', 'railway:switch': 'default' }]) {
  test(`plain diamond (${tags ? JSON.stringify(tags) : 'untagged'}): column AP empty, same diamond`, async () => {
    const plain = await generate(tags);
    const slip = await generate({ railway: 'switch', 'railway:switch': 'double_slip' });
    const d = diamondOf(plain.rows);
    assert.equal(d.length, 1);
    assert.equal(d[0].Slip, '');
    // The slip changes nothing but column AP.
    const strip = (rows) => rows.map(r => r._fields.slice(0, 41).join(','));
    assert.deepEqual(strip(plain.rows), strip(slip.rows));
  });
}

test('a slip tag on a node that is not a crossing is reported, not applied', () => {
  const warnings = [];
  const junction = { name: 'J', railwayType: 'junction', _topoKey: '44.1000000,9.8000000', lat: 44.1, lon: 9.8 };
  const counts = markSlipDiamonds([junction],
    [{ id: '1', lat: 44.1, lon: 9.8, tags: { railway: 'switch', 'railway:switch': 'double_slip' } }], warnings);
  assert.deepEqual(counts, { double: 0, single: 0 });
  assert.equal(junction.slip, undefined);
  assert.ok(warnings.some(w => /not a crossing of two tracks/.test(w)));
});
