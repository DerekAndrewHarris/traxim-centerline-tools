/**
 * OSM Workflow Logic
 * Handles the full OSM-based file generation workflow
 */

// API Configuration
const API_BASE = '/api/file-generator';
const POLL_INTERVAL = 2000; // 2 seconds

// State Management
const state = {
    sessionId: null,
    geocodedLocations: [],
    availableSections: [],
    selectedSections: [],
    geometryJobId: null,
    infrastructureJobId: null,
    generatedFiles: [],
    waypointCounter: 0,
    sectionsCache: new Map() // Cache for sections queries
};

// Map Reference
let osmMap = null;
const mapLayers = {
    geocoded: L.layerGroup(),
    sections: L.layerGroup(),
    geometry: L.layerGroup(),
    topology: L.layerGroup()
};

/**
 * Initialize Leaflet Map
 */
function initMap() {
    osmMap = L.map('map').setView([45.5, 9.0], 7); // Center on northern Italy

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19
    }).addTo(osmMap);

    // Add layer groups
    Object.values(mapLayers).forEach(layer => layer.addTo(osmMap));

    // Expose to global scope for tab switching
    window.osmMap = osmMap;
}

/**
 * Create New Session
 */
async function createSession() {
    try {
        showSessionStatus('Creating session...', 'loading');
        
        const response = await fetch(`${API_BASE}/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) throw new Error(`Session creation failed: ${response.status}`);

        const data = await response.json();
        state.sessionId = data.session.id;

        showSessionStatus(`Session: ${data.session.id.slice(0, 8)}...`, 'active');
        enablePanel('panel-route');
        
        console.log('Session created:', data.session.id);
    } catch (error) {
        console.error('Session creation error:', error);
        showSessionStatus('Session creation failed', 'error');
        alert(`Failed to create session: ${error.message}`);
    }
}

/**
 * Add Waypoint Input
 */
function addWaypoint(defaultValue = '') {
    state.waypointCounter++;
    const waypointId = state.waypointCounter;
    const waypointsList = document.getElementById('waypointsList');
    
    const waypointDiv = document.createElement('div');
    waypointDiv.className = 'waypoint-item';
    waypointDiv.id = `waypoint-${waypointId}`;
    waypointDiv.innerHTML = `
        <div class="form-group">
            <label for="inputWaypoint${waypointId}">Waypoint ${waypointId}</label>
            <div style="display: flex; gap: 8px;">
                <input type="text" id="inputWaypoint${waypointId}" placeholder="e.g., Genoa" value="${defaultValue}" style="flex: 1;" />
                <button class="btn-secondary btn-small" onclick="removeWaypoint(${waypointId})" ${waypointsList.children.length < 2 ? 'disabled' : ''}>Remove</button>
            </div>
        </div>
    `;
    
    waypointsList.appendChild(waypointDiv);
    updateRemoveButtons();
}

/**
 * Remove Waypoint Input
 */
function removeWaypoint(waypointId) {
    const waypointDiv = document.getElementById(`waypoint-${waypointId}`);
    if (waypointDiv) {
        waypointDiv.remove();
        updateRemoveButtons();
        renumberWaypoints();
    }
}

// Expose to global scope for onclick handler
window.removeWaypoint = removeWaypoint;

/**
 * Update Remove Button States (disable if only 2 waypoints remain)
 */
function updateRemoveButtons() {
    const waypointsList = document.getElementById('waypointsList');
    const removeButtons = waypointsList.querySelectorAll('.btn-secondary');
    const shouldDisable = waypointsList.children.length <= 2;
    
    removeButtons.forEach(btn => {
        btn.disabled = shouldDisable;
    });
}

/**
 * Renumber Waypoint Labels
 */
function renumberWaypoints() {
    const waypointsList = document.getElementById('waypointsList');
    const waypoints = waypointsList.querySelectorAll('.waypoint-item');
    
    waypoints.forEach((waypoint, index) => {
        const label = waypoint.querySelector('label');
        if (label) {
            label.textContent = `Waypoint ${index + 1}`;
        }
    });
}

/**
 * Get All Waypoint Values
 */
function getWaypointValues() {
    const waypointsList = document.getElementById('waypointsList');
    const inputs = waypointsList.querySelectorAll('input[type="text"]');
    const values = [];
    
    inputs.forEach(input => {
        const value = input.value.trim();
        if (value) {
            values.push(value);
        }
    });
    
    return values;
}

/**
 * Geocode Locations — one at a time, showing results as they arrive
 */
async function geocodeLocations() {
    const waypoints = getWaypointValues();
    const radiusKm = parseInt(document.getElementById('inputSearchRadius').value);

    if (waypoints.length < 2) {
        alert('Please enter at least 2 waypoints');
        return;
    }

    if (!state.sessionId) {
        alert('Please create a session first');
        return;
    }

    const btn = document.getElementById('btnGeocode');
    btn.disabled = true;
    btn.textContent = 'Geocoding...';

    const summaryDiv = document.getElementById('geocodedSummary');
    const listDiv = document.getElementById('geocodedList');
    summaryDiv.style.display = 'block';

    state.geocodedLocations = [];
    const failedLocations = [];

    for (let i = 0; i < waypoints.length; i++) {
        const waypoint = waypoints[i];

        // Show a pending entry while this waypoint is being looked up
        listDiv.innerHTML = renderGeocodedList(state.geocodedLocations, failedLocations,
            `Searching for "${waypoint}"\u2026 (${i + 1} of ${waypoints.length})`);

        try {
            const response = await fetch(`${API_BASE}/geography/geocode`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId: state.sessionId,
                    places: [waypoint],
                    // First waypoint resets geocodedPlaces in the session;
                    // subsequent ones append to it.
                    appendToSession: i > 0
                })
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }

            const data = await response.json();
            const result = data.results[0];

            if (result.error) {
                failedLocations.push(waypoint);
            } else {
                state.geocodedLocations.push({
                    name: waypoint,
                    lat: result.lat,
                    lon: result.lon,
                    displayName: result.displayName,
                    source: result.source,
                    radiusKm
                });
                drawGeocodedLocations(state.geocodedLocations);
            }
        } catch (error) {
            console.error(`Geocoding error for "${waypoint}":`, error);
            failedLocations.push(waypoint);
        }

        // Update list after each result
        listDiv.innerHTML = renderGeocodedList(state.geocodedLocations, failedLocations,
            i < waypoints.length - 1
                ? `Searching for "${waypoints[i + 1]}"\u2026 (${i + 2} of ${waypoints.length})`
                : null);
    }

    btn.disabled = false;
    btn.textContent = 'Geocode Locations';

    if (failedLocations.length > 0) {
        alert(`Warning: Could not geocode:\n${failedLocations.join(', ')}\n\nContinuing with ${state.geocodedLocations.length} successful location(s).`);
    }

    if (state.geocodedLocations.length === 0) {
        listDiv.innerHTML = '<p style="color:#ff5555;">No locations could be geocoded. Please check your location names.</p>';
        return;
    }

    // Show query instructions and button
    document.getElementById('queryInstructions').style.display = 'block';
    const btnQuerySections = document.getElementById('btnQuerySections');
    btnQuerySections.style.display = 'block';
    btnQuerySections.disabled = false;
    setTimeout(() => btnQuerySections.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100);
}

/**
 * Render the geocoded locations list HTML (used for incremental updates)
 */
function renderGeocodedList(locations, failed, pendingMsg) {
    let html = '';
    locations.forEach((loc, index) => {
        html += `
            <div class="result-item" style="margin-bottom:12px;padding:8px;background:rgba(67,160,71,0.1);border-left:3px solid #43a047;border-radius:3px;">
                <strong style="color:#43a047;">${index + 1}. ${loc.name}</strong><br>
                <span style="font-size:11px;color:#ccc;display:block;margin-top:4px;">${loc.displayName}</span>
                <span style="font-size:11px;color:#888;display:block;margin-top:2px;">Source: ${loc.source}</span>
            </div>`;
    });
    failed.forEach(name => {
        html += `
            <div class="result-item" style="margin-bottom:12px;padding:8px;background:rgba(255,85,85,0.1);border-left:3px solid #ff5555;border-radius:3px;">
                <strong style="color:#ff5555;">${name}</strong> — not found
            </div>`;
    });
    if (pendingMsg) {
        html += `<p style="color:#aaa;margin-top:8px;">${pendingMsg}</p>`;
    }
    return html;
}

/**
 * Draw Geocoded Locations on Map
 */
function drawGeocodedLocations(locations) {
    mapLayers.geocoded.clearLayers();

    const bounds = [];

    locations.forEach((loc, index) => {
        // Add marker
        const marker = L.circleMarker([loc.lat, loc.lon], {
            radius: 8,
            fillColor: '#43a047',
            color: '#fff',
            weight: 2,
            opacity: 1,
            fillOpacity: 0.8
        });

        marker.bindPopup(`<strong>${loc.name}</strong><br>${loc.displayName}`);
        marker.addTo(mapLayers.geocoded);

        // Add search radius circle
        const circle = L.circle([loc.lat, loc.lon], {
            radius: loc.radiusKm * 1000,
            color: '#43a047',
            fillOpacity: 0.1,
            weight: 1
        });
        circle.addTo(mapLayers.geocoded);

        bounds.push([loc.lat, loc.lon]);
    });

    // Fit map to show all locations
    if (bounds.length > 0) {
        osmMap.fitBounds(bounds, { padding: [50, 50] });
    }
}

/**
 * Query Railway Sections
 */
async function querySections() {
    if (!state.sessionId || state.geocodedLocations.length === 0) {
        alert('Please geocode locations first');
        return;
    }

    try {
        const btn = document.getElementById('btnQuerySections');
        btn.disabled = true;
        btn.textContent = 'Querying OSM...';

        const resultsDiv = document.getElementById('sectionsResults');
        resultsDiv.style.display = 'block';
        resultsDiv.innerHTML = '<p>Querying OpenStreetMap for railway sections...</p>';

        // Build bounding boxes between consecutive pairs of waypoints
        // For waypoints A→B→C, create bboxes [A-B, B-C]
        const bboxes = [];
        const radiusKm = 0; // No margin - tight bounding boxes reduce irrelevant results
        
        for (let i = 0; i < state.geocodedLocations.length - 1; i++) {
            const locA = state.geocodedLocations[i];
            const locB = state.geocodedLocations[i + 1];
            
            // Calculate margin in degrees (search radius for buffer around the route)
            const avgLat = (locA.lat + locB.lat) / 2;
            const latMargin = radiusKm / 111; // km to degrees latitude
            const lonMargin = radiusKm / (111 * Math.cos(avgLat * Math.PI / 180)); // km to degrees longitude
            
            // Create rectangle encompassing both points with margin
            bboxes.push({
                minLat: Math.min(locA.lat, locB.lat) - latMargin,
                minLon: Math.min(locA.lon, locB.lon) - lonMargin,
                maxLat: Math.max(locA.lat, locB.lat) + latMargin,
                maxLon: Math.max(locA.lon, locB.lon) + lonMargin
            });
        }

        // Store bboxes in state for map drawing
        state.searchBboxes = bboxes;

        // Draw bboxes on map immediately so user can see the query area
        drawSections([]);

        // Check cache first
        const cacheKey = JSON.stringify(bboxes);
        let data;
        
        if (state.sectionsCache.has(cacheKey)) {
            console.log('[Section Query] Using cached results');
            data = state.sectionsCache.get(cacheKey);
            resultsDiv.innerHTML = '<p style="color: #43a047;">✓ Using cached results (instant)</p>';
        } else {
            const response = await fetch(`${API_BASE}/geography/sections`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId: state.sessionId,
                    bboxes: bboxes
                })
            });

            if (!response.ok) throw new Error(`Section query failed: ${response.status}`);

            data = await response.json();
            
            // Only cache successful results — if Overpass failed with zero sections
            // don't store the empty response so the next attempt re-queries live.
            const overpassFailed = data.overpassFailures && data.sections.length === 0;
            if (!overpassFailed) {
                state.sectionsCache.set(cacheKey, data);
                console.log('[Section Query] Results cached for future use');
            } else {
                console.warn('[Section Query] Overpass failure — result not cached so retry will re-query');
            }
        }
        state.availableSections = data.sections;
        state._lastOverpassFailures = data.overpassFailures || null;

        // If Overpass failed with no sections, show the error in the results div
        // but stay in Step 1 so the user can just click the button again to retry.
        if (data.overpassFailures && data.sections.length === 0) {
            displaySections([]);
            btn.disabled = false;
            btn.textContent = 'Query OSM Sections';
            return;
        }

        // Enable Step 2 and display sections
        enablePanel('panel-sections');
        displaySections(state.availableSections);
        drawSections(state.availableSections);

        btn.disabled = false;
        btn.textContent = 'Query OSM Sections';
        document.getElementById('btnGenerateGeometry').style.display = 'block';

    } catch (error) {
        console.error('Section query error:', error);
        alert(`Section query failed: ${error.message}`);
        
        const btn = document.getElementById('btnQuerySections');
        btn.disabled = false;
        btn.textContent = 'Query OSM Sections';
    }
}

/**
 * Display Railway Sections
 */
function displaySections(sections) {
    const resultsDiv = document.getElementById('sectionsResults');
    
    if (sections.length === 0) {
        resultsDiv.innerHTML = state._lastOverpassFailures
            ? '<p class="warning">Overpass is failing to return results. This is likely a congestion issue. Please try again later.</p>'
            : '<p class="warning">No railway sections found in the specified areas. Try increasing the search radius or adjusting your waypoint locations.</p>';
        return;
    }

    let html = `
        <div class="sections-list">
            <h4>Found ${sections.length} railway section${sections.length !== 1 ? 's' : ''}</h4>
    `;
    
    sections.forEach((section, index) => {
        const isSelected = state.selectedSections.includes(index);
        html += `
            <div class="section-item ${isSelected ? 'selected' : ''}">
                <label>
                    <input type="checkbox" class="section-checkbox" data-index="${index}" ${isSelected ? 'checked' : ''}>
                    <strong>${section.name || 'Unnamed section'}</strong>
                </label>
                <div class="section-details">
                    <span>Type: ${section.type || 'railway'}</span>
                    ${section.operator ? ` | Operator: ${section.operator}` : ''}
                    ${section.ref ? ` | Ref: ${section.ref}` : ''}
                    <br><span class="osm-id">OSM ${section.osmType} ${section.osmId}</span>
                </div>
            </div>
        `;
    });
    
    html += '</div>';
    resultsDiv.innerHTML = html;
    resultsDiv.style.display = 'block';

    // Add event listeners to checkboxes
    document.querySelectorAll('.section-checkbox').forEach(checkbox => {
        checkbox.addEventListener('change', function() {
            const index = parseInt(this.getAttribute('data-index'));
            if (this.checked) {
                if (!state.selectedSections.includes(index)) {
                    state.selectedSections.push(index);
                }
            } else {
                state.selectedSections = state.selectedSections.filter(i => i !== index);
            }
            
            // Update generate button
            document.getElementById('btnGenerateGeometry').disabled = state.selectedSections.length === 0;
            
            // Visual feedback
            this.closest('.section-item').classList.toggle('selected', this.checked);
        });
    });

    // Enable generate button if sections selected
    document.getElementById('btnGenerateGeometry').disabled = state.selectedSections.length === 0;
}

/**
 * Draw Sections on Map — search bboxes as dashed blue rectangles
 */
function drawSections(sections) {
    mapLayers.sections.clearLayers();

    // Draw the search bboxes that were calculated in querySections()
    if (state.searchBboxes && state.searchBboxes.length > 0) {
        state.searchBboxes.forEach((bbox, i) => {
            const rect = L.rectangle(
                [[bbox.minLat, bbox.minLon], [bbox.maxLat, bbox.maxLon]],
                { color: '#2196F3', weight: 2, fillOpacity: 0.05, dashArray: '6, 4' }
            );
            rect.bindPopup(`<strong>Search bbox ${i + 1}</strong>`);
            rect.addTo(mapLayers.sections);
        });
    }
}

/**
 * Fetch map overlay data from the server and draw on the map.
 * Called after geometry generation and infrastructure generation to
 * progressively build up the visual picture.
 */
async function fetchAndDrawOverlays() {
    if (!state.sessionId) return;

    try {
        const resp = await fetch(`${API_BASE}/sessions/${state.sessionId}/map-overlays`);
        if (!resp.ok) return;
        const data = await resp.json();

        // ── Search bboxes (blue dashed) ──────────────────────────────────────
        mapLayers.sections.clearLayers();
        (data.searchBboxes || []).forEach((bbox, i) => {
            const rect = L.rectangle(
                [[bbox.minLat, bbox.minLon], [bbox.maxLat, bbox.maxLon]],
                { color: '#2196F3', weight: 2, fillOpacity: 0.05, dashArray: '6, 4' }
            );
            rect.bindPopup(`<strong>Search bbox ${i + 1}</strong>`);
            rect.addTo(mapLayers.sections);
        });

        // ── Corridor bboxes (orange dashed) ──────────────────────────────────
        (data.corridorBboxes || []).forEach(({ name, bbox }) => {
            const rect = L.rectangle(
                [[bbox.minLat, bbox.minLon], [bbox.maxLat, bbox.maxLon]],
                { color: '#ff9800', weight: 1.5, fillOpacity: 0.03, dashArray: '4, 4' }
            );
            rect.bindPopup(`<strong>Corridor</strong><br>${name}`);
            rect.addTo(mapLayers.sections);
        });

        // ── Geometry centerlines + alternates ────────────────────────────────
        mapLayers.geometry.clearLayers();
        (data.geometryLines || []).forEach(line => {
            const poly = L.polyline(line.coords, {
                color: line.isAlt ? '#ab47bc' : '#ff9800',
                weight: line.isAlt ? 2 : 3,
                opacity: line.isAlt ? 0.7 : 0.9,
                dashArray: line.isAlt ? '4, 4' : null
            });
            poly.bindPopup(`<strong>${line.label}</strong><br>${line.coords.length} points`);
            poly.addTo(mapLayers.geometry);
        });

        // ── Topology ways (thin grey — raw OSM ways) ────────────────────────
        mapLayers.topology.clearLayers();
        (data.topologyWays || []).forEach(w => {
            const poly = L.polyline(w.coords, {
                color: '#888',
                weight: 1.5,
                opacity: 0.5
            });
            const tagInfo = Object.entries(w.tags || {})
                .map(([k, v]) => `${k}=${v}`)
                .join('<br>');
            poly.bindPopup(`<strong>Way ${w.id}</strong><br>${tagInfo || 'no tags'}`);
            poly.addTo(mapLayers.topology);
        });

        // ── Corridor buffer polygons (green semi-transparent ~1km buffer) ───
        (data.corridorPolygons || []).forEach((polygon, i) => {
            if (polygon.length < 3) return;
            const poly = L.polygon(polygon, {
                color: '#4caf50',
                weight: 1,
                fillOpacity: 0.08,
                dashArray: '4, 4'
            });
            poly.bindPopup(`<strong>Corridor buffer ${i + 1}</strong><br>~1 km either side of centerline`);
            poly.addTo(mapLayers.sections);
        });

        // Fit map to show geometry if present, else bboxes
        if (data.geometryLines && data.geometryLines.length > 0) {
            const allCoords = data.geometryLines.flatMap(l => l.coords);
            if (allCoords.length > 0) {
                osmMap.fitBounds(allCoords, { padding: [30, 30] });
            }
        }

    } catch (err) {
        console.warn('[Map Overlays] Failed to fetch overlays:', err.message);
    }
}

/**
 * Generate Geometry (combines confirm + generate into one step)
 */
async function generateGeometry() {
    if (state.selectedSections.length === 0) {
        alert('Please select at least one railway section.');
        return;
    }

    if (!state.sessionId) {
        alert('No active session');
        return;
    }

    const btn = document.getElementById('btnGenerateGeometry');
    btn.disabled = true;
    btn.textContent = 'Confirming sections…';

    try {
        // Step 1: confirm selected sections
        const selectedSectionData = state.selectedSections.map(i => state.availableSections[i]);
        const confirmResponse = await fetch(`${API_BASE}/geography/confirm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: state.sessionId, selectedSections: selectedSectionData })
        });
        if (!confirmResponse.ok) throw new Error(`Section confirmation failed: ${confirmResponse.status}`);

        // Step 2: start geometry generation
        btn.textContent = 'Starting generation…';
        const spacing = parseInt(document.getElementById('inputSpacing').value);
        const response = await fetch(`${API_BASE}/geometry/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: state.sessionId, spacingMetres: spacing })
        });
        if (!response.ok) throw new Error(`Geometry generation failed: ${response.status}`);

        const data = await response.json();
        state.geometryJobId = data.jobId;

        document.getElementById('progressGeometry').style.display = 'block';
        document.getElementById('geometryResults').style.display = 'none';
        pollGeometryJob();

    } catch (error) {
        console.error('Geometry generation error:', error);
        alert(`Geometry generation failed: ${error.message}`);
        btn.disabled = false;
        btn.textContent = 'Confirm routes and generate geometry';
    }
}

/**
 * Poll Geometry Job Status
 */
async function pollGeometryJob() {
    try {
        const response = await fetch(`${API_BASE}/geometry/jobs/${state.geometryJobId}`);
        
        if (!response.ok) throw new Error(`Job status check failed: ${response.status}`);

        const job = await response.json();

        // Update progress bar
        document.getElementById('progressFillGeometry').style.width = `${job.progress}%`;
        document.getElementById('progressTextGeometry').textContent = 
            job.currentStep || `Progress: ${job.progress}%`;

        // Refresh map overlays while job is running (geometry CSVs appear as
        // each segment completes, giving progressive visual feedback).
        if (job.status === 'processing') {
            fetchAndDrawOverlays();
        }

        if (job.status === 'completed') {
            // Job complete
            document.getElementById('progressGeometry').style.display = 'none';
            displayGeometryResults(job.result);
            
            // Enable Download Geometry panel
            enablePanel('panel-download-geometry');
            document.getElementById('btnDownloadGeometryZip').disabled = false;
            document.getElementById('btnDownloadGeometryKml').disabled = false;
            document.getElementById('btnDownloadGeometryBoth').disabled = false;

            // Unlock step 4 so the user can proceed without having to download first.
            // Pass false so step 3 stays open and is not auto-collapsed.
            // Button stays disabled until user types a network name.
            enablePanel('panel-infrastructure', false);
            document.getElementById('btnGenerateInfrastructure').disabled = true;
            
            // Results report is shown by displayGeometryResults() at top of step 3
            
            const btn = document.getElementById('btnGenerateGeometry');
            btn.textContent = 'Geometry Generated ✓';
            btn.classList.add('confirmed');

            // Draw overlays on map (bboxes, centerlines, topology ways)
            fetchAndDrawOverlays();

        } else if (job.status === 'failed') {
            // Job failed
            document.getElementById('progressGeometry').style.display = 'none';
            alert(`Geometry generation failed: ${job.error}`);
            
            const btn = document.getElementById('btnGenerateGeometry');
            btn.disabled = false;
            btn.textContent = 'Confirm routes and generate geometry';

        } else {
            // Still in progress - poll again
            setTimeout(pollGeometryJob, POLL_INTERVAL);
        }

    } catch (error) {
        console.error('Job polling error:', error);
        document.getElementById('progressTextGeometry').textContent = `Error: ${error.message}`;
        
        const btn = document.getElementById('btnGenerateGeometry');
        btn.disabled = false;
        btn.textContent = 'Confirm routes and generate geometry';
    }
}

/**
 * Display Geometry Results — structured post-generation report
 */
function displayGeometryResults(result) {
    const resultsDiv = document.getElementById('geometryResults');
    resultsDiv.style.display = 'block';

    const succeeded = (result.results || []).filter(r => !r.error);
    const failed    = (result.results || []).filter(r =>  r.error);

    // Collect all warnings from successful segments, split into OSM query failures
    // vs. other informational warnings
    const osmFailures = [];
    const otherWarnings = [];
    for (const r of succeeded) {
        for (const w of (r.warnings || [])) {
            if (/overpass|query fail|osm api|timeout|rate.limit/i.test(w)) {
                osmFailures.push({ section: r.section, warning: w });
            } else if (!/topology json saved/i.test(w)) {
                otherWarnings.push({ section: r.section, warning: w });
            }
        }
    }

    let html = '';

    // ── Succeeded ──────────────────────────────────────────────────────────
    if (succeeded.length > 0) {
        html += `<p class="success"><strong>✓ Generated (${succeeded.length} section${succeeded.length > 1 ? 's' : ''}):</strong></p><ul>`;
        for (const r of succeeded) {
            const altNote = r.alternativeCount > 0
                ? ` <span style="color:#aaa;font-size:0.9em;">+ ${r.alternativeCount} alt route${r.alternativeCount > 1 ? 's' : ''}</span>`
                : '';
            html += `<li>${r.section}: ${r.pointCount} points (${r.lengthKm.toFixed(2)} km)${altNote}</li>`;
        }
        html += '</ul>';
    }

    // ── Failed ─────────────────────────────────────────────────────────────
    if (failed.length > 0) {
        html += `<p class="warning"><strong>✗ Failed (${failed.length} section${failed.length > 1 ? 's' : ''}):</strong></p><ul>`;
        for (const r of failed) {
            html += `<li class="error">${r.section}: ${r.error}</li>`;
        }
        html += `<p style="color:#e57373;font-size:11px;">These sections produced no geometry file. ` +
                `You can retry the whole process after a short break to allow OSM query limits to reset.</p>`;
    }

    // ── OSM query failures (non-fatal) ────────────────────────────────────
    if (osmFailures.length > 0) {
        html += `<p class="warning" style="margin-top:10px"><strong>⚠ OSM query issues:</strong></p><ul>`;
        for (const f of osmFailures) {
            html += `<li style="color:#ffb74d;font-size:11px;">${f.section}: ${f.warning}</li>`;
        }
        html += `</ul><p style="color:#aaa;font-size:11px;">Some queries failed but the section was still generated using available data. ` +
                `Geometry may be incomplete. If the result looks wrong, retry after a short break.</p>`;
    }

    // ── Other warnings ────────────────────────────────────────────────────
    if (otherWarnings.length > 0) {
        html += `<p style="color:#aaa;margin-top:8px;font-size:11px;"><strong>Notes:</strong></p><ul>`;
        for (const w of otherWarnings) {
            html += `<li style="color:#aaa;font-size:11px;">${w.section}: ${w.warning}</li>`;
        }
        html += '</ul>';
    }

    if (!html) {
        html = '<p style="color:#aaa">No results returned.</p>';
    }

    resultsDiv.innerHTML = html;
}

/**
 * Download Geometry ZIP
 */
async function downloadGeometryZip() {
    try {
        window.location.href = `${API_BASE}/sessions/${state.sessionId}/download-geometry`;
    } catch (error) {
        console.error('Download error:', error);
        alert('Download failed: ' + error.message);
    }
}

/**
 * Download Geometry KML
 */
async function downloadGeometryKml() {
    try {
        const btn = document.getElementById('btnDownloadGeometryKml');
        btn.disabled = true;
        btn.textContent = 'Generating KMZ...';
        
        // Download geometry ZIP from backend
        const response = await fetch(`${API_BASE}/sessions/${state.sessionId}/download-geometry`);
        if (!response.ok) throw new Error(`Failed to download geometry: ${response.status}`);
        
        const zipBlob = await response.blob();
        
        btn.textContent = 'Reading CSV files...';
        
        // Extract CSV files from ZIP using JSZip
        const zip = await JSZip.loadAsync(zipBlob);
        const geometryDict = {};
        
        // Read each CSV file (excluding wayids files)
        for (const [filename, file] of Object.entries(zip.files)) {
            if (filename.endsWith('.csv') && !filename.includes('wayids')) {
                const csvContent = await file.async('text');
                const sectionName = filename.replace('.csv', '').replace(/_/g, ' ');
                
                // Use IOFunctions to parse CSV (same as original tool)
                const points = IOFunctions.readCsvLatLongCharlotte(csvContent);
                
                if (points.length > 0) {
                    geometryDict[sectionName] = points;
                }
                
                console.log(`Read ${points.length} points from ${sectionName}`);
            }
        }
        
        btn.textContent = 'Generating KML...';
        
        // Generate KML using IOFunctions (same as original tool)
        const kml = IOFunctions.generateLinesKML(geometryDict, {
            exaggeration: 1,
            offset: 0,
            altitudeMode: 'clampToGround'
        });
        
        btn.textContent = 'Creating KMZ...';
        
        // Create KMZ file (ZIP with doc.kml inside)
        const kmz = new JSZip();
        kmz.file('doc.kml', kml);
        const kmzBlob = await kmz.generateAsync({
            type: 'blob',
            compression: 'DEFLATE',
            compressionOptions: { level: 9 }
        });
        
        // Download KMZ
        const url = URL.createObjectURL(kmzBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `traxim-geometry-${state.sessionId}.kmz`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        btn.disabled = false;
        btn.textContent = 'Generate & Download KMZ';
        
        console.log(`KMZ generated with ${Object.keys(geometryDict).length} sections`);
    } catch (error) {
        console.error('KMZ generation error:', error);
        alert('KMZ generation failed: ' + error.message);
        
        const btn = document.getElementById('btnDownloadGeometryKml');
        btn.disabled = false;
        btn.textContent = 'Generate & Download KMZ';
    }
}

/**
 * Download Both Geometry Formats
 */
async function downloadGeometryBoth() {
    try {
        const btn = document.getElementById('btnDownloadGeometryBoth');
        btn.disabled = true;
        btn.textContent = 'Downloading ZIP...';
        
        // Download geometry ZIP from backend
        const response = await fetch(`${API_BASE}/sessions/${state.sessionId}/download-geometry`);
        if (!response.ok) throw new Error(`Failed to download geometry: ${response.status}`);
        
        const zipBlob = await response.blob();
        
        btn.textContent = 'Reading CSV files...';
        
        // Extract and process CSV files using JSZip
        const zip = await JSZip.loadAsync(zipBlob);
        const geometryDict = {};
        
        for (const [filename, file] of Object.entries(zip.files)) {
            if (filename.endsWith('.csv') && !filename.includes('wayids')) {
                const csvContent = await file.async('text');
                const sectionName = filename.replace('.csv', '').replace(/_/g, ' ');
                const points = IOFunctions.readCsvLatLongCharlotte(csvContent);
                
                if (points.length > 0) {
                    geometryDict[sectionName] = points;
                }
            }
        }
        
        btn.textContent = 'Generating KMZ...';
        
        // Generate KML using IOFunctions
        const kml = IOFunctions.generateLinesKML(geometryDict, {
            exaggeration: 1,
            offset: 0,
            altitudeMode: 'clampToGround'
        });
        
        // Create KMZ file
        const kmz = new JSZip();
        kmz.file('doc.kml', kml);
        const kmzBlob = await kmz.generateAsync({
            type: 'blob',
            compression: 'DEFLATE',
            compressionOptions: { level: 9 }
        });
        
        btn.textContent = 'Downloading files...';
        
        // Download CSV ZIP
        const zipUrl = URL.createObjectURL(zipBlob);
        const zipLink = document.createElement('a');
        zipLink.href = zipUrl;
        zipLink.download = `traxim-geometry-${state.sessionId}.zip`;
        document.body.appendChild(zipLink);
        zipLink.click();
        document.body.removeChild(zipLink);
        URL.revokeObjectURL(zipUrl);
        
        // Wait a moment then download KMZ
        setTimeout(() => {
            const kmzUrl = URL.createObjectURL(kmzBlob);
            const kmzLink = document.createElement('a');
            kmzLink.href = kmzUrl;
            kmzLink.download = `traxim-geometry-${state.sessionId}.kmz`;
            document.body.appendChild(kmzLink);
            kmzLink.click();
            document.body.removeChild(kmzLink);
            URL.revokeObjectURL(kmzUrl);
        }, 500);
        
        btn.disabled = false;
        btn.textContent = 'Download Both (ZIP + KMZ)';
        
        console.log(`Generated both formats with ${Object.keys(geometryDict).length} sections`);
    } catch (error) {
        console.error('Download error:', error);
        alert('Download failed: ' + error.message);
        
        const btn = document.getElementById('btnDownloadGeometryBoth');
        btn.disabled = false;
        btn.textContent = 'Download Both (ZIP + KMZ)';
    }
}

/**
 * Generate Infrastructure
 */
async function generateInfrastructure() {
    if (!state.sessionId) {
        alert('No active session');
        return;
    }

    try {
        const btn = document.getElementById('btnGenerateInfrastructure');
        btn.disabled = true;
        btn.textContent = 'Starting Generation...';

        const networkName = document.getElementById('inputNetworkName').value.trim() || 'Railway Network';

        const response = await fetch(`${API_BASE}/infrastructure/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: state.sessionId,
                networkName: networkName
            })
        });

        if (!response.ok) throw new Error(`Infrastructure generation failed: ${response.status}`);

        const data = await response.json();
        state.infrastructureJobId = data.jobId;

        // Show progress container
        document.getElementById('progressInfrastructure').style.display = 'block';
        document.getElementById('infrastructureResults').style.display = 'none';

        // Start polling
        pollInfrastructureJob();

    } catch (error) {
        console.error('Infrastructure generation error:', error);
        alert(`Infrastructure generation failed: ${error.message}`);
        
        const btn = document.getElementById('btnGenerateInfrastructure');
        btn.disabled = false;
        btn.textContent = 'Generate Infrastructure';
    }
}

/**
 * Poll Infrastructure Job Status
 */
async function pollInfrastructureJob() {
    try {
        const response = await fetch(`${API_BASE}/infrastructure/jobs/${state.infrastructureJobId}`);
        
        if (!response.ok) throw new Error(`Job status check failed: ${response.status}`);

        const job = await response.json();

        // Update progress bar
        document.getElementById('progressFillInfrastructure').style.width = `${job.progress}%`;
        document.getElementById('progressTextInfrastructure').textContent = 
            job.currentStep || `Progress: ${job.progress}%`;

        if (job.status === 'completed') {
            // Job complete
            document.getElementById('progressInfrastructure').style.display = 'none';
            displayInfrastructureResults(job.result);
            
            // Enable download
            enablePanel('panel-download');
            updateDownloadSummary();
            document.getElementById('btnDownloadAll').disabled = false;
            
            const btn = document.getElementById('btnGenerateInfrastructure');
            btn.textContent = 'Infrastructure Generated ✓';
            btn.classList.add('confirmed');

        } else if (job.status === 'failed') {
            // Job failed
            document.getElementById('progressInfrastructure').style.display = 'none';
            alert(`Infrastructure generation failed: ${job.error}`);
            
            const btn = document.getElementById('btnGenerateInfrastructure');
            btn.disabled = false;
            btn.textContent = 'Generate Infrastructure';

        } else {
            // Still in progress - poll again
            setTimeout(pollInfrastructureJob, POLL_INTERVAL);
        }

    } catch (error) {
        console.error('Job polling error:', error);
        document.getElementById('progressTextInfrastructure').textContent = `Error: ${error.message}`;
        
        const btn = document.getElementById('btnGenerateInfrastructure');
        btn.disabled = false;
        btn.textContent = 'Generate Infrastructure';
    }
}

/**
 * Display Infrastructure Results
 */
function displayInfrastructureResults(result) {
    const resultsDiv = document.getElementById('infrastructureResults');
    resultsDiv.style.display = 'block';

    let html = '<p class="success"><strong>Infrastructure generated successfully:</strong></p>';
    html += `<ul>`;
    html += `<li>Nodes: ${result.nodeCount}</li>`;
    html += `<li>Connections: ${result.connectionCount}</li>`;
    html += `<li>File: ${result.fileName}</li>`;
    html += `</ul>`;

    if (result.warnings && result.warnings.length > 0) {
        html += '<p><strong>Warnings:</strong></p><ul>';
        result.warnings.slice(0, 5).forEach(w => {
            html += `<li class="warning">${w}</li>`;
        });
        if (result.warnings.length > 5) {
            html += `<li class="warning">... and ${result.warnings.length - 5} more warnings</li>`;
        }
        html += '</ul>';
    }

    resultsDiv.innerHTML = html;
}

/**
 * Update Download Summary
 */
function updateDownloadSummary() {
    const summaryDiv = document.getElementById('downloadSummary');
    summaryDiv.style.display = 'block';
    
    summaryDiv.innerHTML = `
        <p class="success"><strong>Infrastructure file generated successfully.</strong></p>
        <p>Click below to download.</p>
    `;
}

/**
 * Download All Files
 */
async function downloadAllFiles() {
    if (!state.sessionId) {
        alert('No active session');
        return;
    }

    try {
        const btn = document.getElementById('btnDownloadAll');
        btn.disabled = true;
        btn.textContent = 'Downloading...';

        const response = await fetch(`${API_BASE}/sessions/files/${state.sessionId}/Infrastructure.csv`);
        
        if (!response.ok) throw new Error(`Download failed: ${response.status}`);

        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'Infrastructure.csv';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);

        btn.disabled = false;
        btn.textContent = 'Download Complete ✓';
        btn.classList.add('confirmed');

    } catch (error) {
        console.error('Download error:', error);
        alert(`Download failed: ${error.message}`);
        
        const btn = document.getElementById('btnDownloadAll');
        btn.disabled = false;
        btn.textContent = 'Download Infrastructure.csv';
    }
}

/**
 * Show Session Status
 */
function showSessionStatus(message, status) {
    const statusEl = document.getElementById('sessionStatus');
    statusEl.textContent = message;
    statusEl.className = 'session-status ' + status;
}

/**
 * Enable/Disable Panel
 */
function enablePanel(panelId, collapsePrevious = true) {
    const panel = document.getElementById(panelId);
    panel.classList.remove('disabled');
    panel.classList.remove('collapsed');
    
    // Auto-collapse the previous panel when advancing to the next step
    if (collapsePrevious) {
        const allPanels = ['panel-route', 'panel-sections', 'panel-download-geometry', 'panel-infrastructure', 'panel-download'];
        const currentIndex = allPanels.indexOf(panelId);
        if (currentIndex > 0) {
            const previousPanel = document.getElementById(allPanels[currentIndex - 1]);
            if (previousPanel) {
                previousPanel.classList.add('collapsed');
            }
        }
    }
}

/**
 * Initialize Event Listeners
 */
document.addEventListener('DOMContentLoaded', function() {
    // Initialize map
    initMap();

    // Initialize waypoints with 2 default locations
    addWaypoint('');
    addWaypoint('');

    // Session management
    document.getElementById('btnNewSession').addEventListener('click', createSession);

    // Waypoint management
    document.getElementById('btnAddWaypoint').addEventListener('click', () => addWaypoint(''));

    // Workflow steps
    document.getElementById('btnGeocode').addEventListener('click', geocodeLocations);
    document.getElementById('btnQuerySections').addEventListener('click', querySections);
    document.getElementById('btnGenerateGeometry').addEventListener('click', generateGeometry);
    document.getElementById('btnDownloadGeometryZip').addEventListener('click', downloadGeometryZip);
    document.getElementById('btnDownloadGeometryKml').addEventListener('click', downloadGeometryKml);
    document.getElementById('btnDownloadGeometryBoth').addEventListener('click', downloadGeometryBoth);
    document.getElementById('btnGenerateInfrastructure').addEventListener('click', generateInfrastructure);
    document.getElementById('inputNetworkName').addEventListener('input', function() {
        const btn = document.getElementById('btnGenerateInfrastructure');
        // Only enable if the panel is unlocked (not disabled) and there is a name
        if (!document.getElementById('panel-infrastructure').classList.contains('disabled')) {
            btn.disabled = this.value.trim() === '';
        }
    });
    document.getElementById('btnDownloadAll').addEventListener('click', downloadAllFiles);

    // Panel collapse/expand toggle
    document.querySelectorAll('.panel-header').forEach(header => {
        header.addEventListener('click', function(e) {
            // Don't toggle if clicking on a button inside the header
            if (e.target.tagName === 'BUTTON') return;
            
            const panel = this.closest('.workflow-panel');
            
            // Allow expanding/collapsing any panel, even if disabled
            // Just show a warning if they try to interact with disabled content
            panel.classList.toggle('collapsed');
        });
    });

    // Map controls
    document.getElementById('btnClearMap').addEventListener('click', function() {
        Object.values(mapLayers).forEach(layer => layer.clearLayers());
    });

    // Topology layer toggle
    document.getElementById('chkTopologyWays').addEventListener('change', function() {
        if (this.checked) {
            osmMap.addLayer(mapLayers.topology);
        } else {
            osmMap.removeLayer(mapLayers.topology);
        }
    });

    // Auto-create session on load
    createSession();
});
