/**
 * Spline interpolation and point resampling for track geometry.
 * Ported from the Traxim Centreline Tools web app (cardinal spline → Bezier → geodetic resample).
 *
 * The pipeline mirrors what the Centreline Tool does when converting KML paths to Traxim CSVs:
 *   1. cardinalSpline2()       — compute Bezier control points from raw input points
 *   2. interpolateBezier()     — densify to fine intermediate points
 *   3. resampleAtInterval()    — produce evenly-spaced output points at the target spacing
 */

import { GeoPoint } from "./geopoint.js";
import { vincentyInverse, vincentyDirect } from "./geodetic.js";

// ─── Step 1: Cardinal spline → Bezier control points ─────────────────────────

function calcCurveEnd2(end, adj, tension) {
  const cp = new GeoPoint(
    tension * (adj.latitude - end.latitude) + end.latitude,
    tension * (adj.longitude - end.longitude) + end.longitude,
    end.altitude
  );
  cp.section = end.section;
  const prevDeltaX = adj.longitude - end.longitude;
  const prevDeltaY = adj.latitude - end.latitude;
  return { controlPoint: cp, prevDeltaX, prevDeltaY };
}

function calcCurve2(pts, tension) {
  const deltaX = pts[2].longitude - pts[0].longitude;
  const deltaY = pts[2].latitude - pts[0].latitude;

  const p1 = new GeoPoint(
    pts[1].latitude - tension * deltaY,
    pts[1].longitude - tension * deltaX,
    pts[1].altitude
  );
  p1.section = pts[1].section;

  const p2 = new GeoPoint(
    pts[1].latitude + tension * deltaY,
    pts[1].longitude + tension * deltaX,
    pts[1].altitude
  );
  p2.section = pts[1].section;

  return { p1, p2, prevDeltaX: deltaX, prevDeltaY: deltaY };
}

function calcCurveEnd(end, adj, tension) {
  const p = new GeoPoint(
    tension * (adj.latitude - end.latitude) + end.latitude,
    tension * (adj.longitude - end.longitude) + end.longitude,
    end.altitude
  );
  p.section = end.section;
  return p;
}

export function cardinalSpline2(points, t = 0.5) {
  if (points.length < 2) return points.map((p) => p.clone());

  const tension = t * (1.0 / 3.0);
  const nrRetPts = points.length * 3 - 2;
  const ret = new Array(nrRetPts);

  const start = calcCurveEnd2(points[0], points[1], tension);
  ret[0] = points[0].clone();
  ret[1] = start.controlPoint;

  for (let i = 0; i < points.length - 2; i++) {
    const cr = calcCurve2([points[i], points[i + 1], points[i + 2]], tension);
    ret[3 * i + 2] = cr.p1;
    ret[3 * i + 3] = points[i + 1].clone();
    ret[3 * i + 4] = cr.p2;
  }

  ret[nrRetPts - 2] = calcCurveEnd(
    points[points.length - 1],
    points[points.length - 2],
    tension
  );
  ret[nrRetPts - 1] = points[points.length - 1].clone();

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
