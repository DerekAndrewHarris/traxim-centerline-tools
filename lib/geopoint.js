// GeoPoint class - represents a geographic point
class GeoPoint {
    constructor(latitude, longitude, altitude = 0) {
        this.latitude = latitude;   // in degrees
        this.longitude = longitude; // in degrees
        this.altitude = altitude;   // in meters
        this.section = '';
        this.name = '';
        this.description = '';
        this.curveRadius = null;
        this.speed = null;
        this.chainage = null;
    }

    // Calculate distance to another point using geodetic calculator
    distance(otherPoint, geodeticCalculator) {
        const ellipsoid = Ellipsoid.WGS84;
        const start = new GlobalCoordinates(this.latitude, this.longitude);
        const end = new GlobalCoordinates(otherPoint.latitude, otherPoint.longitude);
        const curve = geodeticCalculator.calculateGeodeticCurve(ellipsoid, start, end);
        return curve.ellipsoidalDistance;
    }

    // Calculate bearing to another point (in radians)
    bearingToPoint(otherPoint, geodeticCalculator) {
        const ellipsoid = Ellipsoid.WGS84;
        const start = new GlobalCoordinates(this.latitude, this.longitude);
        const end = new GlobalCoordinates(otherPoint.latitude, otherPoint.longitude);
        const curve = geodeticCalculator.calculateGeodeticCurve(ellipsoid, start, end);
        return curve.azimuth;
    }

    // Project a new point from this point given bearing and distance
    projectNewOnBearingDist(bearing, distance, geodeticCalculator) {
        const ellipsoid = Ellipsoid.WGS84;
        const start = new GlobalCoordinates(this.latitude, this.longitude);
        const endPos = geodeticCalculator.calculateEndingGlobalCoordinates(
            ellipsoid, 
            start, 
            bearing, 
            distance
        );
        
        // Interpolate altitude
        const newAltitude = this.altitude;
        
        const newPoint = new GeoPoint(endPos.latitude, endPos.longitude, newAltitude);
        newPoint.section = this.section;
        return newPoint;
    }

    // Clone this point
    clone() {
        const cloned = new GeoPoint(this.latitude, this.longitude, this.altitude);
        cloned.section = this.section;
        cloned.name = this.name;
        cloned.description = this.description;
        cloned.curveRadius = this.curveRadius;
        cloned.speed = this.speed;
        cloned.chainage = this.chainage;
        return cloned;
    }

    // Convert to string for debugging
    toString() {
        return `GeoPoint(${this.latitude.toFixed(6)}, ${this.longitude.toFixed(6)}, ${this.altitude.toFixed(2)}m)`;
    }
}
