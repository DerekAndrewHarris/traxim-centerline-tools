/**
 * OSM Geocoding Service
 * Geocodes place names using OSM administrative boundaries and railway stations
 * 
 * Algorithm:
 * 1. Nominatim search (fast indexed) → get multiple candidates
 * 2. Pick the result with the smallest bounding-box area (city beats province)
 * 3. If the best result is an OSM relation, fetch admin_centre via direct ID lookup
 * 4. Query for railway stations within ~10km of center
 * 5. Return closest station (typically the main/central station)
 * 6. Fall back to Overpass global admin boundary search if Nominatim fails
 * 
 * Caching: Results are cached in-memory to avoid repeated API calls for common places.
 * 
 * Ported from: Traxim-MCP-Servers/traxim-input-creator-mcp/tools/geography.js
 */

import { ipv4Fetch } from './ipv4fetch.js';
import { overpassFetch } from './overpass.js';

/**
 * In-memory cache for geocoding results
 * Key: normalized place name (lowercase, trimmed)
 * Value: geocoding result object
 */
const geocodeCache = new Map();
const MAX_CACHE_SIZE = 1000; // Limit cache size to prevent memory issues

/**
 * Normalize place name for cache lookup (lowercase, trim, normalize spaces)
 */
function normalizePlaceName(placeName) {
  return placeName.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Get cached geocoding result
 */
function getCachedResult(placeName) {
  const key = normalizePlaceName(placeName);
  const cached = geocodeCache.get(key);
  
  if (cached) {
    console.log(`[Geocoding] Cache hit: ${placeName}`);
    return cached;
  }
  
  return null;
}

/**
 * Store geocoding result in cache
 */
function setCachedResult(placeName, result) {
  const key = normalizePlaceName(placeName);
  
  // Implement simple LRU: if cache is full, remove oldest entry
  if (geocodeCache.size >= MAX_CACHE_SIZE) {
    const firstKey = geocodeCache.keys().next().value;
    geocodeCache.delete(firstKey);
    console.log(`[Geocoding] Cache full, evicted: ${firstKey}`);
  }
  
  geocodeCache.set(key, result);
  console.log(`[Geocoding] Cached result for: ${placeName} (cache size: ${geocodeCache.size})`);
}

/**
 * Find OSM administrative boundary by name
 * Searches admin levels 8 (municipality), 6 (province), 4 (region) in order
 * Prefers admin_centre node over geometric centroid for accuracy
 * 
 * @param {string} placeName - City or place name
 * @returns {Promise<{lat: number, lon: number, bbox, adminLevel: number, displayName: string, centerSource: string}|null>}
 */
async function findAdminBoundary(placeName) {
  const adminLevels = [8, 6, 4]; // Municipality → Province → Region
  
  for (const level of adminLevels) {
    // Step 1: Get the relation to find admin_centre member
    // Search multiple name variants: name (local), name:en (English), int_name (international), alt_name (alternative)
    const relationQuery = `
      [out:json][timeout:30];
      (
        relation["boundary"="administrative"]["admin_level"="${level}"]["name"~"^${placeName}$",i];
        relation["boundary"="administrative"]["admin_level"="${level}"]["name:en"~"^${placeName}$",i];
        relation["boundary"="administrative"]["admin_level"="${level}"]["int_name"~"^${placeName}$",i];
        relation["boundary"="administrative"]["admin_level"="${level}"]["alt_name"~"^${placeName}$",i];
      );
      out;
    `;
    
    try {
      const data = await overpassFetch(relationQuery, 30, 2);
      
      if (data.elements && data.elements.length > 0) {
        const relation = data.elements[0];
        let centerLat, centerLon, centerSource;
        
        // PREFERRED: admin_centre node (usually the town hall/railway station)
        const adminCentreMember = (relation.members || []).find(
          m => m.type === 'node' && m.role === 'admin_centre'
        );
        
        if (adminCentreMember) {
          // Step 2: Fetch the admin_centre node coordinates
          const nodeQuery = `[out:json][timeout:30];node(${adminCentreMember.ref});out;`;
          
          try {
            const nodeData = await overpassFetch(nodeQuery, 30, 1);
            if (nodeData.elements && nodeData.elements.length > 0) {
              const node = nodeData.elements[0];
              centerLat = node.lat;
              centerLon = node.lon;
              centerSource = "admin_centre_node";
            }
          } catch (e) {
            console.warn(`[Geocoding] Could not fetch admin_centre node: ${e.message}`);
          }
        }
        
        // FALLBACK: Use geometric centroid if admin_centre not available
        if (!centerLat || !centerLon) {
          if (relation.center) {
            centerLat = relation.center.lat;
            centerLon = relation.center.lon;
          } else if (relation.lat && relation.lon) {
            centerLat = relation.lat;
            centerLon = relation.lon;
          } else if (relation.bounds) {
            centerLat = (relation.bounds.minlat + relation.bounds.maxlat) / 2;
            centerLon = (relation.bounds.minlon + relation.bounds.maxlon) / 2;
          } else {
            continue; // No center available, try next admin level
          }
          centerSource = "geometric_centroid";
        }
        
        const bbox = relation.bounds ? {
          minLat: relation.bounds.minlat,
          minLon: relation.bounds.minlon,
          maxLat: relation.bounds.maxlat,
          maxLon: relation.bounds.maxlon
        } : null;
        
        console.log(`[Geocoding] Found admin boundary: ${relation.tags?.name} (level ${level}, center: ${centerSource})`);
        
        return {
          lat: centerLat,
          lon: centerLon,
          bbox,
          adminLevel: level,
          displayName: relation.tags?.name || placeName,
          centerSource
        };
      }
    } catch (e) {
      console.warn(`[Geocoding] Admin level ${level} search failed: ${e.message}`);
      continue;
    }
  }
  
  return null;
}

/**
 * Find railway stations near a given point
 * @param {number} centerLat 
 * @param {number} centerLon 
 * @param {number} radiusDeg - Search radius in degrees (default: 0.1 ~ 11km)
 * @returns {Promise<Array<{lat, lon, name, distanceKm}>>}
 */
async function findNearbyStations(centerLat, centerLon, radiusDeg = 0.1) {
  const minLat = centerLat - radiusDeg;
  const maxLat = centerLat + radiusDeg;
  const minLon = centerLon - radiusDeg;
  const maxLon = centerLon + radiusDeg;
  
  const query = `
    [out:json][timeout:30];
    (
      node["railway"~"^(station|halt)$"]["name"](${minLat},${minLon},${maxLat},${maxLon});
      way["railway"~"^(station|halt)$"]["name"](${minLat},${minLon},${maxLat},${maxLon});
    );
    out center;
  `;
  
  try {
    const data = await overpassFetch(query, 30, 2);
    const stations = [];
    
    for (const element of data.elements || []) {
      const stationLat = element.center?.lat || element.lat;
      const stationLon = element.center?.lon || element.lon;
      const stationName = element.tags?.name;
      
      if (stationLat && stationLon && stationName) {
        // Calculate distance from center (rough approximation)
        const latDiff = (stationLat - centerLat) * 111; // ~111 km per degree lat
        const lonDiff = (stationLon - centerLon) * 111 * Math.cos(centerLat * Math.PI / 180);
        const distanceKm = Math.sqrt(latDiff * latDiff + lonDiff * lonDiff);
        
        stations.push({
          lat: stationLat,
          lon: stationLon,
          name: stationName,
          distanceKm
        });
      }
    }
    
    // Sort by distance (closest first)
    stations.sort((a, b) => a.distanceKm - b.distanceKm);
    
    console.log(`[Geocoding] Found ${stations.length} nearby stations`);
    return stations;
  } catch (e) {
    console.warn(`[Geocoding] Station search failed: ${e.message}`);
    return [];
  }
}

/**
 * Search Nominatim for a place name and pick the result with the smallest
 * bounding-box area (most specific match — city beats province).
 * If the best result is an OSM relation, fetch admin_centre via a direct
 * Overpass ID lookup (instant, no regex scan).
 *
 * @param {string} placeName
 * @returns {Promise<{lat, lon, bbox?, displayName, adminLevel?, centerSource, osmId?}|null>}
 */
async function findPlaceViaNominatim(placeName) {
  const url = `https://nominatim.openstreetmap.org/search?` +
    `q=${encodeURIComponent(placeName)}&format=json&limit=10&addressdetails=1&extratags=1`;
  const res = await ipv4Fetch(url, {
    headers: { 'User-Agent': 'TraximFileGenerator/1.0 (traximrail.com)' }
  });
  const candidates = await res.json();
  if (!candidates.length) return null;

  // Compute bbox area for each candidate and pick the smallest
  const scored = candidates.map(c => {
    const bb = c.boundingbox; // [south, north, west, east] as strings
    if (!bb || bb.length < 4) return { c, area: Infinity };
    const latSpan = Math.abs(parseFloat(bb[1]) - parseFloat(bb[0]));
    const lonSpan = Math.abs(parseFloat(bb[3]) - parseFloat(bb[2]));
    return { c, area: latSpan * lonSpan };
  });
  scored.sort((a, b) => a.area - b.area);

  const best = scored[0].c;
  console.log(`[Geocoding] Nominatim best of ${candidates.length}: "${best.display_name}" (area=${scored[0].area.toFixed(6)}, type=${best.osm_type}/${best.osm_id})`);

  let centerLat = parseFloat(best.lat);
  let centerLon = parseFloat(best.lon);
  let centerSource = 'nominatim_center';
  let adminLevel = best.address?.admin_level ? parseInt(best.address.admin_level) : null;

  // If the best result is a relation, try to fetch its admin_centre node
  // This is a direct ID lookup — fast and reliable
  if (best.osm_type === 'relation') {
    try {
      const relQuery = `[out:json][timeout:15];relation(${best.osm_id});out;`;
      const relData = await overpassFetch(relQuery, 15, 1);
      const rel = relData.elements?.[0];
      if (rel) {
        adminLevel = adminLevel || (rel.tags?.admin_level ? parseInt(rel.tags.admin_level) : null);
        const adminCentreMember = (rel.members || []).find(
          m => m.type === 'node' && m.role === 'admin_centre'
        );
        if (adminCentreMember) {
          const nodeQuery = `[out:json][timeout:15];node(${adminCentreMember.ref});out;`;
          const nodeData = await overpassFetch(nodeQuery, 15, 1);
          const node = nodeData.elements?.[0];
          if (node) {
            centerLat = node.lat;
            centerLon = node.lon;
            centerSource = 'admin_centre_node';
            console.log(`[Geocoding] Got admin_centre node ${adminCentreMember.ref} for relation ${best.osm_id}`);
          }
        }
      }
    } catch (e) {
      console.warn(`[Geocoding] Could not fetch admin_centre for relation ${best.osm_id}: ${e.message}`);
      // Fall through — use Nominatim lat/lon
    }
  }

  const bb = best.boundingbox;
  const bbox = bb ? {
    minLat: parseFloat(bb[0]),
    maxLat: parseFloat(bb[1]),
    minLon: parseFloat(bb[2]),
    maxLon: parseFloat(bb[3])
  } : null;

  return {
    lat: centerLat,
    lon: centerLon,
    bbox,
    adminLevel,
    displayName: best.display_name,
    centerSource,
    osmId: best.osm_type === 'relation' ? best.osm_id : null
  };
}

/**
 * Reverse-geocode a coordinate to a short, human-friendly place label.
 * Used to name waypoints placed by clicking the map, where we already have
 * the exact coordinate and just want a display name for it — not a place
 * search, so this never touches Overpass and only makes a single Nominatim
 * call, with a single fast attempt (best-effort: a slow/failed lookup should
 * never block the caller, which falls back to a generic label instead).
 *
 * Uses Nominatim's structured `address` fields rather than splitting
 * `display_name`, since the free-text string's component order/count shifts
 * depending on what was hit (a street address inserts road/house-number at
 * the front; a rural point skips straight to hamlet/county) — the address
 * object lets us pick "the settlement" regardless of what the exact point
 * landed on.
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<{label: string, displayName: string}|null>}
 */
export async function reverseGeocodePlace(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?` +
    `lat=${lat}&lon=${lon}&format=json&addressdetails=1`;

  try {
    const res = await ipv4Fetch(url, {
      headers: { 'User-Agent': 'TraximFileGenerator/1.0 (traximrail.com)' },
      socketTimeout: 7000
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const addr = data.address || {};

    const label = addr.town || addr.city || addr.village || addr.hamlet ||
      addr.suburb || addr.municipality || addr.county ||
      (data.display_name ? data.display_name.split(',')[0].trim() : null);

    if (!label) return null;

    console.log(`[Geocoding] Reverse geocoded (${lat}, ${lon}) -> "${label}"`);
    return { label, displayName: data.display_name || label };
  } catch (e) {
    console.warn(`[Geocoding] Reverse geocode failed for (${lat}, ${lon}): ${e.message}`);
    return null;
  }
}

/**
 * Geocode a place name to coordinates
 * 
 * Strategy 1 (fast): Nominatim → smallest bbox result → admin_centre via direct ID → nearby station
 * Strategy 2 (fallback): Overpass global admin boundary search (slow, only if Nominatim fails)
 * 
 * @param {string} placeName - City or place name
 * @returns {Promise<{lat, lon, displayName, source, stationName?, centerSource?}|null>}
 */
export async function geocodePlace(placeName) {
  console.log(`[Geocoding] Geocoding: ${placeName}`);
  
  // Check cache first
  const cached = getCachedResult(placeName);
  if (cached) {
    return cached;
  }

  // Strategy 1: Nominatim (fast indexed search) → admin_centre → nearby station
  let placeInfo = null;
  try {
    placeInfo = await findPlaceViaNominatim(placeName);
  } catch (e) {
    console.warn(`[Geocoding] Nominatim search failed: ${e.message}`);
  }

  // Strategy 2 (fallback): Overpass global admin boundary search (slow)
  if (!placeInfo) {
    console.log(`[Geocoding] Nominatim returned nothing, falling back to Overpass admin search`);
    placeInfo = await findAdminBoundary(placeName);
  }

  if (placeInfo) {
    // Search for railway stations near the center
    const nearbyStations = await findNearbyStations(placeInfo.lat, placeInfo.lon, 0.1);
    
    if (nearbyStations.length > 0) {
      const closestStation = nearbyStations[0];
      console.log(`[Geocoding] Using railway station: ${closestStation.name} (${closestStation.distanceKm.toFixed(2)} km from center)`);
      
      const result = {
        lat: closestStation.lat,
        lon: closestStation.lon,
        displayName: `${closestStation.name} (${placeInfo.displayName})`,
        source: 'railway_station',
        stationName: closestStation.name,
        centerSource: placeInfo.centerSource
      };
      setCachedResult(placeName, result);
      return result;
    } else {
      console.log(`[Geocoding] No stations found, using place center`);
      const result = {
        lat: placeInfo.lat,
        lon: placeInfo.lon,
        displayName: placeInfo.displayName,
        source: 'place_center',
        centerSource: placeInfo.centerSource
      };
      setCachedResult(placeName, result);
      return result;
    }
  }

  console.warn(`[Geocoding] All strategies exhausted for: ${placeName}`);
  return null;
}
