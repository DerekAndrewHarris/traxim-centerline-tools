# Segment Geocoding and Routing Improvements

> **Historical / superseded (noted 2026-08-23).** This describes the predecessor MCP tool
> (`tools/geography.js`, `index.js` `scope_geography` — not this repo's
> `backend/services/osm/geocoding.js`). It's also superseded on its own terms: name-search
> geocoding (the subject of this whole document) is no longer the primary way this project
> defines waypoints — click-to-place on the map is. See `OSM_DATA_LOADING_PROCESS.md`'s
> "Current Waypoint Definition (2026-08-23)" section for what replaced it and why. Kept here
> as a historical record of the MCP tool's development, not as current guidance.

## Issues Addressed

### 1. Railway Station Geocoding (IMPLEMENTED)
**Problem**: Bounding boxes were using city center or region center coordinates invece of railway station coordinates, causing incorrect segment routing.

**Solution**:
- Enhanced `geocodePlace()` in [tools/geography.js](tools/geography.js) to search for railway stations first
- Multiple search strategies:
  1. "{City} Centrale" (e.g., "Pisa Centrale")
  2. "{City} Piazza Principe" (for Genova)
  3. "Stazione di {City}" (Italian format)
  4. "{City} railway station" (English format)
5. Fallback to city center if no station found
- Returns `source` field indicating: `railway_station`, `city_center`, or `manual_override`

### 2. Coordinate Confirmation & Override (IMPLEMENTED)
**Problem**: No way for user to verify or correct geocoded coordinates before proceeding.

**Solution**:
- Modified `scope_geography` tool in [index.js](index.js) to return geocoded coordinates in response
- Added `geocodedPlaces` array showing:
  - Place name
  - Latitude/longitude
  - Source (railway_station vs city_center)
  - Full display name from Nominatim
- Added `coordinate_overrides` parameter to `scope_geography`:
  ```javascript
  // Example usage:
  scope_geography({
    routes: [["Genoa", "Pisa", "Lucca"]],
    coordinate_overrides: {
      "Livorno": { lat: 43.548, lon: 10.310 }  // Livorno Centrale station
    }
  })
  ```

### 3. Segment Overlap (IMPLEMENTED)
**Problem**: Segments ended exactly at station coordinates, no overlap for continuity.

**Solution**:
- Modified `boundingBox()` in [tools/geography.js](tools/geography.js) to extend ~1km beyond endpoints
- Extension margins:
  - `EXTENSION_LAT`: 0.01° (~1.1 km)
  - `EXTENSION_LON`: 0.015° (~1.1 km at 44°N)
- Ensures adjacent segments overlap by ~2km (1km extension on each end)

### 4. Parallel Track Detection (NOT YET IMPLEMENTED)
**Problem**: When double tracks diverge by >50m, they should be traced as separate centerlines, then merged when they reconverge within 8m.

**Current behavior**: Parallel deduplication removes one track entirely if endpoints are similar.

**Proposed solution** (requires implementation):
1. During way chaining, detect when next candidate way is >50m perpendicular distance from current centerline
2. If detected:
   - Start new centerline branch
   - Trace in both directions until:
     - Dead  end (no more connected ways)
     - Outside segment bbox
     - Rejoins main centerline (within 8m)
3. Generate separate CSV files for each centerline (e.g., `Genova_-_Sestri_Levante_Track1.csv`, `Track2.csv`)

**Implementation location**: [tools/geometry.js](tools/geometry.js) in `generateGeometryForSegment()` around line 315 (chaining logic).

## Testing & Verification

### Test Scripts Created:
1. **`test-station-geocoding.mjs`**: Verifies railway station geocoding for major Italian cities
2. **`diagnose-segment-routing.mjs`**: Analyzes generated geometry files to detect routing mismatches

### Expected Results After Re-running scope_geography:
- Genova → Genova Piazza Principe station (~44.407, 8.934)
- La Spezia → La Spezia Centrale (~44.102, 9.825)  
- Viareggio → Viareggio station (~43.867, 10.251)
- Pisa → Pisa Centrale (~43.709, 10.398)
- Lucca → Lucca station (~43.844, 10.503)
- Firenze → Firenze Santa Maria Novella (~43.777, 11.248)
- Livorno → Livorno Centrale (~43.548, 10.310)

## Next Steps

1. **Test the geocoding improvements**:
   ```bash
   node test-station-geocoding.mjs
   ```

2. **Re-run scope_geography** to regenerate segment bboxes with correct station coordinates

3. **Reload geometry** with improved bboxes:
   ```bash
   node reload-via-mcp.mjs
   ```

4. **Verify with diagnostic**:
   ```bash
   node diagnose-segment-routing.mjs
   ```

5. **Implement parallel track detection** (Issue #4) if needed after testing current improvements

## Known Limitations

- Nominatim free API has rate limiting (~1 request/second)
- Some smaller stations may not be in Nominatim database
- Coordinate override mechanism requires user to know correct coordinates

## Files Modified

- `tools/geography.js`:
  - Enhanced `geocodePlace()` with railway station search
  - Modified `boundingBox()` to add 1km segment overlap
- `index.js`:
  - Added `coordinate_overrides` parameter to `scope_geography`
  - Modified scope_geography response to include `geocodedPlaces` array
