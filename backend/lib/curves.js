/**
 * Spline interpolation and point resampling for track geometry.
 * Ported from the Traxim Centreline Tools web app (cardinal spline → Bezier → geodetic resample).
 *
 * The pipeline mirrors what the Centreline Tool does when converting KML paths to Traxim CSVs:
 *   1. cardinalSpline2()       — compute Bezier control points from raw input points
 *   2. interpolateBezier()     — densify to fine intermediate points
 *   3. resampleAtInterval()    — produce evenly-spaced output points at the target spacing
 *
 * cardinalSpline2() uses a CENTRIPETAL Catmull-Rom parameterization (2026-09),
 * not the original uniform Cardinal spline. The original ported implementation
 * computed each point's tangent from the raw lat/lon delta between its two
 * neighbours, regardless of how far apart those neighbours actually were - a
 * known failure mode of uniform Catmull-Rom for non-uniformly-spaced input,
 * which real OSM way vertices always are (a long straight may have only two
 * or three widely-spaced nodes immediately adjacent to a curve mapped with
 * many closely-spaced ones). The tangent computed at that junction gets
 * dominated by the long segment, and the resulting curve overshoots past the
 * corner before bending back - confirmed live on a real route (Genova-Sestri
 * Levante: a long straight extended ~340m past where the following curve
 * should have started, doubling back on itself, and the same thing at the
 * straight's other end).
 *
 * Centripetal parameterization (alpha=0.5) scales each tangent by the actual
 * geodetic distance to its neighbours instead of a fixed uniform weighting,
 * which is provably free of loops/cusps for any point spacing (Barry &
 * Goldman 1988) - not just "usually better" for this specific case. Verified
 * against a synthetic sparse-straight-into-dense-curve test case before
 * shipping: the old algorithm backtracked ~70m past where it should have
 * turned; centripetal reduced that to <1m (noise-level).
 */

import { GeoPoint } from "./geopoint.js";
import { vincentyInverse, vincentyDirect } from "./geodetic.js";

// ─── Step 1: Centripetal Catmull-Rom → Bezier control points ─────────────────

function pointDistanceM(a, b) {
  return vincentyInverse(a.latitude, a.longitude, b.latitude, b.longitude).distance;
}

/**
 * "Phantom point" for spline boundary conditions: reflects b through a,
 * giving a plausible continuation of the a->b direction. Used so the very
 * first/last real points get a well-defined tangent instead of the
 * degenerate zero tangent that repeating the endpoint would produce.
 */
function extrapolate(a, b) {
  const p = new GeoPoint(
    2 * a.latitude - b.latitude,
    2 * a.longitude - b.longitude,
    a.altitude
  );
  p.section = a.section;
  return p;
}

/**
 * Centripetal Catmull-Rom tangents, converted to Bezier control points, for
 * the segment [p1, p2] given its neighbours p0 (before p1) and p3 (after p2).
 * Standard generalized Catmull-Rom-to-Bezier construction (e.g. Barry &
 * Goldman 1988; see also https://qroph.github.io/2018/07/30/smooth-paths-using-catmull-rom-splines.html):
 * each tangent is normalized to its OWN segment's local knot span, which is
 * why m1/m2 differ even though the underlying path is geometrically
 * continuous - the parameterization speed differs between unequal-length
 * segments, and that's exactly what prevents the long-segment-dominates
 * overshoot the uniform version had.
 */
function segmentControlPoints(p0, p1, p2, p3, alpha = 0.5) {
  const d0 = Math.max(pointDistanceM(p0, p1), 1e-6) ** alpha;
  const d1 = Math.max(pointDistanceM(p1, p2), 1e-6) ** alpha;
  const d2 = Math.max(pointDistanceM(p2, p3), 1e-6) ** alpha;

  const t0 = 0, t1 = d0, t2 = d0 + d1, t3 = d0 + d1 + d2;

  function axisTangents(get) {
    const m1 = (t2 - t1) * (
      (get(p1) - get(p0)) / (t1 - t0) -
      (get(p2) - get(p0)) / (t2 - t0) +
      (get(p2) - get(p1)) / (t2 - t1)
    );
    const m2 = (t2 - t1) * (
      (get(p2) - get(p1)) / (t2 - t1) -
      (get(p3) - get(p1)) / (t3 - t1) +
      (get(p3) - get(p2)) / (t3 - t2)
    );
    return { m1, m2 };
  }

  const lat = axisTangents((p) => p.latitude);
  const lon = axisTangents((p) => p.longitude);

  const cpAfterP1 = new GeoPoint(
    p1.latitude + lat.m1 / 3,
    p1.longitude + lon.m1 / 3,
    p1.altitude
  );
  cpAfterP1.section = p1.section;

  const cpBeforeP2 = new GeoPoint(
    p2.latitude - lat.m2 / 3,
    p2.longitude - lon.m2 / 3,
    p2.altitude
  );
  cpBeforeP2.section = p2.section;

  return { cpAfterP1, cpBeforeP2 };
}

export function cardinalSpline2(points, alpha = 0.5) {
  if (points.length < 2) return points.map((p) => p.clone());

  const n = points.length;
  const nrRetPts = n * 3 - 2;
  const ret = new Array(nrRetPts);

  for (let i = 0; i < n - 1; i++) {
    const p0 = i > 0 ? points[i - 1] : extrapolate(points[0], points[1]);
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = i < n - 2 ? points[i + 2] : extrapolate(points[n - 1], points[n - 2]);

    const { cpAfterP1, cpBeforeP2 } = segmentControlPoints(p0, p1, p2, p3, alpha);

    ret[3 * i] = p1.clone();
    ret[3 * i + 1] = cpAfterP1;
    ret[3 * i + 2] = cpBeforeP2;
  }
  ret[nrRetPts - 1] = points[n - 1].clone();

  return ret;
}

// ─── Step 2: Bezier interpolation ─────────────────────────────────────────────

function lerp(a, b, t) {
  const r = new GeoPoint(
    a.latitude + (b.latitude - a.latitude) * t,
    a.longitude + (b.longitude - a.longitude) * t,
    0 // altitude not interpolated in original C# Lerp
  );
  r.section = a.section;
  return r;
}

function bezier(a, b, c, d, t) {
  const ab = lerp(a, b, t);
  const bc = lerp(b, c, t);
  const cd = lerp(c, d, t);
  return lerp(lerp(ab, bc, t), lerp(bc, cd, t), t);
}

export function interpolateBezier(controlPoints, numPerSegment = 60) {
  if (controlPoints.length < 4) return controlPoints.map((p) => p.clone());

  const result = [];
  for (let i = 0; i < controlPoints.length - 3; i += 3) {
    result.push(controlPoints[i].clone());
    for (let j = 1; j <= numPerSegment; j++) {
      const t = j / (numPerSegment + 1);
      result.push(
        bezier(
          controlPoints[i],
          controlPoints[i + 1],
          controlPoints[i + 2],
          controlPoints[i + 3],
          t
        )
      );
    }
  }
  result.push(controlPoints[controlPoints.length - 1].clone());
  return result;
}

// ─── Step 3: Geodetic resample at fixed interval ───────────────────────────────

/**
 * Resample a dense array of GeoPoints so that consecutive points are
 * approximately `targetSpacing` metres apart (Vincenty distance).
 * Accumulates a running chainage (km) for each output point.
 *
 * @param {GeoPoint[]} points  - Dense input points (from interpolateBezier)
 * @param {number} targetSpacing - Desired output spacing in metres (default 25)
 * @returns {GeoPoint[]} - Resampled points with .chainage set (km)
 */
export function resampleAtInterval(points, targetSpacing = 25) {
  if (points.length < 2) return points.map((p) => p.clone());

  const output = [];
  let accumulated = 0; // distance since last output point (metres)
  let totalChainage = 0; // total distance from start (metres)

  // Emit the first point
  const first = points[0].clone();
  first.chainage = 0;
  output.push(first);

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const segLen = vincentyInverse(
      prev.latitude, prev.longitude,
      curr.latitude, curr.longitude
    ).distance;

    let remaining = segLen;
    let segPos = 0; // position along segment consumed so far

    while (accumulated + remaining >= targetSpacing) {
      const need = targetSpacing - accumulated;
      const frac = (segPos + need) / segLen;

      // Interpolate position
      const lat = prev.latitude + (curr.latitude - prev.latitude) * frac;
      const lon = prev.longitude + (curr.longitude - prev.longitude) * frac;
      const alt = prev.altitude + (curr.altitude - prev.altitude) * frac;

      totalChainage += need + (segPos > 0 ? 0 : 0);
      const pt = new GeoPoint(lat, lon, alt);
      pt.section = prev.section || curr.section;
      pt.chainage = (totalChainage + need) / 1000; // will be set below

      // Track cumulative distance properly
      const outputKm = output.length * targetSpacing / 1000;
      pt.chainage = outputKm;
      output.push(pt);

      segPos += need;
      remaining -= need;
      accumulated = 0;
    }

    accumulated += remaining;
    totalChainage += segLen;
  }

  // Emit the last point if it isn't already very close to the previous output
  const last = points[points.length - 1].clone();
  last.chainage = (output.length * targetSpacing) / 1000;
  if (
    output.length === 0 ||
    vincentyInverse(
      output[output.length - 1].latitude,
      output[output.length - 1].longitude,
      last.latitude,
      last.longitude
    ).distance > targetSpacing * 0.1
  ) {
    output.push(last);
  }

  return output;
}

/**
 * Full pipeline: raw OSM/KML points → smooth spline → resampled at targetSpacing metres.
 * @param {GeoPoint[]} rawPoints - Input points (lat/lon, any spacing)
 * @param {number} targetSpacing - Output spacing in metres (default 25)
 * @returns {GeoPoint[]} - Resampled, smoothed points ready for Traxim CSV
 */
export function processTrackPoints(rawPoints, targetSpacing = 25) {
  if (rawPoints.length < 2) return rawPoints;
  const controlPoints = cardinalSpline2(rawPoints, 0.5);
  const dense = interpolateBezier(controlPoints, 60);
  return resampleAtInterval(dense, targetSpacing);
}
