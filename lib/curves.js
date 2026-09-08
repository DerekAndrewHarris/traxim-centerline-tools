// Curve fitting algorithms
// Ported from C# Curves class
console.log('[curves.js] Starting to load curves.js...');

class Curves {
    // Cardinal spline interpolation
    static cardinalSpline(points, tension = 0.5) {
        if (points.length < 2) {
            return points;
        }

        const result = [];
        const numSegments = 60; // Number of interpolated points per segment

        for (let i = 0; i < points.length - 1; i++) {
            const p0 = i > 0 ? points[i - 1] : points[i];
            const p1 = points[i];
            const p2 = points[i + 1];
            const p3 = i < points.length - 2 ? points[i + 2] : points[i + 1];

            for (let t = 0; t < numSegments; t++) {
                const u = t / numSegments;
                const interpolated = this.cardinalSplinePoint(p0, p1, p2, p3, u, tension);
                result.push(interpolated);
            }
        }

        // Add the last point
        result.push(points[points.length - 1].clone());

        return result;
    }

    // Calculate a single point on a cardinal spline
    static cardinalSplinePoint(p0, p1, p2, p3, t, tension) {
        const s = (1 - tension) / 2;

        const t2 = t * t;
        const t3 = t2 * t;

        // Cardinal spline basis functions
        const h1 =  2 * t3 - 3 * t2 + 1;
        const h2 = -2 * t3 + 3 * t2;
        const h3 =      t3 - 2 * t2 + t;
        const h4 =      t3 -     t2;

        // Tangent vectors
        const m1_lat = s * (p2.latitude - p0.latitude);
        const m1_lon = s * (p2.longitude - p0.longitude);
        const m1_alt = s * (p2.altitude - p0.altitude);

        const m2_lat = s * (p3.latitude - p1.latitude);
        const m2_lon = s * (p3.longitude - p1.longitude);
        const m2_alt = s * (p3.altitude - p1.altitude);

        // Interpolate
        const lat = h1 * p1.latitude + h2 * p2.latitude + h3 * m1_lat + h4 * m2_lat;
        const lon = h1 * p1.longitude + h2 * p2.longitude + h3 * m1_lon + h4 * m2_lon;
        const alt = h1 * p1.altitude + h2 * p2.altitude + h3 * m1_alt + h4 * m2_alt;

        const newPoint = new GeoPoint(lat, lon, alt);
        newPoint.section = p1.section;
        return newPoint;
    }

    // Catmull-Rom spline (special case of cardinal spline with tension = 0)
    static catmullRomSpline(points) {
        return this.cardinalSpline(points, 0);
    }

    // Cardinal spline that returns Bezier control points (Step 1 of C# process).
    //
    // Uses CENTRIPETAL Catmull-Rom parameterization (2026-09), not the
    // original uniform Cardinal spline this was ported from. The original
    // computed each point's tangent from the raw lat/lon delta between its
    // two neighbours regardless of how far apart they actually were - a
    // known failure mode of uniform Catmull-Rom for non-uniformly-spaced
    // input, which real OSM/KML path vertices always are (a long straight
    // may have only two or three widely-spaced points immediately adjacent
    // to a curve with many closely-spaced ones). The tangent at that
    // junction gets dominated by the long segment, and the resulting curve
    // overshoots past the corner before bending back - confirmed live on a
    // real route (backend/lib/curves.js, which shares this same algorithm
    // for the OSM-based pipeline: a long straight extended ~340m past where
    // the following curve should have started, doubling back on itself).
    //
    // Centripetal parameterization (alpha=0.5) scales each tangent by the
    // actual geodetic distance to its neighbours instead of a fixed uniform
    // weighting, which is provably free of loops/cusps for any point
    // spacing (Barry & Goldman 1988) - not just "usually better" for this
    // case. See backend/lib/curves.js for the equivalent fix and a
    // synthetic-test validation of the approach.
    static cardinalSpline2(points, alpha = 0.5) {
        if (points.length < 2) {
            return points.map((p) => p.clone());
        }

        const n = points.length;
        const nrRetPts = n * 3 - 2;
        const retPnt = new Array(nrRetPts);

        for (let i = 0; i < n - 1; i++) {
            const p0 = i > 0 ? points[i - 1] : this.extrapolatePoint(points[0], points[1]);
            const p1 = points[i];
            const p2 = points[i + 1];
            const p3 = i < n - 2 ? points[i + 2] : this.extrapolatePoint(points[n - 1], points[n - 2]);

            const { cpAfterP1, cpBeforeP2 } = this.segmentControlPoints(p0, p1, p2, p3, alpha);

            retPnt[3 * i] = p1.clone();
            retPnt[3 * i + 1] = cpAfterP1;
            retPnt[3 * i + 2] = cpBeforeP2;
        }
        retPnt[nrRetPts - 1] = points[n - 1].clone();

        return retPnt;
    }

    // Geodetic distance in metres between two GeoPoints, using the same
    // Vincenty implementation (geodetic.js) the rest of this app relies on.
    static pointDistanceM(a, b) {
        const calc = new GeodeticCalculator();
        const curve = calc.calculateGeodeticCurve(
            Ellipsoid.WGS84,
            new GlobalCoordinates(a.latitude, a.longitude),
            new GlobalCoordinates(b.latitude, b.longitude)
        );
        return curve.ellipsoidalDistance;
    }

    // "Phantom point" for spline boundary conditions: reflects b through a,
    // giving a plausible continuation of the a->b direction. Used so the
    // very first/last real points get a well-defined tangent instead of the
    // degenerate zero tangent that repeating the endpoint would produce.
    static extrapolatePoint(a, b) {
        const p = new GeoPoint(
            2 * a.latitude - b.latitude,
            2 * a.longitude - b.longitude,
            a.altitude
        );
        p.section = a.section;
        return p;
    }

    // Centripetal Catmull-Rom tangents, converted to Bezier control points,
    // for the segment [p1, p2] given its neighbours p0 (before p1) and p3
    // (after p2). Standard generalized Catmull-Rom-to-Bezier construction
    // (e.g. Barry & Goldman 1988; see also
    // https://qroph.github.io/2018/07/30/smooth-paths-using-catmull-rom-splines.html):
    // each tangent is normalized to its OWN segment's local knot span, which
    // is why m1/m2 differ even though the underlying path is geometrically
    // continuous - the parameterization speed differs between unequal-length
    // segments, and that's exactly what prevents the long-segment-dominates
    // overshoot the uniform version had.
    static segmentControlPoints(p0, p1, p2, p3, alpha = 0.5) {
        const d0 = Math.max(this.pointDistanceM(p0, p1), 1e-6) ** alpha;
        const d1 = Math.max(this.pointDistanceM(p1, p2), 1e-6) ** alpha;
        const d2 = Math.max(this.pointDistanceM(p2, p3), 1e-6) ** alpha;

        const t0 = 0, t1 = d0, t2 = d0 + d1, t3 = d0 + d1 + d2;

        const axisTangents = (get) => {
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
        };

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

    // Linear interpolation between two points
    // Matches C# Lerp - only interpolates lat/lon, NOT altitude
    static lerp(a, b, t) {
        const result = new GeoPoint(
            a.latitude + (b.latitude - a.latitude) * t,
            a.longitude + (b.longitude - a.longitude) * t,
            0  // C# doesn't interpolate altitude, leaves at default
        );
        result.section = a.section;
        return result;
    }

    // Calculate a point on a cubic Bezier curve
    static bezier(a, b, c, d, t) {
        const ab = this.lerp(a, b, t);
        const bc = this.lerp(b, c, t);
        const cd = this.lerp(c, d, t);
        const abbc = this.lerp(ab, bc, t);
        const bccd = this.lerp(bc, cd, t);
        const dest = this.lerp(abbc, bccd, t);
        return dest;
    }

    // Interpolate points along Bezier curve segments (Step 2 of C# process)
    // Matches C# BezierPoints implementation exactly
    static interpolateBezier(controlPoints, numPointsPerSegment = 60) {
        if (controlPoints.length < 4) {
            return controlPoints;
        }

        const result = [];

        // Process control points in groups of 4, stepping by 3
        // This matches the C# loop: for (int i = 0; i < cardinal.Count - 3; i += 3)
        for (let i = 0; i < controlPoints.length - 3; i += 3) {
            // Add the first control point (actual point, not interpolated)
            // This matches C#: interpPoints.Add(cardinal[i]);
            result.push(controlPoints[i].clone());
            
            // Interpolate numPointsPerSegment points between the 4 control points
            // CRITICAL: t = i / (count + 1), NOT i / count!
            // For count=60: t goes from 1/61 to 60/61 (never 0.0 or 1.0)
            for (let j = 1; j <= numPointsPerSegment; j++) {
                const t = j / (numPointsPerSegment + 1);
                const interpolated = this.bezier(
                    controlPoints[i],
                    controlPoints[i + 1],
                    controlPoints[i + 2],
                    controlPoints[i + 3],
                    t
                );
                result.push(interpolated);
            }
        }
        
        // Add the last control point (the C# doesn't do this in the loop,
        // but we need to include the final point)
        result.push(controlPoints[controlPoints.length - 1].clone());

        return result;
    }

    // Simple linear interpolation between two points
    static linearInterpolate(p1, p2, t) {
        const lat = p1.latitude + (p2.latitude - p1.latitude) * t;
        const lon = p1.longitude + (p2.longitude - p1.longitude) * t;
        const alt = p1.altitude + (p2.altitude - p1.altitude) * t;

        const newPoint = new GeoPoint(lat, lon, alt);
        newPoint.section = p1.section;
        return newPoint;
    }

    // Calculate curvature at a point (returns radius in meters)
    static calculateCurvature(p1, p2, p3, geodeticCalculator) {
        const bearing1 = p1.bearingToPoint(p2, geodeticCalculator);
        const bearing2 = p2.bearingToPoint(p3, geodeticCalculator);
        
        let deltaBearing = Math.abs(bearing2 - bearing1);
        if (deltaBearing > Math.PI) {
            deltaBearing = 2 * Math.PI - deltaBearing;
        }

        if (deltaBearing < 0.001) {
            return Infinity; // Straight line
        }

        const dist = p1.distance(p3, geodeticCalculator) / 2;
        const radius = dist / Math.sin(deltaBearing / 2);
        
        return radius;
    }

    // Smooth a set of points using moving average
    static smooth(points, windowSize = 3) {
        if (points.length < windowSize) {
            return points.map(p => p.clone());
        }

        const result = [];
        const halfWindow = Math.floor(windowSize / 2);

        for (let i = 0; i < points.length; i++) {
            const start = Math.max(0, i - halfWindow);
            const end = Math.min(points.length - 1, i + halfWindow);
            
            let sumLat = 0, sumLon = 0, sumAlt = 0;
            let count = 0;

            for (let j = start; j <= end; j++) {
                sumLat += points[j].latitude;
                sumLon += points[j].longitude;
                sumAlt += points[j].altitude;
                count++;
            }

            const smoothed = new GeoPoint(
                sumLat / count,
                sumLon / count,
                sumAlt / count
            );
            smoothed.section = points[i].section;
            result.push(smoothed);
        }

        return result;
    }
}

console.log('[curves.js] Curves class defined:', typeof Curves);
if (typeof window !== 'undefined') {
    window.Curves = Curves;
    console.log('[curves.js] Curves explicitly attached to window');
}
