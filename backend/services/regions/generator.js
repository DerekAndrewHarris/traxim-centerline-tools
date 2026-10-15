/**
 * Regions.csv Generator
 *
 * Field semantics confirmed against the actual Traxim engine parser
 * (TraximCore/Process/InputRegions.cs), not just the (incomplete) skill
 * reference — that reference only documents Region Name, Colour, Train
 * Graph Order, and Opposing/Following Delay, but the real file (and the
 * parser) also has Reverse Section, Nominal Superelevation, and one
 * Nominal Cant Deficiency column per train speed class.
 *
 * Column layout: Region Name, Colour, Train Graph Order, Opposing Delay,
 * Following Delay, Reverse Section, Nominal Superelevation, then one
 * Nominal Cant Deficiency column per speed class (label taken from row 1
 * at that same column position — see below), then a mandatory blank
 * separator column before anything else.
 *
 * The mandatory first row (blank name, White, order 1) is structurally
 * required — the parser reads that row's own cant-deficiency column(s) as
 * the train SPEED CLASS LABELS (e.g. "Normal"), not as numeric values, and
 * uses those labels for every subsequent row's actual numeric values at
 * the same columns. This generator only ever defines a single "Normal"
 * class.
 *
 * Opposing/Following Delay, Nominal Superelevation, and Nominal Cant
 * Deficiency are all real operational/engineering judgements the generator
 * has no way to derive from OSM/geometry data — populated with the
 * engine's own defaults (90s / 90s / 120mm / 75mm) rather than left blank,
 * per Derek: an explicit default value is a clearer signal to review it
 * than an empty cell would be. Callers should surface DEFAULTS_WARNING to
 * the user.
 */

import fs from 'fs/promises';
import path from 'path';

const DEFAULT_OPPOSING_DELAY = 90;
const DEFAULT_FOLLOWING_DELAY = 90;
const DEFAULT_SUPERELEVATION = 120;
const DEFAULT_CANT_DEFICIENCY = 75;

export const DEFAULTS_WARNING =
  `Regions.csv: Opposing/Following Delay (${DEFAULT_OPPOSING_DELAY}s), Nominal Superelevation ` +
  `(${DEFAULT_SUPERELEVATION}mm), and Nominal Cant Deficiency (${DEFAULT_CANT_DEFICIENCY}mm) were ` +
  `populated with default values for every region — these are real operational/track-engineering ` +
  `judgements the generator can't derive automatically. Review and adjust them for each region ` +
  `before using this file.`;

/**
 * @param {string[]} regionNames - Region names, one per geometry FILE actually produced
 *   (a segment's main centerline plus each of its alternative routes are each their own
 *   file and their own region - see backend/services/geometry/generator.js, whose first
 *   CSV column for each file is exactly the name that must appear here), in route order
 * @param {string[]} colourPalette - Region colour palette (e.g. REGION_COLOURS from infrastructure/generator.js)
 * @returns {string} CSV file content
 */
export function generateRegionsCsv(regionNames, colourPalette) {
  const lines = [
    '# First row of input data should always be blank for region name, "White" for colour and "1" for Train Graph Order. ',
    '# An unlimited number of train speed classes for nominal cant deficiency can be added from column H rightwards, but an empty column must be left between the last class and any column with non-input data.',
    '#Region Name, Colour, Train Graph Order,Opposing delay,Following Delay,Reverse Section,Nominal Superelevation,Nominal cant deficiency',
    // Mandatory first row: structural placeholder, not a real region — the
    // "Normal" here is the speed-class LABEL used by every row below, not a
    // data value for this row (see file header above).
    ',White,1,0,0,FALSE,,Normal,'
  ];

  regionNames.forEach((name, i) => {
    const colour = colourPalette[i % colourPalette.length];
    const order = i + 2; // 1 is reserved for the mandatory first row
    lines.push(
      `${name},${colour},${order},${DEFAULT_OPPOSING_DELAY},${DEFAULT_FOLLOWING_DELAY},` +
      `FALSE,${DEFAULT_SUPERELEVATION},${DEFAULT_CANT_DEFICIENCY},`
    );
  });

  return lines.join('\n') + '\n';
}

// ── Region names from the geometry files actually on disk ──────────────────
//
// Traxim matches each Regions.csv row to a geometry file by the region name in
// that file's own first column, so Regions.csv must list exactly the geometry
// files the user downloads: no more (a row for a file that was never written,
// e.g. an alternative route that failed) and no fewer (e.g. the `_altN` rows
// that the infrastructure step used to drop). Reading the names back from the
// files themselves is the only way to guarantee that.

/**
 * True for a file in the geometry folder that is a Traxim geometry input.
 * `_wayids.csv` files are diagnostics (OSM way id lists), not geometry, and
 * `_topology.json` files are not CSV at all.
 * @param {string} fileName
 * @returns {boolean}
 */
export function isGeometryCsvFile(fileName) {
  return fileName.endsWith('.csv') && !fileName.endsWith('_wayids.csv');
}

/**
 * Read the region name (first column of the first data row) from each
 * geometry CSV in a folder. Files with no data row are skipped.
 * @param {string} geometryDir
 * @returns {Promise<string[]>} region names, unordered
 */
export async function readGeometryRegionNames(geometryDir) {
  let files;
  try {
    files = await fs.readdir(geometryDir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const names = [];
  for (const file of files.filter(isGeometryCsvFile).sort()) {
    const content = await fs.readFile(path.join(geometryDir, file), 'utf-8');
    const firstDataLine = content.split(/\r?\n/).find(l => l.trim() && !l.startsWith('#'));
    if (!firstDataLine) continue;
    const name = firstDataLine.split(',')[0].trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Put region names into route order: segments in the order given, each
 * segment's main file first, then its `_alt1`, `_alt2`, ... files in number
 * order. Names that don't belong to any listed segment go last, A-Z.
 * @param {string[]} names - region names (e.g. from readGeometryRegionNames)
 * @param {string[]} segmentLabels - segment labels in route order
 * @returns {string[]} a new, ordered array
 */
export function orderRegionNames(names, segmentLabels) {
  const key = (name) => {
    const m = name.match(/^(.*)_alt(\d+)$/);
    const base = m ? m[1] : name;
    const alt = m ? parseInt(m[2], 10) : 0;
    const idx = segmentLabels.indexOf(base);
    return { idx: idx === -1 ? Infinity : idx, alt };
  };
  return [...names].sort((a, b) => {
    const ka = key(a), kb = key(b);
    if (ka.idx !== kb.idx) return ka.idx - kb.idx;
    if (ka.alt !== kb.alt) return ka.alt - kb.alt;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
