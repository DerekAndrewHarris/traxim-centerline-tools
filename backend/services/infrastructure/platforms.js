/**
 * Platform faces and platform numbers (October 2026).
 *
 * Two questions the infrastructure generator has to answer for every
 * OpenStreetMap platform:
 *
 *  1. Which tracks does it serve? A platform edge serves the track that runs
 *     ALONG it. So for every track near the platform we measure how far it
 *     runs alongside the platform and on which side of the platform it is.
 *     On each side the nearest track that runs alongside for a reasonable
 *     length is that side's face. A track that only touches the platform's
 *     tip (it carries on beyond the platform's end, or ends head-on against
 *     it) is not a face.
 *
 *     This replaces a side test that used the average of the outline's
 *     corner points as the platform's "centre": for a long, bent or
 *     L-shaped outline that point can lie OUTSIDE the platform, beyond one
 *     of its tracks, and then both tracks looked as if they were on the same
 *     side (La Spezia Centrale, OSM way 617064897: platform 1's own track
 *     617064911 lost to the dock track 617064906).
 *
 *  2. Which number does each face get? OSM gives a platform's numbers in its
 *     ref tag, e.g. "1", "4 - 5", "4-5", "4;5". A ref with two numbers
 *     serves two tracks; which track gets which number is decided by which
 *     side of the platform the track is on: numbers run across the station
 *     in one direction (the direction is taken from the station's other
 *     platforms, or, at a station with only one numbered platform, lowest
 *     numbers nearest the station's own OSM point). A face without a number
 *     of its own is NOT given a guessed one: it gets a provisional name and
 *     a warning.
 */

const M_PER_DEG = 111320;

/** A local flat x/y frame in metres (x east, y north) around `origin`. */
export function localFrame(origin) {
  const cosLat = Math.cos(origin.lat * Math.PI / 180);
  return {
    toXY: (p) => ({ x: (p.lon - origin.lon) * M_PER_DEG * cosLat, y: (p.lat - origin.lat) * M_PER_DEG })
  };
}

/**
 * Split a platform ref into its numbers.
 * "4 - 5", "4-5", "4;5", "4/5", "4, 5", "4 & 5", "4 e 5", "4 and 5" -> ["4", "5"]
 * "1" -> ["1"]; "1A" -> ["1A"]; "Binario 3" -> ["3"]; "" / null -> []
 * @param {string|null|undefined} ref
 * @returns {string[]}
 */
export function parsePlatformNumbers(ref) {
  if (ref === null || ref === undefined) return [];
  let s = String(ref).trim();
  if (!s) return [];
  // Drop a leading word such as "Platform", "Binario", "Gleis", "Quai", "Voie".
  s = s.replace(/^(platforms?|plat\.?|binari?o?|bin\.?|gleis|gleise|bahnsteig|quai|quais|voie|voies|track|tracks|and[eé]n|v[ií]a|spor)\s+/i, '');
  return s
    .split(/\s*(?:[;,/&+–—]|\s-\s|-|\band\b|\be\b|\bund\b|\bet\b|\by\b)\s*/i)
    .map(t => t.trim())
    .filter(Boolean);
}

/**
 * The numbers of an OSM platform: from its ref, else local_ref, else a name
 * that is only a number (or numbers), e.g. "1", "Binario 4", "Platform 2;3".
 * Names like "Platform" or "La Spezia Centrale" give no number.
 * @returns {string[]}
 */
export function platformNumbersOf(platform) {
  for (const v of [platform.ref, platform.local_ref]) {
    const t = parsePlatformNumbers(v);
    if (t.length > 0) return t;
  }
  const name = (platform.name || '').trim();
  if (/^(?:(?:platforms?|binari?o?|bin\.?|gleis|bahnsteig|quai|voie|track|and[eé]n|v[ií]a)\s+)?[0-9]+[A-Za-z]?(?:(?:\s*[;,/&-]\s*|\s+(?:e|and|und|et|y)\s+)[0-9]+[A-Za-z]?)*$/i.test(name)) {
    return parsePlatformNumbers(name);
  }
  return [];
}

/** Leading whole number of a platform number ("12A" -> 12), or null. */
export function numericValue(token) {
  const m = /^(\d+)/.exec(String(token));
  return m ? Number(m[1]) : null;
}

/** Long axis (unit vector) and length along it of a set of x/y points. */
export function principalAxis(pts) {
  if (pts.length < 2) return { axis: null, length: 0 };
  const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pts) { sxx += (p.x - mx) ** 2; syy += (p.y - my) ** 2; sxy += (p.x - mx) * (p.y - my); }
  if (sxx + syy < 1e-6) return { axis: null, length: 0 };
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const axis = { x: Math.cos(theta), y: Math.sin(theta) };
  const along = pts.map(p => p.x * axis.x + p.y * axis.y);
  return { axis, length: Math.max(...along) - Math.min(...along), centre: { x: mx, y: my } };
}

/** Nearest point on a polyline (x/y) to p: {x, y, dist}. */
function nearestOnPolyline(p, line) {
  let best = { x: line[0].x, y: line[0].y, dist: Math.hypot(p.x - line[0].x, p.y - line[0].y) };
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i], b = line[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq < 1e-12 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const x = a.x + t * dx, y = a.y + t * dy;
    const dist = Math.hypot(p.x - x, p.y - y);
    if (dist < best.dist) best = { x, y, dist };
  }
  return best;
}

/** Sampling step along a track when measuring how far it runs beside a platform (m). */
const SAMPLE_STEP_M = 2;

/**
 * How a track way sits against a platform outline.
 * @param {Array<{x,y}>} outline - platform outline (or centre line) in metres
 * @param {Array<{x,y}>} track - the track way's points in metres
 * @param {{x,y}} axis - the platform's long axis (unit)
 * @param {number} maxGapM - a track point within this distance of the outline counts as "alongside"
 * @returns {{alongM:number, side:number, dist:number}}
 *   alongM: length of track running alongside the platform;
 *   side: +1 platform to the LEFT of the track (looking along `axis`), -1 to the right, 0 unclear;
 *   dist: typical (median) gap between track and platform where alongside, Infinity if never
 */
export function trackAgainstPlatform(outline, track, axis, maxGapM) {
  let alongM = 0, sideSum = 0;
  const gaps = [];
  // Only bother with the part of the track near the platform.
  const xs = outline.map(p => p.x), ys = outline.map(p => p.y);
  const pad = maxGapM + SAMPLE_STEP_M;
  const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
  for (let i = 0; i < track.length - 1; i++) {
    const a = track[i], b = track[i + 1];
    if (Math.max(a.x, b.x) < minX || Math.min(a.x, b.x) > maxX || Math.max(a.y, b.y) < minY || Math.min(a.y, b.y) > maxY) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) continue;
    let tx = (b.x - a.x) / len, ty = (b.y - a.y) / len;
    // Turn the track's direction to agree with the platform's axis, so that
    // "left" means the same thing for every track (OSM ways can be drawn
    // either way round).
    if (axis && tx * axis.x + ty * axis.y < 0) { tx = -tx; ty = -ty; }
    const n = Math.max(1, Math.ceil(len / SAMPLE_STEP_M));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const s = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
      const q = nearestOnPolyline(s, outline);
      if (q.dist > maxGapM) continue;
      const w = len / n;
      alongM += w;
      gaps.push(q.dist);
      const cross = tx * (q.y - s.y) - ty * (q.x - s.x); // + platform to the left of the track
      if (Math.abs(cross) > 0.05) sideSum += Math.sign(cross) * w;
    }
  }
  gaps.sort((p, q) => p - q);
  const dist = gaps.length ? gaps[Math.floor(gaps.length / 2)] : Infinity;
  const side = alongM > 0 && Math.abs(sideSum) >= 0.5 * alongM ? Math.sign(sideSum) : 0;
  return { alongM, side, dist };
}

/**
 * The tracks a platform serves: at most one per side.
 *
 * @param {Array<{lat,lon}>} platformGeometry - OSM outline or centre line (>= 2 points)
 * @param {Array<{wayId:string, dist:number}>} candidates - tracks near the platform
 * @param {Map<string, {coords:Array<{lat,lon}>}>} waysById
 * @param {number} maxGapM - how far from the platform edge a track can be and still serve it
 * @returns {{faces: Array<{side:number, ways:Array<{wayId, dist, alongM}>}>, axis: {x,y}|null, length: number}|null}
 *   faces: one per side that has a track running alongside, each with its
 *   usable ways (nearest first); null when the outline is too small to tell.
 */
export function platformFacesAlongside(platformGeometry, candidates, waysById, maxGapM) {
  if (!platformGeometry || platformGeometry.length < 2) return null;
  const origin = platformGeometry[0];
  const { toXY } = localFrame(origin);
  const outline = platformGeometry.map(toXY);
  const { axis, length } = principalAxis(outline);
  if (!axis || length < 1) return null;

  // A face must run alongside for a reasonable part of the platform: at
  // least 30 m, or 30 % of a shorter platform.
  const minAlongM = Math.min(30, 0.3 * length);

  const bySide = new Map();
  for (const cand of candidates) {
    const way = waysById.get(cand.wayId);
    if (!way || !way.coords || way.coords.length < 2) continue;
    const r = trackAgainstPlatform(outline, way.coords.map(toXY), axis, maxGapM);
    if (r.alongM < minAlongM || r.side === 0) continue;
    if (!bySide.has(r.side)) bySide.set(r.side, []);
    bySide.get(r.side).push({ wayId: cand.wayId, dist: r.dist, alongM: r.alongM });
  }
  const faces = [...bySide.entries()]
    .map(([side, ways]) => ({ side, ways: ways.sort((p, q) => p.dist - q.dist || q.alongM - p.alongM) }))
    .sort((p, q) => p.ways[0].dist - q.ways[0].dist);
  return { faces, axis, length };
}

/**
 * Give every platform node of one station its platform number.
 *
 * Each node carries `_platformFace`, recorded when it was inserted:
 *   { osmId, numbers: string[], side: +1|-1|0, axis: {x,y} (east/north),
 *     faceCount, rank (0 = the face running alongside the platform
 *     furthest), bay: boolean, ref }
 *
 * @param {Array<object>} platformNodes - nodes with lat/lon/km and _platformFace
 * @param {{lat:number, lon:number}} anchor - the station's own OSM point
 * @returns {{number: Map<object, string|null>, notes: Map<object, string>, orderAssumed: string[]}}
 *   number: the node's platform number, or null (no number of its own);
 *   notes: why a node has no number (for the warning);
 *   orderAssumed: refs whose numbers were put in order using the station
 *   point only (no other platform to go by)
 */
export function assignPlatformNumbers(platformNodes, anchor) {
  const number = new Map();
  const notes = new Map();
  const orderAssumed = [];
  if (platformNodes.length === 0) return { number, notes, orderAssumed };

  const { toXY } = localFrame(platformNodes[0]);
  // The station's long axis from its platform nodes' platforms (or the
  // nodes themselves), and the "across" direction (normal) at right angles.
  const axisPts = [];
  for (const n of platformNodes) {
    const f = n._platformFace;
    if (f && f.axis) {
      const p = toXY(n);
      // Two points along the node's own platform direction.
      axisPts.push({ x: p.x - 50 * f.axis.x, y: p.y - 50 * f.axis.y }, { x: p.x + 50 * f.axis.x, y: p.y + 50 * f.axis.y });
    }
  }
  let A = principalAxis(axisPts).axis;
  if (!A) A = principalAxis(platformNodes.map(toXY)).axis || { x: 1, y: 0 };
  const N = { x: -A.y, y: A.x };
  const across = (p) => { const q = toXY(p); return q.x * N.x + q.y * N.y; };

  // Which way do the numbers run across the station? From every numbered
  // node: its position across the station against its platform's average
  // number.
  const meanValue = (nums) => {
    const v = nums.map(numericValue).filter(x => x !== null);
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
  };
  const samples = platformNodes
    .map(n => ({ l: across(n), v: n._platformFace ? meanValue(n._platformFace.numbers) : null }))
    .filter(s => s.v !== null);
  let dir = 0;
  if (samples.length >= 2) {
    const ml = samples.reduce((s, x) => s + x.l, 0) / samples.length;
    const mv = samples.reduce((s, x) => s + x.v, 0) / samples.length;
    const cov = samples.reduce((s, x) => s + (x.l - ml) * (x.v - mv), 0);
    if (Math.abs(cov) > 1e-6) dir = Math.sign(cov);
  }
  let dirFromAnchor = false;
  if (dir === 0) {
    // Only one numbered platform: lowest numbers nearest the station's own
    // OSM point (usually the station building, beside platform 1).
    const meanAcross = platformNodes.reduce((s, n) => s + across(n), 0) / platformNodes.length;
    dir = anchor && across(anchor) > meanAcross ? -1 : 1;
    dirFromAnchor = true;
  }

  for (const n of platformNodes) {
    const f = n._platformFace;
    const nums = f ? f.numbers : [];
    if (!f || nums.length === 0) {
      number.set(n, null);
      notes.set(n, !f ? 'OpenStreetMap gives it no platform number'
        : f.ref ? `the ref "${f.ref}" of OSM platform way ${f.osmId} has no platform number in it`
          : `OSM platform way ${f.osmId} has no ref (platform number)`);
      continue;
    }
    // This track's side of its platform, across the station: +1 = towards N.
    let across1 = 0;
    if (f.side && f.axis) {
      const along = f.axis.x * A.x + f.axis.y * A.y >= 0 ? 1 : -1;
      across1 = -f.side * along; // platform on the track's left -> track on the platform's right
    }
    // Numbers in the order they run across the station (towards +N).
    const ordered = [...nums];
    if (nums.every(t => numericValue(t) !== null)) ordered.sort((p, q) => numericValue(p) - numericValue(q) || (p < q ? -1 : 1));
    if (dir < 0) ordered.reverse();

    if (nums.length === 1) {
      if (f.faceCount > 1 && f.rank > 0) {
        number.set(n, null);
        notes.set(n, `it is the shorter of ${f.faceCount} tracks beside OSM platform way ${f.osmId}, whose ref "${f.ref}" has only one number` +
          (f.bay ? '; this track ends at the platform, so it is probably a bay (dock) platform' : ''));
      } else {
        number.set(n, nums[0]);
      }
      continue;
    }
    // Two or more numbers: the track on the "low" side gets the first in
    // order across the station, the other side the last.
    if (across1 === 0) {
      number.set(n, null);
      notes.set(n, `OSM platform way ${f.osmId} (ref "${f.ref}") has ${nums.length} numbers and it could not be told which side of the platform this track is on`);
      continue;
    }
    number.set(n, across1 < 0 ? ordered[0] : ordered[ordered.length - 1]);
    if (dirFromAnchor && f.ref && !orderAssumed.includes(f.ref)) orderAssumed.push(f.ref);
  }
  return { number, notes, orderAssumed };
}
