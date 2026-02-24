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

    // Cardinal spline that returns Bezier control points (Step 1 of C# process)
    // Matches the exact C# CardinalSpline2 implementation
    static cardinalSpline2(points, t = 0.5) {
        if (points.length < 2) {
            return points;
        }

        // Tension is scaled by 1/3 for control point calculation
        const tension = t * (1.0 / 3.0);
        
        // Output array size: input points * 3 - 2
        const nrRetPts = points.length * 3 - 2;
        const retPnt = new Array(nrRetPts);
        
        let prevDeltaX = 0;
        let prevDeltaY = 0;
        
        // START: Handle first point specially
        const p1Start = this.calcCurveEnd2(points[0], points[1], tension, prevDeltaX, prevDeltaY);
        prevDeltaX = p1Start.prevDeltaX;
        prevDeltaY = p1Start.prevDeltaY;
        
        retPnt[0] = points[0].clone();  // First point is the original point
        retPnt[1] = p1Start.controlPoint;  // Control point after first point
        
        // MIDDLE: Process all interior segments
        for (let i = 0; i < points.length - 2; i++) {
            const curveResult = this.calcCurve2(
                [points[i], points[i + 1], points[i + 2]], 
                tension, 
                prevDeltaX, 
                prevDeltaY
            );
            prevDeltaX = curveResult.prevDeltaX;
            prevDeltaY = curveResult.prevDeltaY;
            
            retPnt[3 * i + 2] = curveResult.p1;        // Control point before point
            retPnt[3 * i + 3] = points[i + 1].clone(); // Actual input point
            retPnt[3 * i + 4] = curveResult.p2;        // Control point after point
        }
        
        // END: Handle last point specially
        const p1End = this.calcCurveEnd(points[points.length - 1], points[points.length - 2], tension);
        retPnt[nrRetPts - 2] = p1End;                          // Control point before last
        retPnt[nrRetPts - 1] = points[points.length - 1].clone(); // Last point is original
        
        return retPnt;
    }
    
    // Calculate control point for curve end (first point)
    static calcCurveEnd2(end, adj, tension, prevDeltaX, prevDeltaY) {
        // Calculate and store the delta for next iteration
        const deltaX = adj.longitude - end.longitude;
        const deltaY = adj.latitude - end.latitude;
        
        // Calculate control point using simple offset
        const controlPoint = new GeoPoint(
            tension * (adj.latitude - end.latitude) + end.latitude,
            tension * (adj.longitude - end.longitude) + end.longitude,
            end.altitude  // Preserve altitude from actual point
        );
        controlPoint.section = end.section;
        
        return {
            controlPoint: controlPoint,
            prevDeltaX: deltaX,
            prevDeltaY: deltaY
        };
    }
    
    // Calculate TWO control points for interior curve segment
    static calcCurve2(pts, tension, prevDeltaX, prevDeltaY) {
        // Calculate delta between pts[0] and pts[2] (skipping middle point)
        const deltaX = pts[2].longitude - pts[0].longitude;
        const deltaY = pts[2].latitude - pts[0].latitude;
        
        // Use current delta (the C# code has Min() commented out)
        const minDX = deltaX;
        const minDY = deltaY;
        
        // Calculate TWO control points (before and after pts[1])
        const p1 = new GeoPoint(
            pts[1].latitude - tension * minDY,   // Control point BEFORE
            pts[1].longitude - tension * minDX,
            pts[1].altitude  // Preserve altitude from actual point
        );
        p1.section = pts[1].section;
        
        const p2 = new GeoPoint(
            pts[1].latitude + tension * minDY,   // Control point AFTER
            pts[1].longitude + tension * minDX,
            pts[1].altitude  // Preserve altitude from actual point
        );
        p2.section = pts[1].section;
        
        return {
            p1: p1,
            p2: p2,
            prevDeltaX: deltaX,
            prevDeltaY: deltaY
        };
    }
    
    // Calculate control point for curve end (last point)
    static calcCurveEnd(end, adj, tension) {
        const p1 = new GeoPoint(
            tension * (adj.latitude - end.latitude) + end.latitude,
            tension * (adj.longitude - end.longitude) + end.longitude,
            end.altitude  // Preserve altitude from actual point
        );
        p1.section = end.section;
        return p1;
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
