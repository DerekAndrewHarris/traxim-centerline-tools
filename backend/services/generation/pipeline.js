/**
 * Generation pipeline: the work behind the geometry and infrastructure jobs.
 *
 * Moved here (October 2026) from the bodies of the two route handlers in
 * routes/geometry.js and routes/infrastructure.js, unchanged, so that the
 * website's two separate jobs and the agent's single combined job
 * (services/agent/agentSessions.js) run exactly the same code.
 */

import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import archiver from 'archiver';
import { generateGeometryForSegment } from '../geometry/generator.js';
import { prefetchRelationWayIds } from '../osm/osmGeometry.js';
import { generateRegionsCsv, readGeometryRegionNames, orderRegionNames, isGeometryCsvFile, DEFAULTS_WARNING as REGIONS_DEFAULTS_WARNING } from '../regions/generator.js';
import { REGION_COLOURS, generateInfrastructureForSections, parseGeometryCsv } from '../infrastructure/generator.js';
import { generateSpeedboards } from '../speedboards/generator.js';
import { DEFAULT_RULING_GRADIENT } from '../geometry/processor.js';
import { readSessionMetadataSync, updateSessionMetadata } from '../../utils/tempFiles.js';
import { buildGeometryKml } from '../../utils/kmlGenerator.js';
import { isValidOutputStamp, makeOutputStamp } from '../../utils/outputNames.js';
import { groupWarnings } from '../../utils/warningKinds.js';

// ── Maximum gradient for elevation smoothing (user setting, October 2026) ──
// The smoothing pulls the elevation profile so that no stretch is steeper
// than this. Default DEFAULT_RULING_GRADIENT, 2.5% = 1 in 40 (was 4% until
// 16 Oct 2026); steeper values are unusual and should be set deliberately.
// Tunnels and bridges are interpolated between their portals before this,
// unchanged.
export const MAX_GRADIENT_DEFAULT_PERCENT = Math.round(DEFAULT_RULING_GRADIENT * 1000) / 10;
export const MAX_GRADIENT_MIN_PERCENT = 1;
export const MAX_GRADIENT_MAX_PERCENT = 6;

/**
 * The maximum gradient (percent) from a request, or the default when it is
 * not given. Throws a RangeError with a readable message when it is not a
 * number between MAX_GRADIENT_MIN_PERCENT and MAX_GRADIENT_MAX_PERCENT.
 * @param {*} value
 * @returns {number} percent, at most 2 decimal places
 */
export function parseMaxGradientPercent(value) {
  if (value === undefined || value === null || value === '') return MAX_GRADIENT_DEFAULT_PERCENT;
  const percent = typeof value === 'string' ? Number(value.trim()) : Number(value);
  if (typeof value === 'boolean' || !Number.isFinite(percent) ||
      percent < MAX_GRADIENT_MIN_PERCENT || percent > MAX_GRADIENT_MAX_PERCENT) {
    throw new RangeError(
      `The maximum gradient must be a number of percent between ${MAX_GRADIENT_MIN_PERCENT} and ${MAX_GRADIENT_MAX_PERCENT} ` +
      `(default ${MAX_GRADIENT_DEFAULT_PERCENT}, i.e. 1 in ${Math.round(100 / MAX_GRADIENT_DEFAULT_PERCENT)}).`
    );
  }
  return Math.round(percent * 100) / 100;
}

/**
 * Problems serious enough that some files cannot be used as they are, from a
 * geometry job's per-leg results. Shown first and never shortened (the
 * agent's job status and the website's geometry results), unlike ordinary
 * warnings. Each message starts with the files it affects and says which
 * are not affected, so the agent's single list is clear and the website
 * shows it only with the geometry results (not again at Infrastructure).
 *   - legs whose geometry could not be generated at all;
 *   - routes with no elevation data (every altitude 0), e.g. when an
 *     elevation tile could not be downloaded or read (see elevation.js).
 * @param {Array<object>} results - runGeometryGeneration's results
 * @returns {string[]}
 */
const NOT_AFFECTED_BY_ELEVATION = 'Infrastructure, Regions and Speedboards do not use elevation and are not affected; in the KMZ (Google Earth) these routes are drawn on the ground, without heights, instead of at sea level.';

export function describeSeriousProblems(results) {
  const problems = [];
  const list = Array.isArray(results) ? results : [];
  const succeeded = list.filter(r => !r.error);
  const failed = list.filter(r => r.error);
  if (failed.length > 0 && succeeded.length > 0) {
    problems.push(
      `Geometry, Regions and Infrastructure: geometry could not be generated for ${failed.length} of ${list.length} legs: ` +
      failed.map(r => `${r.section} (${r.error})`).join('; ') +
      '. Those legs have no geometry file, no region and no infrastructure, so the network has gaps.'
    );
  }

  const routes = [];
  for (const r of succeeded) {
    if (r.elevation) routes.push({ route: r.section, ok: r.elevation.ok !== false, reason: r.elevation.reason });
    for (const alt of r.alternativeElevation || []) {
      routes.push({ route: alt.route, ok: alt.ok !== false, reason: alt.reason });
    }
  }
  const missing = routes.filter(r => !r.ok);
  if (missing.length > 0) {
    const reason = missing.find(r => r.reason)?.reason;
    const tileProblem = missing.some(r => /elevation tile|elevation cache folder|geotiff package/i.test(r.reason || ''));
    const why = (reason ? ` Reason: ${reason}.` : '') +
      (tileProblem
        ? ' The elevation data (Copernicus DEM tiles, downloaded once and kept on the server) could not be downloaded or read. ' +
          'Try generating the files again in a few minutes; if it happens again, tell the Traxim administrator (the server\'s elevation cache needs checking).'
        : ' Try generating the files again later.');
    if (missing.length === routes.length) {
      problems.unshift(
        `Geometry: no elevation data, all altitudes are 0, so the geometry files cannot be used as they are ` +
        `(gradients, and therefore running times, would be wrong). ${NOT_AFFECTED_BY_ELEVATION}${why}`
      );
    } else {
      problems.unshift(
        `Geometry: no elevation data for ${missing.length} of ${routes.length} routes (${missing.map(r => r.route).join(', ')}): ` +
        `their altitudes are all 0, so those geometry files cannot be used as they are. ${NOT_AFFECTED_BY_ELEVATION}${why}`
      );
    }
  }
  return problems;
}

/**
 * Error thrown when a generated network has more nodes than allowed.
 * Only the agent job sets a limit; the website has none.
 */
export class NodeLimitError extends Error {
  constructor(nodeCount, maxNodes) {
    super(
      `The generated network has ${nodeCount} nodes, more than the limit of ${maxNodes} for one generation. ` +
      `No files were produced. Split the route into smaller parts (fewer waypoints, or fewer sections per ` +
      `session) and generate each part separately; the parts can be joined afterwards in the Network Editor.`
    );
    this.name = 'NodeLimitError';
    this.nodeCount = nodeCount;
    this.maxNodes = maxNodes;
  }
}

/**
 * Enrich the user's selected sections with the data the search found
 * (altOsmId, segmentIndices, wayIds...) and a preliminary corridor box.
 * Same logic the website's POST /geography/confirm has always used.
 *
 * @param {Array<{osmId, osmType, name?}>} selectedSections
 * @param {Array<object>} candidateSections - from session.json
 * @param {Array<{minLat,minLon,maxLat,maxLon}>} searchBboxes - from session.json
 * @returns {Array<object>} confirmedSections
 */
export function enrichConfirmedSections(selectedSections, candidateSections, searchBboxes) {
  return selectedSections.map(sel => {
    // Find matching candidate to get altOsmId, segmentIndices, wayIds, etc.
    const candidate = candidateSections.find(
      c => String(c.osmId) === String(sel.osmId) && c.osmType === sel.osmType
    );

    const enriched = {
      osmId: sel.osmId,
      osmType: sel.osmType,
      name: sel.name || (candidate ? candidate.name : `Section_${sel.osmId}`),
      ...(candidate ? {
        altOsmId: candidate.altOsmId || undefined,
        type: candidate.type,
        operator: candidate.operator,
        ref: candidate.ref,
        wayIds: candidate.wayIds,
        segmentIndices: candidate.segmentIndices
      } : {})
    };

    // Compute corridorBbox from searchBboxes + segmentIndices
    const indices = enriched.segmentIndices || [0];
    const relevantBboxes = indices
      .filter(i => i < searchBboxes.length)
      .map(i => searchBboxes[i]);

    if (relevantBboxes.length > 0) {
      enriched.corridorBbox = {
        minLat: Math.min(...relevantBboxes.map(b => b.minLat)),
        minLon: Math.min(...relevantBboxes.map(b => b.minLon)),
        maxLat: Math.max(...relevantBboxes.map(b => b.maxLat)),
        maxLon: Math.max(...relevantBboxes.map(b => b.maxLon))
      };
    }

    return enriched;
  });
}

/**
 * One segment per pair of consecutive waypoints, with the confirmed sections
 * that the section search found in that segment's box.
 * @param {object} sessionData - parsed session.json
 * @returns {Array<{label, bbox, startPoint, endPoint, sections}>}
 */
export function buildGeometrySegments(sessionData) {
  const confirmedSections = sessionData.confirmedSections || [];
  const searchBboxes = sessionData.searchBboxes || [];
  const geocodedPlaces = sessionData.geocodedPlaces || [];
  const segments = [];
  for (let i = 0; i < searchBboxes.length; i++) {
    const placeA = geocodedPlaces[i];
    const placeB = geocodedPlaces[i + 1];
    const labelA = placeA ? (placeA.stationName || placeA.place || `Place_${i}`) : `Place_${i}`;
    const labelB = placeB ? (placeB.stationName || placeB.place || `Place_${i + 1}`) : `Place_${i + 1}`;

    // Find confirmed sections whose segmentIndices include this segment index
    const relevantSections = confirmedSections.filter(
      s => Array.isArray(s.segmentIndices) && s.segmentIndices.includes(i)
    );

    segments.push({
      label: `${labelA} - ${labelB}`,
      bbox: searchBboxes[i],
      startPoint: placeA ? { lat: placeA.lat, lon: placeA.lon } : null,
      endPoint: placeB ? { lat: placeB.lat, lon: placeB.lon } : null,
      sections: relevantSections
    });
  }
  return segments;
}

/**
 * Geometry.kmz in the session folder (beside Regions.csv): every route in
 * geometry/ as a line, for checking in Google Earth. The same KMZ as the
 * website's "Generate & Download KMZ" button: a ZIP holding doc.kml (the
 * same KML, see utils/kmlGenerator.js). Removed when there is no geometry.
 * Never fails the job.
 * @param {string} sessionDirPath
 */
export async function writeGeometryKmz(sessionDirPath) {
  const kmzPath = path.join(sessionDirPath, 'Geometry.kmz');
  try {
    const built = await buildGeometryKml(path.join(sessionDirPath, 'geometry'));
    if (!built) {
      await fs.rm(kmzPath, { force: true });
      return;
    }
    await new Promise((resolve, reject) => {
      const output = fsSync.createWriteStream(kmzPath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);
      archive.pipe(output);
      archive.append(built.kml, { name: 'doc.kml' }); // KMZ format requires doc.kml
      archive.finalize();
    });
  } catch (kmzErr) {
    console.warn(`[Geometry API] Could not write Geometry.kmz: ${kmzErr.message}`);
  }
}

/**
 * Speedboards.csv in the session folder, from the OSM ways' speed tags and the
 * geometry files on disk (one region per file, in Regions.csv order). Always
 * written when geometry exists: with no speed data it is a valid file with no
 * speedboards, and the result says so (noSpeedData). Never fails the job.
 * @returns {Promise<{file: string|null, boardCount: number, regionsWithData: number, regionCount: number, noSpeedData: boolean, warnings: string[]}>}
 */
export async function writeSpeedboards(sessionDirPath, geometryDir, regionNames, ways) {
  const speedboardsPath = path.join(sessionDirPath, 'Speedboards.csv');
  try {
    const byRegion = new Map();
    let files = [];
    try { files = await fs.readdir(geometryDir); } catch { /* no geometry */ }
    for (const f of files.filter(isGeometryCsvFile)) {
      const { points, sectionName } = parseGeometryCsv(await fs.readFile(path.join(geometryDir, f), 'utf-8'));
      if (sectionName && points.length >= 2) byRegion.set(sectionName, points);
    }
    if (byRegion.size === 0) {
      await fs.rm(speedboardsPath, { force: true });
      return { file: null, boardCount: 0, regionsWithData: 0, regionCount: 0, noSpeedData: true, warnings: [] };
    }
    const order = [...regionNames.filter(n => byRegion.has(n)), ...[...byRegion.keys()].filter(n => !regionNames.includes(n))];
    const result = generateSpeedboards(order.map(region => ({ region, points: byRegion.get(region) })), ways || []);
    await fs.writeFile(speedboardsPath, result.csv, 'utf-8');
    console.log(`[Geometry API] Wrote Speedboards.csv (${result.boardCount} rows, ${result.regionsWithData}/${result.regionCount} routes with speed data)`);
    const { csv, ...summary } = result;
    return { file: 'Speedboards.csv', ...summary };
  } catch (err) {
    console.error('[Geometry API] Failed to write Speedboards.csv:', err);
    await fs.rm(speedboardsPath, { force: true }).catch(() => {});
    return { file: null, boardCount: 0, regionsWithData: 0, regionCount: 0, noSpeedData: true,
      warnings: [`Speedboards: the file could not be made (${err.message}).`] };
  }
}

/**
 * The geometry job: geometry CSVs (main route + _altN per segment),
 * Regions.csv, Speedboards.csv, Geometry.kmz, osm_topology.json and corridor data.
 *
 * @param {{sessionId: string, sessionPath: string, spacingMetres: number, segments: Array,
 *          maxGradientPercent?: number, outputStamp?: string}} data
 *   maxGradientPercent: elevation smoothing limit (default MAX_GRADIENT_DEFAULT_PERCENT)
 *   outputStamp: date stamp for the download names (default: now, see utils/outputNames.js)
 * @param {(progress: number, step: string) => void} updateProgress
 * @returns {Promise<{sessionId, totalSections, successfulSections, results, regionsWarning,
 *          seriousProblems: string[], maxGradientPercent: number, outputStamp: string}>}
 */
export async function runGeometryGeneration(data, updateProgress) {
  const { sessionId, sessionPath: sessionDirPath, spacingMetres, segments } = data;
  const maxGradientPercent = parseMaxGradientPercent(data.maxGradientPercent);
  const outputStamp = isValidOutputStamp(data.outputStamp) ? data.outputStamp : makeOutputStamp();
  const results = [];
  const geometryDir = path.join(sessionDirPath, 'geometry');
  const sessionPath = path.join(sessionDirPath, 'session.json');

  // Remove the previous run's geometry outputs first. Otherwise a rerun
  // in the same session (e.g. after re-confirming different places, or
  // when a segment now has fewer alternative routes) leaves old files
  // behind, and they would still be zipped for download and read by the
  // infrastructure step, without matching rows in the new Regions.csv.
  // Nothing in this folder is a cache: OSM caches live in the session root.
  try {
    for (const f of await fs.readdir(geometryDir)) {
      if (f.endsWith('.csv') || f.endsWith('_topology.json')) {
        await fs.unlink(path.join(geometryDir, f));
      }
    }
  } catch (clearErr) {
    if (clearErr.code !== 'ENOENT') {
      console.warn(`[Geometry API] Could not clear old geometry files: ${clearErr.message}`);
    }
  }

  // Pre-fetch relation way IDs once for all unique relations used across segments.
  // This avoids repeating expensive Overpass family-expansion queries (one per
  // unique relation, not once per segment × per relation).
  const allSections = segments.flatMap(seg => seg.sections ?? []);
  const relationWayIdCache = allSections.length > 0
    ? await prefetchRelationWayIds(allSections)
    : null;

  // Process each segment (pair of adjacent places). Segments are generated in
  // route order, one at a time — priorCenterlines accumulates each completed
  // segment's own raw chain so later segments' alt-route detection can recognise
  // "this candidate is just an earlier segment's mainline, walked backward past
  // our shared waypoint" (see priorCenterlines doc in generator.js).
  const priorCenterlines = [];
  // Finished elevation profiles of the earlier segments' routes, so that an
  // alternative route starting or ending on one of them takes its height
  // there from it (see anchorRouteEnds in geometry/processor.js).
  const priorProfiles = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];

    const segProgress = Math.floor((i / segments.length) * 100);
    await updateProgress(
      segProgress,
      `Processing segment ${i + 1}/${segments.length}: ${segment.label}`
    );

    try {
      const result = await generateGeometryForSegment(
        segment.label,
        segment.bbox,
        geometryDir,
        spacingMetres,
        segment.startPoint,
        segment.endPoint,
        (progress, step) => {
          const overallProgress = segProgress + Math.floor((progress / 100) * (100 / segments.length));
          updateProgress(overallProgress, `${segment.label}: ${step}`);
        },
        segment.sections,
        relationWayIdCache,
        sessionDirPath,
        priorCenterlines,
        { maxGradient: maxGradientPercent / 100, priorProfiles }
      );

      // rawCoords is only for the next segments' alt-route detection — keep it
      // out of the client-facing job result (it can be thousands of points).
      // elevationProfiles likewise (for the next segments' alternative routes).
      const { rawCoords, elevationProfiles, ...publicResult } = result;
      if (rawCoords) priorCenterlines.push(rawCoords);
      if (Array.isArray(elevationProfiles)) priorProfiles.push(...elevationProfiles);

      results.push({
        section: segment.label,
        ...publicResult
      });

    } catch (error) {
      console.error(`[Geometry API] Failed to generate geometry for segment '${segment.label}':`, error.message);
      results.push({
        section: segment.label,
        error: error.message
      });
    }
  }

  // Regions.csv needs one row per geometry FILE actually produced, not per
  // confirmed OSM relation - a segment's main centerline and each of its
  // alternative routes are each their own file, each with its own region
  // name in that file's own first column (see generator.js: segmentLabel /
  // altLabel), and Traxim correlates Regions.csv rows to geometry files by
  // that exact name. The names are read back from the files on disk, so a
  // failed segment or a failed alternative route gets no row. Written to
  // the session ROOT (not geometryDir) so it's naturally excluded from the
  // geometry-only ZIP and naturally included in the "download all" ZIP.
  // This is the ONLY writer of Regions.csv (the infrastructure step reads
  // the same geometry files and must not rewrite it).
  let regionsWarning = null;
  let regionNames = [];
  try {
    regionNames = orderRegionNames(
      await readGeometryRegionNames(geometryDir),
      segments.map(s => s.label)
    );
  } catch (namesErr) {
    console.error(`[Geometry API] Could not read region names from geometry files:`, namesErr);
  }
  console.log(`[Geometry API] Regions.csv: ${regionNames.length} region(s) from ${results.length} segment result(s) - ` +
    regionNames.map(n => `"${n}"`).join(', '));
  try {
    const regionsCsv = generateRegionsCsv(regionNames, REGION_COLOURS);
    const regionsPath = path.join(sessionDirPath, 'Regions.csv');
    await fs.writeFile(regionsPath, regionsCsv, 'utf-8');
    regionsWarning = REGIONS_DEFAULTS_WARNING;
    console.log(`[Geometry API] Wrote Regions.csv to ${regionsPath} (${regionNames.length} region(s), ${regionsCsv.length} bytes)`);
  } catch (regionsErr) {
    console.error(`[Geometry API] Failed to write Regions.csv:`, regionsErr);
  }

  // Merge infrastructure-format topology from all segments and write a
  // single osm_topology.json so the infrastructure pipeline can skip its
  // own Overpass query.
  let mergedWays = [];
  try {
    const seenWayIds = new Set();
    const seenNodeIds = new Set();
    const allWays = [];
    const allTaggedNodes = [];

    for (const r of results) {
      if (!r.infraTopology) continue;
      for (const w of r.infraTopology.ways) {
        if (!seenWayIds.has(w.id)) { seenWayIds.add(w.id); allWays.push(w); }
      }
      for (const n of r.infraTopology.taggedNodes) {
        if (!seenNodeIds.has(n.id)) { seenNodeIds.add(n.id); allTaggedNodes.push(n); }
      }
    }

    mergedWays = allWays;
    if (allWays.length > 0) {
      const topoPath = path.join(sessionDirPath, 'osm_topology.json');
      await fs.writeFile(topoPath, JSON.stringify({ ways: allWays, taggedNodes: allTaggedNodes }), 'utf-8');
      console.log(`[Geometry API] Wrote osm_topology.json (${allWays.length} ways, ${allTaggedNodes.length} tagged nodes)`);
    }
  } catch (topoErr) {
    console.warn(`[Geometry API] Failed to write osm_topology.json: ${topoErr.message}`);
  }

  // Speedboards.csv (session root, beside Regions.csv): from the OSM speed
  // tags on the ways just fetched, aligned to the geometry files on disk.
  const speedboards = await writeSpeedboards(sessionDirPath, geometryDir, regionNames, mergedWays);

  // Strip infraTopology from results before returning (large payload)
  for (const r of results) delete r.infraTopology;

  await writeGeometryKmz(sessionDirPath);

  // Update session metadata with real corridorBboxes derived from centerline
  // geometry (replacing the preliminary ones set at /confirm from searchBboxes).
  // Also write corridor_polygons.json for map visualization.
  try {
    const corridorBboxes = [];
    const corridorPolygons = [];
    for (const r of results) {
      if (r.corridorBbox) corridorBboxes.push(r.corridorBbox);
      if (r.bufferPolygon && r.bufferPolygon.length > 0) corridorPolygons.push(r.bufferPolygon);
    }

    if (corridorBboxes.length > 0) {
      const freshData = JSON.parse(await fs.readFile(sessionPath, 'utf-8'));
      // Assign corridorBbox per confirmedSection based on its segmentIndices
      if (freshData.confirmedSections) {
        for (const cs of freshData.confirmedSections) {
          const relevant = (cs.segmentIndices || [])
            .filter(idx => idx < corridorBboxes.length)
            .map(idx => corridorBboxes[idx]);
          if (relevant.length > 0) {
            cs.corridorBbox = {
              minLat: Math.min(...relevant.map(b => b.minLat)),
              maxLat: Math.max(...relevant.map(b => b.maxLat)),
              minLon: Math.min(...relevant.map(b => b.minLon)),
              maxLon: Math.max(...relevant.map(b => b.maxLon))
            };
          }
        }
      }
      freshData.corridorBboxes = corridorBboxes;
      await fs.writeFile(sessionPath, JSON.stringify(freshData, null, 2), 'utf-8');
      console.log(`[Geometry API] Updated session with ${corridorBboxes.length} real corridorBbox(es)`);
    }

    if (corridorPolygons.length > 0) {
      const polyPath = path.join(sessionDirPath, 'corridor_polygons.json');
      await fs.writeFile(polyPath, JSON.stringify(corridorPolygons), 'utf-8');
      console.log(`[Geometry API] Wrote corridor_polygons.json (${corridorPolygons.length} polygon(s))`);
    }
  } catch (cbErr) {
    console.warn(`[Geometry API] Failed to update corridorBbox: ${cbErr.message}`);
  }

  // Strip corridor data from results (already persisted)
  for (const r of results) {
    delete r.corridorBbox;
    delete r.bufferPolygon;
  }

  const seriousProblems = describeSeriousProblems(results);
  // The stamp, gradient and problems of this run, for the download names and
  // for the infrastructure step (which belongs to the same set of files).
  try {
    await updateSessionMetadata(sessionId, {
      outputStamp,
      geometryMaxGradientPercent: maxGradientPercent,
      geometrySeriousProblems: seriousProblems,
      geometrySpeedboards: speedboards
    });
  } catch (metaErr) {
    console.warn(`[Geometry API] Could not record the output stamp: ${metaErr.message}`);
  }

  await updateProgress(100, 'All segments processed');

  return {
    sessionId,
    totalSections: segments.length,
    successfulSections: results.filter(r => !r.error).length,
    results,
    regionsWarning,
    speedboards,
    seriousProblems,
    maxGradientPercent,
    outputStamp,
    // Every section's warnings (prefixed with the section) in three groups:
    // serious and review are always shown in full, info on request.
    warningGroups: groupWarnings(results.flatMap(r => (r.warnings || [])
      .filter(w => !/topology json saved/i.test(w))
      .map(w => `${r.section}: ${w}`)))
  };
}

/**
 * Merge all search boxes into one "minLat,minLon,maxLat,maxLon" string for
 * the infrastructure step's Overpass queries.
 * @param {Array<object|string>} searchBboxes
 * @returns {string}
 */
export function mergeSearchBboxes(searchBboxes) {
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  for (const bbox of searchBboxes) {
    // bbox may be an object {minLat,minLon,maxLat,maxLon} or a "minLat,minLon,maxLat,maxLon" string
    if (typeof bbox === 'string') {
      const parts = bbox.split(',').map(parseFloat);
      minLat = Math.min(minLat, parts[0]); minLon = Math.min(minLon, parts[1]);
      maxLat = Math.max(maxLat, parts[2]); maxLon = Math.max(maxLon, parts[3]);
    } else {
      minLat = Math.min(minLat, bbox.minLat); minLon = Math.min(minLon, bbox.minLon);
      maxLat = Math.max(maxLat, bbox.maxLat); maxLon = Math.max(maxLon, bbox.maxLon);
    }
  }
  return `${minLat},${minLon},${maxLat},${maxLon}`;
}

/**
 * The infrastructure job: Infrastructure.csv from the geometry files and
 * the OSM topology. Regions.csv is deliberately NOT written here (see the
 * comment below).
 *
 * @param {{sessionId, sessionPath, confirmedSections, networkName, geometryDir, bbox, maxNodes?, infrastructureStamp?}} jobData
 *   maxNodes: optional node limit (agent jobs only). When the network has
 *   more nodes, a NodeLimitError is thrown and Infrastructure.csv is not written.
 *   infrastructureStamp: date stamp for this run's Infrastructure download
 *   name. Every infrastructure run has its own (default: when it starts), so
 *   regenerating Infrastructure never gives a file the same name as before;
 *   the geometry, Regions and KMZ keep the stamp of their geometry run.
 * @param {(progress: number, step: string) => void} progressCallback
 * @param {Function} [generate] - the generator (tests pass a stand-in)
 */
export async function runInfrastructureGeneration(jobData, progressCallback, generate = generateInfrastructureForSections) {
  const { sessionId, confirmedSections, networkName, geometryDir, bbox, sessionPath, maxNodes } = jobData;
  const infrastructureStamp = isValidOutputStamp(jobData.infrastructureStamp) ? jobData.infrastructureStamp : makeOutputStamp();

  // Generate infrastructure
  const result = await generate(
    confirmedSections,
    networkName,
    geometryDir,
    bbox,
    progressCallback,
    sessionPath
  );

  if (maxNodes && result.nodeCount > maxNodes) {
    throw new NodeLimitError(result.nodeCount, maxNodes);
  }

  // Write Infrastructure.csv to session directory
  const outputPath = path.join(sessionPath, 'Infrastructure.csv');
  fsSync.writeFileSync(outputPath, result.csv, 'utf-8');

  // Regions.csv is deliberately NOT written here. The geometry step writes
  // it with one row per geometry file (main routes and each `_altN`
  // alternative), named exactly as in those files, and this step's
  // Infrastructure.csv uses those same names (it reads them from the same
  // geometry files). Rewriting it here from the confirmed OSM sections
  // used to replace those rows with relation names that match neither
  // the geometry files nor Infrastructure.csv, and dropped the `_altN` rows.

  // Update session metadata
  await updateSessionMetadata(sessionId, {
    infrastructureGenerated: true,
    infrastructureFile: 'Infrastructure.csv',
    infrastructureTimestamp: new Date().toISOString(),
    infrastructureNodeCount: result.nodeCount,
    infrastructureConnectionCount: result.connectionCount,
    infrastructureWarnings: result.warnings,
    infrastructureStamp
  });

  // The stamp of the geometry run this Infrastructure was built from.
  let geometryStamp = null;
  try { geometryStamp = (readSessionMetadataSync(sessionId) || {}).outputStamp || null; } catch { /* no stamp */ }

  return {
    filePath: outputPath,
    fileName: 'Infrastructure.csv',
    regionsFile: 'Regions.csv',
    infrastructureStamp,
    geometryStamp,
    nodeCount: result.nodeCount,
    connectionCount: result.connectionCount,
    warnings: result.warnings,
    // serious and review: always shown in full; info: on request.
    warningGroups: groupWarnings(result.warnings)
  };
}

/**
 * Map overlay data for a session: search boxes, corridor boxes, generated
 * geometry lines, OSM topology ways and corridor polygons. Used by the
 * website's GET /sessions/:id/map-overlays and by the agent session view.
 * @param {string} sessionPath - session folder
 */
export async function readMapOverlays(sessionPath) {
  const result = { searchBboxes: [], corridorBboxes: [], geometryLines: [], topologyWays: [], corridorPolygons: [] };

  // 1. Read session.json for bboxes & confirmed section metadata
  try {
    const raw = await fs.readFile(path.join(sessionPath, 'session.json'), 'utf-8');
    const meta = JSON.parse(raw);

    if (Array.isArray(meta.searchBboxes)) {
      result.searchBboxes = meta.searchBboxes;
    }

    // Corridor bboxes from confirmed sections
    if (Array.isArray(meta.confirmedSections)) {
      for (const sec of meta.confirmedSections) {
        if (sec.corridorBbox) {
          result.corridorBboxes.push({ name: sec.name, bbox: sec.corridorBbox });
        }
      }
    }
  } catch { /* session.json may not exist yet */ }

  // 2. Read geometry CSVs for centerline + alt polylines
  const geometryDir = path.join(sessionPath, 'geometry');
  try {
    const files = await fs.readdir(geometryDir);
    const csvFiles = files.filter(f => f.endsWith('.csv') && !f.includes('_wayids'));
    for (const csvFile of csvFiles) {
      const content = await fs.readFile(path.join(geometryDir, csvFile), 'utf-8');
      const coords = [];
      for (const line of content.split('\n')) {
        const parts = line.split(',');
        // CSV columns vary; lat is index 1, lon is index 2 in the standard geometry CSV
        const lat = parseFloat(parts[1]);
        const lon = parseFloat(parts[2]);
        if (isFinite(lat) && isFinite(lon)) coords.push([lat, lon]);
      }
      if (coords.length >= 2) {
        const label = csvFile.replace(/\.csv$/, '').replace(/_/g, ' ');
        const isAlt = /_alt\d+$/.test(csvFile.replace(/\.csv$/, ''));
        result.geometryLines.push({ label, isAlt, coords });
      }
    }
  } catch { /* geometry dir may not exist yet */ }

  // 3. Read osm_topology.json for raw OSM way polylines
  try {
    const raw = await fs.readFile(path.join(sessionPath, 'osm_topology.json'), 'utf-8');
    const topo = JSON.parse(raw);
    if (Array.isArray(topo.ways)) {
      for (const w of topo.ways) {
        if (Array.isArray(w.coords) && w.coords.length >= 2) {
          result.topologyWays.push({
            id: w.id,
            coords: w.coords.map(c => [c.lat, c.lon]),
            tags: w.tags || {}
          });
        }
      }
    }
  } catch { /* topology file may not exist yet */ }

  // 4. Read corridor_polygons.json for ~1km buffer around centerline
  try {
    const raw = await fs.readFile(path.join(sessionPath, 'corridor_polygons.json'), 'utf-8');
    const polys = JSON.parse(raw);
    if (Array.isArray(polys)) {
      result.corridorPolygons = polys;
    }
  } catch { /* corridor polygons may not exist yet */ }

  return result;
}
