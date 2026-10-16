/**
 * Warning kinds (October 2026): serious and "check these" warnings are never
 * hidden; only information notes go into the "show all" list / are
 * shortened for the agent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { warningKind, groupWarnings } from '../backend/utils/warningKinds.js';

test('warnings the user must act on are "review", never "info"', () => {
  for (const w of [
    'PLATFORMS MERGED at 44.11138, 9.81447: 3 platform nodes closer than 250 m on one track ...',
    'PLATFORMS NOT NUMBERED at Testa: 1 platform node has a provisional name ...',
    'PLATFORM NUMBER USED TWICE at Testa: platform 3 is on 2 tracks ...',
    'PLATFORM NUMBER ORDER ASSUMED at Testa: ...',
    'Slips: 2 double slip(s) and 0 single slip(s) found in OpenStreetMap; they are diamonds in the file ...',
    'Topology: degree-4 key at A - B km 0.943 — created diamond crossing "x"',
    'Speedboards: NO SPEED DATA was found in OpenStreetMap for these routes ...',
    'LINK MISMATCH: "A" F-arm → "B" X-arm ...',
    'Platform "Platform" (12): within 50m of a turnout/diamond — skipped (needs manual review).',
    'Something new the generator says one day'
  ]) assert.equal(warningKind(w), 'review', w);
});

test('missing data is "serious"', () => {
  for (const w of [
    'Platform fetch failed: HTTP 504. Platform nodes will be omitted.',
    'La Spezia - Sestri Levante: Elevation data unavailable (tile missing). Altitudes set to 0.',
    'Alternative 2 failed: boom',
    'Overpass query error: rate limited'
  ]) assert.equal(warningKind(w), 'serious', w);
});

test('fetch counts, cache loads, topology splits are information', () => {
  for (const w of [
    'Fetched 42 railway platform(s) from Overpass.',
    'Loaded 550 cached ways and 101 tagged nodes from osm_topology.json.',
    'Topology: split 232 ways at intermediate junction nodes.',
    'La Spezia - Sestri Levante: Topology JSON saved (12 ways, 3 tagged nodes).',
    'Naming pass: renamed 364 of 364 nodes to nearest-station convention',
    'Platform "Platform" (617064908): tracks on both sides — one platform node on the track along each side.'
  ]) assert.equal(warningKind(w), 'info', w);
});

test('groups keep every warning, in order', () => {
  const list = ['Fetched 1 railway way', 'PLATFORMS MERGED at 1, 2', 'Platform fetch failed: x', 'Loaded 2 cached station(s)'];
  const g = groupWarnings(list);
  assert.deepEqual(g, { serious: ['Platform fetch failed: x'], review: ['PLATFORMS MERGED at 1, 2'], info: ['Fetched 1 railway way', 'Loaded 2 cached station(s)'] });
});
