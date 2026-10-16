/**
 * Draw column (October 2026): all platform nodes and end nodes are drawn;
 * every other node only if it is at least DRAW_MIN_SPACING_M (500 m) along
 * the line from the previous drawn node. Timing Point follows Draw.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignDrawFlags, DRAW_MIN_SPACING_M, buildInfrastructureCsv } from '../backend/services/infrastructure/generator.js';
import { parseInfrastructureCsv } from './helpers/synthNetwork.js';

// A straight line of through nodes at the given km, with end nodes at each end.
function line(kms, region = 'A') {
  return kms.map((km, i) => ({
    name: `N${i}`, region, km, lat: 44, lon: 9,
    fNode: i > 0 ? `N${i - 1}` : '',
    tNode: i < kms.length - 1 ? `N${i + 1}` : ''
  }));
}
const drawnNames = (nodes) => nodes.filter(n => n.draw).map(n => n.name);

test('the spacing is a named constant of 500 m', () => {
  assert.equal(DRAW_MIN_SPACING_M, 500);
});

test('through nodes are drawn only 500 m or more after the previous drawn node', () => {
  //              end   0.2   0.5   0.6   1.0   1.05  1.7   end
  const nodes = line([0, 0.2, 0.5, 0.6, 1.0, 1.05, 1.7, 1.8]);
  assignDrawFlags(nodes);
  // 0 (end) drawn; 0.2 no; 0.5 yes (0.5 from 0); 0.6 no; 1.0 yes; 1.05 no; 1.7 yes; 1.8 end yes.
  assert.deepEqual(drawnNames(nodes), ['N0', 'N2', 'N4', 'N6', 'N7']);
});

test('platform nodes are always drawn, and count as the previous drawn node', () => {
  const nodes = line([0, 0.3, 0.45, 0.7, 0.9, 2]);
  nodes[2].railwayType = 'platform'; // 0.45
  assignDrawFlags(nodes);
  // 0 end; 0.3 no; 0.45 platform; 0.7 no (0.25 after platform); 0.9 no (0.45); 2 end.
  assert.deepEqual(drawnNames(nodes), ['N0', 'N2', 'N5']);
});

test('end nodes are always drawn, even close to other drawn nodes', () => {
  const nodes = line([0, 0.6, 0.65]);
  assignDrawFlags(nodes);
  assert.deepEqual(drawnNames(nodes), ['N0', 'N1', 'N2']);
});

test('a node drawn for one region counts as drawn on its other region', () => {
  const nodes = line([0, 0.6, 3]);
  nodes[1].region2 = 'B'; nodes[1].km2 = 0.1;
  const b = { name: 'B1', region: 'B', km: 0.3, lat: 44, lon: 9, fNode: 'x', tNode: 'y' };
  nodes.push(b);
  assignDrawFlags(nodes);
  // On B, N1 (km2 0.1, drawn via region A) is the previous drawn node: B1 at 0.3 is too close.
  assert.equal(b.draw, false);
  assert.equal(nodes[1].draw, true);
});

test('the CSV writes Draw and Timing Point from the flag', () => {
  const nodes = line([0, 0.2, 1]);
  assignDrawFlags(nodes);
  const rows = parseInfrastructureCsv(buildInfrastructureCsv(nodes, 'T', nodes.length, nodes.length));
  assert.deepEqual(rows.map(r => r.Draw), ['True', 'False', 'True']);
  assert.deepEqual(rows.map(r => r['Timing Point']), ['True', 'False', 'True']);
});
