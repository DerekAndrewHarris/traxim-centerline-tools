/**
 * Regions.csv must have exactly one row per geometry file, named as in that
 * file's first column (that is how Traxim matches the two files).
 *
 * Run with:  npm test      (or: node --test test/)
 * No network, no server: uses a throwaway folder with made-up geometry files.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  generateRegionsCsv,
  readGeometryRegionNames,
  orderRegionNames,
  isGeometryCsvFile
} from '../backend/services/regions/generator.js';
import { REGION_COLOURS } from '../backend/services/infrastructure/generator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same layout the geometry generator writes.
function geometryCsv(regionName) {
  return '#region name,latitude,longitude,elevation,kilometerage,raw_elevation\n' +
    `${regionName},44.40000000,8.90000000,10.00,0.00000,10.00\n` +
    `${regionName},44.40100000,8.90100000,11.00,0.13500,11.00\n`;
}

// Region names from a Regions.csv, skipping comments and the mandatory blank first row.
function regionRows(csv) {
  return csv.split('\n')
    .filter(l => l.trim() && !l.startsWith('#'))
    .map(l => l.split(',')[0])
    .filter(name => name !== '');
}

async function makeGeometryDir(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'regions-test-'));
  for (const [fileName, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, fileName), content, 'utf-8');
  }
  return dir;
}

test('only geometry CSVs count, not diagnostics', () => {
  assert.equal(isGeometryCsvFile('Genova - Sestri Levante.csv'), true);
  assert.equal(isGeometryCsvFile('Genova_-_Sestri_Levante_alt2.csv'), true);
  assert.equal(isGeometryCsvFile('Genova_-_Sestri_Levante_wayids.csv'), false);
  assert.equal(isGeometryCsvFile('Genova_-_Sestri_Levante_topology.json'), false);
});

test('route order: segments in order, main file then alts by number, strays last', () => {
  const ordered = orderRegionNames(
    ['B - C_alt10', 'Stray', 'B - C', 'A - B_alt1', 'B - C_alt2', 'A - B'],
    ['A - B', 'B - C']
  );
  assert.deepEqual(ordered, ['A - B', 'A - B_alt1', 'B - C', 'B - C_alt2', 'B - C_alt10', 'Stray']);
});

test('Regions.csv lists exactly the geometry files on disk, including _altN, using their own names', async () => {
  // Segment "Genova - Sestri Levante" with alternatives 1 and 3 (alt 2 failed,
  // so its file was never written), plus a second segment and the diagnostics.
  const dir = await makeGeometryDir({
    'Genova_-_Sestri_Levante.csv': geometryCsv('Genova - Sestri Levante'),
    'Genova_-_Sestri_Levante_alt1.csv': geometryCsv('Genova - Sestri Levante_alt1'),
    'Genova_-_Sestri_Levante_alt3.csv': geometryCsv('Genova - Sestri Levante_alt3'),
    'Genova_-_Sestri_Levante_wayids.csv': 'way_id\n123\n456\n',
    'Genova_-_Sestri_Levante_topology.json': '{}',
    'Sestri_Levante_-_La_Spezia.csv': geometryCsv('Sestri Levante - La Spezia'),
    'Empty.csv': '#region name,latitude,longitude,elevation,kilometerage\n'
  });
  try {
    const names = orderRegionNames(
      await readGeometryRegionNames(dir),
      ['Genova - Sestri Levante', 'Sestri Levante - La Spezia']
    );
    const csv = generateRegionsCsv(names, REGION_COLOURS);
    assert.deepEqual(regionRows(csv), [
      'Genova - Sestri Levante',
      'Genova - Sestri Levante_alt1',
      'Genova - Sestri Levante_alt3',
      'Sestri Levante - La Spezia'
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a missing geometry folder gives no regions rather than an error', async () => {
  assert.deepEqual(await readGeometryRegionNames(path.join(os.tmpdir(), 'no-such-folder-' + Date.now())), []);
});

test('infrastructure generation does not rewrite Regions.csv (the old overwrite bug)', async () => {
  // Guard against the bug coming back: the infrastructure route must not
  // write Regions.csv; the geometry step is its only writer.
  const src = await fs.readFile(path.join(__dirname, '..', 'backend', 'routes', 'infrastructure.js'), 'utf-8');
  const code = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert.doesNotMatch(code, /buildRegionsCsv|generateRegionsCsv/);
  assert.doesNotMatch(code, /path\.join\([^)]*'Regions\.csv'\)/);
});
