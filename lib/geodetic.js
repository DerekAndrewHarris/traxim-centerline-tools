// Geodetic calculations based on Vincenty's formulae
// Ported from the C# GeodeticCalculator
console.log('[geodetic.js] Starting to load geodetic.js...');

class Ellipsoid {
    constructor(semiMajor, semiMinor) {
        this.semiMajorAxis = semiMajor;
        this.semiMinorAxis = semiMinor;
        this.flattening = (semiMajor - semiMinor) / semiMajor;
        this.inverseFlattening = 1.0 / this.flattening;
    }

    static get WGS84() {
        return new Ellipsoid(6378137.0, 6356752.314245);
    }

    static get GRS80() {
        return new Ellipsoid(6378137.0, 6356752.314140);
    }
}

class GlobalCoordinates {
    constructor(latitude, longitude) {
        this.latitude = latitude;   // in degrees
        this.longitude = longitude; // in degrees
    }

    get latitudeRadians() {
        return this.latitude * Math.PI / 180.0;
    }

    get longitudeRadians() {
        return this.longitude * Math.PI / 180.0;
    }
}

class GeodeticCurve {
    constructor(ellipsoidalDistance, azimuth, reverseAzimuth) {
        this.ellipsoidalDistance = ellipsoidalDistance; // meters
        this.azimuth = azimuth;                         // radians
        this.reverseAzimuth = reverseAzimuth;           // radians
    }
}

class GeodeticCalculator {
    constructor() {
        this.accuracy = 1.0e-12;
        this.maxIterations = 20;
    }

    // Calculate geodetic curve between two points using Vincenty's formula
    calculateGeodeticCurve(ellipsoid, start, end) {
        const a = ellipsoid.semiMajorAxis;
        const b = ellipsoid.semiMinorAxis;
        const f = ellipsoid.flattening;

        const phi1 = start.latitudeRadians;
        const phi2 = end.latitudeRadians;
        const lambda1 = start.longitudeRadians;
        const lambda2 = end.longitudeRadians;

        const deltaLambda = lambda2 - lambda1;

        const U1 = Math.atan((1.0 - f) * Math.tan(phi1));
        const U2 = Math.atan((1.0 - f) * Math.tan(phi2));

        const sinU1 = Math.sin(U1);
        const cosU1 = Math.cos(U1);
        const sinU2 = Math.sin(U2);
        const cosU2 = Math.cos(U2);

        let lambda = deltaLambda;
        let lambdaP = 2.0 * Math.PI;
        let iterLimit = this.maxIterations;
        let cosSqAlpha, sinSigma, cos2SigmaM, cosSigma, sigma, sinLambda, cosLambda;

        while (Math.abs(lambda - lambdaP) > this.accuracy && --iterLimit > 0) {
            sinLambda = Math.sin(lambda);
            cosLambda = Math.cos(lambda);
            
            const sinSqSigma = (cosU2 * sinLambda) * (cosU2 * sinLambda) +
                              (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) * 
                              (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda);
            
            sinSigma = Math.sqrt(sinSqSigma);
            
            if (sinSigma === 0) {
                return new GeodeticCurve(0, 0, 0);
            }
            
            cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
            sigma = Math.atan2(sinSigma, cosSigma);
            const sinAlpha = cosU1 * cosU2 * sinLambda / sinSigma;
            cosSqAlpha = 1.0 - sinAlpha * sinAlpha;
            
            cos2SigmaM = cosSigma - 2.0 * sinU1 * sinU2 / cosSqAlpha;
            
            if (isNaN(cos2SigmaM)) {
                cos2SigmaM = 0;
            }
            
            const C = f / 16.0 * cosSqAlpha * (4.0 + f * (4.0 - 3.0 * cosSqAlpha));
            lambdaP = lambda;
            lambda = deltaLambda + (1.0 - C) * f * sinAlpha *
                    (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * 
                    (-1.0 + 2.0 * cos2SigmaM * cos2SigmaM)));
        }

        if (iterLimit === 0) {
            console.warn('Vincenty formula failed to converge');
        }

        const uSq = cosSqAlpha * (a * a - b * b) / (b * b);
        const A = 1.0 + uSq / 16384.0 * (4096.0 + uSq * (-768.0 + uSq * (320.0 - 175.0 * uSq)));
        const B = uSq / 1024.0 * (256.0 + uSq * (-128.0 + uSq * (74.0 - 47.0 * uSq)));
        const deltaSigma = B * sinSigma * (cos2SigmaM + B / 4.0 * (cosSigma * 
                          (-1.0 + 2.0 * cos2SigmaM * cos2SigmaM) - B / 6.0 * cos2SigmaM * 
                          (-3.0 + 4.0 * sinSigma * sinSigma) * (-3.0 + 4.0 * cos2SigmaM * cos2SigmaM)));

        const s = b * A * (sigma - deltaSigma);

        const alpha1 = Math.atan2(cosU2 * sinLambda, 
                                 cosU1 * sinU2 - sinU1 * cosU2 * cosLambda);
        const alpha2 = Math.atan2(cosU1 * sinLambda, 
                                 -sinU1 * cosU2 + cosU1 * sinU2 * cosLambda);

        return new GeodeticCurve(s, alpha1, alpha2);
    }

    // Calculate ending coordinates given start point, bearing, and distance
    calculateEndingGlobalCoordinates(ellipsoid, start, azimuth, distance) {
        const a = ellipsoid.semiMajorAxis;
        const b = ellipsoid.semiMinorAxis;
        const f = ellipsoid.flattening;

        const phi1 = start.latitudeRadians;
        const lambda1 = start.longitudeRadians;
        const alpha1 = azimuth;
        const s = distance;

        const tanU1 = (1.0 - f) * Math.tan(phi1);
        const cosU1 = 1.0 / Math.sqrt(1.0 + tanU1 * tanU1);
        const sinU1 = tanU1 * cosU1;

        const sigma1 = Math.atan2(tanU1, Math.cos(alpha1));
        const sinAlpha = cosU1 * Math.sin(alpha1);
        const cosSqAlpha = 1.0 - sinAlpha * sinAlpha;
        const uSq = cosSqAlpha * (a * a - b * b) / (b * b);
        const A = 1.0 + uSq / 16384.0 * (4096.0 + uSq * (-768.0 + uSq * (320.0 - 175.0 * uSq)));
        const B = uSq / 1024.0 * (256.0 + uSq * (-128.0 + uSq * (74.0 - 47.0 * uSq)));

        let sigma = s / (b * A);
        let sigmaP = 2.0 * Math.PI;
        let iterLimit = this.maxIterations;
        let cos2SigmaM, sinSigma, cosSigma, deltaSigma;

        while (Math.abs(sigma - sigmaP) > this.accuracy && --iterLimit > 0) {
            cos2SigmaM = Math.cos(2.0 * sigma1 + sigma);
            sinSigma = Math.sin(sigma);
            cosSigma = Math.cos(sigma);
            deltaSigma = B * sinSigma * (cos2SigmaM + B / 4.0 * (cosSigma * 
                        (-1.0 + 2.0 * cos2SigmaM * cos2SigmaM) - B / 6.0 * cos2SigmaM * 
                        (-3.0 + 4.0 * sinSigma * sinSigma) * (-3.0 + 4.0 * cos2SigmaM * cos2SigmaM)));
            sigmaP = sigma;
            sigma = s / (b * A) + deltaSigma;
        }

        if (iterLimit === 0) {
            console.warn('Vincenty formula failed to converge');
        }

        const tmp = sinU1 * sinSigma - cosU1 * cosSigma * Math.cos(alpha1);
        const phi2 = Math.atan2(sinU1 * cosSigma + cosU1 * sinSigma * Math.cos(alpha1),
                               (1.0 - f) * Math.sqrt(sinAlpha * sinAlpha + tmp * tmp));

        const lambda = Math.atan2(sinSigma * Math.sin(alpha1),
                                  cosU1 * cosSigma - sinU1 * sinSigma * Math.cos(alpha1));

        const C = f / 16.0 * cosSqAlpha * (4.0 + f * (4.0 - 3.0 * cosSqAlpha));
        const L = lambda - (1.0 - C) * f * sinAlpha *
                 (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * 
                 (-1.0 + 2.0 * cos2SigmaM * cos2SigmaM)));

        const lambda2 = lambda1 + L;

        const lat2 = phi2 * 180.0 / Math.PI;
        const lon2 = lambda2 * 180.0 / Math.PI;

        return new GlobalCoordinates(lat2, lon2);
    }
}

console.log('[geodetic.js] Classes defined - Ellipsoid:', typeof Ellipsoid, 'GlobalCoordinates:', typeof GlobalCoordinates, 'GeodeticCurve:', typeof GeodeticCurve, 'GeodeticCalculator:', typeof GeodeticCalculator);
if (typeof window !== 'undefined') {
    window.Ellipsoid = Ellipsoid;
    window.GlobalCoordinates = GlobalCoordinates;
    window.GeodeticCurve = GeodeticCurve;
    window.GeodeticCalculator = GeodeticCalculator;
    console.log('[geodetic.js] All classes explicitly attached to window');
}
