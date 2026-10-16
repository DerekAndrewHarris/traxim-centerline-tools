# Traxim File Generator - Backend API

## Overview

Backend infrastructure for the Traxim File Generator, providing REST API endpoints for:
- Temporary session management
- OSM geography services (waypoint reverse-geocoding, railway section discovery)
- OSM-based geometry generation
- Infrastructure generation
- Centerline KML/CSV conversion (not yet ported to the backend — still client-side only, see the main README)
- ZIP file downloads

## Architecture

**Design:** Simple, stateless backend with:
- **No authentication** (public access)
- **No Redis** (in-memory job queue)
- **Temporary storage only** (24-hour auto-cleanup)
- **Polling for progress** (simpler than WebSocket/SSE)

## Directory Structure

```
backend/
├── routes/
│   ├── index.js           # Route aggregator
│   ├── sessions.js        # Session management endpoints
│   ├── geography.js       # OSM geocode/reverse-geocode & section discovery
│   ├── geometry.js        # Geometry generation (job-queue backed)
│   ├── infrastructure.js  # Infrastructure generation (job-queue backed)
│   └── centerline.js      # (TODO) KML/CSV conversion — still client-side only (lib/)
├── services/
│   ├── osm/                # ipv4fetch, overpass, geocoding, sections, osmGeometry
│   ├── geometry/            # generator.js, processor.js
│   ├── infrastructure/      # generator.js, processor.js
│   └── elevation.js         # Copernicus DEM tiles (cached on disk) - elevations
├── utils/
│   ├── tempFiles.js       # Session creation & cleanup
│   ├── zipGenerator.js    # ZIP archive generation
│   ├── jobQueue.js        # In-memory job queue
│   ├── kmlGenerator.js    # KML output for map overlays
│   └── errorHandler.js    # Error handling middleware
└── server.js              # Development server
```

## Installation

### 1. Install Dependencies

```bash
cd traxim-centerline-tools
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your configuration
```

### 3. Run Development Server

```bash
npm run dev
```

Server will start on `http://localhost:3001`

## API Endpoints

### Health Check

```bash
GET /api/file-generator/health
```

Returns API status and version info.

### Session Management

#### Create Session
```bash
POST /api/file-generator/sessions

Response:
{
  "success": true,
  "session": {
    "id": "abc-123-def-456",
    "createdAt": "2026-03-13T10:00:00Z",
    "expiresAt": "2026-03-14T10:00:00Z"
  }
}
```

#### Get Session Info
```bash
GET /api/file-generator/sessions/:id

Response:
{
  "success": true,
  "session": {
    "id": "abc-123-def-456",
    "createdAt": "2026-03-13T10:00:00Z",
    "expiresAt": "2026-03-14T10:00:00Z",
    "files": ["geometry/Track_1.csv", "Infrastructure.csv"]
  }
}
```

#### Delete Session
```bash
DELETE /api/file-generator/sessions/:id

Response: 204 No Content
```

#### Download All Files (ZIP)
```bash
GET /api/file-generator/sessions/:id/download-all

Response: ZIP file download
```

#### Download Single File
```bash
GET /api/file-generator/files/:sessionId/:filename

Response: File download
```

### Geography (Waypoints & Sections)

The frontend defines waypoints by clicking the map (exact coordinates, no lookup needed)
and uses `/reverse-geocode` purely to attach a display name. `/geocode` (name → coordinates)
still exists and works, but the frontend no longer calls it — it turned out to be
unreliable enough (wrong-place matches from a naive bbox-area heuristic, and Overpass
rate-limit cascades on the admin-boundary/station-search fallback chain) that click-to-place
replaced it as the supported path. See `OSM_DATA_LOADING_PROCESS.md` for the full story.

```bash
# Give a clicked point a display name; also records it in the session's
# geocodedPlaces list (same shape /geocode uses) so later steps (e.g. geometry
# segment labels) see a real name instead of a generic placeholder.
POST /api/file-generator/geography/reverse-geocode
Body: { sessionId, lat, lon, appendToSession? }
Response: { sessionId, result: { place, lat, lon, displayName, source: "map_click" } }

# Name → coordinates (kept for API compatibility; not used by the current frontend)
POST /api/file-generator/geography/geocode
Body: { sessionId, places: string[], appendToSession? }

# Find railway route relations within bounding boxes between waypoints
POST /api/file-generator/geography/sections
Body: { sessionId, bboxes: [{minLat, minLon, maxLat, maxLon}, ...] }

# Confirm which candidate sections to carry into geometry generation
POST /api/file-generator/geography/confirm
Body: { sessionId, selectedSections: [{osmId, osmType}, ...] }
```

### Geometry & Infrastructure Generation

Both are job-queue backed (see Job Queue below) — the generate endpoint returns a
`jobId`, poll the jobs endpoint for progress:

```bash
POST /api/file-generator/geometry/generate        Body: { sessionId, spacingMetres? }
GET  /api/file-generator/geometry/jobs/:jobId

POST /api/file-generator/infrastructure/generate   Body: { sessionId, networkName }
GET  /api/file-generator/infrastructure/jobs/:jobId
```

These can each take a few minutes — the OSM queries behind them (Overpass relation/way
fetches) are the bottleneck, not the local processing.

## Agent access (through the Traxim Controller)

_Added October 2026. Full design, tool list and deployment steps: `documentation/FILE_GENERATOR_AGENT_ACCESS.md` in the Controller repo (Traxim-Live-Control-Interface-for-Web)._

AI agents use the File Generator only through the Traxim Controller's MCP connector (`generator_` tools). The Controller checks the user's login and calls this service **server to server** on `127.0.0.1:3001`, under `/internal/agent/...` (`backend/routes/agent.js`). The generation logic stays here.

- **Who is calling:** headers `X-Traxim-Internal-Key` (shared secret `TRAXIM_INTERNAL_KEY`, same value in both services) and `X-Traxim-User-Id`. nginx does not forward `/internal/`, requests that came through nginx (`X-Forwarded-For`/`X-Real-IP`) are refused, and without the key every call is refused. No key configured = agent routes off (503); the website is unaffected. See `backend/utils/internalAuth.js`.
- **Ownership:** agent sessions store `agent.ownerId` in `session.json`; every agent route answers 404 for anything that is not the caller's. The public `/api/file-generator` routes answer 404 for agent sessions and agent jobs (`backend/utils/publicSessionGuard.js`), so the website's anonymous API cannot reach them.
- **Workflow:** `backend/services/agent/agentSessions.js`: waypoints -> section search (a background job; search boxes worked out on the server, `searchBoxes.js`) -> numbered section list -> the user's choice recorded -> one combined job (geometry, then infrastructure; Regions.csv is written by the geometry step) -> outputs-only ZIP (`Infrastructure.csv`, `Regions.csv`, `Geometry/*.csv`).
- **Limits** (`backend/services/agent/limits.js`, env overrides): 20 generations per hour per user, 5,000 infrastructure nodes per generation (checked when the infrastructure step has built the nodes, before `Infrastructure.csv` is written), 30 new sessions per hour, 25 waypoints, 2 jobs waiting or running per user.
- The shared job code is in `backend/services/generation/pipeline.js` (used by both the website's routes and the agent job).
- Browser view of an agent session: `/TraximCenterlineTools/?session=<id>` (read-only, needs the Traxim login; data comes from the Controller).

## Session Lifecycle

1. **Create:** `POST /sessions` returns UUID
2. **Use:** Store sessionId in browser, make API calls with it
3. **Download:** Files available for 24 hours
4. **Cleanup:** Cron job deletes expired sessions automatically

## Job Queue

**In-memory queue** for background processing:
- Max 3 concurrent jobs (set `MAX_CONCURRENT_JOBS`, 1-16)
- Progress tracking via polling
- Auto-cleanup of completed jobs after 1 hour

**Usage example:**

```javascript
import jobQueue from './backend/utils/jobQueue.js';

// Create job
const jobId = jobQueue.createJob('geometry', { spacing: 25 }, async (data, updateProgress) => {
  updateProgress(0, 'Starting...');
  // ... do work ...
  updateProgress(50, 'Processing section 2 of 4');
  // ... more work ...
  updateProgress(100, 'Complete');
  return { files: ['output.csv'] };
});

// Check status
const job = jobQueue.getJob(jobId);
console.log(job.status, job.progress);
```

## Development

### Watch Mode
```bash
npm run dev
```

Auto-restarts on file changes (uses `--watch` flag).

### Testing

Test endpoints with curl:

```bash
# Create session
curl -X POST http://localhost:3001/api/file-generator/sessions

# Get session info
curl http://localhost:3001/api/file-generator/sessions/abc-123

# Health check
curl http://localhost:3001/api/file-generator/health
```

## Next Steps

Geography, geometry, and infrastructure generation are all built (see Geography and
Geometry & Infrastructure Generation above). Remaining:
- Regions.csv and Speedboards.csv generation
- Centerline conversion as a backend API (currently client-side only, see main README)

## Environment Variables

See `.env.example` for full list. Key variables:

```bash
NODE_ENV=development
PORT=3001
TEMP_FILES_DIR=./temp-sessions
SESSION_EXPIRY_HOURS=24
OVERPASS_API_URL=https://overpass-api.de/api/interpreter
MAX_CONCURRENT_JOBS=3
# Agent access: TRAXIM_INTERNAL_KEY (secret, never in git) and AGENT_* limits, see .env.example
```

## Security

- **No authentication** on the website API (`/api/file-generator`), as before. Agent sessions are separate: see "Agent access" above.
- **Session isolation:** UUID-based directories prevent collisions
- **Path validation:** All file operations validated against session directory
- **Automatic cleanup:** Expired sessions deleted daily
- **CORS:** Configurable allowed origins

## Troubleshooting

**Port already in use:**
```bash
# Change PORT in .env or:
PORT=3002 npm run dev
```

**Session not found:**
- Check if session expired (24 hours)
- Verify sessionId is correct UUID format

**File downloads failing:**
- Check TEMP_FILES_DIR permissions
- Verify session directory exists
- Check disk space

## License

ISC
