/**
 * Geometry Generator
 * Main orchestration for generating Traxim geometry CSV files from OSM data
 *
 * Ported from: Traxim-MCP-Servers/traxim-input-creator-mcp/tools/geometry.js
 *
 * Pipeline per segment:
 *   1. Fetch ALL railway ways in segment bbox
 *   1b. Fetch tagged junction nodes + split ways at intermediate junctions
 *   2. Write diagnostic wayId CSV
 *   3. Detect parallel ways (same endpoints + close proximity)
 *   4. Deduplicate: keep one representative per parallel group
 *   5. Chain ways via graph traversal (F→T heuristic from terminus)
 *   5b. Detect alternative routes (>50m divergence from main centerline)
 *   6. Spline-smooth + resample at target spacing (Cardinal → Bezier → resample)
 *   7. Elevation fetch + interpolation
 *   8. Compute chainage via Vincenty, write CSV
 *   9. Generate alternative route CSVs
 *   10. Build and save topology JSON
 */

import { GeoPoint } from '../../lib/geopoint.js';
import { processTrackPoints } from '../../lib/curves.js';
import { distanceMetres } from '../../lib/geodetic.js';
import { fetchSegmentGeometryFromOSM, fetchSegmentGeometryViaRelations, prefetchRelationWayIds, fetchRailwayTaggedNodes } from '../osm/osmGeometry.js';
import {
  coordKey,
  buildEndpointIndex,
  assignParallelGroups,
  deduplicateByGroup,
  chainWaysViaGraph,
  splitWaysAtIntermediateJunctions,
  detectAlternativeRoutes,
  calculateRouteLengthMeters
} from './processor.js';
import { fetchElevations } from '../elevation.js';
import path from 'path';
import { promises as fs } from 'fs';

/**
 * Generate geometry CSV for a geographic segment (between two user-defined places).
 *
 * Unlike section-based generation (which queries a specific OSM relation), this
 * queries ALL railway=rail ways within the segment bbox. This captures crossing
 * loops, sidings, and station tracks regardless of which OSM relation they belong to.
 *
 * @param {string} segmentLabel - Human-readable label, e.g. "Genova - Sestri Levante"
 * @param {{minLat, minLon, maxLat, maxLon}} segmentBbox
 * @param {string} outputDir - Session geometry directory
 * @param {number} spacingMetres - Target point spacing (default 25m)
 * @param {{lat: number, lon: number}} [startPoint] - Optional start point to guide chain direction
 * @param {{lat: number, lon: number}} [endPoint] - Optional end point
 * @param {Function} progressCallback - Called with (progress 0-100, step description)
 * @param {Array<{osmId: string, osmType: string, name: string, altOsmId?: string}>} [sections] - Confirmed sections covering this segment (for relation-based queries)
 * @param {Map<string, string[]>} [relationWayIdCache] - Pre-fetched relation→wayIds cache shared across all segments
 * @param {string} [sessionPath] - Session directory path; if provided, writes osm_topology.json for infrastructure reuse
 * @returns {Promise<{filePath: string, pointCount: number, lengthKm: number, alternativeCount: number, alternativeFiles: string[], warnings: string[]}>}
 */
export async function generateGeometryForSegment(segmentLabel, segmentBbox, outputDir, spacingMetres = 25, startPoint = null, endPoint = null, progressCallback = null, sections = null, relationWayIdCache = null, sessionPath = null) {
  const warnings = [];
  const safeName = segmentLabel.replace(/[^a-zA-Z0-9_\-]/g, '_');

  console.log(`\n[Geometry Generator] Starting segment generation: ${segmentLabel}`);
  console.log(`[Geometry Generator] Output: ${outputDir}/${safeName}.csv`);

  try {
    // ── 1. Fetch railway ways via relations or bbox (0-15%) ──────────────────
    if (progressCallback) progressCallback(0, 'Fetching OSM data...');

    let fetchResult;
    if (sections && sections.length > 0) {
      // Use relation-based multi-phase query: relation ways → centerline → buffer bbox → all ways
      console.log(`[Geometry Generator] Using relation-based query (${sections.length} confirmed section(s))`);
      fetchResult = await fetchSegmentGeometryViaRelations(segmentBbox, sections, relationWayIdCache);
    } else {
      // Fallback: simple bbox query
      console.log(`[Geometry Generator] No confirmed sections — falling back to bbox query`);
      fetchResult = await fetchSegmentGeometryFromOSM(segmentBbox);
    }
    const { wayIds, wayGeometry, wayNodes, wayTags } = fetchResult;

    if (wayIds.length === 0 || wayGeometry.size === 0) {
      throw new Error(`No railway ways found in segment '${segmentLabel}'`);
    }

    console.log(`[Geometry Generator] Fetched ${wayIds.length} ways`);
    if (progressCallback) progressCallback(10, `Fetched ${wayIds.length} ways from OSM`);

    // ── 1b. Fetch tagged junction nodes + split ways (15-20%) ─────────────────
    if (progressCallback) progressCallback(15, 'Fetching junction nodes...');

    let splitWayIds, splitWayGeometry, splitWayNodes;
    let taggedNodes = [];
    try {
      taggedNodes = await fetchRailwayTaggedNodes(segmentBbox);
      console.log(`[Geometry Generator] Fetched ${taggedNodes.length} tagged junction nodes`);

      ({ splitWayIds, splitWayGeometry, splitWayNodes } =
        splitWaysAtIntermediateJunctions(wayIds, wayGeometry, wayNodes, taggedNodes));
      console.log(`[Geometry Generator] After junction splitting: ${wayIds.length} → ${splitWayIds.length} ways`);
    } catch (junctionErr) {
      console.warn(`[Geometry Generator] Junction splitting failed, proceeding with unsplit ways: ${junctionErr.message}`);
      splitWayIds = wayIds;
      splitWayGeometry = wayGeometry;
      splitWayNodes = wayNodes;
    }
    if (progressCallback) progressCallback(20, `Split to ${splitWayIds.length} way segments`);

    // ── 2. Write diagnostic wayId CSV ─────────────────────────────────────────
    const diagLines = ['Index,WayId,StartLat,StartLon,EndLat,EndLon,NodeCount'];
    splitWayIds.forEach((wid, idx) => {
      const pts = splitWayGeometry.get(wid);
      if (pts && pts.length >= 2) {
        const s = pts[0];
        const e = pts[pts.length - 1];
        diagLines.push(`${idx},${wid},${s.lat.toFixed(7)},${s.lon.toFixed(7)},${e.lat.toFixed(7)},${e.lon.toFixed(7)},${pts.length}`);
      } else {
        diagLines.push(`${idx},${wid},,,,,0`);
      }
    });
    await fs.writeFile(path.join(outputDir, `${safeName}_wayids.csv`), diagLines.join('\n') + '\n', 'utf-8');

    // ── 3 & 4. Parallel track deduplication (20-30%) ──────────────────────────
    if (progressCallback) progressCallback(20, 'Detecting parallel tracks...');

    const endpointIndex = buildEndpointIndex(splitWayIds, splitWayGeometry);
    const parallelGroups = assignParallelGroups(splitWayIds, splitWayGeometry, endpointIndex);
    const dedupedWayIds = deduplicateByGroup(splitWayIds, parallelGroups);

    const droppedCount = splitWayIds.length - dedupedWayIds.length;
    if (droppedCount > 0) {
      warnings.push(
        `Parallel track deduplication: ${droppedCount} of ${splitWayIds.length} ways removed. ` +
        `${dedupedWayIds.length} retained for centreline.`
      );
    }
    if (progressCallback) progressCallback(30, `Deduplicated to ${dedupedWayIds.length} ways`);

    // ── 5. Chain ways via graph traversal (30-45%) ────────────────────────────
    if (progressCallback) progressCallback(30, 'Building centreline path...');

    const { coords: rawCoords, visitedIds: mainChainWayIds } = chainWaysViaGraph(
      dedupedWayIds, splitWayGeometry, warnings, startPoint, endPoint
    );

    if (rawCoords.length < 2) {
      throw new Error(
        `Insufficient coordinates (${rawCoords.length}) after chaining for segment '${segmentLabel}'.`
      );
    }

    console.log(`[Geometry Generator] Chained ${rawCoords.length} coordinates from ${mainChainWayIds.size} ways`);
    if (progressCallback) progressCallback(40, `Chained ${rawCoords.length} points`);

    // ── 5b. Prune overflow main-chain ways ────────────────────────────────────────
    // The raw chain may extend well past the waypoints. Ways entirely in the overflow
    // zone (before startPoint-1km or after endPoint+1km) get released back into the
    // alt-route candidate pool. This prevents pre-start overflow ways (e.g. a tunnel
    // approach the chain traverses before reaching the startPoint station) from being
    // permanently marked as mainline and invisible to alt-route detection.
    // Also clip the centerline reference used by alt-route distance checks.
    const TRUNCATE_OVERSHOOT_M = 1000;
    let prunedMainChainWayIds = mainChainWayIds;
    let altDetectionCoords = rawCoords;

    if ((startPoint || endPoint) && rawCoords.length >= 2) {
      let rawStartIdx = 0, rawEndIdx = rawCoords.length - 1;

      if (startPoint) {
        let minD = Infinity, closest = 0;
        for (let i = 0; i < rawCoords.length; i++) {
          const d = distanceMetres(startPoint.lat, startPoint.lon, rawCoords[i].lat, rawCoords[i].lon);
          if (d < minD) { minD = d; closest = i; }
        }
        let walked = 0; rawStartIdx = closest;
        while (rawStartIdx > 0) {
          walked += distanceMetres(rawCoords[rawStartIdx].lat, rawCoords[rawStartIdx].lon,
            rawCoords[rawStartIdx - 1].lat, rawCoords[rawStartIdx - 1].lon);
          if (walked >= TRUNCATE_OVERSHOOT_M) break;
          rawStartIdx--;
        }
      }

      if (endPoint) {
        let minD = Infinity, closest = rawCoords.length - 1;
        for (let i = 0; i < rawCoords.length; i++) {
          const d = distanceMetres(endPoint.lat, endPoint.lon, rawCoords[i].lat, rawCoords[i].lon);
          if (d < minD) { minD = d; closest = i; }
        }
        let walked = 0; rawEndIdx = closest;
        while (rawEndIdx < rawCoords.length - 1) {
          walked += distanceMetres(rawCoords[rawEndIdx].lat, rawCoords[rawEndIdx].lon,
            rawCoords[rawEndIdx + 1].lat, rawCoords[rawEndIdx + 1].lon);
          if (walked >= TRUNCATE_OVERSHOOT_M) break;
          rawEndIdx++;
        }
      }

      if (rawStartIdx < rawEndIdx) {
        altDetectionCoords = rawCoords.slice(rawStartIdx, rawEndIdx + 1);
        prunedMainChainWayIds = new Set(mainChainWayIds);
        for (const wid of mainChainWayIds) {
          const pts = splitWayGeometry.get(wid);
          if (!pts || pts.length === 0) continue;
          const mid = pts[Math.floor(pts.length / 2)];
          // Find the closest raw-chain index to this way's midpoint
          let minD = Infinity, closestIdx = 0;
          for (let i = 0; i < rawCoords.length; i++) {
            const d = distanceMetres(mid.lat, mid.lon, rawCoords[i].lat, rawCoords[i].lon);
            if (d < minD) { minD = d; closestIdx = i; }
          }
          if (closestIdx < rawStartIdx || closestIdx > rawEndIdx) {
            prunedMainChainWayIds.delete(wid);
          }
        }
        const released = mainChainWayIds.size - prunedMainChainWayIds.size;
        if (released > 0) console.log(`[Geometry Generator] Released ${released} overflow way(s) from main chain for alt route detection`);
      }
    }

    // ── 5c. Alternative route detection (45-50%) ──────────────────────────────────
    if (progressCallback) progressCallback(45, 'Detecting alternative routes...');

    // Use full splitWayIds (not dedupedWayIds) so alternatives can choose between parallel options
    const alternativeRoutes = detectAlternativeRoutes(
      splitWayIds, splitWayGeometry, prunedMainChainWayIds, altDetectionCoords, segmentBbox
    );

    if (alternativeRoutes.length > 0) {
      warnings.push(
        `Detected ${alternativeRoutes.length} alternative route(s) diverging >50m from main centerline.`
      );
    }
    console.log(`[Geometry Generator] Detected ${alternativeRoutes.length} alternative routes`);
    if (progressCallback) progressCallback(50, `Found ${alternativeRoutes.length} alternative route(s)`);

    // ── 6. Spline-smooth + resample main centerline (50-60%) ──────────────────
    if (progressCallback) progressCallback(50, 'Smoothing and resampling...');

    const rawPoints = rawCoords.map(c => {
      const pt = new GeoPoint(c.lat, c.lon, 0);
      pt.section = segmentLabel;
      return pt;
    });

    const processedPoints = processTrackPoints(rawPoints, spacingMetres);

    console.log(`[Geometry Generator] Processed to ${processedPoints.length} points at ${spacingMetres}m spacing`);

    // ── 6b. Truncate to 1km beyond each waypoint (start / end) ───────────────
    // OSM ways extend well past station locations. We clip the resampled line to
    // at most 1km beyond startPoint and endPoint so adjacent segment geometries
    // only overlap ~2km, giving flexibility without enormous redundancy.
    const truncated = (() => {
      if ((!startPoint && !endPoint) || processedPoints.length < 2) return processedPoints;

      let startIdx = 0;
      let endIdx = processedPoints.length - 1;

      if (startPoint) {
        // Find the index closest to startPoint
        let minD = Infinity, closest = 0;
        for (let i = 0; i < processedPoints.length; i++) {
          const d = distanceMetres(startPoint.lat, startPoint.lon, processedPoints[i].latitude, processedPoints[i].longitude);
          if (d < minD) { minD = d; closest = i; }
        }
        // Walk backward from closest until we've gone >= TRUNCATE_OVERSHOOT_M
        let walked = 0;
        startIdx = closest;
        while (startIdx > 0) {
          walked += distanceMetres(
            processedPoints[startIdx].latitude, processedPoints[startIdx].longitude,
            processedPoints[startIdx - 1].latitude, processedPoints[startIdx - 1].longitude
          );
          if (walked >= TRUNCATE_OVERSHOOT_M) break;
          startIdx--;
        }
      }

      if (endPoint) {
        let minD = Infinity, closest = processedPoints.length - 1;
        for (let i = 0; i < processedPoints.length; i++) {
          const d = distanceMetres(endPoint.lat, endPoint.lon, processedPoints[i].latitude, processedPoints[i].longitude);
          if (d < minD) { minD = d; closest = i; }
        }
        let walked = 0;
        endIdx = closest;
        while (endIdx < processedPoints.length - 1) {
          walked += distanceMetres(
            processedPoints[endIdx].latitude, processedPoints[endIdx].longitude,
            processedPoints[endIdx + 1].latitude, processedPoints[endIdx + 1].longitude
          );
          if (walked >= TRUNCATE_OVERSHOOT_M) break;
          endIdx++;
        }
      }

      if (startIdx > endIdx) return processedPoints; // sanity guard
      const slice = processedPoints.slice(startIdx, endIdx + 1);
      console.log(`[Geometry Generator] Truncated: kept [${startIdx}..${endIdx}] of ${processedPoints.length} points`);
      return slice;
    })();

    if (truncated.length < 2) {
      warnings.push('Truncation produced fewer than 2 points — using full resampled line.');
    }
    const finalPoints = truncated.length >= 2 ? truncated : processedPoints;

    console.log(`[Geometry Generator] Final: ${finalPoints.length} points at ${spacingMetres}m spacing`);
    if (progressCallback) progressCallback(60, `Resampled to ${finalPoints.length} points`);

    // ── 7. Elevation fetch (60-70%) ───────────────────────────────────────────
    if (progressCallback) progressCallback(60, 'Fetching elevation data...');

    try {
      const elevPts = finalPoints.map(pt => ({ lat: pt.latitude, lon: pt.longitude }));
      const elevResults = await fetchElevations(elevPts, (pct, msg) => {
        if (progressCallback) progressCallback(60 + Math.round(pct * 0.1), msg);
      });
      for (let i = 0; i < finalPoints.length; i++) {
        finalPoints[i].altitude = elevResults[i].elevation;
      }
    } catch (elevError) {
      console.warn(`[Geometry Generator] Elevation failed: ${elevError.message}`);
      warnings.push(`Elevation unavailable: ${elevError.message}. Altitudes set to 0.`);
      for (const pt of finalPoints) pt.altitude = 0;
    }

    // ── 8. Chainage + write main CSV (70-80%) ────────────────────────────────
    if (progressCallback) progressCallback(70, 'Computing chainage...');

    let totalKm = 0;
    finalPoints[0].chainage = 0;
    for (let i = 1; i < finalPoints.length; i++) {
      totalKm += distanceMetres(
        finalPoints[i - 1].latitude, finalPoints[i - 1].longitude,
        finalPoints[i].latitude, finalPoints[i].longitude
      ) / 1000;
      finalPoints[i].chainage = totalKm;
    }

    console.log(`[Geometry Generator] Total length: ${totalKm.toFixed(2)} km`);

    if (progressCallback) progressCallback(75, 'Writing geometry file...');

    const filePath = path.join(outputDir, `${safeName}.csv`);
    const lines = ['#region name,latitude,longitude,elevation,kilometerage'];
    for (const pt of finalPoints) {
      lines.push(
        `${segmentLabel},${pt.latitude.toFixed(8)},${pt.longitude.toFixed(8)},` +
        `${pt.altitude.toFixed(2)},${pt.chainage.toFixed(5)}`
      );
    }
    await fs.writeFile(filePath, lines.join('\n') + '\n', 'utf-8');
    console.log(`[Geometry Generator] Wrote geometry to: ${filePath}`);

    // ── 9. Generate alternative route CSVs (80-90%) ──────────────────────────
    const alternativeFiles = [];
    for (let altIdx = 0; altIdx < alternativeRoutes.length; altIdx++) {
      const alt = alternativeRoutes[altIdx];
      if (progressCallback) progressCallback(80 + Math.round((altIdx / Math.max(1, alternativeRoutes.length)) * 5), `Generating alt route ${altIdx + 1}...`);

      try {
        const altFilePath = await generateAlternativeGeometry(
          segmentLabel, alt, altIdx + 1, outputDir, spacingMetres, warnings
        );
        alternativeFiles.push(altFilePath);
      } catch (altErr) {
        warnings.push(`Alternative ${altIdx + 1} failed: ${altErr.message}`);
      }
    }

    // ── 10. Topology JSON (90-100%) ──────────────────────────────────────────
    if (progressCallback) progressCallback(90, 'Building topology JSON...');

    try {
      const endpointIndexObj = {};
      for (const [key, wids] of endpointIndex) {
        endpointIndexObj[key] = [...wids];
      }

      const mainChainGroups = new Set(
        [...mainChainWayIds].map(wid => parallelGroups.get(wid))
      );

      const wayDescriptors = splitWayIds.map(wid => {
        const pts = splitWayGeometry.get(wid) ?? [];
        const nodes = splitWayNodes.get(wid) ?? [];
        const gid = parallelGroups.get(wid) ?? -1;
        const start = pts[0] ?? {};
        const end = pts[pts.length - 1] ?? {};
        return {
          id: wid,
          nodes,
          groupId: gid,
          role: mainChainGroups.has(gid) ? 'main' : 'branch',
          startKey: pts.length ? coordKey(start) : null,
          endKey: pts.length ? coordKey(end) : null,
          startLat: start.lat ?? null, startLon: start.lon ?? null,
          endLat: end.lat ?? null, endLon: end.lon ?? null,
        };
      });

      const topology = {
        section: segmentLabel,
        generatedAt: new Date().toISOString(),
        wayCount: splitWayIds.length,
        visitedCount: mainChainWayIds.size,
        visitedWayIds: [...mainChainWayIds],
        excludedCount: splitWayIds.length - mainChainWayIds.size,
        ways: wayDescriptors,
        endpointIndex: endpointIndexObj,
        taggedNodes,
      };

      const topoPath = path.join(outputDir, `${safeName}_topology.json`);
      await fs.writeFile(topoPath, JSON.stringify(topology, null, 2) + '\n', 'utf-8');
      warnings.push(`Topology JSON saved (${splitWayIds.length} ways, ${taggedNodes.length} tagged nodes).`);
      console.log(`[Geometry Generator] Wrote topology to: ${topoPath}`);
    } catch (topoErr) {
      warnings.push(`Topology JSON failed: ${topoErr.message}`);
    }

    // ── 10b. Build infrastructure-format topology for reuse ─────────────────
    // Build the topology object in the same shape that
    // fetchRailwayTopologyFromOverpass returns, so the infrastructure pipeline
    // can skip its own Overpass query.
    const infraTopology = {
      ways: wayIds
        .filter(wid => wayGeometry.has(wid) && (wayGeometry.get(wid) || []).length >= 2)
        .map(wid => ({
          id: wid,
          nodes: wayNodes.get(wid) || [],
          coords: (wayGeometry.get(wid) || []).map(p => ({ lat: p.lat, lon: p.lon })),
          tags: wayTags?.get(wid) || {}
        })),
      taggedNodes
    };

    // ── 10c. Compute real corridor bbox and buffer polygon ───────────────────
    // The corridorBbox should be a tight bounding box around the actual main
    // centerline coordinates + 200m margin. This replaces the preliminary bbox
    // that was set from the search area at /confirm time.
    const CORRIDOR_MARGIN = 200 / 111320; // 200m in degrees
    const BUFFER_MARGIN = 1000 / 111320;  // 1km in degrees

    let clMinLat = Infinity, clMaxLat = -Infinity;
    let clMinLon = Infinity, clMaxLon = -Infinity;
    for (const pt of rawCoords) {
      if (pt.lat < clMinLat) clMinLat = pt.lat;
      if (pt.lat > clMaxLat) clMaxLat = pt.lat;
      if (pt.lon < clMinLon) clMinLon = pt.lon;
      if (pt.lon > clMaxLon) clMaxLon = pt.lon;
    }

    const corridorBbox = {
      minLat: clMinLat - CORRIDOR_MARGIN,
      maxLat: clMaxLat + CORRIDOR_MARGIN,
      minLon: clMinLon - CORRIDOR_MARGIN,
      maxLon: clMaxLon + CORRIDOR_MARGIN
    };

    // Build a simplified buffer polygon ~1km either side of the centerline.
    // Sample the centerline at ~500m intervals and offset each point ±1km
    // perpendicular to the track direction, forming a left and right boundary.
    const bufferPolygon = (() => {
      const SAMPLE_INTERVAL = 500; // metres
      const OFFSET_M = 1000; // 1km
      const pts = finalPoints;
      if (pts.length < 2) return [];

      const left = [];
      const right = [];
      let accumulated = 0;
      let lastSampled = 0;

      for (let i = 0; i < pts.length; i++) {
        if (i > 0) {
          accumulated += distanceMetres(
            pts[i - 1].latitude, pts[i - 1].longitude,
            pts[i].latitude, pts[i].longitude
          );
        }
        if (i > 0 && i < pts.length - 1 && (accumulated - lastSampled) < SAMPLE_INTERVAL) continue;
        lastSampled = accumulated;

        // Compute bearing from prev→next (or edge points)
        const prev = pts[Math.max(0, i - 1)];
        const next = pts[Math.min(pts.length - 1, i + 1)];
        const dLat = next.latitude - prev.latitude;
        const dLon = next.longitude - prev.longitude;
        const len = Math.sqrt(dLat * dLat + dLon * dLon);
        if (len === 0) continue;

        // Perpendicular unit vector (rotated 90°)
        const perpLat = -dLon / len;
        const perpLon = dLat / len;

        // Offset in degrees (approximate, adequate at this scale)
        const offsetDeg = OFFSET_M / 111320;
        left.push([
          pts[i].latitude + perpLat * offsetDeg,
          pts[i].longitude + perpLon * offsetDeg
        ]);
        right.push([
          pts[i].latitude - perpLat * offsetDeg,
          pts[i].longitude - perpLon * offsetDeg
        ]);
      }

      // Form closed polygon: left forward, right reversed
      return left.concat(right.reverse());
    })();

    if (progressCallback) progressCallback(100, 'Complete!');

    return {
      filePath,
      pointCount: finalPoints.length,
      lengthKm: totalKm,
      wayCount: splitWayIds.length,
      alternativeCount: alternativeRoutes.length,
      alternativeFiles,
      warnings,
      infraTopology,
      corridorBbox,
      bufferPolygon
    };

  } catch (error) {
    console.error(`[Geometry Generator] Failed: ${error.message}`);
    throw error;
  }
}

/**
 * Generate a geometry CSV for one alternative route.
 */
async function generateAlternativeGeometry(segmentLabel, alternative, altNumber, outputDir, spacingMetres, warnings) {
  const safeName = segmentLabel.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const altLabel = `${segmentLabel}_alt${altNumber}`;
  const altSafeName = `${safeName}_alt${altNumber}`;

  // Convert to GeoPoints, spline, resample
  const rawPoints = alternative.coords.map(c => {
    const pt = new GeoPoint(c.lat, c.lon, 0);
    pt.section = altLabel;
    return pt;
  });

  const processedPoints = processTrackPoints(rawPoints, spacingMetres);

  // Elevation
  try {
    const elevPts = processedPoints.map(pt => ({ lat: pt.latitude, lon: pt.longitude }));
    const elevResults = await fetchElevations(elevPts);
    for (let i = 0; i < processedPoints.length; i++) {
      processedPoints[i].altitude = elevResults[i].elevation;
    }
  } catch (_) {
    for (const pt of processedPoints) pt.altitude = 0;
  }

  // Chainage
  let totalKm = 0;
  processedPoints[0].chainage = 0;
  for (let i = 1; i < processedPoints.length; i++) {
    totalKm += distanceMetres(
      processedPoints[i - 1].latitude, processedPoints[i - 1].longitude,
      processedPoints[i].latitude, processedPoints[i].longitude
    ) / 1000;
    processedPoints[i].chainage = totalKm;
  }

  // Write CSV
  const filePath = path.join(outputDir, `${altSafeName}.csv`);
  const lines = ['#region name,latitude,longitude,elevation,kilometerage'];
  for (const pt of processedPoints) {
    lines.push(
      `${altLabel},${pt.latitude.toFixed(8)},${pt.longitude.toFixed(8)},` +
      `${pt.altitude.toFixed(2)},${pt.chainage.toFixed(5)}`
    );
  }
  await fs.writeFile(filePath, lines.join('\n') + '\n', 'utf-8');

  warnings.push(
    `Alternative route ${altNumber}: ${alternative.lengthKm.toFixed(2)} km, ` +
    `${alternative.wayIds.length} ways, max deviation ${alternative.maxDeviationM.toFixed(0)}m` +
    (alternative.reconverged ? ` (reconverges)` : ` (branch)`)
  );

  console.log(`[Geometry Generator] Wrote alt route ${altNumber}: ${filePath} (${totalKm.toFixed(2)} km)`);
  return filePath;
}
