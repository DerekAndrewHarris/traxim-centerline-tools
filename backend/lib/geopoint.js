/**
 * GeoPoint — represents a geographic point (lat/lon/elevation).
 * Ported from the Traxim Centreline Tools web app (which itself was ported from C#).
 */
export class GeoPoint {
  constructor(latitude, longitude, altitude = 0) {
    this.latitude = latitude;    // degrees
    this.longitude = longitude;  // degrees
    this.altitude = altitude;    // metres
    this.section = "";
    this.name = "";
    this.curveRadius = null;
    this.chainage = null;        // kilometres from section start
  }

  clone() {
    const c = new GeoPoint(this.latitude, this.longitude, this.altitude);
    c.section = this.section;
    c.name = this.name;
    c.curveRadius = this.curveRadius;
    c.chainage = this.chainage;
    return c;
  }

  toString() {
    return `GeoPoint(${this.latitude.toFixed(6)}, ${this.longitude.toFixed(6)}, ${this.altitude.toFixed(1)}m)`;
  }
}
