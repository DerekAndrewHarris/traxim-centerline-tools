/**
 * Parallel Track Divergence Detection
 * 
 * PROBLEM:
 * Some railway corridors have alternative routes that diverge significantly
 * (>50m separation) and later reconverge. Examples:
 * - La Spezia parallel tunnels (~300m apart)
 * - Freight bypass routes vs passenger routes  
 * - Old vs new alignments
 * 
 * Current behavior: chainWaysViaGraph() picks the "straightest" path at each
 * junction and excludes diverging branches. This loses alternative routes.
 * 
 * REQUIREMENT:
 * 1. Detect where ways diverge >50m from the main centerline
 * 2. Identify if they reconverge within 8m
 * 3. If they represent a true alternative route (diverge + reconverge),
 *    create separate centerline or mark as parallel alternative
 * 
 * IMPLEMENTATION OPTIONS:
 * 
 * A) DUAL CENTERLINES (recommended for simulation):
 *    - Detect divergence/reconvergence points
 *    - Build separate geometry for parallel section
 *    - Mark divergence/convergence junctions in Infrastructure.csv
 *    - Simulator can choose between alternatives for routing
 * 
 * B) SINGLE AVERAGED CENTERLINE (current behavior):
 *    - Continue using one representative path
 *    - Accept that some alternative routes are excluded
 *    - Document excluded ways in topology.json
 * 
 * C) TOPOLOGY-BASED ALTERNATIVES:
 *    - Keep single geometry file per segment
 *    - Add "alternativePaths" section to topology.json
 *    - List divergence points, parallel ways, convergence points
 *    - Infrastructure generation uses this for junction modeling
 */

/**
 * Analyze excluded ways to find potential alternative routes.
 * 
 * An "alternative route" is a sequence of ways that:
 * 1. Diverges from the main centerline (>50m separation)  
 * 2. Runs parallel for significant distance (>500m)
 * 3. Reconverges to main centerline (<8m)
 * 
 * @param {number[]} wayIds - All fetched way IDs
 * @param {Map<number, {lat, lon}[]>} wayGeometry - Geometry for each way
 * @param {Set<number>} visitedWayIds - Ways included in main centerline
 * @param {{lat, lon}[]} centerlineCoords - Main centerline coordinates
 * @returns {{
 *   divergencePoints: Array<{km, lat, lon, separationM}>,
 *   alternativeRoutes: Array<{
 *     wayIds: number[],
 *     divergenceKm: number,
 *     convergenceKm: number,
 *     maxSeparationM: number,
 *     lengthKm: number
 *   }>
 * }}
 */
export function detectAlternativeRoutes(wayIds, wayGeometry, visitedWayIds, centerlineCoords) {
  const excludedWayIds = wayIds.filter(wid => !visitedWayIds.has(wid));
  
  if (excludedWayIds.length === 0 || centerlineCoords.length === 0) {
    return { divergencePoints: [], alternativeRoutes: [] };
  }
  
  // TODO: Implementation
  // 1. For each excluded way, measure its avg distance from centerline  
  // 2. Group excluded ways that connect to each other
  // 3. Find groups that have both endpoints near centerline (<8m)
  // 4. Check if middle section is >50m from centerline
  // 5. Return as alternative route candidates
  
  return { divergencePoints: [], alternativeRoutes: [] };
}

/**
 * Find the nearest point on the centerline to a given point.
 * Returns {index, distance, lat, lon} of nearest centerline point.
 */
function nearestCenterlinePoint(point, centerlineCoords) {
  let minDist = Infinity;
  let minIdx = 0;
  
  for (let i = 0; i < centerlineCoords.length; i++) {
    const cp = centerlineCoords[i];
    const dist = haversineMeters(point.lat, point.lon, cp.lat, cp.lon);
    if (dist < minDist) {
      minDist = dist;
      minIdx = i;
    }
  }
  
  return {
    index: minIdx,
    distance: minDist,
    lat: centerlineCoords[minIdx].lat,
    lon: centerlineCoords[minIdx].lon
  };
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
