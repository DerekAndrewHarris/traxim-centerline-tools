/**
 * Geodetic calculations using Vincenty's formulae on the WGS84 ellipsoid.
 * Ported from the Traxim Centreline Tools web app (which itself was ported from C#).
 */

const WGS84 = {
  a: 6378137.0,
  b: 6356752.314245,
  f: 1 / 298.257223563,
};

/**
 * Calculate the ellipsoidal distance (metres) and forward azimuth (radians)
 * between two lat/lon points using Vincenty's inverse formula.
 * @param {number} lat1 - Start latitude in degrees
 * @param {number} lon1 - Start longitude in degrees
 * @param {number} lat2 - End latitude in degrees
 * @param {number} lon2 - End longitude in degrees
 * @returns {{ distance: number, azimuth: number, reverseAzimuth: number }}
 */
export function vincentyInverse(lat1, lon1, lat2, lon2) {
  const { a, b, f } = WGS84;

  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const L = ((lon2 - lon1) * Math.PI) / 180;

  const U1 = Math.atan((1 - f) * Math.tan(phi1));
  const U2 = Math.atan((1 - f) * Math.tan(phi2));
  const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);

  let lambda = L;
  let lambdaP;
  let cosSqAlpha, sinSigma, cos2SigmaM, cosSigma, sigma, sinLambda, cosLambda;
  let iters = 100;

  do {
    sinLambda = Math.sin(lambda);
    cosLambda = Math.cos(lambda);

    const sinSqSigma =
      cosU2 * sinLambda * (cosU2 * sinLambda) +
      (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) *
        (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda);

    sinSigma = Math.sqrt(sinSqSigma);
    if (sinSigma === 0) return { distance: 0, azimuth: 0, reverseAzimuth: 0 };

    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cosSqAlpha = 1 - sinAlpha * sinAlpha;
    cos2SigmaM = cosSqAlpha
      ? cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha
      : 0;

    const C =
      (f / 16) * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha));
    lambdaP = lambda;
    lambda =
      L +
      (1 - C) *
        f *
        sinAlpha *
        (sigma +
          C *
            sinSigma *
            (cos2SigmaM +
              C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
  } while (Math.abs(lambda - lambdaP) > 1e-12 && --iters > 0);

  const uSq = (cosSqAlpha * (a * a - b * b)) / (b * b);
  const A_ =
    1 +
    (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B_ =
    (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const deltaSigma =
    B_ *
    sinSigma *
    (cos2SigmaM +
      (B_ / 4) *
        (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
          (B_ / 6) *
            cos2SigmaM *
            (-3 + 4 * sinSigma * sinSigma) *
            (-3 + 4 * cos2SigmaM * cos2SigmaM)));

  const distance = b * A_ * (sigma - deltaSigma);
  const azimuth = Math.atan2(
    cosU2 * sinLambda,
    cosU1 * sinU2 - sinU1 * cosU2 * cosLambda
  );
  const reverseAzimuth = Math.atan2(
    cosU1 * sinLambda,
    -sinU1 * cosU2 + cosU1 * sinU2 * cosLambda
  );

  return { distance, azimuth, reverseAzimuth };
}

/**
 * Calculate the destination point given start, bearing (radians), and distance (metres).
 * Uses Vincenty's direct formula.
 * @returns {{ latitude: number, longitude: number }} in degrees
 */
export function vincentyDirect(lat1, lon1, azimuth, distance) {
  const { a, b, f } = WGS84;

  const phi1 = (lat1 * Math.PI) / 180;
  const lambda1 = (lon1 * Math.PI) / 180;
  const alpha1 = azimuth;
  const s = distance;

  const tanU1 = (1 - f) * Math.tan(phi1);
  const cosU1 = 1 / Math.sqrt(1 + tanU1 * tanU1);
  const sinU1 = tanU1 * cosU1;

  const sigma1 = Math.atan2(tanU1, Math.cos(alpha1));
  const sinAlpha = cosU1 * Math.sin(alpha1);
  const cosSqAlpha = 1 - sinAlpha * sinAlpha;
  const uSq = (cosSqAlpha * (a * a - b * b)) / (b * b);
  const A_ =
    1 +
    (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B_ =
    (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));

  let sigma = s / (b * A_);
  let sigmaP;
  let cos2SigmaM, sinSigma, cosSigma, deltaSigma;
  let iters = 100;

  do {
    cos2SigmaM = Math.cos(2 * sigma1 + sigma);
    sinSigma = Math.sin(sigma);
    cosSigma = Math.cos(sigma);
    deltaSigma =
      B_ *
      sinSigma *
      (cos2SigmaM +
        (B_ / 4) *
          (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
            (B_ / 6) *
              cos2SigmaM *
              (-3 + 4 * sinSigma * sinSigma) *
              (-3 + 4 * cos2SigmaM * cos2SigmaM)));
    sigmaP = sigma;
    sigma = s / (b * A_) + deltaSigma;
  } while (Math.abs(sigma - sigmaP) > 1e-12 && --iters > 0);

  const tmp =
    sinU1 * sinSigma - cosU1 * cosSigma * Math.cos(alpha1);
  const phi2 = Math.atan2(
    sinU1 * cosSigma + cosU1 * sinSigma * Math.cos(alpha1),
    (1 - f) * Math.sqrt(sinAlpha * sinAlpha + tmp * tmp)
  );
  const lambdaFwd = Math.atan2(
    sinSigma * Math.sin(alpha1),
    cosU1 * cosSigma - sinU1 * sinSigma * Math.cos(alpha1)
  );
  const C = (f / 16) * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha));
  const L =
    lambdaFwd -
    (1 - C) *
      f *
      sinAlpha *
      (sigma +
        C *
          sinSigma *
          (cos2SigmaM +
            C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
  const lambda2 = lambda1 + L;

  return {
    latitude: (phi2 * 180) / Math.PI,
    longitude: (lambda2 * 180) / Math.PI,
  };
}

/**
 * Convenience: distance in metres between two lat/lon points.
 */
export function distanceMetres(lat1, lon1, lat2, lon2) {
  return vincentyInverse(lat1, lon1, lat2, lon2).distance;
}
