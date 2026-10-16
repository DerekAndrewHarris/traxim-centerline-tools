/**
 * Readable summaries for the agent: the numbered list of sections the user
 * chooses from in chat, warnings shortened to a sensible size, and the
 * per-route geometry summary.
 */

const EARTH_RADIUS_KM = 6371.0088;

function haversineKm(a, b) {
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Total length of a section's OSM ways, from the preview geometry the
 * section search already fetched ([[lat, lon], ...] per way). Double track,
 * sidings and both directions of a route are all counted, so this can be
 * more than the length of the line itself. null if there is no geometry
 * (the preview fetch can fail without failing the search).
 * @param {Array<Array<[number, number]>>} geometry
 * @returns {number|null} kilometres, 1 decimal place
 */
export function sectionLengthKm(geometry) {
  if (!Array.isArray(geometry) || geometry.length === 0) return null;
  let km = 0;
  for (const line of geometry) {
    if (!Array.isArray(line)) continue;
    for (let i = 1; i < line.length; i++) km += haversineKm(line[i - 1], line[i]);
  }
  return Math.round(km * 10) / 10;
}

/**
 * Labels for each leg (pair of consecutive waypoints), e.g. "Genova - Sestri Levante".
 * @param {Array<object>} geocodedPlaces
 * @returns {string[]}
 */
export function legLabels(geocodedPlaces) {
  const name = (p, i) => (p ? (p.stationName || p.place || `Waypoint ${i + 1}`) : `Waypoint ${i + 1}`);
  const labels = [];
  for (let i = 0; i < geocodedPlaces.length - 1; i++) {
    labels.push(`${name(geocodedPlaces[i], i)} - ${name(geocodedPlaces[i + 1], i + 1)}`);
  }
  return labels;
}

/**
 * The numbered section list shown to the user (numbers start at 1).
 * @param {Array<object>} candidateSections - from session.json
 * @param {string[]} legs - from legLabels()
 */
export function summariseSections(candidateSections, legs) {
  return (candidateSections || []).map((s, index) => {
    const summary = {
      number: index + 1,
      name: s.name || 'Unnamed section',
      ref: s.ref || null,
      from: s.from || null,
      to: s.to || null,
      operator: s.operator || null,
      network: s.network || null,
      kind: s.osmType === 'relation'
        ? (s.type === 'railway' ? 'railway line (infrastructure relation)' : `${s.type || 'route'} service route (relation)`)
        : `single named way (${s.type || 'railway'})`,
      length_km: sectionLengthKm(s.geometry),
      ways: Array.isArray(s.wayIds) ? s.wayIds.length : 0,
      found_on_legs: (s.segmentIndices || []).map(i => legs[i] || `leg ${i + 1}`),
      osm: `${s.osmType} ${s.osmId}`,
      osm_url: `https://www.openstreetmap.org/${s.osmType}/${s.osmId}`
    };
    for (const k of Object.keys(summary)) {
      if (summary[k] === null) delete summary[k];
    }
    return summary;
  });
}

/**
 * Shorten a list of generator warnings for the agent: some are long
 * diagnostic lists (e.g. every station name found). Keeps the order.
 * @param {string[]} warnings
 * @param {{maxItems?: number, maxChars?: number}} [options]
 * @returns {{warnings: string[], omitted: number}}
 */
export function shortenWarnings(warnings, { maxItems = 20, maxChars = 400 } = {}) {
  const list = Array.isArray(warnings) ? warnings.filter(w => typeof w === 'string') : [];
  const kept = list.slice(0, maxItems).map(w =>
    w.length > maxChars ? `${w.slice(0, maxChars)}... (shortened; ${w.length} characters in full)` : w
  );
  return { warnings: kept, omitted: Math.max(0, list.length - kept.length) };
}

/**
 * Per-route summary of a geometry job result, without server paths or
 * large data.
 * @param {object} geometryResult - from runGeometryGeneration
 */
export function summariseGeometry(geometryResult) {
  return (geometryResult.results || []).map(r => {
    if (r.error) return { route: r.section, error: r.error };
    const summary = {
      route: r.section,
      length_km: typeof r.lengthKm === 'number' ? Math.round(r.lengthKm * 10) / 10 : undefined,
      points: r.pointCount,
      alternative_routes: r.alternativeCount || 0
    };
    if (r.elevation) summary.elevation_data = r.elevation.ok !== false;
    const altsWithout = (r.alternativeElevation || []).filter(a => a.ok === false).length;
    if (altsWithout > 0) summary.alternative_routes_without_elevation = altsWithout;
    // How much the maximum-gradient smoothing changed this route's profile
    // (compare runs with different max_gradient_percent).
    if (r.smoothing) {
      summary.smoothing_points_adjusted = r.smoothing.adjustedCount;
      summary.smoothing_largest_change_m = Math.round((r.smoothing.maxAdjustmentM || 0) * 10) / 10;
    }
    return summary;
  });
}

/**
 * Speedboards summary for the agent (from runGeometryGeneration's
 * `speedboards`). With no speed data it says so plainly, with the advice.
 * @param {object} sb
 */
export function summariseSpeedboards(sb) {
  if (!sb) return undefined;
  if (!sb.file) {
    return { file_made: false, note: (sb.warnings && sb.warnings[0]) || 'No Speedboards file was made.' };
  }
  const summary = {
    rows: sb.boardCount,
    routes_with_speed_data: sb.regionsWithData,
    routes: sb.regionCount,
    no_speed_data: !!sb.noSpeedData
  };
  if (sb.noSpeedData) {
    summary.note = 'No speed data was found in OpenStreetMap for these routes: the Speedboards file is valid but has no speedboards. ' +
      'Tell the user, and that speeds can still be managed with Auto-Curve Speed Limiting in the settings.';
  }
  return summary;
}
