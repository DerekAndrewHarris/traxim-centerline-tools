/**
 * Geometry Processing Service
 * Handles parallel track deduplication, way chaining, and centerline generation
 * 
 * Key algorithms ported from Traxim-MCP-Servers geometry.js
 */

// Configuration constants
const COORD_PRECISION = 7; // Degrees (~1cm precision for OSM nodes)
const PARALLEL_THRESHOLD_M = 20; // Metres - parallel track detection threshold

/**
 * Convert coordinate to string key for exact endpoint matching
 * @param {{lat: number, lon: number}} pt 
 * @returns {string}
 */
export function coordKey(pt) {
  return `${pt.lat.toFixed(COORD_PRECISION)},${pt.lon.toFixed(COORD_PRECISION)}`;
}

/**
 * Build endpoint index: coordinate key → Set of way IDs
 * @param {string[]} wayIds 
 * @param {Map<string, Array<{lat,lon}>>} wayGeometry 
 * @returns {Map<string, Set<string>>}
 */
export function buildEndpointIndex(wayIds, wayGeometry) {
  const index = new Map();
  
  for (const wid of wayIds) {
    const pts = wayGeometry.get(wid);
    if (!pts || pts.length < 2) continue;
    
    const keys = [coordKey(pts[0]), coordKey(pts[pts.length - 1])];
    for (const key of keys) {
      if (!index.has(key)) {
        index.set(key, new Set());
      }
      index.get(key).add(wid);
    }
  }
  
  console.log(`[Geometry Processor] Built endpoint index: ${index.size} unique endpoints`);
  return index;
}

/**
 * Assign parallel groups to ways
 * Ways with same endpoints and close proximity get same group ID
 * 
 * @param {string[]} wayIds 
 * @param {Map<string, Array<{lat,lon}>>} wayGeometry 
 * @param {Map<string, Set<string>>} endpointIndex 
 * @returns {Map<string, number>}
 */
export function assignParallelGroups(wayIds, wayGeometry, endpointIndex) {
  const groups = new Map(); // wayId → groupId
  let nextGroupId = 0;
  
  for (const wid of wayIds) {
    if (groups.has(wid)) continue;
    
    const pts = wayGeometry.get(wid);
    if (!pts || pts.length < 2) continue;
    
    const startKey = coordKey(pts[0]);
    const endKey = coordKey(pts[pts.length - 1]);
    
    // Find ways that share BOTH endpoints
    const startSet = endpointIndex.get(startKey) ?? new Set();
    const endSet = endpointIndex.get(endKey) ?? new Set();
    const candidates = [...startSet].filter(id => id !== wid && endSet.has(id));
    
    const groupId = nextGroupId++;
    groups.set(wid, groupId);
    
    // Check if candidates are parallel (within threshold)
    for (const pid of candidates) {
      const ppts = wayGeometry.get(pid);
      if (!ppts) continue;
      
      // Convert threshold from metres to degrees (~111km per degree)
      if (averageMinDistanceDeg(pts, ppts) < PARALLEL_THRESHOLD_M / 111_000) {
        groups.set(pid, groupId);
      }
    }
  }
  
  const uniqueGroups = new Set(groups.values()).size;
  console.log(`[Geometry Processor] Assigned ${wayIds.length} ways to ${uniqueGroups} parallel groups`);
  
  return groups;
}

/**
 * Calculate average minimum distance between two way geometries
 * @param {Array<{lat,lon}>} pts1 
 * @param {Array<{lat,lon}>} pts2 
 * @param {number} nSamples 
 * @returns {number} Distance in degrees
 */
function averageMinDistanceDeg(pts1, pts2, nSamples = 6) {
  if (!pts1.length || !pts2.length) return Infinity;
  
  const step = Math.max(1, Math.floor(pts1.length / nSamples));
  let total = 0;
  let count = 0;
  
  for (let i = 0; i < pts1.length; i += step) {
    const p = pts1[i];
    let minD = Infinity;
    
    for (const q of pts2) {
      const d = (p.lat - q.lat) ** 2 + (p.lon - q.lon) ** 2;
      if (d < minD) minD = d;
    }
    
    total += Math.sqrt(minD);
    count++;
  }
  
  return count > 0 ? total / count : Infinity;
}

/**
 * Deduplicate ways by parallel group
 * Keeps only first representative of each group
 * 
 * @param {string[]} wayIds 
 * @param {Map<string, number>} groups 
 * @returns {string[]}
 */
export function deduplicateByGroup(wayIds, groups) {
  const seenGroups = new Set();
  
  const deduplicated = wayIds.filter(wid => {
    const gid = groups.get(wid);
    if (gid === undefined) return true; // Not in any group - keep
    if (seenGroups.has(gid)) return false; // Already have representative
    seenGroups.add(gid);
    return true;
  });
  
  const droppedCount = wayIds.length - deduplicated.length;
  console.log(`[Geometry Processor] Deduplication: ${wayIds.length} → ${deduplicated.length} ways (${droppedCount} dropped)`);
  
  return deduplicated;
}

/**
 * Chain ways via graph traversal
 * Finds best path through way network using F→T heuristic
 * 
 * @param {string[]} wayIds 
 * @param {Map<string, Array<{lat,lon}>>} wayGeometry 
 * @param {Array<string>} warnings 
 * @returns {{coords: Array<{lat,lon}>, visitedIds: Set<string>}}
 */
export function chainWaysViaGraph(wayIds, wayGeometry, warnings = [], startPoint = null, endPoint = null) {
  if (wayIds.length === 0) {
    return { coords: [], visitedIds: new Set() };
  }
  
  const endpointIndex = buildEndpointIndex(wayIds, wayGeometry);
  
  // Find terminus nodes (degree-1 endpoints)
  const startCandidates = [];
  
  for (const [key, wids] of endpointIndex) {
    if (wids.size !== 1) continue; // Not a terminus
    
    const wayId = [...wids][0];
    const pts = wayGeometry.get(wayId);
    if (!pts || pts.length < 2) continue;
    
    startCandidates.push({
      wayId,
      isForward: coordKey(pts[0]) === key
    });
  }
  
  // If no termini (closed loop), use first way
  if (startCandidates.length === 0) {
    const firstId = wayIds.find(wid => wayGeometry.has(wid));
    if (firstId) {
      startCandidates.push({ wayId: firstId, isForward: true });
    }
  }
  
  // If startPoint provided, score candidates by proximity to EITHER endpoint and include the
  // closest-to-endPoint terminus candidates too. This prevents a near-startPoint branch
  // terminus from winning purely by chain length when the correct chain starts from the
  // far end (near endPoint) and traverses toward startPoint.
  if (startPoint) {
    for (const cand of startCandidates) {
      const pts = wayGeometry.get(cand.wayId);
      const coord = cand.isForward ? pts[0] : pts[pts.length - 1];
      cand.distanceToStart = haversineMeters(startPoint.lat, startPoint.lon, coord.lat, coord.lon);
      cand.distanceToEnd = endPoint
        ? haversineMeters(endPoint.lat, endPoint.lon, coord.lat, coord.lon)
        : Infinity;
      cand.distanceToNearest = Math.min(cand.distanceToStart, cand.distanceToEnd);
    }
    startCandidates.sort((a, b) => a.distanceToNearest - b.distanceToNearest);
    
    // Include candidates within 5km of EITHER start or end, plus top 10 nearest
    const maxCand = Math.min(10, startCandidates.length);
    const threshold = 5000;
    const filtered = startCandidates.filter((c, idx) => idx < maxCand || c.distanceToNearest < threshold);
    startCandidates.splice(0, startCandidates.length, ...filtered);
  }
  
  console.log(`[Geometry Processor] Found ${startCandidates.length} starting candidates`);
  
  // Try each terminus and keep best chain
  // Scoring: for segments with both startPoint and endPoint, prefer chains whose two
  // terminal coords best bracket the [startPoint, endPoint] pair (bilateral coverage).
  // This prevents a branch-line terminus near startPoint from winning because its chain
  // is long, when the correct chain starts from a terminus near endPoint.
  let bestChain = [];
  let bestVisited = new Set();
  let bestStartDist = Infinity;
  let bestScore = -Infinity;
  const CHAIN_DIST_PENALTY_M = 3000; // 3km: coverage beyond this penalises the score
  
  for (const start of startCandidates) {
    const { chain, visited } = singleTraversal(
      start.wayId,
      start.isForward,
      endpointIndex,
      wayGeometry,
      wayIds.length
    );
    
    if (startPoint) {
      if (chain.length < 2) continue;
      const p0 = chain[0], pN = chain[chain.length - 1];
      const d1 = haversineMeters(startPoint.lat, startPoint.lon, p0.lat, p0.lon);
      const d2 = endPoint ? haversineMeters(endPoint.lat, endPoint.lon, pN.lat, pN.lon) : 0;
      const d3 = haversineMeters(startPoint.lat, startPoint.lon, pN.lat, pN.lon);
      const d4 = endPoint ? haversineMeters(endPoint.lat, endPoint.lon, p0.lat, p0.lon) : 0;
      // Best pairing of chain termini to segment endpoints (try both orientations)
      const coverage = endPoint ? Math.min(d1 + d2, d3 + d4) : Math.min(d1, d3);
      const score = chain.length / (1 + coverage / CHAIN_DIST_PENALTY_M);
      if (score > bestScore) {
        bestScore = score;
        bestChain = chain;
        bestVisited = visited;
        bestStartDist = Math.min(d1, d3);
      }
    } else {
      if (chain.length > bestChain.length) {
        bestChain = chain;
        bestVisited = visited;
      }
    }
  }
  
  // Report unvisited ways
  const unvisitedCount = wayIds.length - bestVisited.size;
  if (unvisitedCount > 0) {
    const warning = `${unvisitedCount} of ${wayIds.length} ways not included in centreline (branches/sidings excluded by design)`;
    console.log(`[Geometry Processor] ${warning}`);
    warnings.push(warning);
  }
  
  console.log(`[Geometry Processor] Best chain: ${bestChain.length} coordinates from ${bestVisited.size} ways`);
  
  return {
    coords: bestChain,
    visitedIds: bestVisited
  };
}

/**
 * Single graph traversal from starting way/direction
 * @param {string} startWayId 
 * @param {boolean} startForward 
 * @param {Map<string, Set<string>>} endpointIndex 
 * @param {Map<string, Array<{lat,lon}>>} wayGeometry 
 * @param {number} totalWays 
 * @returns {{chain: Array<{lat,lon}>, visited: Set<string>}}
 */
function singleTraversal(startWayId, startForward, endpointIndex, wayGeometry, totalWays) {
  const startPts = wayGeometry.get(startWayId) ?? [];
  const visited = new Set([startWayId]);
  let chain = startForward ? [...startPts] : [...startPts].reverse();
  
  let tailKey = coordKey(chain[chain.length - 1]);
  let incomingDir = directionFromChainTail(chain);
  
  const maxSteps = totalWays + 10;
  let steps = 0;
  
  while (steps++ < maxSteps) {
    const connectedIds = endpointIndex.get(tailKey) ?? new Set();
    const candidates = [...connectedIds].filter(wid => !visited.has(wid));
    
    if (candidates.length === 0) {
      // Gap-bridging: search for nearest unvisited way endpoint within tolerance
      const GAP_TOLERANCE = 0.00002; // ~2m — tight tolerance for coordinate precision mismatches only
      const tailPt = chain[chain.length - 1];
      
      let bestGapWay = null;
      let bestGapDist = GAP_TOLERANCE;
      let bestGapForward = true;
      
      for (const [key, wids] of endpointIndex) {
        for (const wid of wids) {
          if (visited.has(wid)) continue;
          const pts = wayGeometry.get(wid);
          if (!pts || pts.length < 2) continue;
          const ep0 = pts[0];
          const ep1 = pts[pts.length - 1];
          const d0 = Math.sqrt((ep0.lat - tailPt.lat) ** 2 + (ep0.lon - tailPt.lon) ** 2);
          const d1 = Math.sqrt((ep1.lat - tailPt.lat) ** 2 + (ep1.lon - tailPt.lon) ** 2);
          if (d0 < bestGapDist) { bestGapDist = d0; bestGapWay = wid; bestGapForward = true; }
          if (d1 < bestGapDist) { bestGapDist = d1; bestGapWay = wid; bestGapForward = false; }
        }
      }
      
      if (bestGapWay) {
        const gapPts = wayGeometry.get(bestGapWay);
        const ordered = bestGapForward ? gapPts : [...gapPts].reverse();
        // If multiple gap candidates are very close, prefer the straightest
        if (incomingDir && bestGapDist < GAP_TOLERANCE) {
          // Collect all candidates within tolerance
          const gapCandidates = [];
          for (const [key, wids] of endpointIndex) {
            for (const wid of wids) {
              if (visited.has(wid)) continue;
              const pts = wayGeometry.get(wid);
              if (!pts || pts.length < 2) continue;
              const ep0 = pts[0];
              const ep1 = pts[pts.length - 1];
              const d0 = Math.sqrt((ep0.lat - tailPt.lat) ** 2 + (ep0.lon - tailPt.lon) ** 2);
              const d1 = Math.sqrt((ep1.lat - tailPt.lat) ** 2 + (ep1.lon - tailPt.lon) ** 2);
              if (d0 < GAP_TOLERANCE) gapCandidates.push({ wid, isForward: true, dist: d0 });
              if (d1 < GAP_TOLERANCE) gapCandidates.push({ wid, isForward: false, dist: d1 });
            }
          }
          // Deduplicate by wayId (keep closest endpoint)
          const seen = new Map();
          for (const gc of gapCandidates) {
            if (!seen.has(gc.wid) || gc.dist < seen.get(gc.wid).dist) seen.set(gc.wid, gc);
          }
          const uniqueCandidates = [...seen.values()];
          if (uniqueCandidates.length > 1) {
            // Use direction heuristic to pick straightest
            bestGapWay = chooseThroughWay(
              uniqueCandidates.map(c => c.wid), tailKey, incomingDir, wayGeometry
            );
            const chosen = uniqueCandidates.find(c => c.wid === bestGapWay);
            bestGapForward = chosen?.isForward ?? true;
          }
        }
        const finalPts = wayGeometry.get(bestGapWay);
        const finalOrdered = bestGapForward ? finalPts : [...finalPts].reverse();
        console.log(`[Chain Gap Bridge] Jumped ${(bestGapDist * 111000).toFixed(1)}m to way ${bestGapWay} at ${visited.size} ways`);
        chain.push(...finalOrdered.slice(1));
        visited.add(bestGapWay);
        tailKey = coordKey(chain[chain.length - 1]);
        incomingDir = directionFromChainTail(chain);
        continue;
      }
      
      // No bridgeable gap found — log and stop
      console.log(`[Chain Break] Tail at (${tailPt.lat.toFixed(7)}, ${tailPt.lon.toFixed(7)}) — ${visited.size} ways visited, chain=${chain.length} pts. No unvisited ways within ${(GAP_TOLERANCE * 111000).toFixed(0)}m.`);
      break;
    }
    
    // Choose straightest path (T direction) at turnouts
    const nextWayId = candidates.length === 1
      ? candidates[0]
      : chooseThroughWay(candidates, tailKey, incomingDir, wayGeometry);
    
    const pts = wayGeometry.get(nextWayId);
    if (!pts || pts.length < 2) {
      visited.add(nextWayId);
      break;
    }
    
    const isForward = coordKey(pts[0]) === tailKey;
    const ordered = isForward ? pts : [...pts].reverse();
    
    // Append new points (skip first - already in chain)
    chain.push(...ordered.slice(1));
    visited.add(nextWayId);
    
    tailKey = coordKey(chain[chain.length - 1]);
    incomingDir = directionFromChainTail(chain);
  }
  
  return { chain, visited };
}

/**
 * Get unit direction vector from last two points of chain
 * @param {Array<{lat,lon}>} chain 
 * @returns {{dlat: number, dlon: number} | null}
 */
function directionFromChainTail(chain) {
  if (chain.length < 2) return null;
  
  const p1 = chain[chain.length - 2];
  const p2 = chain[chain.length - 1];
  
  return {
    dlat: p2.lat - p1.lat,
    dlon: p2.lon - p1.lon
  };
}

/**
 * Check if the chain has doubled back on itself.
 * Compares direction of first half vs second half — if they oppose
 * (dot product < -0.3, i.e. >107° reversal), the chain is folding back.
 * @param {Array<{lat,lon}>} chain
 * @param {number} minPoints - minimum chain points before checking
 * @returns {boolean}
 */
function isChainDoublingBack(chain, minPoints = 20) {
  if (chain.length < minPoints) return false;
  // Compare direction of the first few points with the last few points
  const n = Math.min(5, Math.floor(chain.length / 4));
  const initialDir = {
    dlat: chain[n].lat - chain[0].lat,
    dlon: chain[n].lon - chain[0].lon
  };
  const recentDir = {
    dlat: chain[chain.length - 1].lat - chain[chain.length - 1 - n].lat,
    dlon: chain[chain.length - 1].lon - chain[chain.length - 1 - n].lon
  };
  const iLen = Math.sqrt(initialDir.dlat ** 2 + initialDir.dlon ** 2);
  const rLen = Math.sqrt(recentDir.dlat ** 2 + recentDir.dlon ** 2);
  if (iLen < 1e-9 || rLen < 1e-9) return false;
  const dot = (initialDir.dlat * recentDir.dlat + initialDir.dlon * recentDir.dlon) / (iLen * rLen);
  return dot < -0.3;
}

/**
 * Choose way that continues straightest (T branch) at turnout
 * Uses dot product to find smallest angle with incoming direction
 * 
 * @param {string[]} candidateIds 
 * @param {string} tailKey 
 * @param {{dlat,dlon}|null} incomingDir 
 * @param {Map<string, Array<{lat,lon}>>} wayGeometry 
 * @returns {string}
 */
function chooseThroughWay(candidateIds, tailKey, incomingDir, wayGeometry, rejectUturns = false) {
  if (!incomingDir) return candidateIds[0];
  
  const inLen = Math.sqrt(incomingDir.dlat ** 2 + incomingDir.dlon ** 2);
  if (inLen === 0) return candidateIds[0];
  
  let bestId = null;
  let bestDot = -Infinity;
  
  for (const wid of candidateIds) {
    const pts = wayGeometry.get(wid);
    if (!pts || pts.length < 2) continue;
    
    // Determine which end connects to tail
    const isForward = coordKey(pts[0]) === tailKey;
    const dir = isForward
      ? { dlat: pts[1].lat - pts[0].lat, dlon: pts[1].lon - pts[0].lon }
      : { dlat: pts[pts.length - 2].lat - pts[pts.length - 1].lat, dlon: pts[pts.length - 2].lon - pts[pts.length - 1].lon };
    
    const outLen = Math.sqrt(dir.dlat ** 2 + dir.dlon ** 2);
    if (outLen === 0) continue;
    
    // Dot product (normalized): 1 = straight, -1 = reverse
    const dot = (incomingDir.dlat * dir.dlat + incomingDir.dlon * dir.dlon) / (inLen * outLen);
    
    if (dot > bestDot) {
      bestDot = dot;
      bestId = wid;
    }
  }
  
  // Reject any choice that would require a sharp turn (>~75°) — only for alt routes
  if (rejectUturns && bestDot < 0.25) return null;
  
  return bestId;
}

// ── Segment-based helpers ────────────────────────────────────────────────────

/**
 * Haversine distance in metres between two lat/lon points
 */
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Minimum distance from a point to the nearest point on a polyline (metres)
 */
function minDistanceToLineMeters(point, lineCoords) {
  if (lineCoords.length === 0) return Infinity;
  // Use local flat-earth projection centred on the test point
  const cosLat = Math.cos(point.lat * Math.PI / 180);
  const px = point.lon * cosLat;
  const py = point.lat;

  let minDist2 = Infinity;  // squared distance in degree-units
  // Check distance to each vertex
  for (const lp of lineCoords) {
    const dx = lp.lon * cosLat - px;
    const dy = lp.lat - py;
    const d2 = dx * dx + dy * dy;
    if (d2 < minDist2) minDist2 = d2;
  }
  // Check distance to each segment (point-to-segment projection)
  for (let i = 0; i < lineCoords.length - 1; i++) {
    const ax = lineCoords[i].lon * cosLat - px;
    const ay = lineCoords[i].lat - py;
    const bx = lineCoords[i + 1].lon * cosLat - px;
    const by = lineCoords[i + 1].lat - py;
    const abx = bx - ax, aby = by - ay;
    const ab2 = abx * abx + aby * aby;
    if (ab2 < 1e-20) continue; // degenerate segment
    const t = Math.max(0, Math.min(1, ((-ax) * abx + (-ay) * aby) / ab2));
    const cx = ax + t * abx;
    const cy = ay + t * aby;
    const d2 = cx * cx + cy * cy;
    if (d2 < minDist2) minDist2 = d2;
  }
  return Math.sqrt(minDist2) * 111320;  // convert degrees to metres
}

/**
 * Total route length in metres from a coordinate array
 */
export function calculateRouteLengthMeters(coords) {
  if (coords.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversineMeters(
      coords[i - 1].lat, coords[i - 1].lon,
      coords[i].lat, coords[i].lon
    );
  }
  return total;
}

/**
 * Split ways at intermediate junction nodes (switches, crossovers, crossings).
 *
 * OSM ways can contain junction nodes mid-way. This function identifies shared
 * nodes (appearing in 2+ ways) inside a way and splits at those points, creating
 * virtual way segments that properly connect at junctions.
 *
 * Critical for alternative route detection — without splitting, diverging ways
 * may appear disconnected because the junction node is mid-way, not at an endpoint.
 *
 * @param {string[]} wayIds
 * @param {Map<string, {lat,lon}[]>} wayGeometry
 * @param {Map<string, string[]>} wayNodes
 * @param {Array<{id: string, lat: number, lon: number, tags: object}>} taggedNodes
 * @returns {{splitWayIds: string[], splitWayGeometry: Map, splitWayNodes: Map}}
 */
export function splitWaysAtIntermediateJunctions(wayIds, wayGeometry, wayNodes, taggedNodes) {
  // Build set of explicitly tagged junction node IDs
  const junctionNodeSet = new Set();
  for (const tn of (taggedNodes ?? [])) {
    const rt = tn.tags?.railway;
    if (rt === 'switch' || rt === 'railway_crossing' || rt === 'crossover') {
      junctionNodeSet.add(tn.id);
    }
  }

  // Identify topological junctions: nodes appearing in 2+ ways
  const nodeUsage = new Map();
  for (const wid of wayIds) {
    const nodes = wayNodes.get(wid) || [];
    for (let i = 0; i < nodes.length; i++) {
      const nodeId = nodes[i];
      if (!nodeUsage.has(nodeId)) nodeUsage.set(nodeId, []);
      nodeUsage.get(nodeId).push({ wayId: wid, index: i });
    }
  }

  const sharedJunctions = new Set();
  for (const [nodeId, usage] of nodeUsage) {
    if (usage.length >= 2) {
      sharedJunctions.add(nodeId);
    }
  }

  if (sharedJunctions.size === 0) {
    return { splitWayIds: wayIds, splitWayGeometry: wayGeometry, splitWayNodes: wayNodes };
  }

  console.log(`[Geometry Processor] Found ${sharedJunctions.size} shared junction nodes for splitting`);

  const newWayIds = [];
  const newWayGeometry = new Map();
  const newWayNodes = new Map();
  let virtualIdCounter = 9000000000;

  for (const wid of wayIds) {
    const nodes = wayNodes.get(wid) || [];
    const geom = wayGeometry.get(wid) || [];

    // Find shared junction nodes within this way (excluding endpoints)
    const junctionIndices = [];
    for (let i = 1; i < nodes.length - 1; i++) {
      if (sharedJunctions.has(nodes[i])) {
        junctionIndices.push(i);
      }
    }

    if (junctionIndices.length === 0) {
      newWayIds.push(wid);
      newWayGeometry.set(wid, geom);
      newWayNodes.set(wid, nodes);
      continue;
    }

    // Split at each junction
    const boundaries = [0, ...junctionIndices, nodes.length - 1];
    for (let s = 0; s < boundaries.length - 1; s++) {
      const startIdx = boundaries[s];
      const endIdx = boundaries[s + 1];
      const isOriginal = (startIdx === 0 && endIdx === nodes.length - 1);
      const segId = isOriginal ? wid : String(virtualIdCounter++);
      const segNodes = nodes.slice(startIdx, endIdx + 1);
      const segGeom = geom.slice(startIdx, endIdx + 1);

      newWayIds.push(segId);
      newWayGeometry.set(segId, segGeom);
      newWayNodes.set(segId, segNodes);
    }
  }

  console.log(`[Geometry Processor] Split ${wayIds.length} ways → ${newWayIds.length} segments (${newWayIds.length - wayIds.length} virtual)`);

  return { splitWayIds: newWayIds, splitWayGeometry: newWayGeometry, splitWayNodes: newWayNodes };
}

/**
 * Detect alternative routes that diverge >50m from the main centerline.
 *
 * @param {string[]} allWayIds - ALL way IDs (incl. parallel dupes) for alternatives
 * @param {Map<string, {lat,lon}[]>} wayGeometry
 * @param {Set<string>} mainChainWayIds - Ways used in main centerline
 * @param {{lat,lon}[]} mainCenterlineCoords
 * @param {{minLat, maxLat, minLon, maxLon}} bbox
 * @returns {Array<{wayIds: string[], coords: {lat,lon}[], divergencePoint: {lat,lon}, convergencePoint: {lat,lon}|null, lengthKm: number, maxDeviationM: number, reconverged: boolean}>}
 */
export function detectAlternativeRoutes(allWayIds, wayGeometry, mainChainWayIds, mainCenterlineCoords, bbox) {
  const DIVERGENCE_THRESHOLD_M = 50;
  const CONVERGENCE_THRESHOLD_M = 8;
  const MAX_CORRIDOR_DEVIATION_M = 5000;
  const MIN_ALTERNATIVE_LENGTH_M = 1000;

  // Excluded ways: not in main chain, or short main-line crossovers (<100m)
  const excludedWayIds = allWayIds.filter(wid => {
    if (!mainChainWayIds.has(wid)) return true;
    const pts = wayGeometry.get(wid);
    if (!pts || pts.length < 2) return false;
    return calculateRouteLengthMeters(pts) < 100;
  });

  if (excludedWayIds.length === 0 || mainCenterlineCoords.length === 0) return [];

  // Measure separation of each excluded way from main centerline
  const waySeparations = new Map();
  for (const wid of excludedWayIds) {
    const pts = wayGeometry.get(wid);
    if (!pts || pts.length < 2) continue;
    const step = Math.max(1, Math.floor(pts.length / 5));
    let totalSep = 0, count = 0;
    for (let i = 0; i < pts.length; i += step) {
      totalSep += minDistanceToLineMeters(pts[i], mainCenterlineCoords);
      count++;
    }
    waySeparations.set(wid, count > 0 ? totalSep / count : Infinity);
  }

  // Filter to ways that diverge significantly from main centerline
  const divergingWayIds = excludedWayIds.filter(wid => {
    const sep = waySeparations.get(wid);
    return sep !== undefined && sep > DIVERGENCE_THRESHOLD_M;
  });

  if (divergingWayIds.length === 0) return [];

  console.log(`[Alt Routes] ${excludedWayIds.length} excluded ways, ${divergingWayIds.length} diverging (>50m from main)`);

  // (debug tracing removed)

  // Build connectivity graph for excluded ways
  const excludedEndpointIndex = buildEndpointIndex(excludedWayIds, wayGeometry);

  const alternatives = [];
  const processed = new Set();
  const seenWaySets = [];

  // Helper: evaluate a candidate and add to alternatives if it qualifies
  function evaluateCandidate(start, allCenterlines, passLabel) {
    if (processed.has(start.wayId)) return;

    console.log(`[Alt Routes P${passLabel}] Processing candidate: way ${start.wayId}, forward=${start.isForward}`);

    // Check this start diverges from ALL existing alternatives too
    const startPts = wayGeometry.get(start.wayId);
    if (startPts && startPts.length >= 2 && alternatives.length > 0) {
      const step = Math.max(1, Math.floor(startPts.length / 3));
      let minDistToAnyAlt = Infinity;
      for (let i = 0; i < startPts.length; i += step) {
        for (const alt of alternatives) {
          const dist = minDistanceToLineMeters(startPts[i], alt.coords);
          if (dist < minDistToAnyAlt) minDistToAnyAlt = dist;
        }
      }
      if (minDistToAnyAlt < DIVERGENCE_THRESHOLD_M) {
        processed.add(start.wayId);
        return;
      }
    }

    const result = buildAlternativeCenterline(
      start.wayId, start.isForward, excludedEndpointIndex, wayGeometry,
      mainCenterlineCoords, MAX_CORRIDOR_DEVIATION_M, CONVERGENCE_THRESHOLD_M,
      excludedWayIds.length
    );

    if (!result) { console.log(`[Alt Routes P${passLabel}]   → buildAlternativeCenterline returned null`); return; }
    const { chain, visited, maxDeviation, reconverged } = result;
    visited.forEach(wid => processed.add(wid));
    if (chain.length < 2) { console.log(`[Alt Routes P${passLabel}]   → chain too short (${chain.length} pts)`); return; }

    const routeLengthM = calculateRouteLengthMeters(chain);
    if (routeLengthM < MIN_ALTERNATIVE_LENGTH_M) { console.log(`[Alt Routes P${passLabel}]   → too short: ${(routeLengthM/1000).toFixed(2)}km < 1km`); return; }
    if (maxDeviation > MAX_CORRIDOR_DEVIATION_M) { console.log(`[Alt Routes P${passLabel}]   → max deviation ${maxDeviation.toFixed(0)}m > 5km`); return; }
    if (maxDeviation < DIVERGENCE_THRESHOLD_M) { console.log(`[Alt Routes P${passLabel}]   → never diverges from main (maxDev=${maxDeviation.toFixed(0)}m < 50m)`); return; }

    const waySignature = [...visited].sort().join(',');
    if (seenWaySets.includes(waySignature)) return;
    seenWaySets.push(waySignature);

    // Reject if the full chain is redundant with an already-accepted alt route
    if (alternatives.length > 0) {
      const step2 = Math.max(1, Math.floor(chain.length / 20));
      for (const alt of alternatives) {
        let totalDistToAlt = 0, cnt = 0;
        for (let i = 0; i < chain.length; i += step2) {
          totalDistToAlt += minDistanceToLineMeters(chain[i], alt.coords);
          cnt++;
        }
        const avgDistToAlt = totalDistToAlt / cnt;
        if (avgDistToAlt < DIVERGENCE_THRESHOLD_M) {
          console.log(`[Alt Routes P${passLabel}]   → redundant with existing alt (avgDistToAlt=${avgDistToAlt.toFixed(0)}m < 50m)`);
          return;
        }
      }
    }

    // Average separation from main
    const step = Math.max(1, Math.floor(chain.length / 20));
    let totalSep = 0, sepCount = 0;
    for (let i = 0; i < chain.length; i += step) {
      totalSep += minDistanceToLineMeters(chain[i], mainCenterlineCoords);
      sepCount++;
    }
    const avgSep = totalSep / sepCount;

    if (reconverged && avgSep < 75) { console.log(`[Alt Routes P${passLabel}]   → reconverged parallel (avgSep=${avgSep.toFixed(0)}m)`); return; }
    if (routeLengthM < 2000 && visited.size < 5 && !reconverged) { console.log(`[Alt Routes P${passLabel}]   → short non-reconverging (${(routeLengthM/1000).toFixed(2)}km, ${visited.size} ways)`); return; }

    // Filter out alt routes whose centroid falls outside the segment bbox
    if (bbox) {
      const margin = 0.01; // ~1.1 km
      const sStep = Math.max(1, Math.floor(chain.length / 20));
      let sLat = 0, sLon = 0, sCnt = 0;
      for (let j = 0; j < chain.length; j += sStep) {
        sLat += chain[j].lat; sLon += chain[j].lon; sCnt++;
      }
      const cLat = sLat / sCnt, cLon = sLon / sCnt;
      if (cLat < bbox.minLat - margin || cLat > bbox.maxLat + margin ||
          cLon < bbox.minLon - margin || cLon > bbox.maxLon + margin) {
        console.log(`[Alt Routes P${passLabel}]   → centroid outside bbox`);
        return;
      }
    }

    const startPoint = chain[0];
    const endPoint = chain[chain.length - 1];
    const startDist = minDistanceToLineMeters(startPoint, mainCenterlineCoords);
    const endDist = minDistanceToLineMeters(endPoint, mainCenterlineCoords);

    alternatives.push({
      wayIds: [...visited],
      coords: chain,
      divergencePoint: startDist < endDist ? startPoint : endPoint,
      convergencePoint: reconverged ? endPoint : null,
      lengthKm: routeLengthM / 1000,
      maxDeviationM: maxDeviation,
      reconverged
    });
    console.log(`[Alt Routes P${passLabel}]   ✓ ACCEPTED: ${(routeLengthM/1000).toFixed(2)}km, ${visited.size} ways, maxDev=${maxDeviation.toFixed(0)}m, reconverged=${reconverged}`);
  }

  // ── PASS 1: Terminus-based (dead ends in excluded network) ──
  // Finds branch lines, industrial sidings, and other routes with a clear dead end
  const terminusCandidates = [];
  for (const [key, wids] of excludedEndpointIndex) {
    if (wids.size !== 1) continue;
    const wayId = [...wids][0];
    if (!divergingWayIds.includes(wayId)) continue;
    const pts = wayGeometry.get(wayId);
    if (!pts || pts.length < 2) continue;
    terminusCandidates.push({ wayId, isForward: coordKey(pts[0]) === key });
  }

  console.log(`[Alt Routes] Pass 1: ${terminusCandidates.length} terminus candidates`);
  for (const start of terminusCandidates) {
    evaluateCandidate(start, [mainCenterlineCoords], '1');
  }
  console.log(`[Alt Routes] Pass 1 found ${alternatives.length} alternative routes`);

  // ── PASS 2: Orphan diverging ways (>50m from ALL centerlines) ──
  // After pass 1, find ways still far from main + all pass-1 alt centerlines.
  // These are tunnels/bypasses that don't have a terminus — they connect to the
  // main line at both ends. Start traversal from their junction with the main chain.
  const allCenterlines = [mainCenterlineCoords, ...alternatives.map(a => a.coords)];

  // Find orphan ways: excluded ways not yet processed where ANY sampled point is
  // >50m from all centerlines. A tunnel connecting to the main line at both ends
  // will have endpoints near the centerline but its middle section far away —
  // any point being far is enough to warrant investigation.
  const orphanWayIds = excludedWayIds.filter(wid => {
    if (processed.has(wid)) return false;
    const pts = wayGeometry.get(wid);
    if (!pts || pts.length < 2) return false;
    const step = Math.max(1, Math.floor(pts.length / 5));
    let maxMinDist = 0;
    for (let i = 0; i < pts.length; i += step) {
      let minDist = Infinity;
      for (const cl of allCenterlines) {
        const d = minDistanceToLineMeters(pts[i], cl);
        if (d < minDist) minDist = d;
      }
      if (minDist > maxMinDist) maxMinDist = minDist;
    }
    const isOrphan = maxMinDist > DIVERGENCE_THRESHOLD_M;
    return isOrphan;
  });

  if (orphanWayIds.length > 0) {
    console.log(`[Alt Routes] Pass 2: ${orphanWayIds.length} orphan ways (>50m from all centerlines)`);

    // For each orphan way, try starting traversal from both ends.
    // buildAlternativeCenterline will chain through connected excluded ways
    // and may reach the main line (reconverge) at both ends.
    const pass2Candidates = [];
    const seenPass2Keys = new Set();

    for (const wid of orphanWayIds) {
      const pts = wayGeometry.get(wid);
      if (!pts || pts.length < 2) continue;
      // Try both directions
      for (const isForward of [true, false]) {
        const ck = `${wid}:${isForward ? 'fwd' : 'rev'}`;
        if (!seenPass2Keys.has(ck)) {
          seenPass2Keys.add(ck);
          pass2Candidates.push({ wayId: wid, isForward });
        }
      }
    }

    console.log(`[Alt Routes] Pass 2: ${pass2Candidates.length} junction-connected orphan candidates`);
    const pass1Count = alternatives.length;
    for (const start of pass2Candidates) {
      evaluateCandidate(start, allCenterlines, '2');
    }
    console.log(`[Alt Routes] Pass 2 found ${alternatives.length - pass1Count} additional alternative routes`);
  }

  // ── PASS 3: Dead-end spurs branching off accepted alternatives ──
  // Finds short sidings/spurs whose junction endpoint touches an existing alt
  // route geometry. These are too short for the main passes but represent real
  // branches that need node coverage. Only the spur itself is included (not
  // the onward chain through the parent alt route).
  {
    const MIN_SPUR_LENGTH_M = 150;
    const SPUR_PROXIMITY_M = 25;
    const pass2Count = alternatives.length;

    for (const [key, wids] of excludedEndpointIndex) {
      if (wids.size !== 1) continue;
      const wayId = [...wids][0];
      // Skip if already included in an accepted alternative
      const inAccepted = alternatives.some(a => a.wayIds.map(String).includes(String(wayId)));
      if (inAccepted) continue;
      const pts = wayGeometry.get(wayId);
      if (!pts || pts.length < 2) continue;

      const isDeadEnd = coordKey(pts[0]) === key;
      const junctionPt = isDeadEnd ? pts[pts.length - 1] : pts[0];

      // Check if the junction end is near any accepted alt route OR mainline
      let nearGeometry = false;
      for (const alt of alternatives) {
        if (minDistanceToLineMeters(junctionPt, alt.coords) < SPUR_PROXIMITY_M) { nearGeometry = true; break; }
      }
      if (!nearGeometry) {
        nearGeometry = minDistanceToLineMeters(junctionPt, mainCenterlineCoords) < SPUR_PROXIMITY_M;
      }
      if (!nearGeometry) continue;

      // Build a spur-only chain: follow dead-end ways from the terminus
      // until reaching a junction that connects to a known alt route.
      const spurWayIds = [wayId];
      const spurChain = isDeadEnd ? [...pts] : [...pts].reverse();
      const spurVisited = new Set([wayId]);
      let spurTailKey = coordKey(spurChain[spurChain.length - 1]);

      // Follow onward dead-end ways (single-connection continuations)
      for (let step = 0; step < 20; step++) {
        const nextIds = excludedEndpointIndex.get(spurTailKey) ?? new Set();
        const candidates = [...nextIds].filter(w => !spurVisited.has(w));
        if (candidates.length !== 1) break; // Stop at junctions or dead ends
        const nextId = candidates[0];
        const npts = wayGeometry.get(nextId);
        if (!npts || npts.length < 2) break;
        const nForward = coordKey(npts[0]) === spurTailKey;
        const ordered = nForward ? npts : [...npts].reverse();
        spurChain.push(...ordered.slice(1));
        spurVisited.add(nextId);
        spurWayIds.push(nextId);
        spurTailKey = coordKey(spurChain[spurChain.length - 1]);
      }

      const routeLengthM = calculateRouteLengthMeters(spurChain);
      if (routeLengthM < MIN_SPUR_LENGTH_M) continue;

      // Check that the spur actually diverges from nearest centerline.
      // A spur running parallel and close to an existing track is just a yard siding.
      const allCl = [mainCenterlineCoords, ...alternatives.map(a => a.coords)];
      const spurStep = Math.max(1, Math.floor(spurChain.length / 5));
      let spurTotalSep = 0, spurSepCount = 0;
      for (let si = 0; si < spurChain.length; si += spurStep) {
        let minD = Infinity;
        for (const cl of allCl) {
          const d = minDistanceToLineMeters(spurChain[si], cl);
          if (d < minD) minD = d;
        }
        spurTotalSep += minD;
        spurSepCount++;
      }
      const spurAvgSep = spurSepCount > 0 ? spurTotalSep / spurSepCount : 0;
      if (spurAvgSep < SPUR_PROXIMITY_M) {
        console.log(`[Alt Routes P3] Skipped spur way ${wayId}: avg separation ${spurAvgSep.toFixed(0)}m < ${SPUR_PROXIMITY_M}m`);
        continue;
      }

      const maxDeviation = Math.max(...spurChain.map(p => minDistanceToLineMeters(p, mainCenterlineCoords)));

      spurVisited.forEach(wid => processed.add(wid));
      alternatives.push({
        wayIds: spurWayIds,
        coords: spurChain,
        divergencePoint: spurChain[0],
        convergencePoint: null,
        lengthKm: routeLengthM / 1000,
        maxDeviationM: maxDeviation,
        reconverged: false
      });
      console.log(`[Alt Routes P3] ✓ SPUR: way ${wayId}, ${(routeLengthM/1000).toFixed(2)}km, ${spurVisited.size} ways`);
    }

    if (alternatives.length > pass2Count) {
      console.log(`[Alt Routes] Pass 3 found ${alternatives.length - pass2Count} dead-end spurs`);
    }
  }

  // ── Final deduplication: remove short alts that are near-duplicates of longer alts ──
  // Sort by length descending so longer routes are kept in favour of shorter ones.
  if (alternatives.length > 1) {
    const sorted = alternatives.slice().sort((a, b) => b.coords.length - a.coords.length);
    const keep = [];
    for (const alt of sorted) {
      let redundant = false;
      for (const kept of keep) {
        const step = Math.max(1, Math.floor(alt.coords.length / 10));
        let totalDist = 0, cnt = 0;
        for (let i = 0; i < alt.coords.length; i += step) {
          totalDist += minDistanceToLineMeters(alt.coords[i], kept.coords);
          cnt++;
        }
        const avgDist = totalDist / cnt;
        if (avgDist < DIVERGENCE_THRESHOLD_M) {
          console.log(`[Alt Routes] Dedup: removed alt (${(alt.lengthKm).toFixed(2)}km, ${alt.wayIds.length} ways) as redundant with longer alt (avgDist=${avgDist.toFixed(0)}m < ${DIVERGENCE_THRESHOLD_M}m)`);
          redundant = true;
          break;
        }
      }
      if (!redundant) keep.push(alt);
    }
    if (keep.length < alternatives.length) {
      console.log(`[Alt Routes] Dedup removed ${alternatives.length - keep.length} redundant alts`);
      alternatives.length = 0;
      alternatives.push(...keep);
    }
  }

  return alternatives;
}

/**
 * Build alternative centerline from a diverging start way.
 * Stops on reconvergence (<8m from main), excessive deviation (>5km), or dead end.
 */
function buildAlternativeCenterline(
  startWayId, startForward, endpointIndex, wayGeometry,
  mainCenterlineCoords, maxAllowedDeviation, convergenceThreshold, totalWays
) {
  const startPts = wayGeometry.get(startWayId);
  if (!startPts || startPts.length < 2) return null;

  const visited = new Set([startWayId]);
  let chain = startForward ? [...startPts] : [...startPts].reverse();
  let tailKey = coordKey(chain[chain.length - 1]);
  let incomingDir = directionFromChainTail(chain);
  let maxDeviation = 0;
  let reconverged = false;

  const maxSteps = totalWays + 10;
  let steps = 0;
  let _fwdExitReason = 'maxSteps';

  while (steps++ < maxSteps) {
    const tailDist = minDistanceToLineMeters(chain[chain.length - 1], mainCenterlineCoords);
    maxDeviation = Math.max(maxDeviation, tailDist);

    if (tailDist < convergenceThreshold) { _fwdExitReason = `converged tailDist=${tailDist.toFixed(1)}m`; reconverged = true; break; }
    if (tailDist > maxAllowedDeviation) return null;

    const connectedIds = endpointIndex.get(tailKey) ?? new Set();
    const candidates = [...connectedIds].filter(wid => !visited.has(wid));
    if (candidates.length === 0) {
      // Gap-bridging: search for nearest unvisited way endpoint within tolerance
      // Also reject candidates that would double back (negative dot product with travel direction)
      const ALT_GAP_TOLERANCE = 0.0001; // ~10m — bridges OSM node gaps in alt routes
      const tailPt = chain[chain.length - 1];
      // Use longer-baseline direction for gap bridge to avoid being misled by terminal curvature
      const gapRefIdx = Math.max(0, chain.length - 5);
      const gapDir = chain.length >= 5
        ? { dlat: chain[chain.length-1].lat - chain[gapRefIdx].lat, dlon: chain[chain.length-1].lon - chain[gapRefIdx].lon }
        : incomingDir;
      let bestGapWay = null, bestGapDist = ALT_GAP_TOLERANCE, bestGapForward = true;
      for (const [key, wids] of endpointIndex) {
        for (const wid of wids) {
          if (visited.has(wid)) continue;
          const pts = wayGeometry.get(wid);
          if (!pts || pts.length < 2) continue;
          const d0 = Math.sqrt((pts[0].lat - tailPt.lat) ** 2 + (pts[0].lon - tailPt.lon) ** 2);
          const d1 = Math.sqrt((pts[pts.length - 1].lat - tailPt.lat) ** 2 + (pts[pts.length - 1].lon - tailPt.lon) ** 2);
          // Check direction: use longer-baseline bearing to reject jumps to opposite-direction tracks
          if (d0 < bestGapDist) {
            if (gapDir) {
              const cDir = { dlat: pts[pts.length - 1].lat - pts[0].lat, dlon: pts[pts.length - 1].lon - pts[0].lon };
              const dot = gapDir.dlat * cDir.dlat + gapDir.dlon * cDir.dlon;
              if (dot >= 0) { bestGapDist = d0; bestGapWay = wid; bestGapForward = true; }
            } else { bestGapDist = d0; bestGapWay = wid; bestGapForward = true; }
          }
          if (d1 < bestGapDist) {
            if (gapDir) {
              const cDir = { dlat: pts[0].lat - pts[pts.length - 1].lat, dlon: pts[0].lon - pts[pts.length - 1].lon };
              const dot = gapDir.dlat * cDir.dlat + gapDir.dlon * cDir.dlon;
              if (dot >= 0) { bestGapDist = d1; bestGapWay = wid; bestGapForward = false; }
            } else { bestGapDist = d1; bestGapWay = wid; bestGapForward = false; }
          }
        }
      }
      if (bestGapWay) {
        const preLen = chain.length;
        const gapPts = wayGeometry.get(bestGapWay);
        const ordered = bestGapForward ? gapPts : [...gapPts].reverse();
        console.log(`[Alt Gap Bridge FWD] Jumped ${(bestGapDist * 111000).toFixed(1)}m to way ${bestGapWay}`);
        chain.push(...ordered.slice(1));
        visited.add(bestGapWay);
        if (isChainDoublingBack(chain)) {
          console.log(`[Alt Chain] Stopped: chain doubled back after gap bridge to way ${bestGapWay}`);
          chain.length = preLen;
          visited.delete(bestGapWay);
          _fwdExitReason = `gapBridgeDoubleBack way=${bestGapWay}`;
          break;
        }
        tailKey = coordKey(chain[chain.length - 1]);
        incomingDir = directionFromChainTail(chain);
        continue;
      }
      _fwdExitReason = `noMoreCandidates tailKey=${tailKey}`;
      break;
    }

    // Filter out dead ends if continuations exist (only when multiple candidates)
    let filtered = candidates;
    if (candidates.length > 1) {
      const withOnward = candidates.filter(wid => {
        const pts = wayGeometry.get(wid);
        if (!pts || pts.length < 2) return false;
        const isForward = coordKey(pts[0]) === tailKey;
        const farKey = coordKey(isForward ? pts[pts.length - 1] : pts[0]);
        const onward = endpointIndex.get(farKey) ?? new Set();
        return [...onward].some(id => !visited.has(id) && id !== wid);
      });
      filtered = withOnward.length > 0 ? withOnward : candidates;
    }

    // Choose the candidate that best continues current direction.
    // Use longer-baseline direction to avoid being misled by terminal curvature.
    const altDir = chain.length >= 5
      ? { dlat: chain[chain.length-1].lat - chain[chain.length-5].lat,
          dlon: chain[chain.length-1].lon - chain[chain.length-5].lon }
      : incomingDir;
    const nextWayId = chooseThroughWay(filtered, tailKey, altDir, wayGeometry, true);
    if (nextWayId === null) { _fwdExitReason = `chooseThroughWay=null tailKey=${tailKey} cands=${filtered.join(',')}`; break; }

    const pts = wayGeometry.get(nextWayId);
    if (!pts || pts.length < 2) { visited.add(nextWayId); break; }
    const isForward = coordKey(pts[0]) === tailKey;
    const ordered = isForward ? pts : [...pts].reverse();

    const preLen = chain.length;
    chain.push(...ordered.slice(1));
    visited.add(nextWayId);
    if (isChainDoublingBack(chain)) {
      console.log(`[Alt Chain] Stopped: chain doubled back after adding way ${nextWayId}`);
      chain.length = preLen;
      visited.delete(nextWayId);
      _fwdExitReason = `chainDoubleBack way=${nextWayId}`;
      break;
    }
    tailKey = coordKey(chain[chain.length - 1]);
    incomingDir = directionFromChainTail(chain);
  }

  // Log forward exit reason for chains near S20 area
  {
    const _tail = chain[chain.length - 1];
    const _head = chain[0];
    if ((_tail && Math.abs(_tail.lat - 43.605) < 0.03) || (_head && Math.abs(_head.lat - 43.605) < 0.03)) {
      const tailDist = minDistanceToLineMeters(chain[chain.length - 1], mainCenterlineCoords);
      console.log(`[DBG FWD EXIT] startWay=${startWayId} exit=${_fwdExitReason} chainLen=${chain.length} tailLat=${_tail.lat.toFixed(7)} tailDist=${tailDist.toFixed(1)}m reconverged=${reconverged} visited=[${[...visited].join(',')}]`);
    }
  }

  // Forward traversal complete. Now extend backward from the head of the chain
  // to close any gap at the start end toward the main line.
  let headKey = coordKey(chain[0]);
  let headDist = minDistanceToLineMeters(chain[0], mainCenterlineCoords);
  let headReconverged = headDist < convergenceThreshold;
  steps = 0;

  while (!headReconverged && steps++ < maxSteps) {
    const connectedIds = endpointIndex.get(headKey) ?? new Set();
    const candidates = [...connectedIds].filter(wid => !visited.has(wid));
    if (candidates.length === 0) {
      // Gap-bridging for backward extension — with direction check
      const ALT_GAP_TOLERANCE = 0.0001; // ~10m
      const headPt = chain[0];
      // Use longer-baseline direction for backward gap bridge
      const bwdRefEnd = Math.min(5, chain.length - 1);
      const bwdDir = chain.length >= 2
        ? { dlat: chain[0].lat - chain[bwdRefEnd].lat, dlon: chain[0].lon - chain[bwdRefEnd].lon }
        : null;
      let bestGapWay = null, bestGapDist = ALT_GAP_TOLERANCE, bestGapForward = true;
      for (const [key, wids] of endpointIndex) {
        for (const wid of wids) {
          if (visited.has(wid)) continue;
          const pts = wayGeometry.get(wid);
          if (!pts || pts.length < 2) continue;
          const d0 = Math.sqrt((pts[0].lat - headPt.lat) ** 2 + (pts[0].lon - headPt.lon) ** 2);
          const d1 = Math.sqrt((pts[pts.length - 1].lat - headPt.lat) ** 2 + (pts[pts.length - 1].lon - headPt.lon) ** 2);
          // Check direction: use overall bearing of candidate way
          if (d0 < bestGapDist) {
            if (bwdDir) {
              const cDir = { dlat: pts[pts.length - 1].lat - pts[0].lat, dlon: pts[pts.length - 1].lon - pts[0].lon };
              const dot = bwdDir.dlat * cDir.dlat + bwdDir.dlon * cDir.dlon;
              if (dot >= 0) { bestGapDist = d0; bestGapWay = wid; bestGapForward = true; }
            } else { bestGapDist = d0; bestGapWay = wid; bestGapForward = true; }
          }
          if (d1 < bestGapDist) {
            if (bwdDir) {
              const cDir = { dlat: pts[0].lat - pts[pts.length - 1].lat, dlon: pts[0].lon - pts[pts.length - 1].lon };
              const dot = bwdDir.dlat * cDir.dlat + bwdDir.dlon * cDir.dlon;
              if (dot >= 0) { bestGapDist = d1; bestGapWay = wid; bestGapForward = false; }
            } else { bestGapDist = d1; bestGapWay = wid; bestGapForward = false; }
          }
        }
      }
      if (bestGapWay) {
        const gapPts = wayGeometry.get(bestGapWay);
        const ordered = bestGapForward ? gapPts : [...gapPts].reverse();
        console.log(`[Alt Gap Bridge BWD] Jumped ${(bestGapDist * 111000).toFixed(1)}m to way ${bestGapWay}`);
        chain = [...ordered.slice(0, -1), ...chain];
        visited.add(bestGapWay);
        headKey = coordKey(chain[0]);
        headDist = minDistanceToLineMeters(chain[0], mainCenterlineCoords);
        maxDeviation = Math.max(maxDeviation, headDist);
        if (headDist < convergenceThreshold) { headReconverged = true; }
        if (headDist > maxAllowedDeviation) break;
        continue;
      }
      break;
    }

    // For backward extension, use longer-baseline bearing from the chain head
    const bwdHeadRef = Math.min(5, chain.length - 1);
    const headDir = chain.length >= 2
      ? { dlat: chain[0].lat - chain[bwdHeadRef].lat, dlon: chain[0].lon - chain[bwdHeadRef].lon }
      : { dlat: 0, dlon: 0 };

    const nextWayId = chooseThroughWay(candidates, headKey, headDir, wayGeometry, true);
    if (nextWayId === null) break;

    const pts = wayGeometry.get(nextWayId);
    if (!pts || pts.length < 2) { visited.add(nextWayId); break; }
    const isForward = coordKey(pts[pts.length - 1]) === headKey;
    const ordered = isForward ? pts : [...pts].reverse();

    // Prepend to chain (excluding the shared endpoint)
    chain = [...ordered.slice(0, -1), ...chain];
    visited.add(nextWayId);
    headKey = coordKey(chain[0]);

    headDist = minDistanceToLineMeters(chain[0], mainCenterlineCoords);
    maxDeviation = Math.max(maxDeviation, headDist);
    if (headDist < convergenceThreshold) { headReconverged = true; }
    if (headDist > maxAllowedDeviation) break;
  }

  // If forward end reconverged and backward end also reconverged, mark as fully reconverged
  if (reconverged && headReconverged) {
    reconverged = true;
  } else if (!reconverged && headReconverged) {
    // Only the head reconverged — reverse the chain so start=reconverged, end=open
    chain = chain.reverse();
    reconverged = false;
  }

  // ── Chain cleanup: remove micro-reversal artifacts ──
  // Remove single-point direction spikes where a point deviates < 30m from
  // the interpolated line between its neighbours, causing a direction reversal.
  if (chain.length >= 4) {
    for (let pass = 0; pass < 3; pass++) {
      let changed = false;
      const cleaned = [chain[0]];
      for (let i = 1; i < chain.length - 1; i++) {
        const prev = cleaned[cleaned.length - 1];
        const curr = chain[i];
        const next = chain[i + 1];
        const d1 = { dlat: curr.lat - prev.lat, dlon: curr.lon - prev.lon };
        const d2 = { dlat: next.lat - curr.lat, dlon: next.lon - curr.lon };
        const dot = d1.dlat * d2.dlat + d1.dlon * d2.dlon;
        if (dot < 0) {
          const midLat = (prev.lat + next.lat) / 2;
          const midLon = (prev.lon + next.lon) / 2;
          const dispM = Math.sqrt((curr.lat - midLat) ** 2 + (curr.lon - midLon) ** 2) * 111000;
          if (dispM < 30) { changed = true; continue; }
        }
        cleaned.push(curr);
      }
      cleaned.push(chain[chain.length - 1]);
      chain = cleaned;
      if (!changed) break;
    }
  }

  // Trim initial points that travel opposite to the overall chain direction.
  // This happens at junction areas where the alt shares a few initial nodes
  // with the incoming track before diverging.
  if (chain.length >= 10) {
    const overallDir = {
      dlat: chain[chain.length - 1].lat - chain[0].lat,
      dlon: chain[chain.length - 1].lon - chain[0].lon
    };
    let trimCount = 0;
    for (let i = 0; i < Math.min(Math.floor(chain.length / 4), 5); i++) {
      if (i >= chain.length - 2) break;
      const segDir = { dlat: chain[i + 1].lat - chain[i].lat, dlon: chain[i + 1].lon - chain[i].lon };
      const dot = overallDir.dlat * segDir.dlat + overallDir.dlon * segDir.dlon;
      if (dot < 0) trimCount = i + 1;
      else break;
    }
    if (trimCount > 0) {
      console.log(`[Alt Chain] Trimmed ${trimCount} initial wrong-direction points`);
      chain = chain.slice(trimCount);
    }
  }

  // ── Convergence trimming: remove tails that run close to main ──
  // If the alt converges to run parallel with main, trim the parallel section
  // but keep the very last point as the convergence endpoint.
  // Scan the entire chain to find the divergent core (last/first points above
  // threshold), tolerating scattered near-boundary points.
  const CONVERGENCE_TRIM_M = 25;
  if (chain.length >= 6) {
    // Compute distance to main for every point
    const dists = chain.map(p => minDistanceToLineMeters(p, mainCenterlineCoords));

    // Find the last point from the tail that's clearly divergent (>= threshold)
    let lastDivergent = chain.length - 1;
    for (let i = chain.length - 1; i >= 0; i--) {
      if (dists[i] >= CONVERGENCE_TRIM_M) { lastDivergent = i; break; }
    }

    // Find the first point from the head that's clearly divergent
    let firstDivergent = 0;
    for (let i = 0; i < chain.length; i++) {
      if (dists[i] >= CONVERGENCE_TRIM_M) { firstDivergent = i; break; }
    }

    // Trim tail: keep up to lastDivergent, plus original last point as connection
    if (lastDivergent < chain.length - 3) {
      const trimmed = chain.length - 1 - lastDivergent - 1;
      const lastPt = chain[chain.length - 1];
      chain = [...chain.slice(0, lastDivergent + 1), lastPt];
      dists.length = lastDivergent + 2; // keep dists array in sync
      console.log(`[Alt Chain] Convergence-trimmed ${trimmed} tail points within ${CONVERGENCE_TRIM_M}m of main`);
    }

    // Trim head: keep from firstDivergent onward, plus original first point as connection
    if (firstDivergent > 2) {
      const firstPt = chain[0];
      chain = [firstPt, ...chain.slice(firstDivergent)];
      console.log(`[Alt Chain] Convergence-trimmed ${firstDivergent - 1} head points within ${CONVERGENCE_TRIM_M}m of main`);
    }
  }

  return { chain, visited, maxDeviation, reconverged };
}
