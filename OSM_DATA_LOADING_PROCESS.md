# OSM Data Loading Process for Traxim Input Creator

## Overview

This document describes the process for loading railway infrastructure data from OpenStreetMap (OSM) and converting it into Traxim-compatible input files. The workflow is designed to handle the complexities of Italian railway network OSM tagging while managing API rate limits and timeout constraints.

**Scope note (added 2026-08-23):** this document was originally written for the predecessor
MCP tool (`Traxim-MCP-Servers/traxim-input-creator-mcp` — tool names like `scope_geography`,
files like `tools/geography.js` and `.traxim-state.json` below refer to that codebase, not
this one). The OSM query/geometry/infrastructure **algorithms** described in Steps 4 and 5
(centerline-first buffer approach, junction detection, F/T/D branch assignment, spatial
separation) were ported largely as-is into this repo's backend
(`backend/services/geometry/`, `backend/services/infrastructure/`) and remain accurate
technical references for how those parts work today. **Step 2 (place-name geocoding) is no
longer accurate** — the current tool replaced it with a different, simpler mechanism. See
"Current Waypoint Definition (2026-08-23)" immediately after Step 2.1 for what actually runs
today, and the Version History entry at the bottom for why.

---

## Workflow Steps

### Step 1: Start Scenario
**Tool**: `start_scenario`

Creates or resumes a working directory for the scenario, initializing the state tracking file (`.traxim-state.json`).

---

### Step 2: Scope Geography
**Tool**: `scope_geography`

**Purpose**: Identify candidate railway sections within the desired geographic area.

**Input**: One or more routes, each expressed as an ordered list of place names.

**Example**:
```json
{
  "routes": [
    ["Genoa", "Sestri Levante", "La Spezia", "Viareggio", "Pisa", "Livorno"],
    ["Viareggio", "Firenze"],
    ["Pisa", "Lucca"]
  ]
}
```

**Process**:

#### 2.1. Geocode Place Names — **Admin Centre Node Approach** (2026-03-11)

**Purpose**: Convert place names to coordinates representing the actual city center / main transit hub, not the geographic centroid of the administrative area.

**Challenge**: Initial geocoding used geometric centroids of administrative boundaries, which can be several kilometers from the actual city center. For example:
- **Pisa**: Geometric centroid at 43.66575, 10.36237 (rural area) → found "Tombolo" local station (3.85 km from centroid)
- **Actual city center**: 43.7159, 10.4019 → finds "Pisa Centrale" main station (0.5 km from city center)
- **Result**: Wrong routing (segments going to wrong cities, 25+ km off target)

**Solution**: Use OSM's `admin_centre` **member node** (with role="admin_centre"), which points to the actual city center as curated by OSM mappers.

**Algorithm** (language-agnostic, works globally):

1. **Query admin boundary relations** (search levels 8 → 6 → 4):
   ```
   relation["boundary"="administrative"]["admin_level"="${level}"]["name"~"^${placeName}$",i];
   out;
   ```
   - Level 8: Municipality/Comune (most specific)
   - Level 6: Province/Provincia
   - Level 4: Region/Regione (fallback)

2. **Extract admin_centre member** from relation:
   ```javascript
   const adminCentreMember = relation.members.find(
     m => m.type === 'node' && m.role === 'admin_centre'
   );
   ```
   - **Critical**: This is a **member** with `role="admin_centre"`, not a tag
   - **Query syntax**: Must use `out;` (full relation) not `out tags;` or `out center;`
   - `out center;` returns only geometric centroid, not members

3. **Query the admin_centre node** to get its coordinates:
   ```
   node(${adminCentreMember.ref});
   out;
   ```
   - Returns actual city center location (e.g., Node 66586322 for Genova at 44.40726, 8.93386)
   - Typically within 1 km of main railway station

4. **Search for nearest railway station** within ~11 km radius:
   ```
   node["railway"~"^(station|halt)$"]["name"](bbox);
   way["railway"~"^(station|halt)$"]["name"](bbox);
   ```
   - Sort by distance from admin_centre node
   - Select closest station (typically main/central station)

5. **Fallback strategies**:
   - If admin_centre member not found: Calculate geometric centroid from bbox
   - If no stations found: Use admin_centre node coordinates directly
   - If admin boundary not found: Nominatim text search (last resort)

6. **Manual override mechanism**: `coordinate_overrides` parameter for context-specific cases:
   ```json
   {
     "coordinate_overrides": {
       "Genova": {"lat": 44.407, "lon": 8.934}
     }
   }
   ```
   - Useful when multiple major stations exist (e.g., Genova has both Piazza Principe and Brignole)
   - User decides which station is appropriate for their scenario

**Results** (Italian cities test, 2026-03-11):
- ✅ **7/8 cities** now correctly find main station using admin_centre node:
  - Sestri Levante: 44.27623, 9.39758 → Sestri Levante station
  - La Spezia: 44.11156, 9.81358 → La Spezia Centrale  
  - Viareggio: 43.87389, 10.25262 → Viareggio station
  - Pisa: 43.70786, 10.39839 → **Pisa Centrale** (was "Tombolo" with old approach)
  - Lucca: 43.83728, 10.50618 → Lucca station
  - Firenze: 43.77757, 11.24742 → Firenze Santa Maria Novella
  - Livorno: 43.55420, 10.33610 → **Livorno Centrale** (was admin boundary with old approach)
- ⚠️ Genova: Found "De Ferrari" metro station (0.5 km from admin_centre) instead of "Piazza Principe" main station (requires manual override for context)

**Why this approach is systematic and reproducible**:
1. **Language-agnostic**: Uses OSM structural data (relation members, roles) not text patterns
2. **No hardcoded terms**: No reliance on "Centrale", "Central", "Gare", etc. in station names
3. **Globally applicable**: admin_centre role is standard OSM practice worldwide
4. **Community-curated**: OSM mappers maintain admin_centre nodes as accurate city centers
5. **Transparent**: Returns `centerSource` field indicating whether admin_centre_node or geometric_centroid was used
6. **User-controllable**: Override mechanism for edge cases requiring domain knowledge

**Implementation**: `tools/geography.js` — `findAdminBoundary()` and `geocodePlace()` functions
(predecessor MCP tool; ported into this repo as `backend/services/osm/geocoding.js`, still
callable via `POST /geography/geocode`, but no longer what the frontend uses — see below).

---

### Current Waypoint Definition (2026-08-23)

**The approach above (name → admin boundary → admin_centre node → nearby station) is no
longer the primary mechanism.** It's still implemented in `backend/services/osm/geocoding.js`
and reachable via `POST /geography/geocode`, but the frontend UI dropped it after it proved
unreliable in practice:

1. **Wrong-place matches.** The candidate-selection heuristic picked whichever Nominatim
   result had the smallest bounding-box area, on the theory that "city beats province." In
   practice this systematically favours tiny, obscure, same-named places over the intended
   city — e.g. searching "Genoa" could resolve to a hamlet in Colorado (bbox area ~0.0001)
   over Genova, Italy (bbox area ~0.06, and Nominatim's own top-ranked result by relevance).
2. **Overpass rate-limit cascades.** Resolving a name that isn't an exact station match
   requires a chain of 3–5 *sequential* Overpass calls (admin relation → admin_centre node →
   nearby-station search). Each one is exposed to Overpass's shared public rate limit; a
   single 429 adds a fixed 10s retry penalty *and* inflates the wait before the next call
   too (the app's inter-query gap is based on the previous call's duration). In testing, a
   single place name that wasn't an exact station hit took anywhere from ~80 seconds to over
   two minutes, and one lookup never completed within that window at all.

**Replacement: click-to-place waypoints.**

- The frontend already renders a live Leaflet map (`osm-workflow.js`). Each waypoint row has
  a 📍 button; clicking it arms "pick mode," and the next map click drops a draggable marker
  at that exact coordinate — no OSM query of any kind is needed to define the waypoint itself.
- Coordinates are exact by construction; there is no "wrong place" failure mode anymore.
- A single Nominatim **reverse**-geocode call (`POST /geography/reverse-geocode`, implemented
  in `reverseGeocodePlace()` in the same `geocoding.js`) gives the pin a human-readable label
  (e.g. "Sestri Levante") purely for display and for segment naming later — it never blocks
  or gates the workflow. It uses Nominatim's structured `address` object
  (`town`/`city`/`village`/`hamlet`/`suburb`/`municipality`/`county`, in that priority order)
  rather than splitting the free-text `display_name` string, since that string's component
  order/count shifts depending on what was hit (a street address inserts road/house-number at
  the front; a rural point skips straight to hamlet/county). This is a single Nominatim call
  with **no Overpass involved**, so it doesn't share the failure mode above.
- Every waypoint (there is no longer a name-search fallback in the UI) goes through
  `/reverse-geocode`, one at a time, writing into the session's `geocodedPlaces` list in
  waypoint order — the same list `/geocode` writes, so downstream consumers (e.g. the
  geometry step's per-segment labels) don't need to know which mechanism produced an entry.
- The search bounding boxes between consecutive waypoints are now built and drawn on the map
  as part of resolving waypoints, not deferred until the section query runs — see
  `buildAndDrawBboxes()` in `osm-workflow.js`.

**Net effect:** defining a route went from "usually works, occasionally silently resolves to
the wrong city, and can hang for minutes" to "instant and exact for the coordinate, with a
best-effort label that never blocks anything."

---

#### 2.2. Create Bounding Boxes  

**For each consecutive waypoint pair** (e.g., Genoa→Sestri Levante, Sestri Levante→La Spezia):
   - Calculate rectangular bbox from endpoint coordinates
   - **Extension**: Add 1 km (~0.01° lat, 0.015° lon) beyond each endpoint for segment overlap
   - Ensures adjacent segments connect smoothly (2 km overlap total)
   - Minimum dimensions ensure coverage of curved routes

#### 2.3. Query OSM for Railway Relations

**Query each bounding box**:
   ```
   relation["route"~"^(railway|train)$"](bbox);
   ```
   **Note**: During initial scoping, only route relations are queried. Individual named ways (tunnels, viaducts, bridges with their own name tags like "Galleria Ligia") are NOT included in the candidate list to avoid cluttering the results with hundreds of infrastructure pieces. These named ways are automatically collected later during the corridor fallback in Step 4 (generate_geometry).

#### 2.4. Priority Ordering

**Prioritize results**:
   - `route=railway` (physical infrastructure) — highest priority
   - `route=train` (operational service routes) — lower priority but necessary for Italian network

#### 2.5. Deduplicate Bidirectional Relations

**Process**:
   - Identify pairs like "Roma→Genova" + "Genova→Roma"
   - The second direction is stored as `altOsmId` on the primary section

#### 2.6. Track Segment Coverage

**Record which segments each section covers**:
   - Each section records `segmentIndices` showing which route segments (bounding boxes) it covers

**Output**: 
1. **Candidate sections**: List with OSM IDs, names, operators, and refs
2. **Geocoding report**: Array showing geocoded coordinates for user verification:
   ```json
   {
     "place": "Pisa",
     "lat": 43.70786,
     "lon": 10.39839,
     "source": "railway_station",
     "centerSource": "admin_centre_node",
     "stationName": "Pisa Centrale",
     "displayName": "Pisa Centrale (Pisa)"
   }
   ```
   - User should review to ensure correct stations were found
   - Use `coordinate_overrides` parameter if corrections needed

**Critical Note**: Italian OSM frequently uses **train service names** (e.g., "Frecciabianca Roma→Genova") for relations rather than infrastructure line names. This is normal and expected — these service routes contain the infrastructure ways we need.

---

### Step 3: Confirm Geography
**Tool**: `confirm_geography`

**Purpose**: User confirms which candidate sections to include in the scenario.

**Input**: List of section names to confirm (subset of candidates from step 2)

**Process**:
1. Filters candidates to only confirmed sections
2. For each confirmed section, computes a **corridor bounding box**:
   - Tighter bbox around just the confirmed section's route segments
   - Used as fallback if relation-based queries return insufficient data
3. Stores confirmed sections in state with:
   - `osmId` / `osmType` (relation or way)
   - `altOsmId` / `altOsmType` (bidirectional pair if exists)
   - `corridorBbox` (tight bbox for fallback queries)
   - `segmentIndices` (which route segments this section covers)

**Output**: Confirmed sections ready for geometry generation

---

### Step 4: Generate Geometry
**Tool**: `generate_geometry`

**Purpose**: Fetch OSM way geometry and topology, then generate track centerline CSV files.

**Process per section**:

#### 4a. Fetch Way IDs from OSM

**For relations** (`osmType === "relation"`) — **Centerline-First Buffer Approach** (2026-03-10):

**Overview**: To prevent inclusion of unrelated parallel routes, we build the route centerline first from relation members, then query a tight 100m buffer around that centerline.

**6-Step Process**:

1. **Primary query**: Fetch relation and expand to family (parent route_master + sibling sub-relations):
   ```
   relation(ID);        -- the confirmed relation
   (._; <;);            -- add parent relations
   (._; rel(r););       -- add sibling sub-relations
   way(r);              -- collect ways from entire family
   out;                 -- CRITICAL: use 'out;' not 'out tags;'
   ```
   - **Why family expansion**: Italian railway route relations are often structured as:
     ```
     route_master → sub-relation A (km 0-30) → ways
                  → sub-relation B (km 30-80) → ways
                  → sub-relation C (km 80-153) → ways
     ```
     If the user confirmed only sub-relation B, we need to climb to the parent and descend to all siblings to get the complete route.
   - **Critical query syntax**: `out;` returns relation members (way IDs). Using `out tags;` returns ONLY tags, resulting in empty wayIds arrays (Bug fixed 2026-03-10).

2. **Alternative relation query** (if `altOsmId` exists): Fetch the reverse-direction relation family and merge way IDs
   - Ensures ways only present in one directional variant (e.g., crossover sidings) are included

3. **Fetch preliminary geometry** for relation member ways (typically 43-225 ways):
   ```
   way(id:wayIds);
   out geom;
   ```
   - Required to build centerline coordinates
   - Small query (~200 ways), reliable even during rate limiting

4. **Build centerline** from preliminary way geometry:
   - Graph traversal connecting ways via shared endpoints
   - **Important**: Traverses ALL branches and disconnected components (Bug fixed 2026-03-10)
   - Original bug: `break;` statement stopped at first branch, producing only 4 coordinates
   - Fixed implementation: Follow all unvisited neighbors, handle disconnected segments
   - Result: 790+ coordinates for routes with 192 relation ways

5. **Compute 100m buffer bbox** around centerline:
   - Find min/max lat/lon across all centerline coordinates
   - Add margin: `±0.001°` (~111m at mid-latitudes)
   - Creates tight rectangular bounding box following actual route path

6. **Query buffer area with simple bbox** (not complex polygon):
   ```
   way["railway"="rail"]["usage"!="industrial"](bufferBbox);
   out geom;
   ```
   - **Why simple bbox**: Complex polygon queries consume excessive API quota and timeout frequently
   - Returns ~500-1000 ways in buffer rectangle (includes some off-route sections)

7. **Filter locally by distance to centerline**:
   - For each way in buffer query results, check if it's near the centerline
   - Sample 10 points along way geometry for performance
   - Distance threshold: `0.001°` (~111m)
   - Keep way if ANY sampled point is within threshold of ANY centerline point
   - **Why local filtering**: Simple bbox + local computation more reliable than complex Overpass queries
   - Result: ~200-300 ways per section (vs ~2,500 from segment bboxes)

**Performance**:
- Infrastructure nodes: 19,891 → 6,068 (69% reduction)
- Frecciabianca: 967 ways (vs ~2,500 from segment bboxes, 60% reduction)
- Each section has distinct geometry: Ferrovia Lucca-Pisa (261 ways), Linea Firenze-Lucca (1,085 ways)

**Why this approach**:
- **Problem**: Segment bboxes (large rectangles) included entire regional network
- **Old corridor fallback**: Would query huge geographic areas, including parallel routes 5-10km away
- **Solution**: Build actual route path first, query only within 100m of that path
- **Benefit**: Eliminates duplicate geometries, reduces infrastructure bloat, handles complex route topologies

**For named ways** (`osmType === "way"`) — **Parallel centerline-first implementation**:

Follows the same 7-step centerline-first buffer approach as relations:
1. **Name search**: Query ways with matching name tag across the global bbox
2. Fetch preliminary geometry for matched ways
3. Build centerline from those ways
4. Compute 100m buffer bbox
5. Query simple rectangular bbox
6. Filter locally by distance to centerline
7. Merge results with name-matched ways

**Why same approach**: Named way sections (tunnels, viaducts) have the same over-inclusion problem as relations when using large corridor bboxes.

#### 4b. Fetch Way Geometry and Nodes
- Chunk way IDs (500 per query) to stay within Overpass limits
- Use `out body geom;` to get both:
  - Inline `{lat, lon}` geometry points for each way
  - OSM node IDs along each way (to identify junction nodes within ways)

#### 4c. Fetch Tagged Nodes
Query for railway switches, crossovers, buffer stops, and crossings within the corridor:
```
node["railway"~"^(switch|railway_crossing|buffer_stop)$"](corridorBbox);
```

#### 4d. Build Topology JSON
- **Way descriptors**: For each way, record:
  - `id`, `nodes` (OSM node IDs), `startKey`, `endKey` (coordinate keys "lat,lon")
  - `groupId` (parallel track group), `role` (main or branch)
- **Endpoint index**: Map of coordinate keys to way IDs meeting at that point
- **Tagged nodes**: Railway infrastructure elements from OSM

**Why topology JSON**: Infrastructure generation needs the full graph structure (all ways, including yard tracks and branches) to identify turnouts, loops, and crossovers from first principles.

#### 4e. Process Geometry (Centreline Only)
- **Deduplicate parallel tracks**: Remove parallel double-track ways, keep one representative
- **Chain ways**: Graph traversal from terminus, choosing straightest continuation at junctions
- **Spline smooth and resample**: Create evenly-spaced points along centreline (default 25m)

**Output**: 
- `{SectionName}.csv` — track centerline geometry points
- `{SectionName}_topology.json` — full OSM way graph with tagged nodes
- `{SectionName}_wayids.csv` — diagnostic list of all way IDs

---

#### 4f. Elevation, and the Tunnel/Bridge Correction (2026-08-23, this repo only)

**Not part of the original MCP tool** — elevation lookup was added later, specifically in
`traxim-centerline-tools` (`backend/services/elevation.js`), and isn't covered elsewhere in
this document.

**Source**: the [Open-Elevation API](https://open-elevation.com), a Digital Elevation Model
(DEM) — it returns *ground-surface* height for a given lat/lon. Points are sub-sampled (every
8th point queried, rest interpolated by array index) to limit API calls, batched at 100
points/request, with graceful degradation to elevation=0 if the service is unavailable.

**Problem**: a DEM is structurally wrong for any point where the track's real elevation
diverges from the ground surface — inside a **tunnel** (returns the hill above, not the
tunnel floor) or on a **bridge/viaduct** (returns the valley/river below, not the deck).
Embankments are less affected since they're actual raised ground the DEM already reflects.

**Solution implemented**: OSM tags ways `tunnel=*`/`bridge=*` when this applies. For any
detected tunnel or bridge section, discard the DEM values entirely and **linearly interpolate
elevation between the two portals** (a straight grade through a tunnel/bridge is generally a
good approximation, and matches how these are actually engineered).

**Why this can't be a simple per-point flag**: chaining (4e, above) concatenates whole
way-geometry arrays in order, so at that stage "which way did this point come from" is known
and cheap to track. But the very next step — spline smoothing + resampling
(`processTrackPoints`: cardinal spline → dense Bezier → fixed-interval resample) — generates
**entirely new synthetic points** along a smooth curve, with no 1:1 correspondence back to
original OSM points or ways. A per-point tag can't survive that. What *does* survive is
**distance-along-track (chainage)**, since resampling doesn't change cumulative distance
much — so tunnel/bridge sections are recorded as `[startMetres, endMetres]` intervals in a
pre-smoothing distance frame, and any later point (pre- or post-resampling) can be tested
against those intervals via its own chainage, found by nearest-point lookup back onto the
pre-smoothing chain.

**Implementation** (`backend/services/geometry/processor.js` unless noted):
1. `chainWaysViaGraph`/`singleTraversal` also return `coordWayIds` — which OSM way contributed
   each coordinate — captured while points are still 1:1 with source ways.
2. `buildCumulativeDistances(coords)` — cumulative haversine distance per point (used only for
   internal interval bookkeeping, not the CSV's output kilometerage — that's still full
   Vincenty, computed separately, unaffected by any of this).
3. `extractTaggedIntervals(coordWayIds, chainageM, wayTags, tagKey)` — walks the chain once and
   returns contiguous `{startM, endM}` runs where the segment's source way has a truthy
   `tunnel`/`bridge` tag (anything other than absent or `"no"` — covers `tunnel=yes`,
   `bridge=viaduct`, etc).
4. `mapPointsToChainage(points, refCoords, refChainageM)` — maps the final resampled points
   onto the pre-smoothing chain's distance frame via a forward-only nearest-point walk (both
   sequences traverse the same path in the same order, so this is O(N+M), not O(N·M)).
5. `applyPortalElevationInterpolation(elevations, pointChainageM, intervals)` — for each
   interval, reads the (DEM-derived) elevation at its two portal chainages — trustworthy since
   a portal is ordinary ground level by definition — and overwrites every point's elevation
   inside that interval with a straight-line interpolation between them.
6. Orchestration in `backend/services/geometry/generator.js`: extract intervals right after
   chaining (step 5 above, before 4e's smoothing runs), then after the DEM fetch, apply the
   portal interpolation before writing the CSV.

**A tag-propagation bug found and fixed along the way**: `splitWaysAtIntermediateJunctions`
(used for step 4d's junction splitting) assigns brand-new synthetic IDs (`9000000000+`) to
every split segment, with no link back to the parent way's OSM ID. Since splitting happens at
nearly every junction, this would have broken the tag lookup for almost every real way
segment. Fixed by having each split segment inherit its parent way's tags (`splitWayTags`,
threaded through the same function).

**Also fixed in passing**: `fetchSegmentGeometryFromOSM` (the simple bbox-fallback fetch,
used when no relation is confirmed) was silently discarding OSM tags entirely — Overpass's
`out body geom;` already returns them, but the code only captured `wayGeometry`/`wayNodes`,
not `wayTags`. Now mirrors the relation-based fetch path
(`fetchSegmentGeometryViaRelations`), which already collected tags correctly.

**Verified** against the Sestri Levante → La Spezia coastal segment (heavily tunneled): log
output confirmed 20 tunnel and 21 bridge sections detected; the output CSV showed a ~2km
stretch pinned at a flat, single elevation — the expected signature of a tunnel through a
headland getting a sensible portal-to-portal grade instead of noisy mountain-surface DEM
readings — with normal, varied terrain elevation everywhere else in the file.

**Known scope boundary**: this only covers the **main centerline**. Alternative-route CSVs
(diverging branches >50m from the main line — `generateAlternativeGeometry` in `generator.js`)
use separate chaining/detection logic (`detectAlternativeRoutes`) that doesn't track
per-coordinate way IDs, so they still get raw, uncorrected DEM elevation. Extending this to
alt routes would be a distinct, separately-scoped piece of work.

---

### Step 5: Generate Infrastructure
**Tool**: `generate_infrastructure`

**Purpose**: Create Traxim Infrastructure.csv (turnout nodes and connections) from topology JSONs.

**Process**:

#### 5a. Load Topology JSONs
- Read all `{SectionName}_topology.json` files from geometry directory
- Each contains: ways (with coordinate keys), endpoint index, tagged nodes

#### 5b. Split Ways at Junction Nodes
- Build adjacency map: coordinate key → list of connected ways
- Any coordinate key with degree ≥ 3 (or degree 2 + OSM tagged node) is a junction
- Split ways at junctions to create virtual way segments between junctions

**Why splitting**: Original OSM ways can pass through multiple junctions. We need separate way segments between each junction pair for proper topology analysis.

#### 5c. Create Infrastructure Nodes
For each junction coordinate key:
1. **Degree 2**: Skip (pure through-connection, no Traxim node needed)
2. **Degree 3**: Create standard turnout node (F, T, D branches)
3. **Degree 4**: Create TWO turnout nodes for crossover configuration
4. **Degree 5+**: Warn user — treat as single complex turnout

**Node Identity** (critical for correctness):
- Two junctions at the SAME coordinate (within 0.5m) = SAME node
- Two junctions 8m apart on parallel tracks = DIFFERENT nodes
- Threshold: `SNAP_THRESHOLD_M = 0.5m` (floating-point precision + GPS noise)

#### 5d. Identify Branch Connections (Chain-Following)
For each node, follow way chains to neighboring nodes:
1. Start at node's coordinate key
2. Follow connected way via graph traversal
3. Skip through degree-2 intermediate points
4. Stop when reaching another junction node

Compute **F, T, D branch assignments**:
- F (facing/through): Straightest connection (smallest angle change)
- D (diverging): Sharpest turn
- T (trailing): Intermediate angle

**Why angles**: Traxim needs consistent F/T/D assignments for physics simulation. "Facing" is the main direction, "diverging" is the branch, "trailing" is the reverse direction.

#### 5e. Spatial Separation (30m Minimum)
- Traxim requires nodes ≥ 25.1m apart on same track (we use 30m safety margin)
- **Applied to CONNECTED nodes only** (nodes linked via F/T/D branches)
- **NOT applied to nearby parallel tracks** (they're unconnected, 30m is linear distance along track)

**Implementation**: After chain-following completes (Step 5d), iteratively push apart connected node pairs that are < 30m apart.

#### 5f. Platform and Station Nodes
- Fetch `railway=platform` ways from Overpass
- Insert platform nodes along track sections
- Fetch `railway=station/halt` from Overpass for naming anchors
- Rename nodes based on nearest station (e.g., "Genova Brignole A")

#### 5g. Validation and Warnings
- **Branch conflicts**: Multiple nodes claiming same branch of another node
- **Link mismatches**: Node A→B branch doesn't match B→A back-reference
- Report isolated nodes, degree-4 pairs, naming anomalies

**Output**: `Infrastructure.csv` with all turnout nodes and branch connections

---

## Critical Design Decisions

### Why Centerline-First Buffer Approach (2026-03-10)

**Problem**: Multiple sections generating identical geometries with incorrect names (duplicate 101.48km routes).

**Root cause analysis**:
1. **Immediate**: Segment bboxes too large (large rectangles covering entire region)
2. **Deeper**: Five Florence/Lucca/Pisa sections all shared same rectangular segment boxes
3. **Result**: Corridor fallback included ~2,500 ways from entire regional network, creating 19,891 infrastructure nodes

**Solution: Centerline-First Buffer Approach**

Build the route centerline from confirmed relation ways FIRST, then query a tight 100m corridor around that actual path.

**Implementation** (6 steps):
1. Fetch relation family and member way IDs (typically 43-225 ways)
2. Fetch preliminary geometry for those specific ways
3. Build centerline by chaining ways via graph traversal (790+ coordinates)
4. Compute 100m buffer bbox around centerline (±0.001° margin)
5. Query simple rectangular bbox from Overpass API
6. **Filter locally** by distance to centerline (0.001° threshold, ~111m)

**Key functions** (in `tools/geography.js`):
- `buildCenterlineFromWays(wayIds, wayData)` (lines 307-395): Graph traversal to chain ways into continuous path. **Critical fix**: Original implementation had `break;` statement causing early termination at first branch (only 4 coordinates). Fixed to traverse ALL branches and disconnected components.
- `computeBufferBbox(centerline, margin)` (lines 397-420): Compute min/max lat/lon with margin
- `isWayNearCenterline(wayGeometry, centerline, threshold)` (lines 260-305): Local distance filtering. Samples 10 points along way, returns true if any within threshold of centerline.

**Why local filtering instead of Overpass polygon queries**:
- Complex Overpass queries (polygon bounding boxes) consume excessive API quota
- Simple rectangular bbox queries are fast and reliable
- Local distance computation in Node.js offloads complexity from Overpass API
- More robust: doesn't depend on Overpass query complexity limits

**Results**:
- Infrastructure nodes: 19,891 → 6,068 (69% reduction)
- Ways per section: ~200-300 (vs ~2,500 from segment bboxes)
- Each section now has distinct geometry:
  - Ferrovia Lucca-Pisa: 261 ways, 15.8 km
  - Linea Firenze-Lucca: 1,085 ways, 75.9 km
- No more duplicate geometries

**Tradeoff**: Requires two-pass approach (fetch relation ways first, then buffer query), but eliminates massive over-inclusion problem.

---

### Why No service=yard/spur Filter

**Original code had**:
```
way["railway"="rail"]["usage"!="industrial"]["service"!~"^(yard|spur)$"]
```

**Problem**: This excluded yard tracks and storage sidings, causing:
- Missing junction nodes where yard tracks branch from main line
- Multiple nodes incorrectly assigned to same branch (e.g., Chiavari W had duplicate T-branch connections)
- Massive link mismatch counts (468 errors)

**Solution**: Removed the `service` filter. Query now includes ALL railway tracks in corridor:
```
way["railway"="rail"]["usage"!="industrial"]
```

**Result**: Proper yard junctions created, link mismatches reduced from 468 to 16 (97% reduction).

**Principle**: All physical track infrastructure within the bounding area should be represented, regardless of operational classification.

---

### Why IPv4-Only Fetch

**Problem**: Overpass API endpoints have unreliable IPv6 connectivity. Node.js default fetch may try IPv6 first, causing timeouts.

**Solution**: Custom `ipv4Fetch()` wrapper that forces IPv4 socket connections.

**Location**: `lib/ipv4fetch.js`

**Critical for**: All Overpass API queries (`overpassFetch()` uses `ipv4Fetch()` internally)

---

### Why Tight Coordinate Snap Threshold (0.5m)

**Node identity threshold** (`SNAP_THRESHOLD_M`): 0.5m

**Purpose**: Determine if two OSM coordinate keys represent the same junction or different junctions.

**Examples**:
- Switch at OSM node A: (44.313049, 9.327272)
- Switch at OSM node B: (44.313027, 9.327162)
- Distance: 2.6m → DIFFERENT JUNCTIONS (both should get infrastructure nodes)

**Why 0.5m**: Handles floating-point precision and GPS noise without merging distinct nearby junctions.

**What failed**: Earlier attempts with 30m threshold merged distinct junctions on parallel tracks (~4m apart), causing topology corruption.

---

### Why 30m Spatial Separation After Chain-Following

**Requirement**: Traxim needs nodes ≥ 25.1m apart on same track (30m safety margin).

**Critical distinction**: 30m is **linear distance along track**, not **radial distance**.

**Implementation**:
- Spatial separation moved to Step 5e (AFTER chain-following determines connections)
- Only separates nodes that are CONNECTED via F/T/D branches
- Parallel tracks 4m apart are NOT separated (they're unconnected)

**What failed**: Earlier attempt to separate ALL node pairs within 30m radius caused node explosion (1,924 → 2,595 nodes) and broke parallel track handling.

---

### Why Corridor Fallback Works (Superseded 2026-03-10)

**Historical note**: This approach was replaced by the centerline-first buffer approach to prevent over-inclusion.

**Old scenario**: OSM relation query returns < 100 ways (incomplete data).

**Old fallback**: Direct geographic query for all `railway=rail` ways in `corridorBbox`:
```
way["railway"="rail"]["usage"!="industrial"](minLat,minLon,maxLat,maxLon);
```

**Why it was reliable**:
1. Corridor bbox covered confirmed route segments
2. Geographic filter prevented completely out-of-area ways
3. Didn't depend on OSM relation completeness
4. Captured yard tracks, sidings, and crossovers missing from relations

**Why it was replaced**:
1. **Problem**: Segment bboxes (large rectangles) included entire regional network
2. **Result**: Five Florence/Lucca/Pisa sections all had overlapping segment boxes, resulting in identical geometries (101.48km each) and 19,891 infrastructure nodes
3. **Solution**: Centerline-first buffer approach builds route path FIRST from relation members, then queries tight 100m buffer around that specific path

**See**: "Why Centerline-First Buffer Approach" section above for current implementation.

---

## Troubleshooting Guide

### Problem: Overpass API HTTP 429 (Rate Limiting)

**Symptoms**:
- Error: `429 Too Many Requests`
- Message: "The server is currently overloaded"
- Some sections complete successfully, then all subsequent queries fail

**Root cause**: Overpass API has daily query quotas that reset every 24 hours. Complex queries (large bboxes, relation expansions, polygon boundaries) consume quota rapidly.

**Query complexity hierarchy** (from least to most expensive):
1. **Simple node by ID**: Very cheap, ~5 seconds
2. **Small bbox (<0.1° square)**: Cheap, ~500ms
3. **Way geometry fetch (few hundred ways)**: Moderate, ~4 seconds
4. **Large bbox (>0.5° square)**: Expensive, often triggers rate limit
5. **Relation expansion**: Very expensive, often triggers rate limit
6. **Complex polygon queries**: Most expensive, triggers rate limit immediately

**Diagnostic procedure**:
1. Create test script to check Overpass status with progressive complexity:
   ```javascript
   // test-overpass-status.mjs
   const tests = [
     { name: "Simple node", query: "node(44.4,9.3,44.401,9.301); out;" },
     { name: "Small bbox", query: "way['railway'='rail'](44.4,9.3,44.41,9.31); out;" },
     { name: "Large bbox", query: "way['railway'='rail'](43.5,8.8,44.5,11.5); out;" },
     { name: "Relation", query: "relation(6770773); out;" },
   ];
   // Try each, report which succeed/fail
   ```

2. Run diagnostic: `node test-overpass-status.mjs`
3. **If simple queries succeed**: Quota partially exhausted, simple operations still possible
4. **If all queries fail**: Quota fully exhausted, must wait

**Mitigation strategies**:
1. **Wait 24 hours**: Quotas reset daily (exact timing varies by Overpass instance)
2. **Use simpler queries**: Replace complex polygon queries with rectangular bbox + local filtering
3. **Reduce query count**: Cache topology JSONs, use `regen-infrastructure.mjs` to avoid re-fetching OSM data
4. **Batch wisely**: Process high-priority sections first before quota exhaustion

**Implementation changes** (2026-03-10):
- Changed from complex polygon buffer queries → simple rectangular bbox + local distance filtering
- Moved filtering logic from Overpass (remote) to Node.js (local)
- Result: More reliable, less quota consumption

**Example diagnostic output**:
```
Test 1: Simple node query
✓ Success (4.8s)

Test 2: Small bbox query  
✓ Success (513ms)

Test 3: Large bbox query
✗ Failed: HTTP 429

Test 4: Relation query
✗ Failed: HTTP 429

Diagnosis: Quota partially exhausted. Simple queries work, complex queries blocked.
Recommendation: Wait 24 hours for quota reset.
```

**When to retry**:
- Wait at least 24 hours after first HTTP 429
- Run diagnostic script to confirm quota reset
- If diagnostic succeeds, proceed with full reload

---

### Problem: "No OSM data found for section"

**Diagnosis**:
1. Check `osmType` and `osmId` in state file
2. Verify OSM element exists: `https://www.openstreetmap.org/{type}/{id}`
3. Check if `corridorBbox` exists and is correct

**Common causes**:
- **Wrong osmType**: State says "way" but element is actually "relation"
- **Wrong osmId**: State references train service route instead of infrastructure relation
- **Missing corridorBbox**: Fallback can't trigger without tight bbox
- **Overpass timeout**: Large sections need multiple retries

**Solution**: Re-run `scope_geography` and `confirm_geography` to fix incorrect OSM references.

---

### Problem: Only 1-5 ways found for large section

**Diagnosis**: Relation query or name-based search returned minimal data, centerline-first buffer couldn't expand.

**Common causes**:
- **Wrong OSM reference**: State file references wrong relation/way ID
- **Query syntax error**: Using `out tags;` instead of `out;` (returns no members)
- **Section name mismatch**: For way-based sections, name doesn't match OSM tags
- **Overpass API timeout**: Query too complex or rate limited
- **Relation incomplete**: OSM relation genuinely has few members (check on openstreetmap.org)

**Solutions**:
1. **Verify OSM reference**: Visit `https://www.openstreetmap.org/relation/{osmId}` to confirm relation exists and has members
2. **Check query syntax**: Ensure using `out;` not `out tags;` in geography.js
3. **Check for HTTP 429**: See "Overpass API HTTP 429" troubleshooting section
4. **Re-scope geography**: Run `scope_geography` and `confirm_geography` again to fix incorrect OSM references
5. **Inspect state file**: Check that `osmType` and `osmId` match the correct OSM element type

**With centerline-first approach** (2026-03-10): If relation query succeeds but returns few ways, the buffer query will still find nearby tracks. Problem now indicates true data issue, not fallback failure.

---

### Problem: Duplicate branch connections (multiple nodes on same branch)

**Diagnosis**: Multiple dead-end nodes connecting to same turnout branch (e.g., "Chiavari W T-arm claimed by H and J").

**Root causes**:
1. **Missing intermediate junction**: Yard track junction was excluded by `service=yard` filter
2. **Node merging**: Two distinct junctions incorrectly treated as same node (threshold too loose)
3. **Chain-following error**: Virtual way splitting didn't create expected junction node

**Solution**:
1. Ensure `service=yard` filter is removed from geography.js
2. Verify `SNAP_THRESHOLD_M = 0.5m` (not 30m)
3. Check topology JSON for expected junction coordinate keys
4. Regenerate topology with updated filter

---

### Problem: Node explosion (thousands of extra nodes)

**Diagnosis**: Spatial separation or node creation logic creating excessive infrastructure nodes.

**Common causes**:
1. **Premature degree-2 node creation**: Creating nodes for through-connections that should be skipped
2. **Spatial separation applied to all nearby nodes**: 30m radius separation instead of along-track
3. **Degree-4 duplication errors**: Crossover nodes incorrectly split into >2 nodes

**Solution**:
1. Verify degree-2 nodes are skipped (no special case for tagged junctions)
2. Move spatial separation to after chain-following (Step 5e only)
3. Check degree-4 handling logic for crossovers

---

### Problem: 400+ link mismatches

**Diagnosis**: Node A→B branch assignment doesn't match B→A back-reference.

**Common causes**:
1. **Missing junctions**: Branches connecting to wrong nodes due to missing intermediate junctions
2. **Incorrect branch assignment**: Angle calculations producing wrong F/T/D assignments
3. **Yard tracks excluded**: Dead-end tracks connecting directly to main line nodes

**Solution**: Remove `service=yard` filter and regenerate. Link mismatches should drop dramatically (468 → 16).

---

## File Structure Reference

```
traxim-input-creator-mcp/
├── index.js                          # MCP server with workflow tools
├── tools/
│   ├── geography.js                  # OSM relation/way querying
│   │   ├── queryRailwaySections()    # Step 2: find candidate sections
│   │   └── fetchSectionGeometryFromOSM() # Step 4a: get ways + geometry
│   ├── geometry.js                   # Track geometry processing
│   │   └── generateGeometryForSection() # Step 4: generate CSV + topology JSON
│   ├── infrastructure.js             # Turnout node generation
│   │   └── generateInfrastructureCsv() # Step 5: create Infrastructure.csv
│   └── state.js                      # Scenario state management
├── lib/
│   └── ipv4fetch.js                  # IPv4-only fetch wrapper
├── reload-via-mcp.mjs                # Helper: regenerate topology + infrastructure
└── .traxim-state.json                # Scenario working state (in scenario dir)
```

---

## State File Structure

```json
{
  "scenarioName": "Genoa-Florence-Livorno",
  "workingDir": "/path/to/scenario",
  "geography": {
    "bbox": {
      "minLat": 43.5,
      "minLon": 8.8,
      "maxLat": 44.5,
      "maxLon": 11.5
    },
    "routeSegments": [
      {
        "index": 0,
        "from": "Genoa",
        "to": "Sestri Levante",
        "label": "Genoa - Sestri Levante",
        "bbox": { "minLat": 44.22, "minLon": 8.88, "maxLat": 44.46, "maxLon": 9.42 }
      }
    ],
    "candidateSections": [ /* all found sections */ ],
    "confirmedSections": [
      {
        "name": "Ferrovia Lucca - Pisa",
        "osmId": 6770773,
        "osmType": "relation",
        "altOsmId": null,
        "corridorBbox": { "minLat": 43.7, "minLon": 10.3, "maxLat": 43.9, "maxLon": 10.5 },
        "segmentIndices": [4, 5],
        "wayIds": []  // populated during geometry generation
      }
    ]
  },
  "geometry": {
    "completedSections": ["Ferrovia Lucca - Pisa", "..."],
    "filesGenerated": ["/path/to/Ferrovia_Lucca_-_Pisa.csv"]
  }
}
```

---

## Regeneration Scripts

### Full Reload (from OSM)
```bash
node reload-via-mcp.mjs
```
- Fetches fresh topology from OSM for all confirmed sections
- Uses IPv4 fetch and corridor fallback
- Regenerates Infrastructure.csv
- **Use when**: OSM data has changed, filter was updated, or state file references are correct

### Quick Regeneration (from existing topology JSONs)
```bash
node regen-infrastructure.mjs
```
- Reads existing topology JSONs from geometry/
- Regenerates Infrastructure.csv only
- **Use when**: Testing infrastructure generation logic changes, no OSM fetch needed

---

## Version History

### 2026-08-23: Tunnel/Bridge Elevation Correction (this repo, not the MCP tool)

**Issue**: elevation comes from a Digital Elevation Model (Open-Elevation API), which returns
ground-surface height — wrong for any point inside a tunnel (returns the hill above it) or on
a bridge/viaduct (returns the valley/river below it). Embankments were less affected since
they're actual raised ground the DEM already reflects.

**Solution implemented**: detect OSM `tunnel=*`/`bridge=*` tags on ways, record contiguous
tagged runs as distance-along-track intervals (computed before spline-smoothing destroys the
per-point link to source ways), and linearly interpolate elevation between the two portals for
any point falling inside one — discarding the DEM value for that stretch entirely. See
"Elevation, and the Tunnel/Bridge Correction (2026-08-23, this repo only)" under Step 4 above
for the full mechanism, including a tag-propagation bug in junction-splitting that was found
and fixed along the way.

**Files changed**: `backend/services/geometry/processor.js` (new interval/mapping functions,
`chainWaysViaGraph` now tracks per-coordinate way id, `splitWaysAtIntermediateJunctions` now
carries tags through splitting), `backend/services/geometry/generator.js` (orchestration),
`backend/services/osm/osmGeometry.js` (`fetchSegmentGeometryFromOSM` now also collects tags).

**Verified**: Sestri Levante → La Spezia coastal segment — 20 tunnel and 21 bridge sections
detected; output CSV shows a ~2km flat-elevation stretch through a headland tunnel instead of
noisy mountain-surface readings. Known gap: alternative-route CSVs (diverging branches) aren't
covered yet — separate chaining logic, not wired up.

---

### 2026-08-23: Click-to-Place Waypoints Replace Name Search (this repo, not the MCP tool)

**Issue**: The name-search geocoding path (this repo's port of the admin_centre approach
below) was found to be consistently failing in production use. Investigation surfaced two
distinct, compounding causes:
1. A "smallest bounding-box area wins" candidate-selection heuristic in
   `findPlaceViaNominatim()` picked obscure same-named places over the intended city (e.g.
   "Genoa" → a Colorado hamlet, not Genova, Italy) — confirmed live against Nominatim.
2. The admin-boundary/station-search fallback chain (used for any name that isn't an exact
   station match) makes 3–5 sequential Overpass calls per waypoint. Live testing showed
   these routinely hit Overpass's 429 rate limit, and the app's own retry/backoff design
   compounds rather than recovers from that (a 429 adds a fixed 10s penalty and inflates the
   gap before the *next*, unrelated call too) — one lookup took 84s, another didn't finish
   within 2 minutes.

**Solution implemented**: Click-to-place waypoints as the only mechanism in the UI, backed
by single-call reverse geocoding for display labels only (see "Current Waypoint Definition
(2026-08-23)" under Step 2 above for full detail). Name search (`/geography/geocode`) was
left in place as a backend API for compatibility but is no longer called by the frontend.

**Other changes made alongside this**:
- Search bounding boxes are now built and drawn during "Resolve Waypoints," not deferred
  until the section query — visible immediately, no need to wait for the (slower) OSM query
  to see where it will search.
- Long-running buttons ("Query OSM Sections", "Confirm routes and generate geometry") now
  show a spinner and `cursor: wait` while disabled, and label their expected duration, since
  Overpass queries can take minutes and a plain disabled button with a "not-allowed" cursor
  read as broken/stuck.
- Removed the "Search Radius (km)" control and the per-waypoint "Source" label from the UI —
  both were specific to the retired name-search path and had no meaning for an exact pinned
  coordinate.

**Files changed** (this repo — `traxim-centerline-tools`, distinct from the MCP tool
elsewhere in this document):
- `osm-workflow.js`: click-to-place UI (`toggleMapPick`, `setWaypointPin`, `buildAndDrawBboxes`), `resolveWaypoints()` rewritten around pinned waypoints only, busy-button helpers (`setButtonBusy`/`clearButtonBusy`)
- `backend/services/osm/geocoding.js`: added `reverseGeocodePlace()`
- `backend/routes/geography.js`: added `POST /geography/reverse-geocode`
- `index.html`, `styles.css`: updated instructions, removed the search-radius field, spinner/pin CSS

---

### 2026-03-11: Admin Centre Node Geocoding

**Issue**: Place name geocoding using geometric centroids of administrative boundaries, resulting in wrong station selection and incorrect segment routing:
- **Pisa**: Geometric centroid at 43.66575, 10.36237 → found "Tombolo" local station (3.85 km away)
  - Actual city center: 43.7159, 10.4019 → "Pisa Centrale" main station (0.5 km away)
- **Genova**: Centroid at 44.44916, 8.88066 → found "Rivarolo" secondary station (1.66 km away)
  - Actual city center: 44.40726, 8.93386 → 5.8 km from centroid
- **Result**: Segment bboxes centered on wrong locations, routes going to wrong cities (Pisa-Lucca going toward Firenze, 25+ km off target)

**Root cause**: Using `out center;` returns geometric centroid of administrative boundary polygon, not the actual city center that OSM mappers have curated as the `admin_centre` node.

**Solution implemented**: Extract admin_centre member node from relations
1. Query admin boundary relation (levels 8 → 6 → 4)
2. Find member node with `role="admin_centre"` in relation members array
3. Query that node's coordinates (actual city center)
4. Search for nearest railway station within ~11 km
5. Fallback to geometric centroid if admin_centre not available
6. Support manual `coordinate_overrides` for edge cases

**Bug fixes**:
1. **Query syntax**: Changed `out tags bb center;` → `out;`
   - `out center;` returns only geometric centroid, no members
   - `out tags;` returns only tags, no members  
   - `out;` returns full relation including members array → can find admin_centre node
2. **Member extraction**: Check `element.members` array for node with `role="admin_centre"`
   - Not a tag (`element.tags.admin_centre`) but a member with role
3. **Centroid fallback**: Calculate from bounds if element.center not provided:
   ```javascript
   centerLat = (element.bounds.minlat + element.bounds.maxlat) / 2;
   centerLon = (element.bounds.minlon + element.bounds.maxlon) / 2;
   ```

**Results** (Italian cities test):
- ✅ **7/8 cities** correctly find main station using admin_centre node:
  - Sestri Levante: 44.27623, 9.39758 → Sestri Levante station (was Nominatim fallback)
  - La Spezia: 44.11156, 9.81358 → La Spezia Centrale
  - Viareggio: 43.87389, 10.25262 → Viareggio station
  - **Pisa: 43.70786, 10.39839 → Pisa Centrale** (was "Tombolo")
  - Lucca: 43.83728, 10.50618 → Lucca station
  - Firenze: 43.77757, 11.24742 → Firenze Santa Maria Novella
  - **Livorno: 43.55420, 10.33610 → Livorno Centrale** (was using admin boundary)
- ⚠️ Genova: Found "De Ferrari" metro station (0.5 km from admin_centre) - generic workflow cannot differentiate between metro and main station without domain context

**Why this approach is systematic and reproducible**:
- **Language-agnostic**: Uses OSM structural data (relation members, roles) not text matching
- **No hardcoded terms**: No reliance on "Centrale", "Central", "Hauptbahnhof", etc.
- **Globally applicable**: admin_centre role is standard OSM practice worldwide
- **Community-curated**: OSM mappers maintain admin_centre nodes as accurate city centers
- **User-controllable**: `coordinate_overrides` parameter for context-specific cases

**Files changed**:
- `tools/geography.js` lines 22-95: Modified `findAdminBoundary()` to extract admin_centre member node
- `tools/geography.js` lines 195-210: Updated `geocodePlace()` to return `centerSource` field
- `index.js` lines 163-185: Added `coordinate_overrides` parameter to scope_geography
- `index.js` lines 250-265: Return geocodedPlaces array for user verification

**New diagnostic tools**:
- `test-station-geocoding.mjs`: Test geocoding for all cities in scenario
- `test-single-city-detailed.mjs`: Detailed debug output for single city
- `inspect-admin-tags.mjs`: Inspect all tags on admin boundary relation
- `inspect-admin-members.mjs`: Inspect relation members to find admin_centre node

---

### 2026-03-10: Centerline-First Buffer Approach

**Issue**: Multiple sections (Florence/Lucca/Pisa routes) generating identical geometries (all 101.48km), causing duplicate track names and infrastructure bloat (19,891 nodes overloading RAM).

**Root cause**: Segment bboxes (large rectangles) included entire regional network. Corridor fallback always added ~2,500 ways regardless of relation membership.

**Solution implemented**: Centerline-first buffer approach
1. Fetch relation member ways (43-225 ways)
2. Build centerline from those ways (790+ coordinates)
3. Compute 100m buffer around actual route path
4. Query simple rectangular bbox from Overpass
5. Filter locally by distance to centerline (0.001° threshold)

**Bug fixes**:
1. **Overpass query syntax**: Changed `out tags;` → `out;` 
   - `out tags;` returns only tags, no relation members → empty wayIds arrays
   - `out;` returns tags AND members → proper way lists
2. **Centerline builder**: Removed `break;` statement in graph traversal (line 360)
   - Bug: Stopped at first branch, produced only 4 coordinates
   - Fix: Traverse ALL branches and disconnected components → 790+ coordinates
3. **Query strategy**: Changed from complex Overpass polygon queries → simple bbox + local filtering
   - Complex queries consume excessive API quota, cause HTTP 429 rate limiting
   - Simple rectangular bbox + Node.js distance filtering more reliable

**Results**:
- Infrastructure nodes: 19,891 → 6,068 (69% reduction)
- Ways per section: ~200-300 (vs ~2,500 from segment bboxes)
- Distinct geometries confirmed: Ferrovia Lucca-Pisa (261 ways), Linea Firenze-Lucca (1,085 ways)
- No more duplicate tracks

**Files changed**:
- `tools/geography.js` lines 260-305: New `isWayNearCenterline()` function
- `tools/geography.js` lines 307-395: Fixed `buildCenterlineFromWays()` (removed early break)
- `tools/geography.js` lines 530-610: Centerline-first buffer implementation for relations
- `tools/geography.js` lines 670-740: Parallel implementation for way-based sections

**New diagnostic tools**:
- `test-centerline-buffer.mjs`: Test centerline building for single section
- `test-overpass-status.mjs`: Progressive query complexity tests to diagnose rate limiting

### 2026-03-09: Corridor Fallback Always Enabled
- **Issue**: Yard tracks missing from topology even after filter removal; service route relations (Frecciabianca) don't include yard sidings as members
- **Fix**: Changed corridor fallback to always run (removed `wayIds.length < 100` threshold)
- **Result**: Yard tracks now included even when relations return >100 ways
- **Files changed**: `tools/geography.js` lines ~364, ~390

### 2026-03-09: Scoping Query Simplified
- **Issue**: 190 candidate sections cluttered with individual tunnels/viaducts (Galleria Ligia, etc.)
- **Fix**: Modified `queryRailwaySections()` to exclude named ways during initial scoping; added `includeNamedWays` parameter (default false)
- **Result**: Clean candidate list with only ~60 route relations
- **Files changed**: `tools/geography.js` line 61

### 2026-03-09: Yard Track Filter Removal
- **Issue**: Missing yard junctions, duplicate branch connections, 468 link mismatches
- **Fix**: Removed `["service"!~"^(yard|spur)$"]` from Overpass queries
- **Result**: Yard junctions properly created, link mismatches reduced to 16
- **Files changed**: `tools/geography.js` lines 365, 396

### 2026-03-09: Coordinate Snap Threshold Correction
- **Issue**: Distinct junctions 8m apart being merged, causing topology corruption
- **Fix**: Changed `SNAP_THRESHOLD_M` from 30m → 0.5m
- **Result**: Distinct nearby junctions properly separated
- **Files changed**: `tools/infrastructure.js` line 25-28

### 2026-03-09: Spatial Separation Deferral
- **Issue**: Node explosion (1,924 → 2,595), incorrect parallel track separation
- **Fix**: Moved spatial separation from Step 5c to Step 5e (after chain-following)
- **Result**: Only connected nodes separated, parallel tracks preserved
- **Files changed**: `tools/infrastructure.js` lines 757-830 (old), 1125-1195 (new)

---

## Contact and Maintenance

This process has been refined through extensive testing with the Italian railway network (Genoa-Florence-Livorno scenario). The design decisions documented here address specific challenges with Italian OSM tagging conventions and API reliability issues.

**Key principle**: When in doubt about a filter or threshold, prefer INCLUSION over exclusion. Missing infrastructure causes topology errors; extra nodes can be cleaned up manually in Traxim Network Editor.
