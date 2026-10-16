/**
 * Speedboards.csv from OpenStreetMap speed tags (October 2026).
 *
 * Source data: the railway ways the geometry step already fetched (from the
 * File Generator's own Overpass mirror) and saved in osm_topology.json, with
 * their tags. No extra queries.
 *
 * OSM tags used (OpenRailwayMap tagging, the convention in Italy, the UK and
 * Australia alike):
 *   maxspeed            line speed, both directions. km/h unless a unit is
 *                       given: "75 mph" (UK), "60 km/h", "40 knots".
 *   maxspeed:forward    speed in the direction the OSM way is drawn
 *   maxspeed:backward   speed against it
 * A list ("100;80") counts as its lowest value. Non-numbers ("none",
 * "signals") are ignored. Not used: maxspeed:tilting (tilting trains only),
 * and railway:maxspeed:straight / :diverging, which are tags on switch
 * NODES (turnout speeds), not on track. Ways tagged service=siding / yard /
 * spur / crossover are not used: their limits are not line speeds.
 *
 * File format: exactly what the resolver reads (TraximCore
 * Process/InputSpeedboards.cs):
 *   - header rows "KMDirectionSection,<speed class>,increasing|decreasing",
 *     one per value column, in column order; then a row starting
 *     "#TrainClasses", which ends the header;
 *   - data rows "<region>,<km>,<type>,<speed for column 1>,<speed for column 2>"
 *     (every row must have every column; empty = no board for that column;
 *     empty type = WholeOfTrain). A blank line in the data part would stop
 *     the resolver, so none is written.
 * One speed class, "Normal" (the class the generated Regions.csv defines),
 * in two columns: trains running towards increasing km, and towards
 * decreasing km. A board applies from its km onwards in its direction until
 * the next board.
 *
 * Alignment: each geometry point (every ~25 m) takes the speed of the
 * nearest usable OSM way within MATCH_DISTANCE_M; the way's direction at
 * that point says whether its "forward" is increasing or decreasing km.
 * Boards go where the speed changes, at geometry points, so they are never
 * more than one point (~25 m) from the real change, and always on the safe
 * side: a lower speed starts one point early, a higher speed one point
 * late. Track with no speed data keeps the speed from before it (as the
 * resolver does where there is no board); the first board of each direction
 * is at the start of the line (in that direction), with the first speed
 * found. A line with no speed data at all gets no boards.
 */

export const SPEED_CLASS = 'Normal';
export const MATCH_DISTANCE_M = 15;
const EXCLUDED_SERVICE = new Set(['siding', 'yard', 'spur', 'crossover']);
const MPH = 1.609344;
const KNOT = 1.852;

export const NO_SPEED_DATA_ADVICE =
  'Speeds can still be managed with Auto-Curve Speed Limiting in the settings, which limits speed on curves ' +
  'from the curve radius and the Regions file\'s superelevation and cant deficiency.';

/**
 * km/h from an OSM speed value, or null. Values in mph or knots are
 * converted and rounded DOWN to a whole km/h (75 mph = 120 km/h).
 * @param {string|undefined} value
 * @returns {number|null}
 */
export function parseSpeedKmh(value) {
  if (value === undefined || value === null) return null;
  const speeds = String(value).split(';').map(part => {
    const m = part.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph|knots)?$/);
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (m[2] === 'mph') return Math.floor(n * MPH);
    if (m[2] === 'knots') return Math.floor(n * KNOT);
    return n;
  }).filter(v => v !== null);
  return speeds.length > 0 ? Math.min(...speeds) : null;
}

/**
 * Speeds of one OSM way relative to the way's own drawing direction.
 * @param {object} tags
 * @returns {{forward: number|null, backward: number|null}}
 */
export function waySpeeds(tags = {}) {
  const both = parseSpeedKmh(tags.maxspeed);
  const fwd = parseSpeedKmh(tags['maxspeed:forward']);
  const bwd = parseSpeedKmh(tags['maxspeed:backward']);
  return { forward: fwd ?? both, backward: bwd ?? both };
}

function usableWay(way) {
  if (!way || !Array.isArray(way.coords) || way.coords.length < 2) return false;
  const tags = way.tags || {};
  if (tags.service && EXCLUDED_SERVICE.has(tags.service)) return false;
  const s = waySpeeds(tags);
  return s.forward !== null || s.backward !== null;
}

/** Spatial index of way segments in local metres, cell size ~ MATCH_DISTANCE_M * 4. */
function buildSegmentIndex(ways, origin) {
  const cosLat = Math.cos(origin.lat * Math.PI / 180);
  const toXY = (p) => ({ x: (p.lon - origin.lon) * 111320 * cosLat, y: (p.lat - origin.lat) * 111320 });
  const cell = MATCH_DISTANCE_M * 4;
  const grid = new Map();
  const key = (cx, cy) => `${cx},${cy}`;
  for (const way of ways) {
    const pts = way.coords.map(toXY);
    const speeds = waySpeeds(way.tags);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const seg = { a, b, speeds, wayId: way.id };
      const x0 = Math.floor((Math.min(a.x, b.x) - MATCH_DISTANCE_M) / cell), x1 = Math.floor((Math.max(a.x, b.x) + MATCH_DISTANCE_M) / cell);
      const y0 = Math.floor((Math.min(a.y, b.y) - MATCH_DISTANCE_M) / cell), y1 = Math.floor((Math.max(a.y, b.y) + MATCH_DISTANCE_M) / cell);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 10000) continue; // absurdly long segment: skip
      for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
        const k = key(cx, cy);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(seg);
      }
    }
  }
  return {
    toXY,
    near(p) { return grid.get(key(Math.floor(p.x / cell), Math.floor(p.y / cell))) || []; }
  };
}

/**
 * Speed at each geometry point, in each km direction.
 * @param {Array<{lat:number, lon:number, km:number}>} points - one region's geometry, in km order
 * @param {Array<{id, coords, tags}>} ways - OSM ways (osm_topology.json)
 * @returns {Array<{inc: number|null, dec: number|null}>}
 */
export function speedProfile(points, ways) {
  if (!points || points.length < 2) return (points || []).map(() => ({ inc: null, dec: null }));
  const index = buildSegmentIndex(ways.filter(usableWay), points[0]);
  const xy = points.map(index.toXY);
  return xy.map((p, i) => {
    // Direction of increasing km at this point.
    const prev = xy[Math.max(0, i - 1)], next = xy[Math.min(xy.length - 1, i + 1)];
    const gx = next.x - prev.x, gy = next.y - prev.y;
    let best = null, bestDist = Infinity;
    for (const seg of index.near(p)) {
      const dx = seg.b.x - seg.a.x, dy = seg.b.y - seg.a.y;
      const lenSq = dx * dx + dy * dy;
      const t = lenSq < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.x - seg.a.x) * dx + (p.y - seg.a.y) * dy) / lenSq));
      const d = Math.hypot(p.x - (seg.a.x + t * dx), p.y - (seg.a.y + t * dy));
      if (d < bestDist) { bestDist = d; best = { seg, dx, dy }; }
    }
    if (!best || bestDist > MATCH_DISTANCE_M) return { inc: null, dec: null };
    const sameWay = best.dx * gx + best.dy * gy >= 0;
    const { forward, backward } = best.seg.speeds;
    return sameWay ? { inc: forward, dec: backward } : { inc: backward, dec: forward };
  });
}

/**
 * Board positions for one direction.
 * @param {number[]} order - point indices in the order a train passes them
 * @param {Array<number|null>} speeds - speed at each point (by index)
 * @returns {Array<{index: number, speed: number}>}
 */
function boardsForDirection(order, speeds) {
  const boards = [];
  let current = null;
  for (let k = 0; k < order.length; k++) {
    const s = speeds[order[k]];
    if (s === null || s === undefined) continue;
    if (current === null) {
      boards.push({ index: order[0], speed: s }); // start of the line, first speed found
      current = s;
      continue;
    }
    if (s === current) continue;
    // Lower speed: one point early (the point before). Higher: here.
    const at = s < current && k > 0 ? order[k - 1] : order[k];
    // A board already at that point (several changes within one point): the lowest wins.
    const last = boards[boards.length - 1];
    if (last && last.index === at) last.speed = Math.min(last.speed, s);
    else boards.push({ index: at, speed: s });
    current = s;
  }
  return boards;
}

/**
 * Speedboards for one region (one geometry file).
 * @returns {{rows: Array<{km: string, inc: number|null, dec: number|null}>, pointsWithData: number, points: number}}
 */
export function regionSpeedboards(points, ways) {
  const sorted = [...points].sort((a, b) => a.km - b.km);
  const profile = speedProfile(sorted, ways);
  const up = sorted.map((_, i) => i);
  const down = [...up].reverse();
  const inc = boardsForDirection(up, profile.map(p => p.inc));
  const dec = boardsForDirection(down, profile.map(p => p.dec));
  const byIndex = new Map();
  for (const b of inc) byIndex.set(b.index, { ...(byIndex.get(b.index) || {}), inc: b.speed });
  for (const b of dec) byIndex.set(b.index, { ...(byIndex.get(b.index) || {}), dec: b.speed });
  const rows = [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([i, v]) => ({
    // The geometry file's own km (5 decimals), so each board lands exactly
    // on an existing geometry point.
    km: sorted[i].km.toFixed(5),
    inc: v.inc ?? null,
    dec: v.dec ?? null
  }));
  const pointsWithData = profile.filter(p => p.inc !== null || p.dec !== null).length;
  return { rows, pointsWithData, points: sorted.length };
}

const formatSpeed = (s) => (s === null || s === undefined ? '' : String(Math.round(s * 10) / 10));

/**
 * The whole Speedboards.csv. Regions in the order given; a region with no
 * rows adds nothing. With no rows at all the file is the header only, which
 * the resolver accepts (no boards).
 * @param {Array<{region: string, rows: Array}>} regions
 * @returns {string}
 */
export function buildSpeedboardsCsv(regions) {
  const lines = [
    '#Speedboards generated by the Traxim File Generator from OpenStreetMap maxspeed tags. Speeds in km/h.',
    // No commas or quotes in comment rows (the resolver splits on commas).
    `#Column ${SPEED_CLASS} increasing is for trains running towards higher km and ${SPEED_CLASS} decreasing towards lower km.`,
    `KMDirectionSection,${SPEED_CLASS},increasing`,
    `KMDirectionSection,${SPEED_CLASS},decreasing`,
    '#TrainClasses',
    `#Section,km,type,${SPEED_CLASS} increasing,${SPEED_CLASS} decreasing`
  ];
  for (const { region, rows } of regions) {
    for (const r of rows) lines.push(`${region},${r.km},,${formatSpeed(r.inc)},${formatSpeed(r.dec)}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Speedboards for all regions.
 * @param {Array<{region: string, points: Array}>} geometries - in route order
 * @param {Array} ways - OSM ways with tags
 * @returns {{csv: string, boardCount: number, regionsWithData: number, regionCount: number, noSpeedData: boolean, warnings: string[]}}
 */
export function generateSpeedboards(geometries, ways) {
  const warnings = [];
  const regions = [];
  let boardCount = 0, regionsWithData = 0;
  const partial = [];
  for (const { region, points } of geometries) {
    const result = regionSpeedboards(points, ways || []);
    regions.push({ region, rows: result.rows });
    boardCount += result.rows.length;
    if (result.pointsWithData > 0) {
      regionsWithData++;
      const share = result.pointsWithData / Math.max(1, result.points);
      if (share < 0.95) partial.push(`${region} (${Math.round(share * 100)}%)`);
    }
  }
  const noSpeedData = regionsWithData === 0;
  if (noSpeedData) {
    warnings.push(`Speedboards: NO SPEED DATA was found in OpenStreetMap for these routes, so the Speedboards file has ` +
      `no speedboards (header only; the resolver accepts it). ${NO_SPEED_DATA_ADVICE}`);
  } else {
    warnings.push(`Speedboards: ${boardCount} speedboard row(s) from OpenStreetMap maxspeed tags on ${regionsWithData} of ` +
      `${geometries.length} route(s), class "${SPEED_CLASS}", km/h. Boards are placed at geometry points (within about ` +
      `25 m of the real change, on the safe side). Check them against the real line speeds.`);
    const without = geometries.length - regionsWithData;
    if (without > 0) {
      warnings.push(`Speedboards: ${without} route(s) have no speed data in OpenStreetMap and no speedboards: ` +
        geometries.filter((g, i) => regions[i].rows.length === 0).map(g => g.region).join(', ') + `. ${NO_SPEED_DATA_ADVICE}`);
    }
    if (partial.length > 0) {
      warnings.push(`Speedboards: speed data covers only part of ${partial.length} route(s) (share of track with data): ` +
        `${partial.join(', ')}. Where there is none, the speed before it carries on.`);
    }
  }
  return { csv: buildSpeedboardsCsv(regions), boardCount, regionsWithData, regionCount: geometries.length, noSpeedData, warnings };
}
