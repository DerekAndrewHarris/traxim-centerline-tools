/**
 * OSM Workflow Logic
 * Handles the full OSM-based file generation workflow
 */

// API Configuration
const API_BASE = '/api/file-generator';
const POLL_INTERVAL = 2000; // 2 seconds

/**
 * fetch() with a hard timeout. Used for best-effort calls (like reverse
 * geocoding a pin) that should never be allowed to stall the workflow —
 * on timeout or any failure the caller falls back to a generic label.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 7000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Mark a button as busy: disables it, shows a spinner, and swaps in the
 * given label. Safe to call again on the same button to just update the
 * label while staying busy (e.g. moving from "Confirming..." to
 * "Generating..." without losing the spinner).
 */
function setButtonBusy(btn, label) {
    btn.disabled = true;
    btn.classList.add('btn-loading');
    btn.innerHTML = `<span class="btn-spinner"></span>${label}`;
}

/**
 * Clear a button's busy state: re-enables it, removes the spinner, and
 * restores the given label.
 */
function clearButtonBusy(btn, label) {
    btn.disabled = false;
    btn.classList.remove('btn-loading');
    btn.textContent = label;
}

// State Management
const state = {
    sessionId: null,
    geocodedLocations: [],
    availableSections: [],
    selectedSections: [],
    sectionLayers: {}, // section index -> Leaflet layerGroup, for checkbox-driven map visibility
    geometryJobId: null,
    infrastructureJobId: null,
    generatedFiles: [],
    waypointCounter: 0,
    sectionsCache: new Map(), // Cache for sections queries
    pins: {},           // waypointId -> {lat, lon} for map-clicked waypoints
    pinMarkers: {},      // waypointId -> Leaflet marker for map-clicked waypoints
    pickingWaypointId: null, // waypointId currently armed for a map click, or null
    outputStamp: null,   // date stamp of the last geometry run (geometry, Regions, Speedboards, KMZ names)
    infrastructureStamp: null, // date stamp of the last infrastructure run (its own, every run)
    seriousProblems: [],  // the geometry run's serious problems (shown at Step 3 only)
    infrastructureSeriousProblems: [], // the infrastructure run's own (shown at Step 5)
    infrastructureResult: null // the last infrastructure result (details and warnings shown at Step 5)
};

/**
 * Download name with the run's date stamp, as the Network Editor names its
 * files: "Regions.csv" -> "Regions_2026-10-16_093012.csv". The stamp comes
 * from the server (one per geometry run, also used for Infrastructure).
 */
function stampedFileName(name, stamp = state.outputStamp) {
    if (!stamp || !/^\d{4}-\d{2}-\d{2}_\d{6}$/.test(stamp)) return name;
    const dot = name.lastIndexOf('.');
    return dot > 0 ? `${name.slice(0, dot)}_${stamp}${name.slice(dot)}` : `${name}_${stamp}`;
}

/** Red box listing problems that make files unusable as they are (or '' if none); each problem names the files it affects. */
function seriousProblemsHtml(problems) {
    if (!problems || problems.length === 0) return '';
    const items = problems.map(p => `<li style="margin-bottom:6px;">${escapeHtml(p)}</li>`).join('');
    return '<div class="serious-problems" style="border:2px solid #e53935;background:rgba(229,57,53,0.12);' +
        'border-radius:6px;padding:10px 12px;margin-bottom:12px;">' +
        '<p style="margin:0 0 6px;color:#ff8a80;"><strong>&#9888; Serious problem' + (problems.length > 1 ? 's' : '') +
        ': read before using these files</strong></p>' +
        `<ul style="margin:0;padding-left:18px;color:#ffcdd2;">${items}</ul></div>`;
}

/**
 * Warnings in three groups (October 2026; the server sorts them, see
 * backend/utils/warningKinds.js): serious and "check these" are always shown
 * in full; the informational ones are in a "show all" list that opens on
 * click. Before this, only the first five warnings were shown, which hid the
 * platform merges at La Spezia.
 * @param {{serious?: string[], review?: string[], info?: string[]}|null} groups
 * @param {string[]} [fallback] - plain warning list (older server): all shown as "check these"
 */
function warningGroupsHtml(groups, fallback = []) {
    const g = groups || { serious: [], review: fallback || [], info: [] };
    const serious = g.serious || [], review = g.review || [], info = g.info || [];
    const items = (list, colour) => list.map(w => `<li style="margin-bottom:4px;color:${colour};">${escapeHtml(w)}</li>`).join('');
    let html = '';
    if (serious.length > 0) {
        html += '<div class="warnings-serious" style="border:2px solid #e53935;background:rgba(229,57,53,0.10);border-radius:6px;padding:8px 12px;margin:10px 0;">' +
            `<p style="margin:0 0 6px;color:#ff8a80;"><strong>&#9888; Problems (${serious.length}): some data is missing</strong></p>` +
            `<ul style="margin:0;padding-left:18px;font-size:12px;">${items(serious, '#ffcdd2')}</ul></div>`;
    }
    if (review.length > 0) {
        html += '<div class="warnings-review" style="border:1px solid #ffb74d;border-radius:6px;padding:8px 12px;margin:10px 0;">' +
            `<p style="margin:0 0 6px;color:#ffb74d;"><strong>&#9888; Check these in the files (${review.length})</strong></p>` +
            `<ul style="margin:0;padding-left:18px;font-size:12px;">${items(review, '#ffe0b2')}</ul></div>`;
    }
    if (info.length > 0) {
        html += `<details class="warnings-info" style="margin:8px 0;"><summary style="cursor:pointer;color:#aaa;font-size:12px;">` +
            `Show all ${info.length} information note${info.length === 1 ? '' : 's'} (what the generator did; nothing to fix)</summary>` +
            `<ul style="padding-left:18px;font-size:11px;">${items(info, '#aaa')}</ul></details>`;
    }
    return html;
}

/*
 * Recent network names (October 2026). The Network Name box used to show the
 * browser's own autofill list (old names in the browser's own order). It is
 * now switched off (autocomplete="off") and the page keeps its own list:
 * most recently used first, at most 6, no duplicates (ignoring capitals); a
 * name used again moves to the top and the oldest drops off. Kept in this
 * browser's localStorage; if that is unavailable (private window, blocked
 * storage) the list still works until the page is closed.
 */
const RECENT_NAMES_KEY = 'traxim.fileGenerator.recentNetworkNames';
const RECENT_NAMES_MAX = 6;
let recentNamesMemory = [];

/** The list with `name` added at the top (pure; used by the tests). */
function addRecentName(list, name, max = RECENT_NAMES_MAX) {
    const clean = String(name || '').trim();
    const old = (Array.isArray(list) ? list : []).filter(n => typeof n === 'string' && n.trim());
    if (!clean) return old.slice(0, max);
    return [clean, ...old.filter(n => n.trim().toLowerCase() !== clean.toLowerCase())].slice(0, max);
}

function loadRecentNetworkNames() {
    try {
        const raw = window.localStorage.getItem(RECENT_NAMES_KEY);
        if (raw) {
            const list = JSON.parse(raw);
            if (Array.isArray(list)) return addRecentName(list, '');
        }
    } catch (e) { /* storage unavailable: use this page's own memory */ }
    return recentNamesMemory.slice();
}

function rememberNetworkName(name) {
    const list = addRecentName(loadRecentNetworkNames(), name);
    recentNamesMemory = list;
    try { window.localStorage.setItem(RECENT_NAMES_KEY, JSON.stringify(list)); } catch (e) { /* kept in memory only */ }
    renderRecentNetworkNames(list);
    return list;
}

/** Fill the dropdown under the Network Name box. */
function renderRecentNetworkNames(list = loadRecentNetworkNames()) {
    const datalist = document.getElementById('recentNetworkNames');
    if (!datalist) return;
    datalist.innerHTML = '';
    for (const name of list) {
        const option = document.createElement('option');
        option.value = name;
        datalist.appendChild(option);
    }
}

// Map Reference
let osmMap = null;
const mapLayers = {
    pins: L.layerGroup(),
    geocoded: L.layerGroup(),
    sections: L.layerGroup(),
    geometry: L.layerGroup(),
    topology: L.layerGroup()
};

/**
 * Mouse-wheel zoom: one wheel click = one moderate zoom step (half a zoom
 * level, i.e. the map scale changes by about 1.4x), however the mouse,
 * driver and browser report the click. Same approach as the 3D-Viewer's
 * fix (TrainGraphViewer.html, commit b57f2fd), for the same reason:
 *  - most mice send one event of about 100 px per click;
 *  - some (e.g. Logitech M240 with some drivers) send a burst of several
 *    ~100 px events per click. Leaflet's own handler adds the burst up,
 *    and splits it into several zooms when it lasts longer than 40 ms, so
 *    one click zoomed 2-4 whole levels (4-16x). Here whole-click events
 *    closer together than WHEEL_BURST_MS count once;
 *  - smooth scrolling and trackpads send many small events: each counts as
 *    a fraction of a step;
 *  - one oversized event (Windows "scroll lines" setting) is capped at one step.
 * Add ?wheeldebug=1 to the page address to log what the wheel sends (F12 console).
 */
const WHEEL_ZOOM_STEP = 0.5;      // zoom levels per wheel click (1 = double/halve the scale)
const WHEEL_PX_PER_STEP = 100;    // pixels that count as one click
const WHEEL_FULL_EVENT_PX = 50;   // events at least this big are whole clicks
const WHEEL_BURST_MS = 60;        // whole-click events closer together than this are one click
const WHEEL_APPLY_DELAY_MS = 30;  // gather small (trackpad) events briefly before zooming
const WHEEL_RESIDUAL_MS = 300;    // a rounding left-over older than this is dropped

function installStepWheelZoom(map) {
    const container = map.getContainer();
    const debug = new URLSearchParams(window.location.search).has('wheeldebug');
    let lastStepTime = -Infinity;
    let lastEventTime = -Infinity;
    let pendingSteps = 0;
    let pendingPoint = null;
    let timer = null;

    const apply = () => {
        timer = null;
        if (pendingSteps === 0) return;
        // Leaflet ignores a new zoom while a zoom animation is running, so
        // quick clicks would be lost: wait for it to finish, then zoom on.
        if (map._animatingZoom) {
            map.once('zoomend', () => { if (!timer) timer = setTimeout(apply, 0); });
            return;
        }
        const steps = pendingSteps;
        const from = map.getZoom();
        const snap = map.options.zoomSnap || 0.25;
        const wanted = from - steps * WHEEL_ZOOM_STEP;   // wheel down (positive) zooms out
        const target = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), Math.round(wanted / snap) * snap));
        // Keep what rounding left over, so small trackpad movements add up
        // (forgotten after a pause, see below); not what the zoom limits cut off.
        const atLimit = target === map.getMinZoom() || target === map.getMaxZoom();
        pendingSteps = atLimit ? 0 : steps - (from - target) / WHEEL_ZOOM_STEP;
        if (debug) console.log(`wheel: ${steps.toFixed(2)} step(s): zoom ${from} -> ${target}`);
        if (target !== from) map.setZoomAround(pendingPoint, target);
    };

    container.addEventListener('wheel', (e) => {
        e.preventDefault();
        // Normalise to pixels (deltaMode 1 = lines, 2 = pages)
        const pixels = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1);
        if (pixels === 0) return;

        let steps;
        if (Math.abs(pixels) >= WHEEL_FULL_EVENT_PX) {
            if (e.timeStamp - lastStepTime < WHEEL_BURST_MS) {
                if (debug) console.log(`wheel: ${pixels.toFixed(1)} px ignored (same click)`);
                return;
            }
            lastStepTime = e.timeStamp;
            steps = Math.sign(pixels);               // one whole step, capped
        } else {
            steps = pixels / WHEEL_PX_PER_STEP;      // fraction of a step
        }
        if (debug) console.log(`wheel: ${pixels.toFixed(1)} px -> ${steps.toFixed(2)} step(s)`);

        // A left-over fraction from an earlier, finished movement is dropped,
        // so a click after a pause is always exactly one step.
        if (!timer && e.timeStamp - lastEventTime > WHEEL_RESIDUAL_MS) pendingSteps = 0;
        lastEventTime = e.timeStamp;
        pendingSteps += steps;
        pendingPoint = map.mouseEventToContainerPoint(e);
        if (!timer) timer = setTimeout(apply, WHEEL_APPLY_DELAY_MS);
    }, { passive: false });
}

/**
 * Initialize Leaflet Map
 */
function initMap() {
    osmMap = L.map('map', {
        // Leaflet's own wheel zoom is replaced by installStepWheelZoom() below.
        scrollWheelZoom: false,
        // Allow quarter zoom levels, so a wheel click can be half a level.
        // The +/- buttons still change a whole level (zoomDelta 1).
        zoomSnap: 0.25,
        zoomDelta: 1
    }).setView([45.5, 9.0], 7); // Center on northern Italy
    installStepWheelZoom(osmMap);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19
    }).addTo(osmMap);

    // Add layer groups
    Object.values(mapLayers).forEach(layer => layer.addTo(osmMap));

    // Click-to-place waypoints: only acts while a waypoint is armed via its 📍 button
    osmMap.on('click', onMapClickForPicking);

    // Expose to global scope for tab switching
    window.osmMap = osmMap;
}

/**
 * Reset all workflow UI and state back to the pristine just-loaded condition.
 * Called at the start of createSession() so "New Session" actually starts
 * fresh, rather than just swapping the session ID while every panel, map
 * layer, and cached result from the previous session stays on screen.
 * Harmless no-op on the very first automatic call at page load, since
 * everything is already in this state then.
 */
function resetWorkflowUI() {
    // Map layers
    Object.values(mapLayers).forEach(layer => layer.clearLayers());

    // Core state (sessionId itself is set separately, right after this runs)
    state.geocodedLocations = [];
    state.availableSections = [];
    state.selectedSections = [];
    state.sectionLayers = {};
    state.searchBboxes = [];
    state.geometryJobId = null;
    state.infrastructureJobId = null;
    state.generatedFiles = [];
    state.waypointCounter = 0;
    state.sectionsCache = new Map();
    state.pins = {};
    state.pinMarkers = {};
    state.pickingWaypointId = null;
    state.outputStamp = null;
    state.infrastructureStamp = null;
    state.seriousProblems = [];
    state.infrastructureSeriousProblems = [];
    state.infrastructureResult = null;

    // Waypoints list back to two empty rows
    document.getElementById('waypointsList').innerHTML = '';
    addWaypoint();
    addWaypoint();

    // Re-lock every panel after the always-open route panel
    ['panel-sections', 'panel-download-geometry', 'panel-infrastructure', 'panel-download'].forEach(id => {
        const panel = document.getElementById(id);
        panel.classList.add('disabled');
        panel.classList.add('collapsed');
    });

    // Resolved waypoints list and the query-sections step it unlocks
    document.getElementById('geocodedSummary').style.display = 'none';
    document.getElementById('geocodedList').innerHTML = '';
    document.getElementById('queryInstructions').style.display = 'none';
    const btnQuerySections = document.getElementById('btnQuerySections');
    btnQuerySections.style.display = 'none';
    btnQuerySections.disabled = true;
    const btnGeocode = document.getElementById('btnGeocode');
    btnGeocode.disabled = false;
    btnGeocode.textContent = 'Resolve Waypoints';

    // Sections panel
    document.getElementById('sectionsResults').style.display = 'none';
    document.getElementById('sectionsResults').innerHTML = '';
    const btnGenGeom = document.getElementById('btnGenerateGeometry');
    btnGenGeom.style.display = 'none';
    btnGenGeom.disabled = true;
    btnGenGeom.classList.remove('btn-loading', 'confirmed');
    btnGenGeom.textContent = 'Confirm routes and generate geometry (this may take a few minutes)';
    document.getElementById('maxGradientGroup').style.display = 'none';

    // Geometry download panel
    document.getElementById('progressGeometry').style.display = 'none';
    document.getElementById('geometryResults').style.display = 'none';
    document.getElementById('geometryResults').innerHTML = '';
    document.getElementById('btnDownloadGeometryZip').disabled = true;
    document.getElementById('btnDownloadGeometryRegions').disabled = true;
    document.getElementById('btnDownloadGeometrySpeedboards').disabled = true;
    document.getElementById('btnDownloadGeometryKml').disabled = true;
    document.getElementById('btnDownloadGeometryBoth').disabled = true;

    // Infrastructure panel
    document.getElementById('inputNetworkName').value = '';
    document.getElementById('progressInfrastructure').style.display = 'none';
    document.getElementById('infrastructureResults').style.display = 'none';
    document.getElementById('infrastructureResults').innerHTML = '';
    const btnGenInfra = document.getElementById('btnGenerateInfrastructure');
    btnGenInfra.disabled = true;
    btnGenInfra.classList.remove('btn-loading', 'confirmed');
    btnGenInfra.textContent = 'Generate Infrastructure';

    // Final download panel
    const btnDownloadAll = document.getElementById('btnDownloadAll');
    btnDownloadAll.disabled = true;
    btnDownloadAll.classList.remove('confirmed');
    btnDownloadAll.textContent = 'Download Infrastructure.csv';
}

/**
 * Create New Session
 */
async function createSession() {
    resetWorkflowUI();
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
 * Add a Waypoint Row (placed by clicking the map — see toggleMapPick)
 */
function addWaypoint() {
    state.waypointCounter++;
    const waypointId = state.waypointCounter;
    const waypointsList = document.getElementById('waypointsList');

    const waypointDiv = document.createElement('div');
    waypointDiv.className = 'waypoint-item';
    waypointDiv.id = `waypoint-${waypointId}`;
    waypointDiv.innerHTML = `
        <div class="form-group">
            <label>Waypoint ${waypointId}</label>
            <div style="display: flex; gap: 8px; align-items: center;">
                <button type="button" class="btn-pin btn-small" id="btnPin${waypointId}" onclick="toggleMapPick(${waypointId})">📍 Place on Map</button>
                <span class="waypoint-status" id="waypointStatus${waypointId}">Not placed</span>
                <button class="btn-secondary btn-small" style="margin-left: auto;" onclick="removeWaypoint(${waypointId})" ${waypointsList.children.length < 2 ? 'disabled' : ''}>Remove</button>
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
        if (state.pickingWaypointId === waypointId) {
            disarmMapPick();
        }
        clearWaypointPin(waypointId);
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
 * Get All Placed Waypoints, in on-screen order: { id, lat, lon }.
 * Rows that haven't been pinned yet are skipped.
 */
function getWaypointDescriptors() {
    const waypointsList = document.getElementById('waypointsList');
    const items = waypointsList.querySelectorAll('.waypoint-item');
    const descriptors = [];

    items.forEach(item => {
        const waypointId = parseInt(item.id.replace('waypoint-', ''), 10);
        const pin = state.pins[waypointId];
        if (pin) {
            descriptors.push({ id: waypointId, lat: pin.lat, lon: pin.lon });
        }
    });

    return descriptors;
}

/**
 * Arm/disarm click-to-place picking for a waypoint.
 * Clicking the 📍 button for a waypoint that's already armed cancels picking;
 * clicking it for a different (or unarmed) waypoint (re)arms it.
 */
function toggleMapPick(waypointId) {
    if (state.pickingWaypointId === waypointId) {
        disarmMapPick();
    } else {
        armMapPick(waypointId);
    }
}
window.toggleMapPick = toggleMapPick;

function armMapPick(waypointId) {
    // Only one waypoint can be armed at a time
    disarmMapPick();

    state.pickingWaypointId = waypointId;

    const btn = document.getElementById(`btnPin${waypointId}`);
    if (btn) btn.classList.add('active');

    const mapEl = document.getElementById('map');
    if (mapEl) mapEl.classList.add('picking');

    const banner = document.getElementById('mapPickBanner');
    const bannerText = document.getElementById('mapPickBannerText');
    if (banner && bannerText) {
        bannerText.textContent = `Click the map to place Waypoint ${waypointId}`;
        banner.style.display = 'flex';
    }
}

function disarmMapPick() {
    if (state.pickingWaypointId !== null) {
        const btn = document.getElementById(`btnPin${state.pickingWaypointId}`);
        if (btn) btn.classList.remove('active');
    }
    state.pickingWaypointId = null;

    const mapEl = document.getElementById('map');
    if (mapEl) mapEl.classList.remove('picking');

    const banner = document.getElementById('mapPickBanner');
    if (banner) banner.style.display = 'none';
}

function onMapClickForPicking(e) {
    if (state.pickingWaypointId === null) return;

    const waypointId = state.pickingWaypointId;
    setWaypointPin(waypointId, e.latlng.lat, e.latlng.lng);
    disarmMapPick();
}

/**
 * Set (or move) the pin for a waypoint: stores the coordinate, drops/updates
 * a draggable marker, and updates that row's status display. Clicking the
 * waypoint's button again re-arms picking, so this also serves as "reposition".
 */
function setWaypointPin(waypointId, lat, lon) {
    state.pins[waypointId] = { lat, lon };

    // Drop or move the marker
    let marker = state.pinMarkers[waypointId];
    if (marker) {
        marker.setLatLng([lat, lon]);
    } else {
        marker = L.marker([lat, lon], {
            draggable: true,
            icon: L.divIcon({
                className: 'waypoint-pin-icon',
                html: `<div class="waypoint-pin-marker">${waypointId}</div>`,
                iconSize: [24, 24],
                iconAnchor: [12, 12]
            })
        });
        marker.on('dragend', () => {
            const pos = marker.getLatLng();
            setWaypointPin(waypointId, pos.lat, pos.lng);
        });
        marker.addTo(mapLayers.pins);
        state.pinMarkers[waypointId] = marker;
    }
    marker.bindPopup(`Waypoint ${waypointId}<br>${lat.toFixed(5)}, ${lon.toFixed(5)}`);

    // Update the row's display
    const waypointDiv = document.getElementById(`waypoint-${waypointId}`);
    const pinBtn = document.getElementById(`btnPin${waypointId}`);
    const status = document.getElementById(`waypointStatus${waypointId}`);

    if (waypointDiv) waypointDiv.classList.add('pinned');
    if (pinBtn) {
        pinBtn.classList.add('pinned');
        pinBtn.textContent = '🔄 Re-place';
    }
    if (status) {
        status.textContent = `📍 ${lat.toFixed(5)}, ${lon.toFixed(5)} — drag to fine-tune`;
    }
}

/**
 * Remove just the interim pin marker from the map (keeps state.pins intact).
 * Used once a pinned waypoint has been folded into the final resolved-waypoint
 * list, whose own marker takes over showing that location.
 */
function clearPinMarkerVisual(waypointId) {
    const marker = state.pinMarkers[waypointId];
    if (marker) {
        mapLayers.pins.removeLayer(marker);
        delete state.pinMarkers[waypointId];
    }
}

/**
 * Fully clear a waypoint's pin (state + marker + row display). Used when a
 * waypoint row is removed entirely.
 */
function clearWaypointPin(waypointId) {
    if (!state.pins[waypointId]) return;
    delete state.pins[waypointId];
    clearPinMarkerVisual(waypointId);
}

/**
 * Resolve Waypoints — every waypoint's coordinates are already known (it was
 * placed by clicking the map); this just gives each one a display name via
 * reverse geocoding, one at a time, showing results as they arrive. Then
 * builds and draws the search bounding boxes so they're visible immediately,
 * before the (slower) OSM section query runs.
 */
async function resolveWaypoints() {
    const waypoints = getWaypointDescriptors();

    if (waypoints.length < 2) {
        alert('Please place at least 2 waypoints on the map (click 📍 next to a waypoint, then click the map)');
        return;
    }

    if (!state.sessionId) {
        alert('Please create a session first');
        return;
    }

    const btn = document.getElementById('btnGeocode');
    btn.disabled = true;
    btn.textContent = 'Resolving...';

    const summaryDiv = document.getElementById('geocodedSummary');
    const listDiv = document.getElementById('geocodedList');
    summaryDiv.style.display = 'block';

    state.geocodedLocations = [];
    // The first waypoint resets the session's geocodedPlaces list; the rest
    // append, so array position stays aligned with true waypoint order.
    let sessionWriteCount = 0;

    for (let i = 0; i < waypoints.length; i++) {
        const waypoint = waypoints[i];

        // Coordinates are already known — just get it a display name.
        // Best-effort: a slow/failed reverse geocode falls back to a
        // generic label rather than blocking Resolve.
        let label = `Waypoint ${i + 1}`;
        let displayName = `Pinned at ${waypoint.lat.toFixed(5)}, ${waypoint.lon.toFixed(5)}`;

        try {
            // Timeout is deliberately longer than the server's own 7s Nominatim
            // timeout: the server always resolves with a fallback-labeled 200
            // (never leaves the session write undone), so this only needs to
            // outlast that worst case rather than race it.
            const response = await fetchWithTimeout(`${API_BASE}/geography/reverse-geocode`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId: state.sessionId,
                    lat: waypoint.lat,
                    lon: waypoint.lon,
                    appendToSession: sessionWriteCount > 0
                })
            }, 12000);
            sessionWriteCount++;

            if (response.ok) {
                const data = await response.json();
                label = data.result.place;
                displayName = data.result.displayName;
            }
        } catch (error) {
            console.warn(`Reverse geocoding failed for waypoint ${i + 1}:`, error);
        }

        state.geocodedLocations.push({
            name: label,
            lat: waypoint.lat,
            lon: waypoint.lon,
            displayName
        });
        clearPinMarkerVisual(waypoint.id); // final marker replaces the interim pin marker
        drawGeocodedLocations(state.geocodedLocations);

        listDiv.innerHTML = renderGeocodedList(state.geocodedLocations,
            i < waypoints.length - 1 ? `Resolving Waypoint ${i + 2} of ${waypoints.length}...` : null);
    }

    btn.disabled = false;
    btn.textContent = 'Resolve Waypoints';

    // Show the search bounding boxes right away, before the (slower) OSM query
    buildAndDrawBboxes();

    // Show query instructions and button
    document.getElementById('queryInstructions').style.display = 'block';
    const btnQuerySections = document.getElementById('btnQuerySections');
    btnQuerySections.style.display = 'block';
    btnQuerySections.disabled = false;
    setTimeout(() => btnQuerySections.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100);
}

/**
 * Build a bounding box between each consecutive pair of resolved waypoints,
 * store it for the section query to reuse, and draw it on the map. Tight
 * (no margin) - a box doesn't need to enclose the whole line, only touch it.
 */
function buildAndDrawBboxes() {
    const bboxes = [];
    for (let i = 0; i < state.geocodedLocations.length - 1; i++) {
        const locA = state.geocodedLocations[i];
        const locB = state.geocodedLocations[i + 1];
        bboxes.push({
            minLat: Math.min(locA.lat, locB.lat),
            minLon: Math.min(locA.lon, locB.lon),
            maxLat: Math.max(locA.lat, locB.lat),
            maxLon: Math.max(locA.lon, locB.lon)
        });
    }
    state.searchBboxes = bboxes;
    drawSections([]); // draws just the box outlines; results are added later
    return bboxes;
}

/**
 * Render the resolved-waypoints list HTML (used for incremental updates)
 */
function renderGeocodedList(locations, pendingMsg) {
    let html = '';
    locations.forEach((loc, index) => {
        html += `
            <div class="result-item" style="margin-bottom:12px;padding:8px;background:rgba(67,160,71,0.1);border-left:3px solid #43a047;border-radius:3px;">
                <strong style="color:#43a047;">${index + 1}. ${escapeHtml(loc.name)}</strong><br>
                <span style="font-size:11px;color:#ccc;display:block;margin-top:4px;">${escapeHtml(loc.displayName)}</span>
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
        const marker = L.circleMarker([loc.lat, loc.lon], {
            radius: 8,
            fillColor: '#43a047',
            color: '#fff',
            weight: 2,
            opacity: 1,
            fillOpacity: 0.8
        });

        // Names come from OpenStreetMap / the geocoder: escaped (popup is HTML).
        marker.bindPopup(`<strong>${escapeHtml(loc.name)}</strong><br>${escapeHtml(loc.displayName)}`);
        marker.addTo(mapLayers.geocoded);

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
        setButtonBusy(btn, 'Querying OSM...');

        const resultsDiv = document.getElementById('sectionsResults');
        resultsDiv.style.display = 'block';
        resultsDiv.innerHTML = '<p>Querying OpenStreetMap for railway sections...</p>';

        // Bounding boxes were already built and drawn by Resolve Waypoints;
        // just reuse them here.
        const bboxes = state.searchBboxes || [];

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
        // Default to all sections selected/visible — the user prunes down from
        // there, rather than building up from nothing.
        state.selectedSections = data.sections.map((_, i) => i);

        // If Overpass failed with no sections, show the error in the results div.
        // Step 2 stays disabled (nothing to select) so the user retries from Step 1,
        // but it must still be expanded — displaySections() writes the warning into
        // #sectionsResults, which lives inside Step 2's panel-content, and that's
        // hidden by the 'collapsed' class (disabled only dims it, doesn't hide it).
        // Without this the failure message was rendered invisibly off-screen.
        if (data.overpassFailures && data.sections.length === 0) {
            displaySections([]);
            document.getElementById('panel-sections').classList.remove('collapsed');
            clearButtonBusy(btn, 'Query OSM Sections (this may take a few minutes)');
            return;
        }

        // Enable Step 2 and display sections
        enablePanel('panel-sections');
        displaySections(state.availableSections);
        drawSections(state.availableSections);

        clearButtonBusy(btn, 'Query OSM Sections (this may take a few minutes)');
        document.getElementById('btnGenerateGeometry').style.display = 'block';
        document.getElementById('maxGradientGroup').style.display = 'block';

    } catch (error) {
        console.error('Section query error:', error);
        alert(`Section query failed: ${error.message}`);

        const btn = document.getElementById('btnQuerySections');
        clearButtonBusy(btn, 'Query OSM Sections (this may take a few minutes)');
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
            : '<p class="warning">No railway sections found in the specified areas. Try adjusting your waypoint positions, or check that OpenStreetMap has rail data for this area.</p>';
        // resultsDiv starts as display:none in the HTML; only the success path
        // below used to clear that, so this message was written invisibly.
        resultsDiv.style.display = 'block';
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
                    <strong>${escapeHtml(section.name || 'Unnamed section')}</strong>
                </label>
                <div class="section-details">
                    <span>Type: ${escapeHtml(section.type || 'railway')}</span>
                    ${section.operator ? ` | Operator: ${escapeHtml(section.operator)}` : ''}
                    ${section.ref ? ` | Ref: ${escapeHtml(section.ref)}` : ''}
                    <br><span class="osm-id">OSM ${escapeHtml(section.osmType)} ${escapeHtml(section.osmId)}</span>
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

            // Same checkbox drives map visibility — no separate toggle needed
            const layer = state.sectionLayers && state.sectionLayers[index];
            if (layer) {
                if (this.checked) {
                    mapLayers.sections.addLayer(layer);
                } else {
                    mapLayers.sections.removeLayer(layer);
                }
            }
        });
    });

    // Enable generate button if sections selected
    document.getElementById('btnGenerateGeometry').disabled = state.selectedSections.length === 0;
}

// Cycled per candidate section so overlapping relations stay visually
// separable before the user has pruned the list down. Distinct from the
// colors used for pinned/resolved waypoints, alt routes, the confirmed
// centerline, and the corridor buffer, since a user may see both at once.
const SECTION_PREVIEW_COLORS = [
    '#e53935', '#fb8c00', '#fdd835', '#7cb342', '#00897b',
    '#039be5', '#5e35b1', '#d81b60', '#6d4c41', '#546e7a'
];

/**
 * Draw Sections on Map — search bboxes as dashed blue rectangles, plus each
 * candidate relation as its own colored line (toggled by its checkbox in
 * the results list, hoverable to see which relation it is).
 */
function drawSections(sections) {
    mapLayers.sections.clearLayers();
    state.sectionLayers = {};

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

    // Draw each candidate section as its own colored, hoverable line group.
    // Iterate in reverse so earlier entries in the list end up layered on
    // top: Leaflet stacks later-added layers above earlier ones, so with
    // many overlapping relations, drawing in list order buried each section
    // under every later one — toggling an earlier entry off gave no visible
    // change if a later, still-visible section covered the same path.
    for (let index = sections.length - 1; index >= 0; index--) {
        const section = sections[index];
        const color = SECTION_PREVIEW_COLORS[index % SECTION_PREVIEW_COLORS.length];
        const name = section.name || 'Unnamed section';
        const group = L.layerGroup();

        (section.geometry || []).forEach(coords => {
            if (!coords || coords.length < 2) return;
            const poly = L.polyline(coords, { color, weight: 4, opacity: 0.85 });
            // OSM names are not trusted HTML (Leaflet tooltips are HTML).
            poly.bindTooltip(escapeHtml(name), { sticky: true });
            poly.addTo(group);
        });

        state.sectionLayers[index] = group;
        if (state.selectedSections.includes(index)) {
            mapLayers.sections.addLayer(group);
        }
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
            rect.bindPopup(`<strong>Corridor</strong><br>${escapeHtml(name)}`);
            rect.addTo(mapLayers.sections);
        });

        // ── Geometry centerlines + alternates ────────────────────────────────
        mapLayers.geometry.clearLayers();
        (data.geometryLines || []).forEach(line => {
            const poly = L.polyline(line.coords, {
                // Deep pink for the confirmed centerline — OSM's base tiles use
                // orange/tan heavily for road rendering, which made the previous
                // #ff9800 line blend in almost completely.
                // Alt routes share the same weight now (were too faint at 2px/0.7
                // opacity to notice); the dash pattern is what keeps them visually
                // distinct from the confirmed line, not thinness.
                color: line.isAlt ? '#ab47bc' : '#ff1493',
                weight: 4,
                opacity: line.isAlt ? 0.85 : 0.9,
                dashArray: line.isAlt ? '4, 4' : null
            });
            poly.bindPopup(`<strong>${escapeHtml(line.label)}</strong><br>${line.coords.length} points`);
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
                .map(([k, v]) => `${escapeHtml(k)}=${escapeHtml(v)}`)
                .join('<br>');
            poly.bindPopup(`<strong>Way ${escapeHtml(w.id)}</strong><br>${tagInfo || 'no tags'}`);
            poly.addTo(mapLayers.topology);
        });

        // ── Corridor buffer polygons (indigo, ~1km buffer around centerline) ───
        // Was green — too easily mistaken for a natural-feature boundary (e.g.
        // a park/reserve) on the base map, and too close to other green UI
        // elements (resolved-waypoint markers). Indigo doesn't occur naturally
        // in OSM's base tile palette, so it reads clearly as app UI.
        (data.corridorPolygons || []).forEach((polygon, i) => {
            if (polygon.length < 3) return;
            const poly = L.polygon(polygon, {
                color: '#3f51b5',
                weight: 2.5,
                fillOpacity: 0.12,
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

    const maxGradientPercent = parseFloat(document.getElementById('inputMaxGradient').value);
    if (!Number.isFinite(maxGradientPercent) || maxGradientPercent < 1 || maxGradientPercent > 6) {
        alert('The maximum gradient must be between 1% and 6% (default 2.5%; steeper than 2.5% is unusual, so set it deliberately).');
        return;
    }

    const btn = document.getElementById('btnGenerateGeometry');
    setButtonBusy(btn, 'Confirming sections…');

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
        setButtonBusy(btn, 'Starting generation…');
        const spacing = parseInt(document.getElementById('inputSpacing').value);
        const response = await fetch(`${API_BASE}/geometry/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: state.sessionId, spacingMetres: spacing, maxGradientPercent })
        });
        if (!response.ok) {
            let message = `Geometry generation failed: ${response.status}`;
            try { const body = await response.json(); if (body && body.error) message = body.error; } catch (e) { /* not JSON */ }
            throw new Error(message);
        }

        const data = await response.json();
        state.geometryJobId = data.jobId;

        // Stays busy for the whole job — the progress bar below shows detail,
        // this keeps the button itself visibly "working" throughout.
        setButtonBusy(btn, 'Generating geometry…');
        document.getElementById('progressGeometry').style.display = 'block';
        document.getElementById('geometryResults').style.display = 'none';
        pollGeometryJob();

    } catch (error) {
        console.error('Geometry generation error:', error);
        alert(`Geometry generation failed: ${error.message}`);
        clearButtonBusy(btn, 'Confirm routes and generate geometry (this may take a few minutes)');
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
            // The job itself only fails on an unexpected exception — an Overpass
            // failure on every segment still comes back as "completed" with each
            // segment's error recorded individually (see routes/geometry.js).
            // Treat "completed but nothing actually succeeded" as a failure so
            // the button stays retryable, instead of locking in a false
            // "Geometry Generated ✓" state.
            const segmentResults = (job.result && job.result.results) || [];
            const anySucceeded = segmentResults.some(r => !r.error);

            document.getElementById('progressGeometry').style.display = 'none';
            displayGeometryResults(job.result);

            if (!anySucceeded && segmentResults.length > 0) {
                const btn = document.getElementById('btnGenerateGeometry');
                clearButtonBusy(btn, 'Confirm routes and generate geometry (this may take a few minutes)');
                return;
            }

            // Enable Download Geometry panel
            enablePanel('panel-download-geometry');
            document.getElementById('btnDownloadGeometryZip').disabled = false;
            document.getElementById('btnDownloadGeometryRegions').disabled = false;
            document.getElementById('btnDownloadGeometrySpeedboards').disabled = false;
            document.getElementById('btnDownloadGeometryKml').disabled = false;
            document.getElementById('btnDownloadGeometryBoth').disabled = false;

            // Unlock step 4 so the user can proceed without having to download first.
            // Pass false so step 3 stays open and is not auto-collapsed.
            // Button stays disabled until user types a network name.
            enablePanel('panel-infrastructure', false);
            document.getElementById('btnGenerateInfrastructure').disabled = true;

            // Results report is shown by displayGeometryResults() at top of step 3

            const btn = document.getElementById('btnGenerateGeometry');
            btn.disabled = false;
            btn.classList.remove('btn-loading');
            btn.textContent = 'Geometry Generated ✓';
            btn.classList.add('confirmed');

            // Draw overlays on map (bboxes, centerlines, topology ways)
            fetchAndDrawOverlays();

        } else if (job.status === 'failed') {
            // Job failed
            document.getElementById('progressGeometry').style.display = 'none';
            alert(`Geometry generation failed: ${job.error}`);

            const btn = document.getElementById('btnGenerateGeometry');
            clearButtonBusy(btn, 'Confirm routes and generate geometry (this may take a few minutes)');

        } else {
            // Still in progress - poll again
            setTimeout(pollGeometryJob, POLL_INTERVAL);
        }

    } catch (error) {
        console.error('Job polling error:', error);
        document.getElementById('progressTextGeometry').textContent = `Error: ${error.message}`;

        const btn = document.getElementById('btnGenerateGeometry');
        clearButtonBusy(btn, 'Confirm routes and generate geometry (this may take a few minutes)');
    }
}

/**
 * Display Geometry Results — structured post-generation report
 */
function displayGeometryResults(result) {
    const resultsDiv = document.getElementById('geometryResults');
    resultsDiv.style.display = 'block';

    // Kept for the download names and for repeating the problems at Step 5.
    state.outputStamp = result.outputStamp || null;
    state.seriousProblems = result.seriousProblems || [];

    const succeeded = (result.results || []).filter(r => !r.error);
    const failed    = (result.results || []).filter(r =>  r.error);

    // Every section's warnings, grouped by the server (serious / check these
    // / information). An older server sends no groups: then all are shown.
    const fallbackWarnings = [];
    for (const r of succeeded) {
        for (const w of (r.warnings || [])) {
            if (!/topology json saved/i.test(w)) fallbackWarnings.push(`${r.section}: ${w}`);
        }
    }

    // Serious problems first, in full (e.g. no elevation data at all).
    let html = seriousProblemsHtml(state.seriousProblems);

    // ── Succeeded ──────────────────────────────────────────────────────────
    if (succeeded.length > 0) {
        html += `<p class="success"><strong>✓ Generated (${succeeded.length} section${succeeded.length > 1 ? 's' : ''}):</strong></p><ul>`;
        for (const r of succeeded) {
            const altNote = r.alternativeCount > 0
                ? ` <span style="color:#aaa;font-size:0.9em;">+ ${r.alternativeCount} alt route${r.alternativeCount > 1 ? 's' : ''}</span>`
                : '';
            html += `<li>${escapeHtml(r.section)}: ${r.pointCount} points (${r.lengthKm.toFixed(2)} km)${altNote}</li>`;
        }
        html += '</ul>';
    }

    // ── Failed ─────────────────────────────────────────────────────────────
    if (failed.length > 0) {
        html += `<p class="warning"><strong>✗ Failed (${failed.length} section${failed.length > 1 ? 's' : ''}):</strong></p><ul>`;
        for (const r of failed) {
            html += `<li class="error">${escapeHtml(r.section)}: ${escapeHtml(r.error)}</li>`;
        }
        html += `<p style="color:#e57373;font-size:11px;">These sections produced no geometry file. ` +
                `You can retry the whole process after a short break to allow OSM query limits to reset.</p>`;
    }

    // ── Warnings: serious and "check these" in full, information on request ──
    html += warningGroupsHtml(result.warningGroups, fallbackWarnings);
    if (result.warningGroups && (result.warningGroups.serious || []).some(w => /overpass|query fail|osm api|time ?out|rate.limit/i.test(w))) {
        html += `<p style="color:#aaa;font-size:11px;">Some OpenStreetMap queries failed but the section was still generated using available data. ` +
                `Geometry may be incomplete. If the result looks wrong, retry after a short break.</p>`;
    }

    // ── Speedboards.csv (October 2026) ────────────────────────────────────
    // No speed data is flagged prominently (the file is still valid, with no
    // speedboards); otherwise its notes are listed like the Regions notice.
    const sb = result.speedboards;
    if (sb && sb.noSpeedData) {
        html += `<p class="warning" style="margin-top:10px"><strong>⚠ Speedboards.csv: no speed data found</strong></p>` +
                `<p style="color:#ffb74d;font-size:11px;">${escapeHtml((sb.warnings && sb.warnings[0]) || 'No speed data was found in OpenStreetMap. Speeds can still be managed with Auto-Curve Speed Limiting in the settings.')}</p>`;
    } else if (sb && Array.isArray(sb.warnings) && sb.warnings.length > 0) {
        html += `<p style="margin-top:10px"><strong>Speedboards.csv:</strong></p><ul>` +
                sb.warnings.map(w => `<li style="font-size:11px;">${escapeHtml(w)}</li>`).join('') + '</ul>';
    }

    // ── Regions.csv defaults notice ───────────────────────────────────────
    if (result.regionsWarning) {
        html += `<p class="warning" style="margin-top:10px"><strong>⚠ Regions.csv:</strong></p>` +
                `<p style="color:#ffb74d;font-size:11px;">${escapeHtml(result.regionsWarning)}</p>`;
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
 * Download Regions.csv
 */
async function downloadRegionsCsv() {
    return downloadSessionCsv('Regions.csv', 'btnDownloadGeometryRegions');
}

/**
 * Download Speedboards.csv (made by the geometry step, beside Regions.csv)
 */
async function downloadSpeedboardsCsv() {
    return downloadSessionCsv('Speedboards.csv', 'btnDownloadGeometrySpeedboards');
}

/**
 * Download one CSV from the session folder, with the geometry run's stamp.
 */
async function downloadSessionCsv(fileName, buttonId) {
    const btn = document.getElementById(buttonId);
    try {
        btn.disabled = true;
        btn.textContent = 'Downloading...';

        const response = await fetch(`${API_BASE}/sessions/files/${state.sessionId}/${fileName}`);
        if (!response.ok) throw new Error(`Download failed: ${response.status}`);

        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = stampedFileName(fileName);
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);

        btn.disabled = false;
        btn.textContent = `Download ${fileName}`;
    } catch (error) {
        console.error('Download error:', error);
        alert('Download failed: ' + error.message);
        btn.disabled = false;
        btn.textContent = `Download ${fileName}`;
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
                // The geometry ZIP has a Geometry/ folder: name the route after the file only.
                const sectionName = filename.split('/').pop().replace('.csv', '').replace(/_/g, ' ');
                
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
            altitudeMode: 'auto' // smoothed heights (absolute); a route with no elevation data is clamped to the ground
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
        a.download = state.outputStamp ? stampedFileName('Geometry.kmz') : `traxim-geometry-${state.sessionId}.kmz`;
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
 * Download All (Geometry ZIP + Regions.csv + Speedboards.csv + KMZ)
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

        btn.textContent = 'Downloading Regions.csv...';

        // Regions.csv is generated at Step 2 alongside geometry, not part of
        // the geometry ZIP (it lives at the session root, not in geometryDir)
        const regionsResponse = await fetch(`${API_BASE}/sessions/files/${state.sessionId}/Regions.csv`);
        if (!regionsResponse.ok) throw new Error(`Failed to download Regions.csv: ${regionsResponse.status}`);
        const regionsBlob = await regionsResponse.blob();

        // Speedboards.csv, also made by the geometry step. A session from
        // before October 2026 has none: then it is simply left out.
        btn.textContent = 'Downloading Speedboards.csv...';
        const speedboardsResponse = await fetch(`${API_BASE}/sessions/files/${state.sessionId}/Speedboards.csv`);
        const speedboardsBlob = speedboardsResponse.ok ? await speedboardsResponse.blob() : null;

        btn.textContent = 'Reading CSV files...';
        
        // Extract and process CSV files using JSZip
        const zip = await JSZip.loadAsync(zipBlob);
        const geometryDict = {};
        
        for (const [filename, file] of Object.entries(zip.files)) {
            if (filename.endsWith('.csv') && !filename.includes('wayids')) {
                const csvContent = await file.async('text');
                // The geometry ZIP has a Geometry/ folder: name the route after the file only.
                const sectionName = filename.split('/').pop().replace('.csv', '').replace(/_/g, ' ');
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
            altitudeMode: 'auto' // smoothed heights (absolute); a route with no elevation data is clamped to the ground
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
        zipLink.download = state.outputStamp ? stampedFileName('Geometry.zip') : `traxim-geometry-${state.sessionId}.zip`;
        document.body.appendChild(zipLink);
        zipLink.click();
        document.body.removeChild(zipLink);
        URL.revokeObjectURL(zipUrl);

        // Stagger each subsequent download — browsers can block multiple
        // simultaneous downloads triggered in the same tick.
        setTimeout(() => {
            const regionsUrl = URL.createObjectURL(regionsBlob);
            const regionsLink = document.createElement('a');
            regionsLink.href = regionsUrl;
            regionsLink.download = stampedFileName('Regions.csv');
            document.body.appendChild(regionsLink);
            regionsLink.click();
            document.body.removeChild(regionsLink);
            URL.revokeObjectURL(regionsUrl);
        }, 500);

        if (speedboardsBlob) {
            setTimeout(() => {
                const sbUrl = URL.createObjectURL(speedboardsBlob);
                const sbLink = document.createElement('a');
                sbLink.href = sbUrl;
                sbLink.download = stampedFileName('Speedboards.csv');
                document.body.appendChild(sbLink);
                sbLink.click();
                document.body.removeChild(sbLink);
                URL.revokeObjectURL(sbUrl);
            }, 750);
        }

        setTimeout(() => {
            const kmzUrl = URL.createObjectURL(kmzBlob);
            const kmzLink = document.createElement('a');
            kmzLink.href = kmzUrl;
            kmzLink.download = state.outputStamp ? stampedFileName('Geometry.kmz') : `traxim-geometry-${state.sessionId}.kmz`;
            document.body.appendChild(kmzLink);
            kmzLink.click();
            document.body.removeChild(kmzLink);
            URL.revokeObjectURL(kmzUrl);
        }, 1000);

        btn.disabled = false;
        btn.textContent = 'Download All (ZIP + Regions + Speedboards + KMZ)';

        console.log(`Generated all formats with ${Object.keys(geometryDict).length} sections`);
    } catch (error) {
        console.error('Download error:', error);
        alert('Download failed: ' + error.message);

        const btn = document.getElementById('btnDownloadGeometryBoth');
        btn.disabled = false;
        btn.textContent = 'Download All (ZIP + Regions + Speedboards + KMZ)';
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

        const typedName = document.getElementById('inputNetworkName').value.trim();
        const networkName = typedName || 'Railway Network';
        if (typedName) rememberNetworkName(typedName);

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
            state.infrastructureStamp = (job.result && job.result.infrastructureStamp) || null;
            displayInfrastructureResults(job.result);
            state.infrastructureSeriousProblems = (job.result && job.result.seriousProblems) || [];
            
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
    // Step 4 collapses as soon as Step 5 opens, so the details and warnings
    // are shown with the download (Step 5), as the geometry's are with its
    // download at Step 3. Step 4 keeps only a short line for when it is
    // reopened.
    state.infrastructureResult = result || {};
    const resultsDiv = document.getElementById('infrastructureResults');
    resultsDiv.style.display = 'block';
    resultsDiv.innerHTML = '<p class="success"><strong>Infrastructure generated.</strong> Details and warnings are in Step 5 (Download Infrastructure).</p>';
}

/**
 * Update Download Summary
 */
function updateDownloadSummary() {
    const summaryDiv = document.getElementById('downloadSummary');
    summaryDiv.style.display = 'block';
    const result = state.infrastructureResult || {};

    // Only Infrastructure's own problems and warnings here. The geometry's
    // (e.g. no elevation data) are shown with the geometry results at Step 3
    // and do not affect Infrastructure, which does not use elevation.
    const groups = result.warningGroups;
    let html = (groups && groups.serious && groups.serious.length > 0)
        ? '' : seriousProblemsHtml(state.infrastructureSeriousProblems);
    html += '<p class="success"><strong>Infrastructure generated successfully:</strong></p>';
    html += '<ul>';
    if (result.nodeCount !== undefined) html += `<li>Nodes: ${result.nodeCount}</li>`;
    if (result.connectionCount !== undefined) html += `<li>Connections: ${result.connectionCount}</li>`;
    html += `<li>File: ${escapeHtml(stampedFileName('Infrastructure.csv', state.infrastructureStamp))}</li>`;
    html += '</ul>';

    // All warnings that need the user (serious, "check these") in full;
    // information notes in a "show all" list.
    html += warningGroupsHtml(groups, result.warnings || []);

    html += `<p>Click below to download${state.infrastructureStamp ? ` (${escapeHtml(stampedFileName('Infrastructure.csv', state.infrastructureStamp))}: the date and time in the name are when this Infrastructure file was generated; the geometry, Regions, Speedboards and KMZ files it was built from carry ${escapeHtml(state.outputStamp || 'their own stamp')})` : ''}.</p>`;
    summaryDiv.innerHTML = html;
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
        a.download = stampedFileName('Infrastructure.csv', state.infrastructureStamp);
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

// ═══════════════════════════════════════════════════════════════════════════
// Agent session view (?session=<id>)
//
// Sessions created by an AI agent (through the Traxim Controller connector)
// can be opened here by their owner. While the agent is waiting for the
// user's choice, the sections can be ticked and unticked to compare them on
// the map (like the normal workflow), and the "Use these sections" button
// records the choice (source "map"; the other way is to tell the agent in
// the chat). Ticking alone records nothing. Once sections are chosen, either
// way, the page only shows the choice. Everything goes through the Traxim
// Controller (/api/agent/generator/...), which checks the normal Traxim login
// cookie and that the session belongs to the logged-in user. Normal use of
// this page needs no login.
// ═══════════════════════════════════════════════════════════════════════════

const CONTROLLER_GENERATOR_API = '/api/agent/generator/sessions';
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// What the session's state means, for the person looking at the page.
const AGENT_VIEW_STATE_TEXT = {
    searching: 'The agent is still looking up the waypoints and searching for railway sections. Reload this page in a minute.',
    search_failed: 'The search for railway sections failed. Ask the agent to try again.',
    awaiting_confirmation: 'Sections found. Choose the sections to include: either here (tick them, then press "Use these sections"), or by telling the agent in the chat which numbered sections you want. If you choose here, go back to your chat afterwards and tell the agent you have chosen: the agent is not told automatically.',
    // The agent cannot be notified from this page (MCP cannot push into the
    // chat): it only sees the choice when the user next writes to it.
    confirmed: "Your choice is recorded. Now go back to your chat and tell the agent you've chosen (for example 'I've chosen the sections on the map'). The agent is not told automatically: it only sees your choice when you next write to it. It will then read your choice back to you before it generates the files.",
    generating: 'The files are being generated. Reload this page later, or ask the agent for progress.',
    ready: 'The files are ready.',
    generation_failed: 'Generation failed. Ask the agent what went wrong.',
    interrupted: 'The File Generator restarted while working on this session. Ask the agent to start again.'
};

const LINK_STYLE = 'color:#64b5f6;text-decoration:underline;';

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Session id from ?session=..., or null. */
function agentSessionIdFromUrl() {
    const value = new URLSearchParams(window.location.search).get('session');
    return value ? value.trim().toLowerCase() : null;
}

/** Leave the view and start an ordinary (no login) session. */
function leaveAgentView() {
    window.location.href = window.location.pathname;
}

function showAgentViewMessage(html) {
    let banner = document.getElementById('agentViewBanner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'agentViewBanner';
        banner.className = 'instruction-box';
        banner.style.marginBottom = '15px';
        const panels = document.querySelector('.control-panels');
        panels.insertBefore(banner, panels.firstChild);
    }
    banner.innerHTML = html +
        '<p><button id="btnLeaveAgentView" class="btn-secondary btn-small">Start a new session of my own (no login needed)</button></p>';
    document.getElementById('btnLeaveAgentView').addEventListener('click', leaveAgentView);
}

async function openAgentSessionView(sessionId) {
    // The normal workflow panels are not used for an agent session.
    ['panel-route', 'panel-sections', 'panel-download-geometry', 'panel-infrastructure', 'panel-download'].forEach(id => {
        const panel = document.getElementById(id);
        panel.classList.add('disabled');
        panel.classList.add('collapsed');
    });
    showSessionStatus('Agent session', 'active');

    if (!SESSION_ID_PATTERN.test(sessionId)) {
        showAgentViewMessage('<p><strong>This link is not valid.</strong> Check it was copied in full.</p>');
        return;
    }

    showAgentViewMessage('<p>Loading the agent session...</p>');
    let response;
    try {
        response = await fetch(`${CONTROLLER_GENERATOR_API}/${sessionId}/view`, { credentials: 'same-origin' });
    } catch (error) {
        showAgentViewMessage(`<p><strong>Could not reach Traxim.</strong> ${escapeHtml(error.message)}</p>`);
        return;
    }

    if (response.status === 401) {
        showAgentViewMessage(
            '<p><strong>Please log in to see this session.</strong></p>' +
            '<p>This session was created by an AI agent for a Traxim account. To view it, ' +
            `<a href="/login.html" target="_blank" rel="noopener" style="${LINK_STYLE}">log in to Traxim</a> (opens in a new tab) ` +
            'with the same account you use with the agent, then come back here and reload this page.</p>' +
            '<p style="font-size:12px;opacity:0.8;">Logging in is only needed to view sessions created with an agent. ' +
            'The File Generator itself needs no login.</p>'
        );
        return;
    }
    if (response.status === 403) {
        showAgentViewMessage('<p><strong>Guest accounts cannot use the File Generator with an agent.</strong> Log in with your own Traxim account.</p>');
        return;
    }
    if (response.status === 404) {
        showAgentViewMessage(
            '<p><strong>Session not found.</strong> It may have expired (sessions are deleted after 24 hours), ' +
            'or it belongs to a different Traxim account than the one you are logged in with.</p>'
        );
        return;
    }
    if (!response.ok) {
        showAgentViewMessage(`<p><strong>Could not load the session</strong> (error ${response.status}). Please try again later.</p>`);
        return;
    }

    const view = await response.json();
    renderAgentSessionView(sessionId, view);
}

/** "Chosen on the map by alice@example.com on 16/10/2026, 09:30" or "Chosen in the chat ...". */
function describeAgentChoice(confirmation) {
    if (!confirmation) return '';
    const when = confirmation.confirmed_at ? ` on ${new Date(confirmation.confirmed_at).toLocaleString()}` : '';
    if (confirmation.source === 'map') {
        return `Chosen on this map page${confirmation.confirmed_by ? ' by ' + confirmation.confirmed_by : ''}${when}.`;
    }
    return `Chosen in the chat with the agent${when}.`;
}

function renderAgentSessionView(sessionId, view) {
    const map = view.map || {};
    const confirmation = view.confirmation || null;
    const chosen = (confirmation && confirmation.section_numbers) || [];
    const sections = view.sections || [];
    // Choosing on the map is only possible while the agent waits for a choice.
    const canChoose = view.state === 'awaiting_confirmation' && sections.length > 0;

    // Waypoints
    // drawGeocodedLocations and drawSections escape the names themselves.
    state.geocodedLocations = (map.waypoints || []).map(w => ({
        name: w.name, lat: w.lat, lon: w.lon, displayName: w.display_name || w.name
    }));
    if (state.geocodedLocations.length > 0) drawGeocodedLocations(state.geocodedLocations);

    // Search boxes and candidate sections. Before a choice: all ticked and
    // drawn, as in the normal workflow; after: the chosen ones only.
    state.searchBboxes = map.search_bboxes || [];
    state.availableSections = map.sections || [];
    state.selectedSections = chosen.length > 0
        ? chosen.map(n => n - 1)
        : state.availableSections.map((_, i) => i);
    drawSections(state.availableSections);

    // Generated geometry, if any
    mapLayers.geometry.clearLayers();
    (map.geometry_lines || []).forEach(line => {
        L.polyline(line.coords, {
            color: line.isAlt ? '#ab47bc' : '#ff1493', weight: 4,
            opacity: line.isAlt ? 0.85 : 0.9, dashArray: line.isAlt ? '4, 4' : null
        }).bindPopup(`<strong>${escapeHtml(line.label)}</strong>`).addTo(mapLayers.geometry);
    });

    const sectionRows = sections.map((s, i) => {
        const isChosen = chosen.includes(s.number);
        const colour = SECTION_PREVIEW_COLORS[i % SECTION_PREVIEW_COLORS.length];
        const swatch = `<span style="display:inline-block;width:14px;height:4px;background:${colour};vertical-align:middle;margin:0 6px 0 2px;"></span>`;
        const details = [s.ref && `ref ${s.ref}`, s.from && s.to && `${s.from} to ${s.to}`, s.operator,
            s.length_km != null && `${s.length_km} km of track mapped`].filter(Boolean).map(escapeHtml).join(' | ');
        const title = `<strong>${s.number}. ${escapeHtml(s.name)}</strong>`;
        const detailHtml = details ? `<br><span style="font-size:11px;">${details}</span>` : '';
        if (canChoose) {
            return '<li class="section-item selected" style="margin-bottom:6px;"><label style="cursor:pointer;">' +
                `<input type="checkbox" class="agent-section-checkbox" data-index="${s.number - 1}" checked> ` +
                `${swatch}${title}</label>${detailHtml}</li>`;
        }
        return `<li style="margin-bottom:6px;${chosen.length && !isChosen ? 'opacity:0.55;' : ''}">` +
            `${title}${isChosen ? ' &#10003; chosen' : ''}${detailHtml}</li>`;
    }).join('');

    const download = view.state === 'ready'
        ? `<p><a class="btn-primary" style="display:inline-block;padding:8px 14px;text-decoration:none;" href="${CONTROLLER_GENERATOR_API}/${sessionId}/download">Download the files (ZIP)</a></p>`
        : '';

    let howTo;
    if (canChoose) {
        howTo = '<p style="font-size:12px;"><strong>Tick or untick sections to compare them on the map</strong> ' +
            '(a ticked section is drawn on top; hover a line to see its name). ' +
            '<strong>Ticking alone does not choose anything:</strong> press <em>Use these sections</em> to record your choice, ' +
            'or tell the agent your choice in the chat instead. ' +
            '<strong>After pressing the button, go back to your chat and tell the agent you have chosen</strong> ' +
            '(the agent is not told automatically).</p>';
    } else if (chosen.length) {
        howTo = `<p style="font-size:12px;"><strong>${escapeHtml(describeAgentChoice(confirmation))}</strong> ` +
            'Lines on the map: the chosen sections. To change the choice, tell the agent in the chat.</p>';
    } else {
        howTo = '<p style="font-size:12px;">Lines on the map: every section found (each in its own colour; hover a line to see its name).</p>';
    }

    const chooseControls = canChoose
        ? '<p style="margin-top:8px;"><button id="btnUseAgentSections" class="btn-primary">Use these sections</button></p>' +
          '<p id="agentChoiceStatus" style="font-size:12px;"></p>'
        : '';

    showAgentViewMessage(
        `<p><strong>Agent session${view.label ? ': ' + escapeHtml(view.label) : ''}</strong></p>` +
        (view.state === 'confirmed'
            ? `<p class="warning"><strong>${escapeHtml(AGENT_VIEW_STATE_TEXT.confirmed)}</strong></p>`
            : `<p>${escapeHtml(AGENT_VIEW_STATE_TEXT[view.state] || '')}</p>`) +
        howTo +
        download +
        (sectionRows ? `<ol style="list-style:none;padding-left:0;margin-top:10px;">${sectionRows}</ol>` : '') +
        chooseControls +
        `<p style="font-size:11px;opacity:0.7;">Session expires ${escapeHtml(new Date(view.expires_at).toLocaleString())}.</p>`
    );

    if (canChoose) wireAgentSectionChoice(sessionId, sections);

    const geometryCoords = (map.geometry_lines || []).flatMap(l => l.coords);
    if (geometryCoords.length > 0) {
        osmMap.fitBounds(geometryCoords, { padding: [30, 30] });
    }
}

/** Checkboxes drive the map (as in the normal workflow); the button records the choice. */
function wireAgentSectionChoice(sessionId, sections) {
    const button = document.getElementById('btnUseAgentSections');
    const status = document.getElementById('agentChoiceStatus');
    const updateButton = () => {
        const n = state.selectedSections.length;
        button.disabled = n === 0;
        button.textContent = n === 0 ? 'Use these sections (tick at least one)' : `Use these ${n} section${n === 1 ? '' : 's'}`;
    };

    document.querySelectorAll('.agent-section-checkbox').forEach(checkbox => {
        checkbox.addEventListener('change', function () {
            const index = parseInt(this.getAttribute('data-index'), 10);
            if (this.checked) {
                if (!state.selectedSections.includes(index)) state.selectedSections.push(index);
            } else {
                state.selectedSections = state.selectedSections.filter(i => i !== index);
            }
            this.closest('li').classList.toggle('selected', this.checked);
            // Same as the normal workflow: a ticked section is added last, so it is drawn on top.
            const layer = state.sectionLayers && state.sectionLayers[index];
            if (layer) {
                if (this.checked) mapLayers.sections.addLayer(layer);
                else mapLayers.sections.removeLayer(layer);
            }
            updateButton();
        });
    });
    updateButton();

    button.addEventListener('click', async () => {
        const numbers = state.selectedSections.map(i => i + 1).sort((a, b) => a - b);
        if (numbers.length === 0) return;
        const names = numbers.map(n => {
            const s = sections.find(x => x.number === n);
            return `${n}. ${s ? s.name : ''}`;
        }).join('\n');
        if (!window.confirm(`Use these ${numbers.length} section(s) for the files?\n\n${names}\n\nAfterwards, go back to your chat and tell the agent you've chosen: it is not told automatically. It will read your choice back to you before it generates the files.`)) {
            return;
        }
        button.disabled = true;
        status.textContent = 'Recording your choice...';
        let response;
        try {
            response = await fetch(`${CONTROLLER_GENERATOR_API}/${sessionId}/choose`, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', 'X-Traxim-Map-Choice': '1' },
                body: JSON.stringify({ section_numbers: numbers })
            });
        } catch (error) {
            status.textContent = `Could not reach Traxim: ${error.message}. Your choice was not recorded; please try again.`;
            updateButton();
            return;
        }
        let data = null;
        try { data = await response.json(); } catch (e) { /* not JSON */ }
        if (response.ok) {
            // Show the recorded choice (the page reloads the session).
            await openAgentSessionView(sessionId);
            return;
        }
        if (response.status === 401) {
            status.textContent = 'You are no longer logged in. Log in to Traxim in another tab, then reload this page. Your choice was not recorded.';
        } else if (response.status === 409) {
            alert((data && data.error) || 'The sections can no longer be chosen here.');
            await openAgentSessionView(sessionId);
            return;
        } else {
            status.textContent = `${(data && data.error) || `Error ${response.status}`}. Your choice was not recorded.`;
        }
        updateButton();
    });
}

/**
 * Initialize Event Listeners
 */
document.addEventListener('DOMContentLoaded', function() {
    // Initialize map
    initMap();

    // Initialize with 2 empty waypoint rows
    addWaypoint();
    addWaypoint();

    // Session management
    document.getElementById('btnNewSession').addEventListener('click', createSession);

    // Waypoint management
    document.getElementById('btnAddWaypoint').addEventListener('click', addWaypoint);

    // Workflow steps
    document.getElementById('btnGeocode').addEventListener('click', resolveWaypoints);
    document.getElementById('btnCancelPick').addEventListener('click', disarmMapPick);
    document.getElementById('btnQuerySections').addEventListener('click', querySections);
    document.getElementById('btnGenerateGeometry').addEventListener('click', generateGeometry);
    document.getElementById('btnDownloadGeometryZip').addEventListener('click', downloadGeometryZip);
    document.getElementById('btnDownloadGeometryRegions').addEventListener('click', downloadRegionsCsv);
    document.getElementById('btnDownloadGeometrySpeedboards').addEventListener('click', downloadSpeedboardsCsv);
    document.getElementById('btnDownloadGeometryKml').addEventListener('click', downloadGeometryKml);
    document.getElementById('btnDownloadGeometryBoth').addEventListener('click', downloadGeometryBoth);
    document.getElementById('btnGenerateInfrastructure').addEventListener('click', generateInfrastructure);
    renderRecentNetworkNames();
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

    // A link from an AI agent (?session=<id>) opens that session read-only;
    // otherwise auto-create an ordinary session on load, as always.
    const agentSessionId = agentSessionIdFromUrl();
    if (agentSessionId) {
        document.getElementById('btnNewSession').addEventListener('click', leaveAgentView, true);
        document.getElementById('btnNewSession').removeEventListener('click', createSession);
        openAgentSessionView(agentSessionId);
    } else {
        createSession();
    }
});
