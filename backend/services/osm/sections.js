/**
 * OSM Railway Sections Discovery Service
 * Finds railway route relations and named ways within specified bounding boxes
 * 
 * Algorithm:
 * 1. Query Overpass for railway route relations in bbox (route=railway, route=train)
 * 2. Query for named railway ways as fallback
 * 3. Deduplicate bidirectional routes (e.g., "Lucca - Viareggio" ↔ "Viareggio - Lucca")
 * 4. Return candidate sections with OSM IDs, names, operators, and contained way IDs
 * 
 * Ported from: Traxim-MCP-Servers/traxim-input-creator-mcp/tools/geography.js
 */

import { overpassFetch } from './overpass.js';

/**
 * Normalize route name for bidirectional deduplication
 * Examples:
 *   "Lucca - Viareggio" → "Lucca – Viareggio"
 *   "Viareggio - Lucca" → "Lucca – Viareggio"
 * 
 * @param {string} name - Route name
 * @returns {string} - Normalized name (sorted alphabetically)
 */
export function normaliseRouteName(name) {
  if (!name) return '';
  
  // Split on various dash separators
  const dashVariants = [' - ', ' – ', ' — ', '-', '–', '—'];
  let parts = [name];
  
  for (const dash of dashVariants) {
    if (name.includes(dash)) {
      parts = name.split(dash).map(p => p.trim());
      break;
    }
  }
  
  if (parts.length < 2) return name; // Not a bidirectional route
  
  // Sort alphabetically and rejoin with canonical separator
  parts.sort();
  return parts.join(' – ');
}

/**
 * Query railway sections within bounding boxes
 * 
 * @param {Array<{minLat, minLon, maxLat, maxLon}>} bboxes - Bounding boxes to search
 * @returns {Promise<Array<{
 *   osmId: string,
 *   osmType: string,
 *   name: string,
 *   type: string,
 *   operator: string,
 *   ref: string,
 *   wayIds: Array<string>,
 *   segmentIndices: Array<number>,
 *   altOsmId?: string,
 *   geometry: Array<Array<[number, number]>>
 * }>>}
 */
export async function queryRailwaySections(bboxes) {
  console.log(`[Railway Sections] Querying ${bboxes.length} bounding boxes`);
  
  // ── Query each bbox individually to track which relations appear in which bbox ──
  // This is essential so that segmentIndices accurately records which segments
  // each relation actually intersects (rather than assuming all-to-all).
  const elemBboxIndices = new Map(); // osmId → Set<bboxIndex>
  const allElements = new Map();     // osmId → element (deduplicated)
  
  let failedBboxCount = 0;

  for (let bboxIdx = 0; bboxIdx < bboxes.length; bboxIdx++) {
    const bbox = bboxes[bboxIdx];
    const bboxStr = `${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon}`;
    
    const query = `
      [out:json][timeout:30];
      (
        relation["route"="railway"]["name"](${bboxStr});
        relation["route"="train"]["name"](${bboxStr});
      );
      out;
      >;
      out skel qt;
    `;
    
    try {
      const data = await overpassFetch(query, 30, 2);
      
      for (const el of (data.elements ?? [])) {
        const elId = String(el.id);
        
        if (!elemBboxIndices.has(elId)) elemBboxIndices.set(elId, new Set());
        elemBboxIndices.get(elId).add(bboxIdx);
        
        // Store the element itself (first occurrence wins; they're identical)
        if (!allElements.has(elId)) allElements.set(elId, el);
      }
    } catch (e) {
      console.warn(`[Railway Sections] Bbox ${bboxIdx} query failed: ${e.message}`);
      failedBboxCount++;
      // Continue with other bboxes rather than failing entirely
    }
  }
  
  // Separate relations and ways from collected elements
  const relations = [];
  const ways = [];
  for (const el of allElements.values()) {
    if (el.type === 'relation') relations.push(el);
    else if (el.type === 'way') ways.push(el);
  }

  console.log(`[Railway Sections] Found ${relations.length} relations, ${ways.length} ways`);

  // Build section candidates map (for deduplication)
  const sectionMap = new Map(); // normalized name → section data
  
  // Process route relations
  for (const rel of relations) {
    const name = rel.tags?.name;
    const routeType = rel.tags?.route; // "railway" or "train"
    
    if (!name) continue;
    
    // Extract way IDs from relation members
    const wayIds = (rel.members || [])
      .filter(m => m.type === 'way')
      .map(m => String(m.ref));
    
    if (wayIds.length === 0) continue;
    
    // Use the tracked bbox intersections for accurate segmentIndices
    const relId = String(rel.id);
    const segmentIndices = Array.from(elemBboxIndices.get(relId) ?? []).sort((a, b) => a - b);
    
    const section = {
      osmId: String(rel.id),
      osmType: 'relation',
      name,
      type: routeType,
      operator: rel.tags?.operator || '',
      ref: rel.tags?.ref || '',
      wayIds,
      segmentIndices
      // geometry is attached below, after dedup, via a dedicated fetch —
      // see "Fetch preview geometry" near the end of this function.
    };
    
    // Bidirectional deduplication
    const normalisedName = normaliseRouteName(name);
    const existing = sectionMap.get(normalisedName);
    
    if (existing) {
      // Merge segmentIndices from both relations (they may cover different bboxes)
      const mergedIndices = [...new Set([...existing.segmentIndices, ...section.segmentIndices])].sort((a, b) => a - b);
      
      // Duplicate found: prefer route=railway over route=train
      if (routeType === 'railway' && existing.type === 'train') {
        // Replace the train route with railway route, store train as altOsmId
        section.altOsmId = existing.osmId;
        section.segmentIndices = mergedIndices;
        sectionMap.set(normalisedName, section);
        console.log(`[Railway Sections] Replaced "${name}" (train) with (railway)`);
      } else if (routeType === 'train' && existing.type === 'railway') {
        // Keep existing railway route, store this train as altOsmId
        existing.altOsmId = section.osmId;
        existing.segmentIndices = mergedIndices;
        console.log(`[Railway Sections] Kept "${existing.name}" (railway), stored train as altOsmId`);
      } else {
        // Both are same type: store as altOsmId (arbitrary choice for deduplication)
        existing.altOsmId = section.osmId;
        existing.segmentIndices = mergedIndices;
        console.log(`[Railway Sections] Deduplicated "${name}" (bidirectional)`);
      }
    } else {
      sectionMap.set(normalisedName, section);
    }
  }
  
  // Process standalone named ways (fallback when no route relations exist)
  for (const way of ways) {
    const name = way.tags?.name;
    const railway = way.tags?.railway;
    
    if (!name || !railway) continue;
    
    // Skip if we already have a route relation for this name
    const normalisedName = normaliseRouteName(name);
    if (sectionMap.has(normalisedName)) continue;
    
    const section = {
      osmId: String(way.id),
      osmType: 'way',
      name,
      type: railway, // e.g., "rail", "light_rail", "subway"
      operator: way.tags?.operator || '',
      ref: way.tags?.ref || '',
      wayIds: [String(way.id)],
      segmentIndices: Array.from(elemBboxIndices.get(String(way.id)) ?? [0]).sort((a, b) => a - b)
    };
    
    sectionMap.set(normalisedName, section);
  }
  
  const sections = Array.from(sectionMap.values());
  console.log(`[Railway Sections] Returning ${sections.length} candidate sections (after deduplication)`);

  // ── Fetch preview geometry for the final section list ──────────────────────
  // Deliberately a separate pass, using only the wayIds already settled on
  // above, rather than reusing tags from the discovery query. The discovery
  // query strips tags from recursed-down ways (`out skel qt;`) — switching it
  // to `out geom qt;` to get geometry inline was tried and reverted, because it
  // also un-stripped tags, which reactivated the "standalone named way"
  // fallback below for essentially every individually-named tunnel/viaduct/track
  // in the corridor (Italian rail mapping names each one), flooding the
  // candidate list with ~150 bogus entries. Fetching geometry separately, by ID,
  // keeps section discovery untouched and only adds the map-preview lines.
  // Chunk boundaries are aligned to section boundaries — a chunk never mixes
  // ways from two different sections unless one section alone exceeds CHUNK
  // (unavoidable then). Overpass is often unstable enough that some chunks
  // fail outright; with boundary-aligned chunks, a failure means "this section
  // has no preview line" rather than "this section has a partial, broken one"
  // (confirmed live: flat chunking split a section's ways across a chunk
  // boundary, and when one of the two chunks failed, that section rendered
  // with only some of its ways).
  const CHUNK = 500;
  const wayIdChunks = [];
  const seenWayIds = new Set(); // a way can appear in >1 section (e.g. shared track); fetch it once
  let currentChunk = [];

  for (const section of sections) {
    const newWayIds = section.wayIds.filter(wid => !seenWayIds.has(wid));
    newWayIds.forEach(wid => seenWayIds.add(wid));
    if (newWayIds.length === 0) continue;

    if (currentChunk.length > 0 && currentChunk.length + newWayIds.length > CHUNK) {
      wayIdChunks.push(currentChunk);
      currentChunk = [];
    }

    if (newWayIds.length > CHUNK) {
      // This one section alone exceeds the chunk size — split internally,
      // but still never merged with a neighboring section's ways.
      for (let i = 0; i < newWayIds.length; i += CHUNK) {
        wayIdChunks.push(newWayIds.slice(i, i + CHUNK));
      }
    } else {
      currentChunk.push(...newWayIds);
    }
  }
  if (currentChunk.length > 0) wayIdChunks.push(currentChunk);

  if (wayIdChunks.length > 0) {
    const wayGeometry = new Map();
    for (let i = 0; i < wayIdChunks.length; i++) {
      const chunk = wayIdChunks[i];
      try {
        const geomData = await overpassFetch(`way(id:${chunk.join(',')});\nout geom;`, 30, 2);
        for (const el of (geomData.elements ?? [])) {
          if (el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length >= 2) {
            wayGeometry.set(String(el.id), el.geometry.map(pt => [pt.lat, pt.lon]));
          }
        }
      } catch (e) {
        console.warn(`[Railway Sections] Preview geometry chunk ${i + 1}/${wayIdChunks.length} failed: ${e.message}`);
        // Non-fatal — affected sections just render without a map preview line.
      }
    }

    for (const section of sections) {
      section.geometry = section.wayIds.map(wid => wayGeometry.get(wid)).filter(Boolean);
    }
  } else {
    for (const section of sections) section.geometry = [];
  }

  return { sections, failedBboxCount, totalBboxCount: bboxes.length };
}

/**
 * Get detailed section information for selected sections
 * (This function can be expanded in the future to fetch full geometry, elevation, etc.)
 * 
 * @param {Array<{osmId: string, osmType: string}>} selectedSections 
 * @returns {Promise<Array>}
 */
export async function getSelectedSectionDetails(selectedSections) {
  console.log(`[Railway Sections] Fetching details for ${selectedSections.length} selected sections`);
  
  // For now, return as-is (geometry processing happens in separate service)
  // Future: Could fetch full way geometries, station nodes, etc.
  
  return selectedSections;
}
