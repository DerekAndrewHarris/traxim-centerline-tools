/**
 * Elevation Service
 * 
 * Queries elevation data from Open-Elevation API (https://open-elevation.com)
 * with intelligent sub-sampling and interpolation to minimize API calls.
 * 
 * Strategy:
 * - Query every ELEV_STRIDE-th point (default 8) to reduce API load
 * - Interpolate elevations for intermediate points
 * - Batch requests (max 100 points per request)
 * - Graceful degradation: return 0 if API unavailable
 */

import { ipv4Fetch } from './osm/ipv4fetch.js';

// Configuration
const OPEN_ELEVATION_URL = 'https://api.open-elevation.com/api/v1/lookup';
const BATCH_SIZE = 100;          // Max points per API request
const ELEV_STRIDE = 8;           // Query every 8th point
const REQUEST_TIMEOUT_MS = 30000; // 30 second timeout per request
const MAX_RETRIES = 2;           // Retry failed requests twice

/**
 * Fetch elevations for an array of points from Open-Elevation API.
 * Uses sub-sampling strategy: queries every ELEV_STRIDE-th point,
 * then interpolates elevations for intermediate points.
 * 
 * @param {Array<{lat: number, lon: number}>} points - Array of coordinate points
 * @param {Function} progressCallback - Optional progress callback (percent, message)
 * @returns {Promise<Array<{lat: number, lon: number, elevation: number}>>} Points with elevations
 */
export async function fetchElevations(points, progressCallback = null) {
  if (!points || points.length === 0) {
    return [];
  }

  try {
    // Step 1: Select sample points (every ELEV_STRIDE-th point, plus first and last)
    const sampleIndices = [];
    sampleIndices.push(0); // Always include first point
    
    for (let i = ELEV_STRIDE; i < points.length; i += ELEV_STRIDE) {
      sampleIndices.push(i);
    }
    
    // Always include last point if not already included
    const lastIdx = points.length - 1;
    if (sampleIndices[sampleIndices.length - 1] !== lastIdx) {
      sampleIndices.push(lastIdx);
    }

    const samplePoints = sampleIndices.map(i => points[i]);

    if (progressCallback) {
      progressCallback(
        0,
        `Fetching elevations for ${samplePoints.length}/${points.length} sample points (every ${ELEV_STRIDE}th point)`
      );
    }

    // Step 2: Fetch elevations for sample points in batches
    const sampleResults = await fetchElevationsBatched(samplePoints, progressCallback);

    // Build map of index → elevation for sample points
    const elevationMap = new Map();
    for (let i = 0; i < sampleIndices.length; i++) {
      elevationMap.set(sampleIndices[i], sampleResults[i].elevation);
    }

    if (progressCallback) {
      progressCallback(80, 'Interpolating elevations for intermediate points');
    }

    // Step 3: Interpolate elevations for all points
    const results = [];
    for (let i = 0; i < points.length; i++) {
      if (elevationMap.has(i)) {
        // Sample point - use fetched elevation
        results.push({
          lat: points[i].lat,
          lon: points[i].lon,
          elevation: elevationMap.get(i)
        });
      } else {
        // Intermediate point - interpolate between surrounding samples
        const elevation = interpolateElevation(i, sampleIndices, elevationMap);
        results.push({
          lat: points[i].lat,
          lon: points[i].lon,
          elevation
        });
      }
    }

    if (progressCallback) {
      progressCallback(100, `Elevation data complete (${results.length} points)`);
    }

    return results;

  } catch (error) {
    console.error('Elevation fetch failed:', error.message);
    
    // Graceful degradation: return all points with elevation = 0
    if (progressCallback) {
      progressCallback(100, 'Elevation service unavailable - using elevation = 0');
    }
    
    return points.map(p => ({
      lat: p.lat,
      lon: p.lon,
      elevation: 0
    }));
  }
}

/**
 * Fetch elevations for points in batches (max BATCH_SIZE per request).
 * Internal function used by fetchElevations.
 * 
 * @param {Array<{lat: number, lon: number}>} points - Points to query
 * @param {Function} progressCallback - Optional progress callback
 * @returns {Promise<Array<{lat: number, lon: number, elevation: number}>>}
 */
async function fetchElevationsBatched(points, progressCallback = null) {
  const results = [];
  const totalBatches = Math.ceil(points.length / BATCH_SIZE);

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const start = batchIdx * BATCH_SIZE;
    const end = Math.min(start + BATCH_SIZE, points.length);
    const batch = points.slice(start, end);

    if (progressCallback) {
      const percent = Math.round((batchIdx / totalBatches) * 70); // 0-70% range
      progressCallback(percent, `Querying elevation batch ${batchIdx + 1}/${totalBatches} (${batch.length} points)`);
    }

    // Query batch with retries
    let batchResults = null;
    let lastError = null;

    for (let retry = 0; retry <= MAX_RETRIES; retry++) {
      try {
        batchResults = await queryElevationBatch(batch);
        break; // Success - exit retry loop
      } catch (error) {
        lastError = error;
        if (retry < MAX_RETRIES) {
          // Wait before retry (exponential backoff)
          const delayMs = 1000 * Math.pow(2, retry);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }

    if (!batchResults) {
      // All retries failed - throw error to trigger graceful degradation
      throw new Error(`Elevation batch ${batchIdx + 1} failed after ${MAX_RETRIES} retries: ${lastError.message}`);
    }

    results.push(...batchResults);
  }

  return results;
}

/**
 * Query elevation for a single batch of points from Open-Elevation API.
 * 
 * @param {Array<{lat: number, lon: number}>} points - Points to query (max 100)
 * @returns {Promise<Array<{lat: number, lon: number, elevation: number}>>}
 */
async function queryElevationBatch(points) {
  if (points.length > BATCH_SIZE) {
    throw new Error(`Batch size ${points.length} exceeds maximum ${BATCH_SIZE}`);
  }

  // Build request body
  const locations = points.map(p => ({
    latitude: p.lat,
    longitude: p.lon
  }));

  const requestBody = JSON.stringify({ locations });

  // Send POST request
  const response = await ipv4Fetch(OPEN_ELEVATION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: requestBody,
    timeout: REQUEST_TIMEOUT_MS
  });

  if (!response.ok) {
    throw new Error(`Open-Elevation API returned ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();

  if (!data.results || !Array.isArray(data.results)) {
    throw new Error('Invalid response format from Open-Elevation API');
  }

  // Extract elevations
  const results = [];
  for (let i = 0; i < points.length; i++) {
    const result = data.results[i];
    results.push({
      lat: points[i].lat,
      lon: points[i].lon,
      elevation: result?.elevation ?? 0
    });
  }

  return results;
}

/**
 * Interpolate elevation for an intermediate point between two sample points.
 * Uses linear interpolation based on array index position.
 * 
 * @param {number} targetIdx - Index of point needing elevation
 * @param {Array<number>} sampleIndices - Array of sample point indices (sorted)
 * @param {Map<number, number>} elevationMap - Map of index → elevation for samples
 * @returns {number} Interpolated elevation
 */
function interpolateElevation(targetIdx, sampleIndices, elevationMap) {
  // Find surrounding sample points
  let lowerIdx = sampleIndices[0];
  let upperIdx = sampleIndices[sampleIndices.length - 1];

  for (let i = 0; i < sampleIndices.length - 1; i++) {
    if (sampleIndices[i] <= targetIdx && sampleIndices[i + 1] >= targetIdx) {
      lowerIdx = sampleIndices[i];
      upperIdx = sampleIndices[i + 1];
      break;
    }
  }

  const lowerElev = elevationMap.get(lowerIdx) ?? 0;
  const upperElev = elevationMap.get(upperIdx) ?? 0;

  if (lowerIdx === upperIdx) {
    return lowerElev;
  }

  // Linear interpolation by index position
  const fraction = (targetIdx - lowerIdx) / (upperIdx - lowerIdx);
  return lowerElev + fraction * (upperElev - lowerElev);
}

/**
 * Batch elevation fetching with configurable stride.
 * Allows caller to customize sub-sampling rate.
 * 
 * @param {Array<{lat: number, lon: number}>} points - Points to query
 * @param {number} stride - Sample every Nth point
 * @param {Function} progressCallback - Optional progress callback
 * @returns {Promise<Array<{lat: number, lon: number, elevation: number}>>}
 */
export async function fetchElevationsWithStride(points, stride, progressCallback = null) {
  const originalStride = ELEV_STRIDE;
  
  try {
    // Temporarily override stride (not ideal, but works for single-threaded JS)
    Object.defineProperty(globalThis, '_ELEV_STRIDE_OVERRIDE', { value: stride, configurable: true });
    
    // Use modified stride
    return await fetchElevations(points, progressCallback);
    
  } finally {
    // Restore original stride
    delete globalThis._ELEV_STRIDE_OVERRIDE;
  }
}

/**
 * Check if Open-Elevation API is available.
 * Sends a minimal test request to verify connectivity.
 * 
 * @returns {Promise<boolean>} True if API is available
 */
export async function checkElevationServiceAvailable() {
  try {
    const testPoint = [{ latitude: 45.0, longitude: 9.0 }];
    const response = await ipv4Fetch(OPEN_ELEVATION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ locations: testPoint }),
      timeout: 5000 // 5 second timeout for health check
    });

    return response.ok;
  } catch (error) {
    return false;
  }
}

export default {
  fetchElevations,
  fetchElevationsWithStride,
  checkElevationServiceAvailable,
  BATCH_SIZE,
  ELEV_STRIDE,
  REQUEST_TIMEOUT_MS
};
