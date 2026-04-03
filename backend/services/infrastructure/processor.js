/**
 * Infrastructure Processor Service
 * 
 * Core algorithms for railway infrastructure generation from OSM topology:
 * - Topology adjacency graph construction
 * - Chain following through degree-2 nodes
 * - F/T/D branch assignment for turnout nodes
 * - Spatial separation enforcement
 * - Platform insertion
 * - Reciprocal link enforcement
 */

// Constants
const MIN_NODE_SPACING_M = 30;  // Minimum 30m spacing between consecutive nodes (Traxim requires ≥25.1m)
const SNAP_THRESHOLD_M = 0.5;   // 0.5m threshold for coordinate matching
const COORD_PRECISION = 7;      // ~1cm precision for coordinate keys

/**
 * Calculate haversine distance between two points in metres.
 * @param {{lat: number, lon: number}} a - First point
 * @param {{lat: number, lon: number}} b - Second point
 * @returns {number} Distance in metres
 */
function haversineM(a, b) {
  const R = 6371000; // Earth radius in metres
  const φ1 = (a.lat * Math.PI) / 180;
  const φ2 = (b.lat * Math.PI) / 180;
  const Δφ = ((b.lat - a.lat) * Math.PI) / 180;
  const Δλ = ((b.lon - a.lon) * Math.PI) / 180;

  const sinΔφ = Math.sin(Δφ / 2);
  const sinΔλ = Math.sin(Δλ / 2);
  const a0 = sinΔφ * sinΔφ + Math.cos(φ1) * Math.cos(φ2) * sinΔλ * sinΔλ;
  const c = 2 * Math.atan2(Math.sqrt(a0), Math.sqrt(1 - a0));

  return R * c;
}

/**
 * Sanitize name for CSV output (replace European decimal commas, remove other commas)
 * @param {string} name - Raw name
 * @returns {string} Sanitized name
 */
function sanitiseName(name) {
  return name
    .replace(/(\d),(\d)/g, '$1.$2')  // European decimal comma → period
    .replace(/,/g, '');              // Remove remaining commas
}

/**
 * Parse coordinate key into lat/lon object
 * @param {string} coordKey - "lat,lon" string
 * @returns {{lat: number, lon: number}}
 */
function parseCoordKey(coordKey) {
  const [latStr, lonStr] = coordKey.split(',');
  return { lat: parseFloat(latStr), lon: parseFloat(lonStr) };
}

/**
 * Generate coordinate key from lat/lon
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @returns {string} "lat,lon" key
 */
function makeCoordKey(lat, lon) {
  return `${lat.toFixed(COORD_PRECISION)},${lon.toFixed(COORD_PRECISION)}`;
}

/**
 * Build topology adjacency graph from OSM ways.
 * For each coordinate appearing in any way, create an entry mapping it to all
 * ways that have it as an endpoint (first or last node).
 * @param {{ways: Array<{id: string, nodes: string[], coords: Array<{lat: number, lon: number}>}>}} topology
 * @returns {Map<string, Array<{wayId: string, otherKey: string, isForward: boolean}>>}
 */
function buildTopologyAdj(topology) {
  const adj = new Map();

  for (const way of topology.ways) {
    if (!way.coords || way.coords.length < 2) continue;

    const firstCoord = way.coords[0];
    const lastCoord = way.coords[way.coords.length - 1];
    const firstKey = makeCoordKey(firstCoord.lat, firstCoord.lon);
    const lastKey = makeCoordKey(lastCoord.lat, lastCoord.lon);

    // Add first endpoint
    if (!adj.has(firstKey)) adj.set(firstKey, []);
    adj.get(firstKey).push({
      wayId: way.id,
      otherKey: lastKey,
      isForward: true
    });

    // Add last endpoint
    if (!adj.has(lastKey)) adj.set(lastKey, []);
    adj.get(lastKey).push({
      wayId: way.id,
      otherKey: firstKey,
      isForward: false
    });
  }

  return adj;
}

/**
 * Detect intermediate junction nodes (switches, crossings) that should split ways.
 * Only nodes shared by multiple ways are true junctions (not just intermediate points).
 * @param {{ways: Array}} topology
 * @returns {{ways: Array, _splitWaysCount: number}}
 */
function splitWaysAtIntermediateJunctions(topology) {
  const { ways, taggedNodes = [] } = topology;
  
  // Build node usage map: how many ways use each node
  const nodeUsage = new Map();
  for (const way of ways) {
    for (const nodeId of way.nodes || []) {
      nodeUsage.set(nodeId, (nodeUsage.get(nodeId) || 0) + 1);
    }
  }

  // Find nodes shared by 2+ ways (true junctions)
  const junctionNodeIds = new Set(
    [...nodeUsage.entries()]
      .filter(([, count]) => count >= 2)
      .map(([nodeId]) => nodeId)
  );

  // Split ways at junction nodes
  let splitCount = 0;
  const splitWays = [];

  for (const way of ways) {
    const { nodes = [], coords = [] } = way;
    if (nodes.length < 3) {
      splitWays.push(way);
      continue;
    }

    // Find junction nodes within this way (excluding endpoints)
    const splitIndices = [];
    for (let i = 1; i < nodes.length - 1; i++) {
      if (junctionNodeIds.has(nodes[i])) {
        splitIndices.push(i);
      }
    }

    if (splitIndices.length === 0) {
      splitWays.push(way);
      continue;
    }

    // Split way into segments at junction nodes
    let prevIdx = 0;
    for (const splitIdx of splitIndices) {
      const segmentNodes = nodes.slice(prevIdx, splitIdx + 1);
      const segmentCoords = coords.slice(prevIdx, splitIdx + 1);
      
      if (segmentNodes.length >= 2) {
        splitWays.push({
          ...way,
          id: `${way.id}_${prevIdx}`,
          nodes: segmentNodes,
          coords: segmentCoords
        });
        splitCount++;
      }
      
      prevIdx = splitIdx;
    }

    // Add final segment
    const finalNodes = nodes.slice(prevIdx);
    const finalCoords = coords.slice(prevIdx);
    if (finalNodes.length >= 2) {
      splitWays.push({
        ...way,
        id: prevIdx === 0 ? way.id : `${way.id}_${prevIdx}`,
        nodes: finalNodes,
        coords: finalCoords
      });
    }
  }

  return {
    ways: splitWays,
    taggedNodes,
    _splitWaysCount: splitCount
  };
}

/**
 * Compute direction vector from a coord key along a way.
 * Returns unit vector pointing away from the coord key toward the other end.
 * @param {string} coordKey - Starting coordinate key
 * @param {string} wayId - Way ID
 * @param {Map<string, {coords: Array<{lat: number, lon: number}>}>} waysById - Ways keyed by ID
 * @returns {{dlat: number, dlon: number}} Direction vector
 */
function computeWayDirection(coordKey, wayId, waysById) {
  const way = waysById.get(wayId);
  if (!way || !way.coords || way.coords.length < 2) {
    return { dlat: 0, dlon: 0 };
  }

  const { lat, lon } = parseCoordKey(coordKey);
  const coords = way.coords;
  const firstKey = makeCoordKey(coords[0].lat, coords[0].lon);
  const isAtStart = firstKey === coordKey;

  let dlat, dlon;
  if (isAtStart) {
    // Direction from start toward second point
    dlat = coords[1].lat - coords[0].lat;
    dlon = coords[1].lon - coords[0].lon;
  } else {
    // Direction away from node (end toward second-to-last point)
    const lastIdx = coords.length - 1;
    dlat = coords[lastIdx - 1].lat - coords[lastIdx].lat;
    dlon = coords[lastIdx - 1].lon - coords[lastIdx].lon;
  }

  const mag = Math.sqrt(dlat * dlat + dlon * dlon) || 1;
  return { dlat: dlat / mag, dlon: dlon / mag };
}

/**
 * Follow a chain of degree-2 nodes from a starting key along a way until reaching
 * a node with degree ≠ 2 (or exit the section).
 * @param {string} startKey - Starting coordinate key
 * @param {string} wayId - Way ID to follow
 * @param {Map<string, Object>} waysById - Ways keyed by ID
 * @param {Map<string, Array>} adj - Topology adjacency graph
 * @param {Set<string>} sectionNodeKeys - Valid node keys for this section
 * @returns {{reachedKey: string, arrivedViaWayId: string} | null}
 */
function followChainToNode(startKey, wayId, waysById, adj, sectionNodeKeys) {
  const way = waysById.get(wayId);
  if (!way || !way.coords || way.coords.length < 2) return null;

  // Determine which end of the way to start from
  const coords = way.coords;
  const firstKey = makeCoordKey(coords[0].lat, coords[0].lon);
  const lastKey = makeCoordKey(coords[coords.length - 1].lat, coords[coords.length - 1].lon);

  let currentKey;
  if (firstKey === startKey) {
    currentKey = lastKey;
  } else if (lastKey === startKey) {
    currentKey = firstKey;
  } else {
    return null; // startKey not an endpoint of this way
  }

  let currentWayId = wayId;
  const MAX_CHAIN_LENGTH = 1000;
  let chainLength = 0;

  while (chainLength < MAX_CHAIN_LENGTH) {
    chainLength++;

    // Check if we've reached a section node
    if (sectionNodeKeys.has(currentKey)) {
      return { reachedKey: currentKey, arrivedViaWayId: currentWayId };
    }

    // Get connections at current key
    const conns = adj.get(currentKey) || [];
    
    // Filter out the way we came from
    const nextConns = conns.filter(c => c.wayId !== currentWayId);

    if (nextConns.length === 0) {
      // Dead end - this is a section boundary
      return { reachedKey: currentKey, arrivedViaWayId: currentWayId };
    }

    if (nextConns.length === 1) {
      // Degree-2 node - continue chain
      const nextConn = nextConns[0];
      currentWayId = nextConn.wayId;
      currentKey = nextConn.otherKey;
    } else {
      // Degree ≥ 3 - reached a junction
      return { reachedKey: currentKey, arrivedViaWayId: currentWayId };
    }
  }

  // Chain too long - safety exit
  return null;
}

/**
 * Determine which branch (F/T/D) a way arrives at on a node.
 * For degree-3 nodes: angle analysis to find through route vs diverging.
 * For degree-2 nodes: F if toward lower km, T if toward higher km.
 * @param {string} nodeKey - Node coordinate key
 * @param {Array<{wayId: string}>} nodeConns - Connections at this node
 * @param {string} arrivedViaWayId - Way ID we arrived on
 * @param {Map<string, Object>} waysById - Ways keyed by ID
 * @param {number} nodeKm - Node's km value (for F/T ordering)
 * @param {number} sourceNodeKm - Source node's km (null if unknown)
 * @returns {'F' | 'T' | 'D' | null}
 */
function determineBranch(nodeKey, nodeConns, arrivedViaWayId, waysById, nodeKm, sourceNodeKm) {
  const degree = nodeConns.length;
  if (degree === 1) {
    // End node - always F
    return 'F';
  }

  if (degree === 2) {
    // Through node - map the two wayIds to F and T deterministically.
    // Which is which doesn't matter much; reciprocal enforcement will fix up.
    return nodeConns[0].wayId === arrivedViaWayId ? 'F' : 'T';
  }

  if (degree >= 3) {
    // Turnout - branch identification.
    // Primary signal: OSM way continuity.  After splitting at intermediate
    // junctions, two segments of the same original way share a base ID
    // (e.g. "1117308999_0" and "1117308999_2").  These are definitively the
    // through pair (F-T); the odd one out is D.
    // Fallback: angle-based analysis (most-opposite dot product) when no
    // shared base way ID exists.

    const dirs = nodeConns.map(c => {
      if (c._isSynthetic && c.otherKey) {
        const { lat: la1, lon: lo1 } = parseCoordKey(nodeKey);
        const { lat: la2, lon: lo2 } = parseCoordKey(c.otherKey);
        const dlat = la2 - la1;
        const dlon = lo2 - lo1;
        const mag = Math.sqrt(dlat * dlat + dlon * dlon) || 1;
        return { wayId: c.wayId, dlat: dlat / mag, dlon: dlon / mag };
      }
      return {
        wayId: c.wayId,
        ...computeWayDirection(nodeKey, c.wayId, waysById)
      };
    });

    // --- Way-continuity through-pair detection ---
    // Extract base way ID by stripping the _N split suffix
    const baseId = (id) => id.replace(/_\d+$/, '');
    let ftIdx1 = -1, ftIdx2 = -1;

    if (degree === 3) {
      const bases = dirs.map(d => baseId(d.wayId));
      for (let i = 0; i < 3; i++) {
        for (let j = i + 1; j < 3; j++) {
          if (bases[i] === bases[j]) {
            ftIdx1 = i;
            ftIdx2 = j;
          }
        }
      }
    }

    // --- Fallback: angle-based through-pair detection ---
    if (ftIdx1 < 0) {
      let minDot = Infinity;
      ftIdx1 = 0; ftIdx2 = 1;
      for (let i = 0; i < dirs.length; i++) {
        for (let j = i + 1; j < dirs.length; j++) {
          const dot = dirs[i].dlat * dirs[j].dlat + dirs[i].dlon * dirs[j].dlon;
          if (dot < minDot) {
            minDot = dot;
            ftIdx1 = i;
            ftIdx2 = j;
          }
        }
      }
    }

    // Step 2: The remaining way is D (diverging branch)
    const dIdx = [0, 1, 2].find(k => k !== ftIdx1 && k !== ftIdx2) ?? 0;
    const dWay = dirs[dIdx].wayId;
    if (arrivedViaWayId === dWay) return 'D';

    // Step 3: Of F and T, the one with the smallest angle to D (largest
    //         dot product with D) is T — it sits on the turnout side.
    const dotFT1_D = dirs[ftIdx1].dlat * dirs[dIdx].dlat + dirs[ftIdx1].dlon * dirs[dIdx].dlon;
    const dotFT2_D = dirs[ftIdx2].dlat * dirs[dIdx].dlat + dirs[ftIdx2].dlon * dirs[dIdx].dlon;

    const tWay = dotFT1_D > dotFT2_D ? dirs[ftIdx1].wayId : dirs[ftIdx2].wayId;
    const fWay = dotFT1_D > dotFT2_D ? dirs[ftIdx2].wayId : dirs[ftIdx1].wayId;
    if (arrivedViaWayId === fWay) return 'F';
    if (arrivedViaWayId === tWay) return 'T';
  }

  return 'T';
}

/**
 * Find nearest km value on geometry line to a given point.
 * @param {{lat: number, lon: number}} point - Point to match
 * @param {Array<{lat: number, lon: number, km: number}>} geometryPoints - Geometry line points
 * @returns {number} Nearest km value
 */
function nearestKm(point, geometryPoints) {
  return projectOntoGeometry(point, geometryPoints).km;
}

/**
 * Project a point onto the nearest segment of the geometry polyline.
 * Returns the interpolated km AND the projected lat/lon on the centerline.
 */
function projectOntoGeometry(point, geometryPoints) {
  if (geometryPoints.length === 0) return { km: 0, projLat: point.lat, projLon: point.lon };
  if (geometryPoints.length === 1) {
    const gp = geometryPoints[0];
    return { km: gp.km, projLat: gp.lat, projLon: gp.lon };
  }

  const cosLat = Math.cos(point.lat * Math.PI / 180);
  let bestDistSq = Infinity;
  let bestKm = geometryPoints[0].km;
  let bestLat = geometryPoints[0].lat;
  let bestLon = geometryPoints[0].lon;
  let bestSegIdx = 0;
  let bestT = 0;

  for (let i = 0; i < geometryPoints.length - 1; i++) {
    const a = geometryPoints[i];
    const b = geometryPoints[i + 1];

    // Work in a locally-flat coordinate system (scale lon by cosLat)
    const ax = a.lon * cosLat, ay = a.lat;
    const bx = b.lon * cosLat, by = b.lat;
    const px = point.lon * cosLat, py = point.lat;

    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;

    let t;
    if (lenSq < 1e-20) {
      t = 0;
    } else {
      t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
      t = Math.max(0, Math.min(1, t));
    }

    const projX = ax + t * dx;
    const projY = ay + t * dy;
    const distSq = (px - projX) ** 2 + (py - projY) ** 2;

    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestKm = a.km + t * (b.km - a.km);
      bestLat = a.lat + t * (b.lat - a.lat);
      bestLon = a.lon + t * (b.lon - a.lon);
      bestSegIdx = i;
      bestT = t;
    }
  }

  // Extrapolate km beyond geometry endpoints: when the nearest projection
  // is at the very start (segment 0, t=0) or very end (last segment, t=1),
  // extend linearly along that segment's direction instead of clamping.
  const last = geometryPoints.length - 2;
  if (bestSegIdx === 0 && bestT === 0) {
    const a = geometryPoints[0], b = geometryPoints[1];
    const ax = a.lon * cosLat, ay = a.lat;
    const bx = b.lon * cosLat, by = b.lat;
    const px = point.lon * cosLat, py = point.lat;
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq > 1e-20) {
      const t = ((px - ax) * dx + (py - ay) * dy) / lenSq; // unclamped
      if (t < 0) {
        bestKm = a.km + t * (b.km - a.km);
        bestLat = a.lat + t * (b.lat - a.lat);
        bestLon = a.lon + t * (b.lon - a.lon);
      }
    }
  } else if (bestSegIdx === last && bestT === 1) {
    const a = geometryPoints[last], b = geometryPoints[last + 1];
    const ax = a.lon * cosLat, ay = a.lat;
    const bx = b.lon * cosLat, by = b.lat;
    const px = point.lon * cosLat, py = point.lat;
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq > 1e-20) {
      const t = ((px - ax) * dx + (py - ay) * dy) / lenSq; // unclamped
      if (t > 1) {
        bestKm = a.km + t * (b.km - a.km);
        bestLat = a.lat + t * (b.lat - a.lat);
        bestLon = a.lon + t * (b.lon - a.lon);
      }
    }
  }

  return { km: bestKm, projLat: bestLat, projLon: bestLon };
}

/**
 * Apply spatial separation to connected nodes that are closer than MIN_NODE_SPACING_M.
 * Pushes nodes apart from their centrepoint to maintain minimum spacing.
 * @param {Array<Object>} nodes - All infrastructure nodes
 * @param {Array<string>} warnings - Warning messages array
 * @returns {number} Number of node pairs separated
 */
function applySpatialSeparation(nodes, warnings) {
  const MAX_ITERATIONS = 10;
  let separationCount = 0;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    let adjustmentsMade = false;

    for (const node of nodes) {
      for (const branch of ['F', 'T', 'D']) {
        const branchFieldNode = branch === 'F' ? 'fNode' : branch === 'T' ? 'tNode' : 'dNode';
        const connectedName = node[branchFieldNode];
        if (!connectedName) continue;

        const connected = nodes.find(n => n.name === connectedName);
        if (!connected) continue;

        // Skip degree-4 partners (already spatially separated at creation)
        if (node._degree4Partner === connected || connected._degree4Partner === node) continue;

        // Compute distance in metres (not degree space) to avoid
        // longitude-scaling error at mid-latitudes
        const centLat = (node.lat + connected.lat) / 2;
        const cosLat = Math.cos(centLat * Math.PI / 180);
        const dlatM = (connected.lat - node.lat) * 111320;
        const dlonM = (connected.lon - node.lon) * 111320 * cosLat;
        const dist = Math.sqrt(dlatM * dlatM + dlonM * dlonM);

        if (dist < MIN_NODE_SPACING_M) {
          let unitDlatM, unitDlonM;

          if (dist > 0) {
            unitDlatM = dlatM / dist;
            unitDlonM = dlonM / dist;
          } else {
            unitDlatM = 1;
            unitDlonM = 0;
          }

          const centLon = (node.lon + connected.lon) / 2;
          const halfSpacing = MIN_NODE_SPACING_M / 2;

          node.lat      = centLat - unitDlatM * halfSpacing / 111320;
          node.lon      = centLon - unitDlonM * halfSpacing / (111320 * cosLat);
          connected.lat = centLat + unitDlatM * halfSpacing / 111320;
          connected.lon = centLon + unitDlonM * halfSpacing / (111320 * cosLat);

          adjustmentsMade = true;

          if (iteration === 0) {
            separationCount++;
            warnings.push(
              `Spatial separation: "${node.name}" ${branch}-branch → "${connected.name}" ` +
              `were ${dist.toFixed(1)}m apart (< ${MIN_NODE_SPACING_M}m) — pushed apart to ${MIN_NODE_SPACING_M}m.`
            );
          }
        }
      }
    }

    if (!adjustmentsMade) break;
  }

  return separationCount;
}

/**
 * Enforce reciprocal links: every connection must be bidirectional.
 * If A's F-arm connects to B's T-arm, then B's T-arm must connect back to A's F-arm.
 * @param {Array<Object>} nodes - All infrastructure nodes
 * @param {Array<string>} warnings - Warning messages array
 * @returns {number} Number of links fixed
 */
function enforceReciprocalLinks(nodes, warnings) {
  const nodeByName = new Map(nodes.map(n => [n.name, n]));
  let fixCount = 0;

  for (const node of nodes) {
    for (const [armField, branchField] of [
      ['fNode', 'fOnBranch'],
      ['tNode', 'tOnBranch'],
      ['dNode', 'dOnBranch']
    ]) {
      const targetName = node[armField];
      const targetBranch = node[branchField];

      if (!targetName || !targetBranch) continue;

      const targetNode = nodeByName.get(targetName);
      if (!targetNode) {
        warnings.push(`Broken link: "${node.name}" ${armField} → "${targetName}" (node not found)`);
        continue;
      }

      const targetArmField = targetBranch === 'F' ? 'fNode' :
                             targetBranch === 'T' ? 'tNode' : 'dNode';
      const targetArmBranchField = targetBranch === 'F' ? 'fOnBranch' :
                                    targetBranch === 'T' ? 'tOnBranch' : 'dOnBranch';

      const sourceBranch = armField === 'fNode' ? 'F' :
                           armField === 'tNode' ? 'T' : 'D';

      const reciprocalName = targetNode[targetArmField];
      const reciprocalBranch = targetNode[targetArmBranchField];

      if (reciprocalName !== node.name || reciprocalBranch !== sourceBranch) {
        if (reciprocalName && reciprocalName !== node.name) {
          // Target arm is already occupied by a DIFFERENT node.
          // Check if that other node's corresponding arm points back correctly
          // (i.e. the existing link is already a valid reciprocal pair).
          // If so, do NOT overwrite — the current node's claim is the stale one.
          const otherNode = nodeByName.get(reciprocalName);
          if (otherNode) {
            const otherArmField = reciprocalBranch === 'F' ? 'fNode' :
                                  reciprocalBranch === 'T' ? 'tNode' : 'dNode';
            if (otherNode[otherArmField] === targetName) {
              // Existing reciprocal pair is valid — skip overwrite, clear stale claim
              warnings.push(
                `Link conflict: "${node.name}" ${sourceBranch}-arm → "${targetName}" ${targetBranch}-arm, ` +
                `but "${targetName}" ${targetBranch}-arm already has valid reciprocal with "${reciprocalName}". ` +
                `Clearing stale claim on "${node.name}" ${sourceBranch}-arm.`
              );
              node[armField] = '';
              node[branchField] = '';
              continue;
            }
          }
          warnings.push(
            `Link conflict: "${node.name}" ${sourceBranch}-arm → "${targetName}" ${targetBranch}-arm, ` +
            `but "${targetName}" ${targetBranch}-arm → "${reciprocalName}" ${reciprocalBranch ?? '?'}-arm. ` +
            `Overwriting to establish reciprocal link.`
          );
        }

        targetNode[targetArmField] = node.name;
        targetNode[targetArmBranchField] = sourceBranch;
        fixCount++;
      }
    }
  }

  if (fixCount > 0) {
    warnings.push(`Reciprocal link enforcement: fixed ${fixCount} one-way links to be bidirectional.`);
  }

  return fixCount;
}

export {
  MIN_NODE_SPACING_M,
  SNAP_THRESHOLD_M,
  COORD_PRECISION,
  haversineM,
  sanitiseName,
  parseCoordKey,
  makeCoordKey,
  buildTopologyAdj,
  splitWaysAtIntermediateJunctions,
  computeWayDirection,
  followChainToNode,
  determineBranch,
  nearestKm,
  projectOntoGeometry,
  applySpatialSeparation,
  enforceReciprocalLinks
};
