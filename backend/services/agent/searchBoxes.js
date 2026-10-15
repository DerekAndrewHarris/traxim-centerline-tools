/**
 * Search boxes worked out on the server (agent sessions).
 *
 * Same rule as the web page (osm-workflow.js, buildAndDrawBboxes): one tight
 * box between each pair of consecutive waypoints, with no margin. A box does
 * not need to enclose the whole line, only touch it, so the section search
 * finds every railway relation that passes through it.
 *
 * Kept identical to the web page on purpose, so an agent session and a
 * website session with the same waypoints find the same sections.
 */

/**
 * @param {Array<{lat: number, lon: number}>} points - waypoints in route order
 * @returns {Array<{minLat: number, minLon: number, maxLat: number, maxLon: number}>}
 */
export function computeSearchBboxes(points) {
  const bboxes = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    bboxes.push({
      minLat: Math.min(a.lat, b.lat),
      minLon: Math.min(a.lon, b.lon),
      maxLat: Math.max(a.lat, b.lat),
      maxLon: Math.max(a.lon, b.lon)
    });
  }
  return bboxes;
}
