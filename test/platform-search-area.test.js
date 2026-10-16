/**
 * Platforms outside the search box (October 2026, Riomaggiore / Manarola).
 *
 * The search box is drawn between the places the user names. A line can
 * leave it: La Spezia - Sestri Levante runs south of La Spezia Centrale's
 * latitude through Manarola and Riomaggiore. Tracks and station names were
 * fetched with a 0.05 degree margin, platforms with none, so those two
 * stations never got platform nodes.
 *
 * Layout (metres; the search box covers only y = -50 .. +50):
 *
 *   W --J1                                            J2 -- E
 *         \  track A (y = -1000) ----- A ----------- /
 *          \ track B (y = -1004) ---- B -.          /
 *                    [Rio platforms]       '-- B, ~500 m further south --'
 *
 * Tracks A and B are one per direction, 4 m apart through the station
 * (x 2100-2300), then ~500 m apart further on, like Riomaggiore. There is
 * no junction at the split, as in OpenStreetMap there.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Net, ll, geometryCsv, platform, rect, writeSession, parseInfrastructureCsv, removeSession
} from './helpers/synthNetwork.js';
import { generateInfrastructureForSections } from '../backend/services/infrastructure/generator.js';

function splitNet() {
  return new Net()
    .point('W', -300, 0).point('J1', 0, 0).point('J2', 5000, 0).point('E', 5300, 0)
    .point('A1', 1000, -1000).point('A2', 2000, -1000).point('A3', 2500, -1000).point('A4', 4000, -1000)
    .point('B1', 1000, -1004).point('B2', 2000, -1004).point('B3', 2500, -1004)
    .point('B4', 3000, -1500).point('B5', 4000, -1500)
    .way(1, ['W', 'J1'])
    .way(2, ['J1', 'A1', 'A2', 'A3', 'A4', 'J2'])
    .way(3, ['J1', 'B1', 'B2', 'B3', 'B4', 'B5', 'J2'])
    .way(4, ['J2', 'E']);
}

// Side platforms: north of track A, south of track B.
const RIO_PLATFORMS = [
  platform(501, 'Rio', rect(2100, 2300, -997.5, -994), '1'),
  platform(502, 'Rio', rect(2100, 2300, -1010, -1006.5), '2')
];

const MAIN_GEOMETRY = geometryCsv('A - B', [[0, 0], [1000, -1000], [2500, -1000], [4000, -1000], [5000, 0]]);
const STATIONS = [{ id: '1', ...ll(2200, -1002), name: 'Rio', railwayType: 'station' }];

// The search box between the two named places: it does not reach the station.
const SEARCH_BBOX = (() => {
  const sw = ll(-300, -50), ne = ll(5300, 50);
  return `${sw.lat},${sw.lon},${ne.lat},${ne.lon}`;
})();

// Stand-in for Overpass: returns the platforms that lie inside the box the
// query asks for, in Overpass's own JSON shape.
function fakeOverpass(platforms, seenBoxes) {
  return async (query) => {
    const m = query.match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/);
    const [s, w, n, e] = m.slice(1).map(Number);
    seenBoxes.push([s, w, n, e]);
    const inside = p => p.lat >= s && p.lat <= n && p.lon >= w && p.lon <= e;
    return {
      elements: platforms
        .filter(p => p.geometry.every(inside))
        .map(p => ({ type: 'way', id: Number(p.id), geometry: p.geometry, tags: { railway: 'platform', ref: p.ref } }))
    };
  };
}

const platformRows = rows => rows.filter(r => r['Signalled F'] === 'False' && r['Signalled T'] === 'False');
const metresNorth = row => (Number(row.Latitude) - ll(0, 0).lat) * 111320;

async function run({ platforms, overpassFetch }) {
  const s = await writeSession({ geometry: { 'A_-_B.csv': MAIN_GEOMETRY }, net: splitNet(), platforms, stations: STATIONS });
  try {
    const result = await generateInfrastructureForSections([], 'Test', s.geometryDir, SEARCH_BBOX, null, s.sessionPath, { overpassFetch });
    return { rows: parseInfrastructureCsv(result.csv), warnings: result.warnings };
  } finally {
    await removeSession(s.sessionPath);
  }
}

test('platforms outside the search box between the named places are still fetched', async () => {
  const boxes = [];
  const { rows } = await run({ platforms: null, overpassFetch: fakeOverpass(RIO_PLATFORMS, boxes) });

  assert.equal(boxes.length, 1, 'one platform query');
  const [s] = boxes[0];
  assert.ok(s < ll(0, -1010).lat, 'the platform query reaches the station south of the search box');

  const plats = platformRows(rows);
  assert.equal(plats.length, 2, `two platform nodes at Rio, got: ${plats.map(r => r.Name).join(', ')}`);
  assert.deepEqual(plats.map(r => r.Name).sort(), ['Rio 1', 'Rio 2']);
});

test('directional tracks ~500 m apart beyond the station: one platform node on each track', async () => {
  // The split itself does not stop platforms attaching (cached platforms, as
  // after the search-box fix): each platform goes on the track beside it.
  const { rows } = await run({ platforms: RIO_PLATFORMS });

  const plats = platformRows(rows);
  assert.equal(plats.length, 2);
  const byName = Object.fromEntries(plats.map(r => [r.Name, r]));
  assert.ok(Math.abs(metresNorth(byName['Rio 1']) - -1000) < 1.5, 'Rio 1 on track A');
  assert.ok(Math.abs(metresNorth(byName['Rio 2']) - -1004) < 1.5, 'Rio 2 on track B');
  // Each is a simple pass-through on its own track, between the two junctions.
  for (const r of plats) {
    assert.equal(r['D Node'], '');
    assert.ok(r['F Node'] && r['T Node']);
  }
});
