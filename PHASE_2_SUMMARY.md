# Phase 2 Summary: OSM Geography Services

**Date:** January 2025  
**Status:** ✅ Geography Services Complete

## Overview

Phase 2 focuses on porting OSM geography services from the MCP server to create a unified web application. This phase establishes the foundation for OSM-based file generation by providing geocoding and railway section discovery capabilities.

## Accomplishments

### 1. IPv4-Only Fetch Wrapper
**File:** [backend/services/osm/ipv4fetch.js](backend/services/osm/ipv4fetch.js) (130 lines)

**Problem Solved:**
Windows Node.js honours IPv6 first, causing 75-second connection hangs on networks without IPv6 routing to European OSM servers.

**Solution:**
- Manual DNS resolution using `dns.lookup({family: 4})`
- Direct IPv4 connection with hostname passed as TLS SNI/Host header
- DNS result caching to prevent repeated lookups
- Configurable timeouts (2s DNS, 8s socket)
- Promise.race for wall-clock timeout enforcement

**Export:**
```javascript
ipv4Fetch(url, options) // Returns {ok, status, json(), text()}
```

### 2. Overpass API Client
**File:** [backend/services/osm/overpass.js](backend/services/osm/overpass.js) (155 lines)

**Features:**
- **Endpoint Management:** Two endpoints (overpass-api.de primary, kumi.systems secondary)
- **Endpoint Probing:** Races minimal query to all endpoints, caches fastest
- **Query Normalization:** Ensures `[out:json][timeout:N]` directive present
- **Rate Limiting:** Detects 429 responses, waits 5 seconds
- **Retry Logic:** Max 2 retries, exponential backoff (2s → 4s → 8s)
- **Error Handling:** Handles 503/504 server errors gracefully
- **Console Logging:** Endpoint selection, element counts, errors

**Export:**
```javascript
overpassFetch(query, timeoutSec=25, maxRetries=2) // Returns {elements: [...]}
resetEndpoint() // Force re-probe endpoints
```

### 3. Geocoding Service
**File:** [backend/services/osm/geocoding.js](backend/services/osm/geocoding.js) (250 lines)

**Algorithm (3-Tier Fallback):**

1. **OSM Admin Boundary Search** (preferred):
   - Searches admin levels 8 (municipality) → 6 (province) → 4 (region)
   - Extracts admin_centre node (typically town hall or main station)
   - Falls back to geometric centroid if admin_centre unavailable

2. **Railway Station Proximity** (if admin boundary found):
   - Queries railway stations within ~11km radius of admin center
   - Sorts by distance (closest first)
   - Returns main/central station coordinates

3. **Nominatim Fallback** (last resort):
   - Uses OSM Nominatim geocoder if admin boundary search fails
   - Less reliable for railway-specific locations

**Functions:**
```javascript
geocodePlace(placeName) // Returns {lat, lon, displayName, source, stationName?, centerSource?}
findAdminBoundary(placeName) // Internal: Search OSM admin boundaries
findNearbyStations(centerLat, centerLon, radiusDeg) // Internal: Find railway stations
```

**Example Output:**
```json
{
  "lat": 44.407,
  "lon": 8.934,
  "displayName": "Genova Piazza Principe (Genova)",
  "source": "railway_station",
  "stationName": "Genova Piazza Principe",
  "centerSource": "admin_centre_node"
}
```

### 4. Railway Sections Discovery
**File:** [backend/services/osm/sections.js](backend/services/osm/sections.js) (180 lines)

**Query Strategy (Priority Order):**
1. `route=railway` (priority 1: physical infrastructure)
2. `route=train` (priority 2: operational train services)
3. Named railway ways (fallback when no route relations exist)

**Bidirectional Deduplication:**
- Normalizes route names for bidirectional matching
- Examples:
  - "Lucca - Viareggio" → "Lucca – Viareggio"
  - "Viareggio - Lucca" → "Lucca – Viareggio"
- Stores duplicate OSM IDs in `altOsmId` field
- Prefers `route=railway` over `route=train` when both exist

**Multi-Bbox Support:**
- Queries multiple bounding boxes in single Overpass call
- Tracks which route segments each section covers via `segmentIndices` array

**Functions:**
```javascript
queryRailwaySections(bboxes) // Returns array of candidate sections
normaliseRouteName(name) // Normalize for bidirectional deduplication
getSelectedSectionDetails(selectedSections) // Placeholder for future expansion
```

**Example Output:**
```json
{
  "osmId": "123456",
  "osmType": "relation",
  "name": "Pontremolese",
  "type": "railway",
  "operator": "RFI",
  "ref": "",
  "wayIds": ["789", "790", "791"],
  "segmentIndices": [0, 1],
  "altOsmId": "123457"
}
```

### 5. Geography API Routes
**File:** [backend/routes/geography.js](backend/routes/geography.js) (190 lines)

**Endpoints:**

#### POST /geography/geocode
**Request:**
```json
{
  "sessionId": "uuid",
  "places": ["Genoa", "Pisa"]
}
```

**Response:**
```json
{
  "sessionId": "uuid",
  "results": [
    {
      "place": "Genoa",
      "lat": 44.407,
      "lon": 8.934,
      "displayName": "Genova Piazza Principe (Genova)",
      "source": "railway_station",
      "stationName": "Genova Piazza Principe",
      "centerSource": "admin_centre_node"
    }
  ]
}
```

#### POST /geography/sections
**Request:**
```json
{
  "sessionId": "uuid",
  "bboxes": [
    {"minLat": 44.35, "minLon": 8.85, "maxLat": 44.42, "maxLon": 8.95}
  ]
}
```

**Response:**
```json
{
  "sessionId": "uuid",
  "sections": [
    {
      "osmId": "123456",
      "osmType": "relation",
      "name": "Pontremolese",
      "type": "railway",
      "operator": "RFI",
      "wayIds": ["789", "790"],
      "segmentIndices": [0]
    }
  ]
}
```

#### POST /geography/confirm
**Request:**
```json
{
  "sessionId": "uuid",
  "selectedSections": [
    {"osmId": "123456", "osmType": "relation"}
  ]
}
```

**Response:**
```json
{
  "sessionId": "uuid",
  "confirmedSections": [...],
  "message": "1 sections confirmed. Ready for geometry generation."
}
```

### 6. Session Metadata Integration
**Enhanced:** [backend/utils/tempFiles.js](backend/utils/tempFiles.js)

**New Function:**
```javascript
updateSessionMetadata(sessionId, updates) // Merge updates into session.json
```

**Stored Metadata:**
- `geocodedPlaces`: Results from /geocode endpoint
- `candidateSections`: Results from /sections endpoint
- `confirmedSections`: Results from /confirm endpoint
- `lastGeocodeTimestamp`: ISO timestamp of last geocode operation
- `lastSectionQueryTimestamp`: ISO timestamp of last section query
- `confirmationTimestamp`: ISO timestamp of section confirmation

### 7. Route Aggregator Update
**Enhanced:** [backend/routes/index.js](backend/routes/index.js)

**Changes:**
- Imported and mounted geography router
- Geography routes now available at `/api/geography/*`

## Testing

### Test Documentation
**File:** [GEOGRAPHY_TEST_GUIDE.md](GEOGRAPHY_TEST_GUIDE.md)

**Provides:**
- Step-by-step testing instructions
- PowerShell and curl examples
- Real-world test cases (Genoa-Pisa, Lucca-Viareggio)
- Debugging tips and validation checklist

### Manual Testing
```powershell
# 1. Create session
$response = Invoke-RestMethod -Uri "http://localhost:3001/api/sessions" -Method POST
$sessionId = $response.id

# 2. Geocode places
$body = @{ sessionId = $sessionId; places = @("Genoa", "Pisa") } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:3001/api/geography/geocode" -Method POST -Body $body -ContentType "application/json"

# 3. Query railway sections
$body = @{
    sessionId = $sessionId
    bboxes = @(
        @{ minLat = 44.35; minLon = 8.85; maxLat = 44.42; maxLon = 8.95 }
    )
} | ConvertTo-Json -Depth 10
Invoke-RestMethod -Uri "http://localhost:3001/api/geography/sections" -Method POST -Body $body -ContentType "application/json"
```

## Integration Points

### With Phase 1 Infrastructure
- ✅ Uses session management (createSession, getSession, updateSessionMetadata)
- ✅ Uses error handling (asyncHandler, AppError)
- ✅ Integrates with route aggregator
- ✅ Stores results in session.json for later use

### With Future Phases
- **Phase 2 (Geometry):** Confirmed sections will be used to query full way geometries
- **Phase 2 (Infrastructure):** Confirmed sections provide topology for junction/platform detection
- **Phase 2 (Elevation):** Geocoded coordinates serve as waypoints for elevation queries
- **Phase 2 (Frontend):** Geography results displayed on Leaflet map for visual confirmation

## Architecture Decisions

### Why IPv4-Only Fetch?
Windows Node.js defaults to IPv6, causing 75-second hangs on networks without IPv6 routing to European servers. IPv4-forcing ensures reliable connections.

### Why Overpass API Failover?
Single Overpass endpoints can be slow or overloaded. Probing + failover ensures best performance and reliability.

### Why 3-Tier Geocoding?
- Admin boundaries more accurate than Nominatim for specific regions
- Railway stations better represent actual route endpoints
- Nominatim provides global coverage as fallback

### Why Bidirectional Deduplication?
OSM often has separate route relations for each direction (e.g., "A → B" and "B → A"). Deduplication prevents duplicate geometry generation while preserving both OSM IDs for reference.

## File Summary

| File | Lines | Purpose |
|------|-------|---------|
| `backend/services/osm/ipv4fetch.js` | 130 | IPv4-only fetch wrapper |
| `backend/services/osm/overpass.js` | 155 | Overpass API client |
| `backend/services/osm/geocoding.js` | 250 | Place name geocoding |
| `backend/services/osm/sections.js` | 180 | Railway section discovery |
| `backend/routes/geography.js` | 190 | Geography API endpoints |
| `backend/utils/tempFiles.js` | +30 | Session metadata updates |
| `backend/routes/index.js` | +2 | Route mounting |
| `GEOGRAPHY_TEST_GUIDE.md` | 250 | Testing documentation |
| `README.md` | Updated | Phase 2 status |
| **Total New Code** | **~1,187 lines** | **9 files modified/created** |

## Dependencies

### Added
None (uses Node.js built-in modules only):
- `https` - HTTPS client
- `dns` - DNS resolution
- `url` - URL parsing

### Reused from Phase 1
- `express` - Web framework
- Session management utilities
- Error handling utilities

## Ready for Next Steps ✅

**Geography services are now complete and ready for:**

1. **Geometry Generation:**
   - Use confirmed sections to query full way geometries from OSM
   - Port geometry processing from centerline-tools (bug-free version)
   - Integrate with job queue for background processing

2. **Elevation Service:**
   - Use geocoded waypoints for elevation queries
   - Batch requests to Open-Elevation API (100 points/request)
   - Augment geometry CSVs with elevation data

3. **Infrastructure Generation:**
   - Use confirmed sections to detect junctions and platforms
   - Port infrastructure generator from MCP
   - Spatial separation and branch assignment

4. **Frontend Integration:**
   - Display geocoded points on Leaflet map
   - Show railway sections with selectable UI
   - Enable route corridor visualization
   - Progress tracking for geometry generation

## Console Logging Examples

```
[Geocoding] Geocoding: Genoa
[Geocoding] Found admin boundary: Genova (level 8, center: admin_centre_node)
[Geocoding] Found 5 nearby stations
[Geocoding] Using railway station: Genova Piazza Principe (0.52 km from admin center)

[Railway Sections] Querying 2 bounding boxes
[Railway Sections] Found 3 relations, 47 ways
[Railway Sections] Deduplicated "Pontremolese" (bidirectional)
[Railway Sections] Returning 2 candidate sections (after deduplication)

[Geography API] Geocoding 2 places for session abc-123
[Geography API] Discovering railway sections for session abc-123 (2 bboxes)
[Geography API] Confirming 1 sections for session abc-123
```

## Known Limitations

1. **No Way Geometry Yet:** Section discovery returns OSM IDs and way IDs, but not full geometries (planned for geometry generation phase)
2. **No Elevation Yet:** Geocoding returns lat/lon, but not altitude (planned for elevation service phase)
3. **No Frontend Yet:** API-only, requires curl/PowerShell testing (frontend planned for later phase)
4. **Single-User:** In-memory session storage (acceptable for current deployment)

## Validation Checklist ✅

- ✅ No compile/lint errors in any Phase 2 files
- ✅ IPv4 fetch wrapper implements Fetch API subset correctly
- ✅ Overpass client handles endpoint failover and retry logic
- ✅ Geocoding service implements 3-tier fallback algorithm
- ✅ Railway sections service implements bidirectional deduplication
- ✅ Geography routes integrate with session management
- ✅ Session metadata updates persist correctly
- ✅ Route aggregator mounts geography routes
- ✅ Test guide provides comprehensive examples
- ✅ README updated with Phase 2 status

## Next Phase Planning

**Phase 2 (Continued) - Geometry Generation:**
- Port geometry processor from centerline-tools (bug-free version, NOT MCP)
- Implement parallel track deduplication (20m threshold)
- Implement way chaining via graph traversal
- Implement spline smoothing and resampling
- Integrate with job queue for background processing
- Create /geometry/generate endpoint (returns jobId)
- Create /jobs/:jobId endpoint (returns status/progress)

**Estimated Effort:** 2-3 days (500-700 lines of code)
