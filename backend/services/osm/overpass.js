/**
 * Overpass API Client
 * Handles Overpass QL queries with endpoint failover and rate limiting
 * 
 * Ported from: Traxim-MCP-Servers/traxim-input-creator-mcp/lib/ipv4fetch.js
 */

import { ipv4Fetch } from './ipv4fetch.js';

// OVERPASS_API_URL (self-hosted rail-only instance, when set) is checked
// deterministically first in probeOverpassEndpoints() — NOT raced against the
// public mirrors. Racing seems appealing (self-hosted, being local, should
// always win) but a race can be lost to a one-off transient hiccup, and the
// result below is cached for ENDPOINT_CACHE_MS — permanently stranding the
// whole cache window on a public mirror even though self-hosted recovers a
// moment later. Only fall through to racing the public mirrors if the
// self-hosted check itself fails.
const SELF_HOSTED_URL = process.env.OVERPASS_API_URL || null;
const PUBLIC_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',        // Public fallback (Germany)
  'https://overpass.kumi.systems/api/interpreter'   // Public fallback (CDN)
];

const PROBE_QUERY = '[out:json][timeout:3];out 0;';
const USER_AGENT = 'TraximFileGenerator/1.0 (traximrail.com)';

// Cached winning endpoint, with a TTL so a transient failure doesn't strand
// the rest of this (potentially long-running) process on a public mirror —
// self-hosted gets re-tried periodically rather than abandoned forever after
// one bad probe.
const ENDPOINT_CACHE_MS = parseInt(process.env.OVERPASS_ENDPOINT_CACHE_MS || '300000', 10); // 5 min
let _activeEndpoint = null;
let _activeEndpointAt = 0;
let _probeInFlight = null;

// Dynamic inter-query gap based on the previous query's response time.
// Overpass slot cooldown mirrors query duration, so we wait as long as the last
// query took before firing the next one. Falls back to a minimum floor.
const MIN_INTER_QUERY_GAP_MS = parseInt(process.env.OVERPASS_MIN_GAP_MS || '500', 10);
const GAP_BUFFER_MS = parseInt(process.env.OVERPASS_GAP_BUFFER_MS || '500', 10);
let _lastQueryCompletedAt = 0;
let _lastQueryDurationMs = MIN_INTER_QUERY_GAP_MS;

async function enforceQueryGap() {
  const gap = Math.max(_lastQueryDurationMs, MIN_INTER_QUERY_GAP_MS) + GAP_BUFFER_MS;
  const elapsed = Date.now() - _lastQueryCompletedAt;
  if (elapsed < gap) {
    const wait = gap - elapsed;
    console.log(`[Overpass] Rate-limit gap: waiting ${wait}ms (last query took ${_lastQueryDurationMs}ms + ${GAP_BUFFER_MS}ms buffer)`);
    await new Promise(resolve => setTimeout(resolve, wait));
  }
}

function recordQueryTiming(durationMs) {
  _lastQueryDurationMs = durationMs;
  _lastQueryCompletedAt = Date.now();
}

/**
 * Probe all Overpass endpoints and cache the fastest
 * @returns {Promise<string>} URL of fastest endpoint
 */
async function probeOne(url) {
  try {
    const res = await ipv4Fetch(url, {
      method: 'POST',
      socketTimeout: 3000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT
      },
      body: new URLSearchParams({ data: PROBE_QUERY })
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const text = await res.text();
    if (text.trimStart().startsWith('<')) {
      throw new Error('XML response (expected JSON)');
    }

    return url;
  } catch (error) {
    throw new Error(`Probe failed: ${error.message}`);
  }
}

async function probeOverpassEndpoints() {
  if (_activeEndpoint && (Date.now() - _activeEndpointAt) < ENDPOINT_CACHE_MS) {
    return _activeEndpoint;
  }
  if (_probeInFlight) return _probeInFlight;

  _probeInFlight = (async () => {
    if (SELF_HOSTED_URL) {
      try {
        return await probeOne(SELF_HOSTED_URL);
      } catch (error) {
        console.warn(`[Overpass] Self-hosted probe failed, falling back to public mirrors: ${error.message}`);
      }
    }
    return Promise.any(PUBLIC_ENDPOINTS.map(probeOne))
      .catch(() => PUBLIC_ENDPOINTS[0]); // All failed → use primary
  })()
    .then((url) => {
      _activeEndpoint = url;
      _activeEndpointAt = Date.now();
      _probeInFlight = null;
      console.log(`[Overpass] Selected endpoint: ${url}`);
      return url;
    });

  return _probeInFlight;
}

/**
 * Execute Overpass QL query with retry logic
 * @param {string} query - Overpass QL query
 * @param {number} timeoutSec - Query timeout in seconds
 * @param {number} maxRetries - Maximum retry attempts
 * @returns {Promise<object>} Parsed JSON response
 */
export async function overpassFetch(query, timeoutSec = 25, maxRetries = 2) {
  const endpoint = await probeOverpassEndpoints();
  
  // Ensure query has timeout directive
  const normalizedQuery = query.trim().startsWith('[')
    ? query
    : `[out:json][timeout:${timeoutSec}];\n${query}`;
  
  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Overpass] Query attempt ${attempt + 1}/${maxRetries + 1}`);

      await enforceQueryGap();
      const t0 = Date.now();

      const res = await ipv4Fetch(endpoint, {
        method: 'POST',
        socketTimeout: (timeoutSec + 5) * 1000, // Add 5s buffer to query timeout
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT
        },
        body: new URLSearchParams({ data: normalizedQuery })
      });

      recordQueryTiming(Date.now() - t0);

      if (res.status === 429) {
        // Rate limited — back off and let the slot recover
        const retryAfter = parseInt(process.env.OVERPASS_RETRY_DELAY_MS || '10000', 10);
        console.warn(`[Overpass] Rate limited (429). Waiting ${retryAfter}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, retryAfter));
        continue;
      }
      
      if (res.status === 504 || res.status === 503) {
        // Gateway timeout or service unavailable
        console.warn(`[Overpass] Server error (${res.status}). Retrying...`);
        lastError = new Error(`Server error: ${res.status}`);
        continue;
      }
      
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      
      const data = await res.json();
      
      // Check for Overpass error in response
      if (data.remark && data.remark.includes('error')) {
        throw new Error(`Overpass error: ${data.remark}`);
      }
      
      console.log(`[Overpass] Query successful. Elements: ${(data.elements || []).length}`);
      return data;
      
    } catch (error) {
      lastError = error;
      console.error(`[Overpass] Attempt ${attempt + 1} failed:`, error.message);
      
      if (attempt < maxRetries) {
        // Exponential backoff: 2s, 4s, 8s...
        const delayMs = Math.pow(2, attempt + 1) * 1000;
        console.log(`[Overpass] Waiting ${delayMs}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  
  throw new Error(`Overpass query failed after ${maxRetries + 1} attempts: ${lastError?.message || 'Unknown error'}`);
}

/**
 * Reset the active endpoint (useful for testing or after errors)
 */
export function resetEndpoint() {
  _activeEndpoint = null;
  _activeEndpointAt = 0;
  _probeInFlight = null;
  console.log('[Overpass] Endpoint cache cleared');
}
