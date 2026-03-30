/**
 * OSM Geometry Fetcher
 * Queries Overpass API for full way geometries based on confirmed railway sections.
 *
 * Ported from: Traxim-MCP-Servers/traxim-input-creator-mcp/tools/geography.js
 *
 * Key features:
 *  - Relation family expansion (route_master → sibling sub-relations)
 *  - altOsmId merging (bidirectional pair union)
 *  - Centerline-first buffer approach (100m corridor around actual route path)
 *  - Corridor bbox filtering (discard ways outside the section's corridor)
 *  - Supplemental siding fetch (safety net for service=siding ways)
 *  - Tagged railway node fetch (switches, crossovers, buffer_stops)
 */

import { overpassFetch } from './overpass.js';
import { ipv4Fetch } from './ipv4fetch.js';

// ── Helper: Build centerline from a set of ways ──────────────────────────────

/**
 * Build a centerline from a set of ways by chaining them into a continuous path.
 * Simplified version for computing buffer corridors — skips parallel-track
 * deduplication. Handles disconnected segments and branching.
 *
 * @param {string[]} wayIds
 * @param {Map} wayGeometry  wayId → [{lat,lon}, ...]
 * @returns {{lat:number,lon:number}[]}
 */
function buildCenterlineFromWays(wayIds, wayGeometry) {
  if (wayIds.length === 0) return [];

  const endpointMap = new Map(); // endpoint key → way IDs that touch it

  for (const wid of wayIds) {
    const pts = wayGeometry.get(wid);
    if (!pts || pts.length < 2) continue;

    const start = `${pts[0].lat.toFixed(6)},${pts[0].lon.toFixed(6)}`;
    const end = `${pts.at(-1).lat.toFixed(6)},${pts.at(-1).lon.toFixed(6)}`;

    if (!endpointMap.has(start)) endpointMap.set(start, []);
    if (!endpointMap.has(end)) endpointMap.set(end, []);
    endpointMap.get(start).push(wid);
    endpointMap.get(end).push(wid);
  }

  const visited = new Set();
  const allCoords = [];

  function traverseComponent(startWay) {
    const coords = [];

    function traverse(wid, reversed) {
      if (visited.has(wid)) return;
      visited.add(wid);

      const pts = wayGeometry.get(wid);
      if (!pts || pts.length < 2) return;

      const wayCoords = reversed ? pts.slice().reverse() : pts.slice();

      if (coords.length > 0) {
        const lastCoord = coords[coords.length - 1];
        if (Math.abs(lastCoord.lat - wayCoords[0].lat) < 0.00001 &&
            Math.abs(lastCoord.lon - wayCoords[0].lon) < 0.00001) {
          wayCoords.shift();
        }
      }
      coords.push(...wayCoords);

      const endPt = coords[coords.length - 1];
      const endKey = `${endPt.lat.toFixed(6)},${endPt.lon.toFixed(6)}`;
      const neighbors = (endpointMap.get(endKey) || []).filter(id => !visited.has(id));

      for (const nextId of neighbors) {
        const nextPts = wayGeometry.get(nextId);
        if (!nextPts) continue;

        const nextEnd = nextPts[nextPts.length - 1];
        const endKeyNext = `${nextEnd.lat.toFixed(6)},${nextEnd.lon.toFixed(6)}`;

        const nextReversed = (endKeyNext === endKey);
        traverse(nextId, nextReversed);
      }
    }

    traverse(startWay, false);
    return coords;
  }

  for (const wid of wayIds) {
    if (!visited.has(wid)) {
      const componentCoords = traverseComponent(wid);
      allCoords.push(...componentCoords);
    }
  }

  return allCoords;
}

// ── Helper: Compute tight bounding box around centerline ─────────────────────

/**
 * @param {{lat:number,lon:number}[]} coords
 * @param {number} margin  Margin in degrees (0.001 ≈ 111m)
 * @returns {{minLat:number, minLon:number, maxLat:number, maxLon:number}}
 */
function computeBufferBbox(coords, margin) {
  if (coords.length === 0) return { minLat: 0, minLon: 0, maxLat: 0, maxLon: 0 };

  let minLat = Infinity, maxLat = -Infinity;
  let minLon = Infinity, maxLon = -Infinity;

  for (const pt of coords) {
    if (pt.lat < minLat) minLat = pt.lat;
    if (pt.lat > maxLat) maxLat = pt.lat;
    if (pt.lon < minLon) minLon = pt.lon;
    if (pt.lon > maxLon) maxLon = pt.lon;
  }

  return {
    minLat: minLat - margin,
    minLon: minLon - margin,
    maxLat: maxLat + margin,
    maxLon: maxLon + margin
  };
}

// ── Helper: Check if a way is near the centerline ────────────────────────────

/**
 * @param {{lat:number,lon:number}[]} wayPoints
 * @param {{lat:number,lon:number}[]} centerline
 * @param {number} maxDistDeg  Maximum distance in degrees (0.001° ≈ 111m)
 * @returns {boolean}
 */
function isWayNearCenterline(wayPoints, centerline, maxDistDeg) {
  if (!wayPoints || wayPoints.length === 0 || centerline.length === 0) return false;

  // Sample a few points from the way (not every point for performance)
  const samplePoints = [];
  const step = Math.max(1, Math.floor(wayPoints.length / 10));
  for (let i = 0; i < wayPoints.length; i += step) {
    samplePoints.push(wayPoints[i]);
  }
  if (wayPoints.length > 1) {
    samplePoints.push(wayPoints[wayPoints.length - 1]);
  }

  const maxDistSq = maxDistDeg * maxDistDeg;

  for (const wayPt of samplePoints) {
    const cosLat = Math.cos(wayPt.lat * Math.PI / 180);
    for (const centerPt of centerline) {
      const latDiff = wayPt.lat - centerPt.lat;
      const lonDiff = (wayPt.lon - centerPt.lon) * cosLat;
      if (latDiff * latDiff + lonDiff * lonDiff <= maxDistSq) {
        return true;
      }
    }
  }

  return false;
}

// ══════════════════════════════════════════════════════════════════════════════
// Main export: fetchSectionGeometryFromOSM
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch geometry for a railway section using the centerline-first buffer approach.
 *
 * Process:
 *   1. Get way IDs from relation (with family expansion) + altOsmId union
 *   2. Build preliminary centerline from those ways
 *   3. Query ALL railway ways within 100m buffer of centerline
 *   4. Filter locally by distance to centerline
 *   5. Fetch full geometry + node IDs for the merged way set
 *   6. Apply corridor bbox filtering
 *   7. Supplemental siding fetch
 *
 * @param {{osmId: string, osmType: string, name: string, altOsmId?: string, corridorBbox?: object}} section
 * @param {{minLat, minLon, maxLat, maxLon}} bbox
 * @returns {Promise<{wayIds: string[], wayGeometry: Map<string, Array<{lat,lon}>>, wayNodes: Map<string, Array<string>>}>}
 */
export async function fetchSectionGeometryFromOSM(section, bbox) {
  console.log(`[OSM Geometry] Fetching geometry for section: ${section.name} (${section.osmType} ${section.osmId})`);

  const bboxStr = `${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon}`;

  // ── Step 1: Get way IDs ────────────────────────────────────────────────────
  let wayIds = [];

  if (section.osmType === 'relation' && section.osmId) {
    // Relation family expansion: climb to parent route_master, descend to all siblings
    try {
      const relData = await overpassFetch(
        `[out:json][timeout:20];\nrelation(${section.osmId});\n(._; <;);\n(._; rel(r););\nway(r);\nout ids;`,
        20, 2
      );
      wayIds = (relData.elements ?? []).filter(e => e.type === 'way').map(e => String(e.id));
      console.log(`[OSM Geometry] Relation family query: ${wayIds.length} ways`);
    } catch (overpassErr) {
      // Fallback: OSM API direct members
      console.warn(`[OSM Geometry] Relation family query failed, trying OSM API fallback: ${overpassErr.message}`);
      try {
        const res = await ipv4Fetch(
          `https://api.openstreetmap.org/api/0.6/relation/${section.osmId}.json`,
          { socketTimeout: 15000, headers: { 'User-Agent': 'TraximCenterlineTools/1.0 (traximrail.com)' } }
        );
        const data = await res.json();
        const rel = (data.elements ?? []).find(el => el.type === 'relation');
        wayIds = (rel?.members ?? []).filter(m => m.type === 'way').map(m => String(m.ref));
        console.log(`[OSM Geometry] OSM API fallback: ${wayIds.length} ways`);
      } catch (apiErr) {
        console.error(`[OSM Geometry] Both Overpass and OSM API failed: ${apiErr.message}`);
        throw new Error(`Cannot fetch section ${section.osmId}: ${apiErr.message}`);
      }
    }

    // ── altOsmId merging (bidirectional pair) ─────────────────────────────────
    if (section.altOsmId) {
      try {
        const altData = await overpassFetch(
          `[out:json][timeout:20];\nrelation(${section.altOsmId});\n(._; <;);\n(._; rel(r););\nway(r);\nout ids;`,
          20, 2
        );
        const altWayIds = (altData.elements ?? []).filter(e => e.type === 'way').map(e => String(e.id));
        if (altWayIds.length > 0) {
          const before = wayIds.length;
          wayIds = [...new Set([...wayIds, ...altWayIds])];
          console.log(`[OSM Geometry] altOsmId ${section.altOsmId}: +${wayIds.length - before} ways (${altWayIds.length} total in alt)`);
        }
      } catch (_) {
        console.warn(`[OSM Geometry] altOsmId query failed — proceeding with primary ways`);
      }
    }

    // ── Centerline-first buffer corridor ─────────────────────────────────────
    const CENTERLINE_THRESHOLD = 20;

    if (wayIds.length >= CENTERLINE_THRESHOLD) {
      try {
        // Fetch preliminary geometry for relation ways
        console.log(`[OSM Geometry] Building centerline from ${wayIds.length} relation ways...`);
        const prelimGeometry = new Map();
        const CHUNK = 500;
        for (let i = 0; i < wayIds.length; i += CHUNK) {
          const chunk = wayIds.slice(i, i + CHUNK);
          const idList = chunk.join(',');
          const geoData = await overpassFetch(
            `[out:json][timeout:20];\nway(id:${idList});\nout geom;`,
            20, 2
          );
          for (const el of (geoData.elements ?? [])) {
            if (el.type === 'way' && Array.isArray(el.geometry)) {
              prelimGeometry.set(String(el.id), el.geometry);
            }
          }
        }
        console.log(`[OSM Geometry] Fetched preliminary geometry for ${prelimGeometry.size} ways`);

        // Build centerline
        const centerline = buildCenterlineFromWays(wayIds, prelimGeometry);
        console.log(`[OSM Geometry] Built centerline with ${centerline.length} coordinates`);

        if (centerline.length >= 2) {
          // Compute 100m buffer bbox (0.001° ≈ 111m)
          const bufferBbox = computeBufferBbox(centerline, 0.001);
          const bStr = `${bufferBbox.minLat},${bufferBbox.minLon},${bufferBbox.maxLat},${bufferBbox.maxLon}`;
          console.log(`[OSM Geometry] Buffer bbox: (${bufferBbox.minLat.toFixed(4)}, ${bufferBbox.minLon.toFixed(4)}) to (${bufferBbox.maxLat.toFixed(4)}, ${bufferBbox.maxLon.toFixed(4)})`);

          // Query ALL railway ways within rectangular bbox
          const bufferData = await overpassFetch(
            `[out:json][timeout:20];\nway["railway"="rail"]["usage"!="industrial"](${bStr});\nout geom;`,
            20, 2
          );
          console.log(`[OSM Geometry] Found ${(bufferData.elements ?? []).length} ways in buffer bbox`);

          // Filter locally — keep only ways within 100m of centerline
          const bufferWayIds = [];
          const MAX_DIST = 0.001; // 0.001° ≈ 111m

          for (const el of (bufferData.elements ?? [])) {
            if (el.type === 'way' && Array.isArray(el.geometry)) {
              const elId = String(el.id);
              if (wayIds.includes(elId)) continue; // already in relation set

              if (isWayNearCenterline(el.geometry, centerline, MAX_DIST)) {
                bufferWayIds.push(elId);
              }
            }
          }

          if (bufferWayIds.length > 0) {
            const originalCount = wayIds.length;
            wayIds = [...new Set([...wayIds, ...bufferWayIds])];
            console.log(`[OSM Geometry] Centerline buffer: ${originalCount} relation + ${bufferWayIds.length} corridor = ${wayIds.length} total`);
          } else {
            console.log(`[OSM Geometry] No additional ways within 100m corridor`);
          }
        }
      } catch (err) {
        console.warn(`[OSM Geometry] Centerline buffer failed: ${err.message} — using relation ways only`);
      }
    } else if (wayIds.length > 0 && wayIds.length < CENTERLINE_THRESHOLD) {
      // Fallback for relations with very few ways: use corridorBbox if available
      if (section.corridorBbox) {
        try {
          const cb = section.corridorBbox;
          const cStr = `${cb.minLat},${cb.minLon},${cb.maxLat},${cb.maxLon}`;
          const corridorData = await overpassFetch(
            `[out:json][timeout:20];\nway["railway"="rail"]["usage"!="industrial"](${cStr});\nout ids;`,
            20, 2
          );
          const corridorWayIds = (corridorData.elements ?? []).filter(e => e.type === 'way').map(e => String(e.id));
          if (corridorWayIds.length > 0) {
            wayIds = [...new Set([...wayIds, ...corridorWayIds])];
            console.log(`[OSM Geometry] corridorBbox fallback: ${wayIds.length} ways total`);
          }
        } catch (_) {
          // corridor search failed — proceed with what we have
        }
      }
    }
  } else {
    // Named way section: search by name across the bbox
    const escaped = section.name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    try {
      const idsData = await overpassFetch(
        `[out:json][timeout:8];\nway["name"="${escaped}"]["railway"~"^(rail|light_rail)$"](${bboxStr});\nout ids;`,
        8, 2
      );
      wayIds = (idsData.elements ?? []).filter(e => e.type === 'way').map(e => String(e.id));
      console.log(`[OSM Geometry] Named way query for "${section.name}": ${wayIds.length} ways`);
    } catch (err) {
      console.error(`[OSM Geometry] Named way query failed: ${err.message}`);
      throw new Error(`Cannot fetch ways for section "${section.name}": ${err.message}`);
    }

    // Apply centerline-first buffer for named way sections too
    const CENTERLINE_THRESHOLD = 20;
    if (wayIds.length >= CENTERLINE_THRESHOLD) {
      try {
        const prelimGeometry = new Map();
        const CHUNK = 500;
        for (let i = 0; i < wayIds.length; i += CHUNK) {
          const chunk = wayIds.slice(i, i + CHUNK);
          const idList = chunk.join(',');
          const geoData = await overpassFetch(
            `[out:json][timeout:20];\nway(id:${idList});\nout geom;`,
            20, 2
          );
          for (const el of (geoData.elements ?? [])) {
            if (el.type === 'way' && Array.isArray(el.geometry)) {
              prelimGeometry.set(String(el.id), el.geometry);
            }
          }
        }

        const centerline = buildCenterlineFromWays(wayIds, prelimGeometry);
        if (centerline.length >= 2) {
          const bufferBbox = computeBufferBbox(centerline, 0.001);
          const bStr = `${bufferBbox.minLat},${bufferBbox.minLon},${bufferBbox.maxLat},${bufferBbox.maxLon}`;

          const bufferData = await overpassFetch(
            `[out:json][timeout:20];\nway["railway"="rail"]["usage"!="industrial"](${bStr});\nout geom;`,
            20, 2
          );

          const bufferWayIds = [];
          const MAX_DIST = 0.001;
          for (const el of (bufferData.elements ?? [])) {
            if (el.type === 'way' && Array.isArray(el.geometry)) {
              const elId = String(el.id);
              if (wayIds.includes(elId)) continue;
              if (isWayNearCenterline(el.geometry, centerline, MAX_DIST)) {
                bufferWayIds.push(elId);
              }
            }
          }

          if (bufferWayIds.length > 0) {
            const originalCount = wayIds.length;
            wayIds = [...new Set([...wayIds, ...bufferWayIds])];
            console.log(`[OSM Geometry] Named way centerline buffer: ${originalCount} + ${bufferWayIds.length} = ${wayIds.length} total`);
          }
        }
      } catch (err) {
        console.warn(`[OSM Geometry] Named way centerline buffer failed: ${err.message}`);
      }
    }
  }

  if (wayIds.length === 0) {
    return { wayIds: [], wayGeometry: new Map(), wayNodes: new Map() };
  }

  // ── Step 2: Fetch full way geometry + node IDs ─────────────────────────────
  // `out body geom;` returns both inline {lat,lon} geometry AND node IDs
  const CHUNK = 500;
  const wayGeometry = new Map();
  const wayNodes = new Map();

  for (let i = 0; i < wayIds.length; i += CHUNK) {
    const chunk = wayIds.slice(i, i + CHUNK);
    const idList = chunk.join(',');
    const geoData = await overpassFetch(
      `[out:json][timeout:22];\nway(id:${idList});\nout body geom;`,
      22, 2
    );
    for (const el of (geoData.elements ?? [])) {
      if (el.type === 'way' && Array.isArray(el.geometry)) {
        const elId = String(el.id);
        wayGeometry.set(elId, el.geometry);
        if (Array.isArray(el.nodes)) {
          wayNodes.set(elId, el.nodes.map(String));
        }
      }
    }
  }

  console.log(`[OSM Geometry] Fetched full geometry for ${wayGeometry.size} ways`);

  // ── Step 2b: Corridor bbox filtering ───────────────────────────────────────
  // Discard any way whose geometry lies entirely outside the corridor bbox.
  if (section.corridorBbox && wayGeometry.size > 0) {
    const cb = section.corridorBbox;
    for (const [wid, pts] of wayGeometry.entries()) {
      const inCorridor = pts.some(
        (p) => p.lat >= cb.minLat && p.lat <= cb.maxLat &&
               p.lon >= cb.minLon && p.lon <= cb.maxLon
      );
      if (!inCorridor) {
        wayGeometry.delete(wid);
        wayNodes.delete(wid);
      }
    }
    const filteredIds = wayIds.filter(wid => wayGeometry.has(wid));
    const removed = wayIds.length - filteredIds.length;
    if (removed > 0) {
      console.log(`[OSM Geometry] Corridor filter removed ${removed} out-of-corridor ways`);
    }
    wayIds = filteredIds;
  }

  // ── Step 2c: Supplemental siding fetch ─────────────────────────────────────
  // Safety net: query specifically for service=siding ways near the route
  if (wayGeometry.size > 0) {
    try {
      let sMinLat = Infinity, sMaxLat = -Infinity;
      let sMinLon = Infinity, sMaxLon = -Infinity;
      for (const pts of wayGeometry.values()) {
        for (const p of pts) {
          if (p.lat < sMinLat) sMinLat = p.lat;
          if (p.lat > sMaxLat) sMaxLat = p.lat;
          if (p.lon < sMinLon) sMinLon = p.lon;
          if (p.lon > sMaxLon) sMaxLon = p.lon;
        }
      }
      const margin = 0.01; // ~1km
      const sStr = `${sMinLat - margin},${sMinLon - margin},${sMaxLat + margin},${sMaxLon + margin}`;
      const sidingData = await overpassFetch(
        `[out:json][timeout:30];\nway["railway"="rail"]["service"="siding"](${sStr});\nout body geom;`,
        30, 2
      );
      let addedSidings = 0;
      for (const el of (sidingData.elements ?? [])) {
        if (el.type === 'way' && Array.isArray(el.geometry)) {
          const elId = String(el.id);
          if (wayGeometry.has(elId)) continue;

          // Apply corridorBbox filter if available
          if (section.corridorBbox) {
            const cb = section.corridorBbox;
            const inCorridor = el.geometry.some(
              (p) => p.lat >= cb.minLat && p.lat <= cb.maxLat &&
                     p.lon >= cb.minLon && p.lon <= cb.maxLon
            );
            if (!inCorridor) continue;
          }

          wayGeometry.set(elId, el.geometry);
          if (Array.isArray(el.nodes)) {
            wayNodes.set(elId, el.nodes.map(String));
          }
          wayIds.push(elId);
          addedSidings++;
        }
      }
      if (addedSidings > 0) {
        console.log(`[OSM Geometry] Supplemental siding fetch: +${addedSidings} sidings`);
      }
    } catch (_) {
      // Siding fetch failed — proceed without
    }
  }

  console.log(`[OSM Geometry] Final: ${wayIds.length} ways, ${wayGeometry.size} geometries, ${wayNodes.size} node arrays`);

  return { wayIds, wayGeometry, wayNodes };
}


/**
 * Fetch geometry for a geographic segment (all railway ways in bbox).
 * Simple bbox-only approach — used as fallback when no confirmed sections available.
 *
 * @param {{minLat, minLon, maxLat, maxLon}} bbox
 * @returns {Promise<{wayIds: string[], wayGeometry: Map<string, Array<{lat,lon}>>, wayNodes: Map<string, Array<string>>}>}
 */
export async function fetchSegmentGeometryFromOSM(bbox) {
  console.log(`[OSM Geometry] Fetching all railway ways in segment bbox`);

  const bboxStr = `${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon}`;

  const query = `
    [out:json][timeout:60];
    (
      way["railway"="rail"]["usage"!="industrial"](${bboxStr});
    );
    out body geom;
  `;

  try {
    const data = await overpassFetch(query, 60, 2);

    if (!data.elements || data.elements.length === 0) {
      throw new Error('No railway ways found in segment');
    }

    const wayIds = [];
    const wayGeometry = new Map();
    const wayNodes = new Map();

    for (const el of data.elements) {
      if (el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length >= 2) {
        const elId = String(el.id);
        wayIds.push(elId);
        wayGeometry.set(elId, el.geometry);
        if (Array.isArray(el.nodes)) {
          wayNodes.set(elId, el.nodes.map(String));
        }
      }
    }

    console.log(`[OSM Geometry] Segment: ${wayIds.length} ways, ${wayGeometry.size} geometries`);

    return { wayIds, wayGeometry, wayNodes };

  } catch (error) {
    console.error(`[OSM Geometry] Failed to fetch segment geometry: ${error.message}`);
    throw error;
  }
}

/**
 * Fetch geometry for a segment using relation-based queries (the correct multi-phase approach).
 *
 * Sequence:
 *   1. Use confirmed section relations to get way IDs (not bbox-bounded)
 *   1b. Pre-filter relation ways to segment corridor (~5km margin)
 *   2. Fetch preliminary geometry for relation ways
 *   3. Build a centerline from relation ways
 *   4+5. Query ALL railway ways in segment corridor (same ~5km bbox as 1b)
 *   6. Merge all ways — relation ways + corridor ways (no filtering/discarding)
 *
 * This gives the downstream algorithms (parallel dedup, alt route detection)
 * the full track graph they need. The centerline from Phase 3 is only used to
 * guide chaining; data is not filtered based on proximity to it.
 *
 * This avoids the problem where a simple rectangle between two endpoint places
 * clips the railway at points where the route curves outside the rectangle
 * (e.g. the Cinque Terre coast between Sestri Levante and La Spezia).
 *
 * Falls back to simple bbox query if no confirmed sections have relations.
 *
 * @param {{minLat, minLon, maxLat, maxLon}} segmentBbox - Original segment bbox (used as fallback)
 * @param {Array<{osmId: string, osmType: string, name: string, altOsmId?: string}>} sections - Confirmed sections covering this segment
 * @returns {Promise<{wayIds: string[], wayGeometry: Map<string, Array<{lat,lon}>>, wayNodes: Map<string, Array<string>>}>}
 */
/**
 * Pre-fetch way IDs for a set of sections' OSM relations in a single pass.
 * Returns a Map<osmId, string[]> that can be passed to fetchSegmentGeometryViaRelations
 * so each per-segment call can skip the Overpass relation queries entirely.
 *
 * @param {Array<{osmId: string, osmType: string, name: string, altOsmId?: string}>} sections
 * @returns {Promise<Map<string, string[]>>}  osmId (or altOsmId) → way ID array
 */
export async function prefetchRelationWayIds(sections) {
  const cache = new Map(); // osmId → string[]

  // Deduplicate relation IDs across all sections
  const toFetch = new Set();
  for (const s of sections) {
    if (s.osmType === 'relation' && s.osmId) toFetch.add(s.osmId);
    if (s.altOsmId) toFetch.add(s.altOsmId);
  }

  console.log(`[OSM Geometry] Pre-fetching way IDs for ${toFetch.size} unique relation(s)`);

  for (const relId of toFetch) {
    try {
      const relData = await overpassFetch(
        `[out:json][timeout:20];\nrelation(${relId});\n(._; <;);\n(._; rel(r););\nway(r);\nout ids;`,
        20, 2
      );
      const wayIds = (relData.elements ?? []).filter(e => e.type === 'way').map(e => String(e.id));
      console.log(`[OSM Geometry] Pre-fetch relation ${relId}: ${wayIds.length} ways`);
      cache.set(relId, wayIds);
    } catch (err) {
      console.warn(`[OSM Geometry] Pre-fetch relation ${relId} failed: ${err.message} — trying OSM API`);
      try {
        const res = await ipv4Fetch(
          `https://api.openstreetmap.org/api/0.6/relation/${relId}.json`,
          { socketTimeout: 15000, headers: { 'User-Agent': 'TraximCenterlineTools/1.0 (traximrail.com)' } }
        );
        const data = await res.json();
        const rel = (data.elements ?? []).find(el => el.type === 'relation');
        const wayIds = (rel?.members ?? []).filter(m => m.type === 'way').map(m => String(m.ref));
        cache.set(relId, wayIds);
      } catch (_) {
        console.warn(`[OSM Geometry] Pre-fetch relation ${relId}: both attempts failed — will skip`);
        cache.set(relId, []); // mark as attempted so we don't retry
      }
    }
  }

  return cache;
}

export async function fetchSegmentGeometryViaRelations(segmentBbox, sections, relationWayIdCache = null) {
  console.log(`[OSM Geometry] Relation-based fetch for ${sections.length} confirmed section(s)`);

  // ── Phase 1: Collect way IDs from all relations ───────────────────────────
  const allRelationWayIds = new Set();

  for (const section of sections) {
    if (section.osmType !== 'relation' || !section.osmId) continue;

    // Use pre-fetched cache when available; otherwise query Overpass now
    if (relationWayIdCache?.has(section.osmId)) {
      const cached = relationWayIdCache.get(section.osmId);
      console.log(`[OSM Geometry] Relation ${section.osmId} (${section.name}): ${cached.length} ways (cached)`);
      for (const wid of cached) allRelationWayIds.add(wid);
    } else {
      // Relation family expansion: climb to parent route_master, descend to all siblings
      try {
        const relData = await overpassFetch(
          `[out:json][timeout:20];\nrelation(${section.osmId});\n(._; <;);\n(._; rel(r););\nway(r);\nout ids;`,
          20, 2
        );
        const wayIds = (relData.elements ?? []).filter(e => e.type === 'way').map(e => String(e.id));
        console.log(`[OSM Geometry] Relation ${section.osmId} (${section.name}): ${wayIds.length} ways`);
        for (const wid of wayIds) allRelationWayIds.add(wid);
      } catch (err) {
        console.warn(`[OSM Geometry] Relation ${section.osmId} query failed: ${err.message}`);
        // Fallback: OSM API direct members
        try {
          const res = await ipv4Fetch(
            `https://api.openstreetmap.org/api/0.6/relation/${section.osmId}.json`,
            { socketTimeout: 15000, headers: { 'User-Agent': 'TraximCenterlineTools/1.0 (traximrail.com)' } }
          );
          const data = await res.json();
          const rel = (data.elements ?? []).find(el => el.type === 'relation');
          const wayIds = (rel?.members ?? []).filter(m => m.type === 'way').map(m => String(m.ref));
          for (const wid of wayIds) allRelationWayIds.add(wid);
        } catch (_) {
          // Both failed for this section — continue with others
        }
      }
    }

    // altOsmId (bidirectional pair)
    if (section.altOsmId) {
      if (relationWayIdCache?.has(section.altOsmId)) {
        const cached = relationWayIdCache.get(section.altOsmId);
        console.log(`[OSM Geometry] altOsmId ${section.altOsmId}: ${cached.length} ways (cached)`);
        for (const wid of cached) allRelationWayIds.add(wid);
      } else {
        try {
          const altData = await overpassFetch(
            `[out:json][timeout:20];\nrelation(${section.altOsmId});\n(._; <;);\n(._; rel(r););\nway(r);\nout ids;`,
            20, 2
          );
          const altWayIds = (altData.elements ?? []).filter(e => e.type === 'way').map(e => String(e.id));
          console.log(`[OSM Geometry] altOsmId ${section.altOsmId}: ${altWayIds.length} ways`);
          for (const wid of altWayIds) allRelationWayIds.add(wid);
        } catch (_) {
          console.warn(`[OSM Geometry] altOsmId ${section.altOsmId} query failed`);
        }
      }
    }
  }

  console.log(`[OSM Geometry] Phase 1 complete: ${allRelationWayIds.size} unique relation way IDs`);

  // If no relation ways found, fall back to simple bbox query
  if (allRelationWayIds.size === 0) {
    console.log(`[OSM Geometry] No relation ways found — falling back to bbox query`);
    return fetchSegmentGeometryFromOSM(segmentBbox);
  }

  // ── Phase 1b: Pre-filter relation ways to segment corridor ────────────────
  // Relations often span much longer routes (e.g. Roma → Genova = 2104 ways)
  // but we only need the segment (e.g. Sestri → La Spezia ≈ 200 ways).
  // Fetch way IDs that intersect an expanded segment bbox first, then only
  // fetch full geometry for the intersection.
  // Use a generous margin (~5km) to capture ways that curve outside the
  // tight segment bbox while keeping the query manageable.
  const preFilterMargin = 0.05; // ~5 km
  const preFilterBbox = {
    minLat: segmentBbox.minLat - preFilterMargin,
    maxLat: segmentBbox.maxLat + preFilterMargin,
    minLon: segmentBbox.minLon - preFilterMargin,
    maxLon: segmentBbox.maxLon + preFilterMargin
  };
  const pfStr = `${preFilterBbox.minLat},${preFilterBbox.minLon},${preFilterBbox.maxLat},${preFilterBbox.maxLon}`;

  let segmentRelationWayIds;
  try {
    const pfData = await overpassFetch(
      `[out:json][timeout:20];\nway["railway"="rail"](${pfStr});\nout ids;`,
      20, 2
    );
    const bboxWayIds = new Set(
      (pfData.elements ?? []).filter(e => e.type === 'way').map(e => String(e.id))
    );
    // Intersect: keep only relation ways that exist within the segment corridor
    segmentRelationWayIds = [...allRelationWayIds].filter(wid => bboxWayIds.has(wid));
    console.log(
      `[OSM Geometry] Phase 1b: filtered ${allRelationWayIds.size} relation ways to ` +
      `${segmentRelationWayIds.length} in segment corridor`
    );
  } catch (err) {
    // If pre-filter fails, use all relation ways (original behaviour)
    console.warn(`[OSM Geometry] Phase 1b pre-filter failed: ${err.message} — using all ${allRelationWayIds.size} relation ways`);
    segmentRelationWayIds = [...allRelationWayIds];
  }

  if (segmentRelationWayIds.length === 0) {
    console.warn(`[OSM Geometry] No relation ways intersect segment corridor — falling back to bbox query`);
    return fetchSegmentGeometryFromOSM(segmentBbox);
  }

  // ── Phase 2: Fetch preliminary geometry for segment-filtered relation ways ─
  const prelimGeometry = new Map();
  const CHUNK = 500;

  for (let i = 0; i < segmentRelationWayIds.length; i += CHUNK) {
    const chunk = segmentRelationWayIds.slice(i, i + CHUNK);
    const idList = chunk.join(',');
    try {
      const geoData = await overpassFetch(
        `[out:json][timeout:20];\nway(id:${idList});\nout geom;`,
        20, 2
      );
      for (const el of (geoData.elements ?? [])) {
        if (el.type === 'way' && Array.isArray(el.geometry)) {
          prelimGeometry.set(String(el.id), el.geometry);
        }
      }
    } catch (err) {
      console.warn(`[OSM Geometry] Preliminary geometry chunk ${Math.floor(i / CHUNK) + 1} failed: ${err.message}`);
    }
  }
  console.log(`[OSM Geometry] Phase 2 complete: preliminary geometry for ${prelimGeometry.size} of ${segmentRelationWayIds.length} ways`);

  // ── Phase 3: Build centerline from relation ways ──────────────────────────
  const centerline = buildCenterlineFromWays(segmentRelationWayIds, prelimGeometry);
  console.log(`[OSM Geometry] Phase 3 complete: centerline with ${centerline.length} coordinates`);

  if (centerline.length < 2) {
    console.warn(`[OSM Geometry] Centerline too short — falling back to bbox query`);
    return fetchSegmentGeometryFromOSM(segmentBbox);
  }

  // ── Phase 4+5: Query ALL railway ways in segment corridor ──────────────────
  // Use the same generous bbox as Phase 1b (segmentBbox + ~5km margin) to
  // capture ALL railway ways in the segment area, including diverging routes,
  // tunnels, and connecting ways. This matches the MCP's simple bbox approach.
  // The downstream algorithms (parallel dedup, alt route detection) classify
  // ways — nothing should be discarded here.
  console.log(
    `[OSM Geometry] Phase 4+5: querying ALL rail ways in segment corridor ` +
    `(${preFilterBbox.minLat.toFixed(4)}, ${preFilterBbox.minLon.toFixed(4)}) → ` +
    `(${preFilterBbox.maxLat.toFixed(4)}, ${preFilterBbox.maxLon.toFixed(4)})`
  );

  let bufferElements = [];
  try {
    const bufferData = await overpassFetch(
      `[out:json][timeout:60];\nway["railway"="rail"](${pfStr});\nout body geom;`,
      60, 2
    );
    bufferElements = bufferData.elements ?? [];
    console.log(`[OSM Geometry] Phase 5 complete: ${bufferElements.length} ways in segment corridor`);
  } catch (err) {
    console.warn(`[OSM Geometry] Segment corridor query failed: ${err.message} — using relation ways only`);
  }

  // ── Phase 6: Merge all ways ───────────────────────────────────────────────
  // Include every railway way from the segment corridor query. Alternative
  // route detection (detectAlternativeRoutes) classifies ways as centerline
  // vs. diverging using a 50m threshold. Nothing is discarded.
  const wayIds = [];
  const wayGeometry = new Map();
  const wayNodes = new Map();
  const wayTags = new Map();

  for (const el of bufferElements) {
    if (el.type !== 'way' || !Array.isArray(el.geometry) || el.geometry.length < 2) continue;

    const elId = String(el.id);
    if (!wayGeometry.has(elId)) {
      wayIds.push(elId);
      wayGeometry.set(elId, el.geometry);
      if (Array.isArray(el.nodes)) {
        wayNodes.set(elId, el.nodes.map(String));
      }
      if (el.tags) {
        wayTags.set(elId, el.tags);
      }
    }
  }

  // Also include segment relation ways that weren't in the buffer bbox result
  // (safety net — shouldn't normally happen since buffer bbox covers centerline)
  for (const wid of segmentRelationWayIds) {
    if (wayGeometry.has(wid)) continue;
    const pts = prelimGeometry.get(wid);
    if (pts && pts.length >= 2) {
      wayIds.push(wid);
      wayGeometry.set(wid, pts);
      // No node IDs or tags from preliminary geometry (was `out geom` not `out body geom`)
    }
  }

  console.log(
    `[OSM Geometry] Phase 6 complete: ${wayIds.length} ways total ` +
    `(${segmentRelationWayIds.length} from relations, ${wayIds.length - segmentRelationWayIds.length} additional from segment corridor)`
  );

  return { wayIds, wayGeometry, wayNodes, wayTags };
}


/**
 * Fetch tagged railway junction nodes (switches, crossovers, buffer_stops, crossings)
 *
 * @param {{minLat, minLon, maxLat, maxLon}} bbox
 * @param {{minLat, minLon, maxLat, maxLon}} [corridorBbox]  Tighter bbox if available
 * @returns {Promise<Array<{id: string, lat: number, lon: number, tags: object}>>}
 */
export async function fetchRailwayTaggedNodes(bbox, corridorBbox = null) {
  const effectiveBbox = corridorBbox || bbox;
  const bboxStr = `${effectiveBbox.minLat},${effectiveBbox.minLon},${effectiveBbox.maxLat},${effectiveBbox.maxLon}`;

  console.log(`[OSM Geometry] Fetching tagged junction nodes in ${corridorBbox ? 'corridor' : 'section'} bbox`);

  const query = `
    [out:json][timeout:30];
    (
      node["railway"~"^(switch|railway_crossing|buffer_stop|crossover|signal|level_crossing)$"](${bboxStr});
    );
    out body;
  `;

  try {
    const data = await overpassFetch(query, 30, 1);

    const taggedNodes = (data.elements || [])
      .filter(el => el.type === 'node' && el.lat && el.lon)
      .map(el => ({
        id: String(el.id),
        lat: el.lat,
        lon: el.lon,
        tags: el.tags || {}
      }));

    console.log(`[OSM Geometry] Found ${taggedNodes.length} tagged junction nodes`);
    return taggedNodes;

  } catch (error) {
    console.warn(`[OSM Geometry] Failed to fetch tagged nodes: ${error.message}`);
    return [];
  }
}
