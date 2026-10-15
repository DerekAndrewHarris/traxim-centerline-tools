/**
 * Agent sessions: the File Generator workflow driven by an AI agent through
 * the Traxim Controller's MCP connector (decided 15 Oct 2026).
 *
 *   1. createAgentSession   waypoints -> background job: resolve waypoints,
 *                           work out the search boxes, find the sections
 *   2. getAgentSessionState the numbered section list (and later progress)
 *   3. confirmAgentSections the USER's choice, made in the chat, recorded
 *   4. startAgentGeneration one combined job: geometry, then infrastructure
 *                           (Regions.csv is written by the geometry step)
 *   5. getAgentJobStatus    progress; outputs list when done
 *   6. streamAgentOutputs   outputs-only ZIP (Infrastructure, Regions, Geometry/)
 *
 * Every function takes the caller's user id (from the Controller, see
 * utils/internalAuth.js) and only ever touches that user's own sessions:
 * anything else answers 404 "not found", exactly like a missing session.
 *
 * The network-facing pieces are in `deps` so tests can replace them.
 */

import path from 'path';
import fsSync from 'fs';
import archiver from 'archiver';
import jobQueue from '../../utils/jobQueue.js';
import {
  createSession,
  deleteSession,
  getTempFilesDir,
  isValidSessionId,
  listSessionIdsSync,
  readSessionMetadataSync,
  updateAgentMetadataSync,
  updateSessionMetadata
} from '../../utils/tempFiles.js';
import { geocodePlace, reverseGeocodePlace } from '../osm/geocoding.js';
import { queryRailwaySections } from '../osm/sections.js';
import { isGeometryCsvFile } from '../regions/generator.js';
import {
  buildGeometrySegments,
  enrichConfirmedSections,
  mergeSearchBboxes,
  readMapOverlays,
  runGeometryGeneration,
  runInfrastructureGeneration
} from '../generation/pipeline.js';
import { computeSearchBboxes } from './searchBoxes.js';
import { legLabels, summariseSections, shortenWarnings, summariseGeometry } from './sectionSummary.js';
import { agentLimits, generationStarts, sessionCreations } from './limits.js';

/** Replaceable in tests (no network, no real generation). */
export const deps = {
  geocodePlace,
  reverseGeocodePlace,
  queryRailwaySections,
  runGeometryGeneration,
  runInfrastructureGeneration,
  // Nominatim's usage policy allows about one request per second.
  pauseBetweenWaypointsMs: 1100,
  sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms))
};

export class AgentError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

const NOT_FOUND = 'Session not found, or it has expired (sessions are deleted after 24 hours).';
const SPACING_DEFAULT = 25;
const SPACING_MIN = 10;
const SPACING_MAX = 100;
const MAX_LABEL = 100;
const MAX_PLACE = 200;
const MAX_USER_REPLY = 1000;

// ── Helpers ─────────────────────────────────────────────────────────────────

function sessionPathOf(sessionId) {
  return path.join(getTempFilesDir(), sessionId);
}

function isExpired(meta) {
  return meta && meta.expiresAt && new Date(meta.expiresAt).getTime() < Date.now();
}

/** The session's metadata if it exists, has not expired and belongs to the user; otherwise 404. */
function ownedSession(userId, sessionId) {
  if (!isValidSessionId(sessionId)) throw new AgentError(NOT_FOUND, 404);
  const meta = readSessionMetadataSync(sessionId);
  if (!meta || !meta.agent || meta.agent.ownerId !== userId || isExpired(meta)) {
    throw new AgentError(NOT_FOUND, 404);
  }
  return meta;
}

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  // No control characters; single line; trimmed and capped.
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

function jobStatusName(status) {
  return status === 'pending' ? 'queued' : status === 'in_progress' ? 'running' : status;
}

function checkActiveJobs(userId) {
  const { maxActiveJobsPerUser } = agentLimits();
  if (jobQueue.countActiveForOwner(userId) >= maxActiveJobsPerUser) {
    throw new AgentError(
      `You already have ${maxActiveJobsPerUser} File Generator job(s) waiting or running. ` +
      `Wait for one to finish (check it with generator_get_job_status or generator_get_session), then try again.`,
      429
    );
  }
}

/**
 * Where a session is in the workflow.
 *   searching | search_failed | awaiting_confirmation | confirmed |
 *   generating | ready | generation_failed | interrupted
 * 'interrupted' means a job was recorded as waiting/running but the service
 * no longer has it (the File Generator restarted: its job list is in memory).
 */
export function deriveState(meta) {
  const agent = meta.agent || {};
  const gen = agent.generation;
  if (gen) {
    if (gen.status === 'queued' || gen.status === 'running') {
      return jobQueue.getJob(gen.jobId) ? 'generating' : 'interrupted';
    }
    if (gen.status === 'completed') return 'ready';
    if (gen.status === 'failed') return 'generation_failed';
  }
  const search = agent.search || {};
  if (search.status === 'queued' || search.status === 'running') {
    return jobQueue.getJob(search.jobId) ? 'searching' : 'interrupted';
  }
  if (search.status === 'failed') return 'search_failed';
  if (agent.confirmation) return 'confirmed';
  return 'awaiting_confirmation';
}

const STATE_EXPLANATIONS = {
  searching: 'Finding the waypoints and searching OpenStreetMap for railway sections. Check again in 15-30 seconds.',
  search_failed: 'The section search failed (see search.error). Start a new session, adjusting the waypoints if the error says so.',
  awaiting_confirmation: 'Sections found. Show the user the numbered list and ask which sections to include. Do not choose for them. Then call generator_confirm_sections with their choice.',
  confirmed: 'The user\'s choice of sections is recorded. You may now start generation with generator_generate_files.',
  generating: 'Generating files. Check progress with generator_get_job_status every 15-30 seconds.',
  ready: 'Files are ready. Give the user the download link; never fetch it yourself.',
  generation_failed: 'Generation failed (see generation.error). The user can change the selection (generator_confirm_sections) or the waypoints (new session) and try again.',
  interrupted: 'The File Generator restarted while a job was waiting or running, so that job was lost. Start it again (generator_generate_files), or start a new session if this was the section search.'
};

function waypointList(meta) {
  return (meta.geocodedPlaces || []).map((p, i) => ({
    number: i + 1,
    name: p.stationName || p.place,
    lat: p.lat,
    lon: p.lon,
    display_name: p.displayName,
    found_by: p.source
  }));
}

function listOutputsSync(sessionPath) {
  const outputs = [];
  for (const name of ['Infrastructure.csv', 'Regions.csv']) {
    const file = path.join(sessionPath, name);
    if (fsSync.existsSync(file)) outputs.push({ file: name, size_bytes: fsSync.statSync(file).size });
  }
  const geometryDir = path.join(sessionPath, 'geometry');
  let names = [];
  try { names = fsSync.readdirSync(geometryDir).filter(isGeometryCsvFile).sort(); } catch { /* none */ }
  for (const name of names) {
    outputs.push({ file: `Geometry/${name}`, size_bytes: fsSync.statSync(path.join(geometryDir, name)).size });
  }
  return outputs;
}

function generationView(gen) {
  if (!gen) return null;
  const view = {
    job_id: gen.jobId,
    status: gen.status,
    network_name: gen.networkName,
    spacing_metres: gen.spacingMetres,
    queued_at: gen.queuedAt
  };
  const job = jobQueue.getJob(gen.jobId);
  if (job && (gen.status === 'queued' || gen.status === 'running')) {
    view.status = jobStatusName(job.status);
    view.progress = job.progress;
    if (job.currentStep) view.current_step = job.currentStep;
    const position = jobQueue.queuePosition(gen.jobId);
    if (position) view.queue_position = position;
  } else if (gen.status === 'queued' || gen.status === 'running') {
    view.status = 'lost';
  }
  if (gen.finishedAt) view.finished_at = gen.finishedAt;
  if (gen.error) view.error = gen.error;
  if (gen.summary) view.summary = gen.summary;
  if (gen.warnings) view.warnings = gen.warnings;
  if (gen.warningsOmitted) view.warnings_omitted = gen.warningsOmitted;
  if (gen.outputs) view.outputs = gen.outputs;
  return view;
}

/**
 * Agent-facing state of one session (no server paths, no large data).
 * @param {object} meta - session.json
 * @param {{map?: boolean}} [options] - map: also return map data for the session view page
 */
async function stateView(meta, { map = false } = {}) {
  const agent = meta.agent || {};
  const state = deriveState(meta);
  const legs = legLabels(meta.geocodedPlaces || []);
  const view = {
    session_id: meta.id,
    label: agent.label || null,
    state,
    what_next: STATE_EXPLANATIONS[state],
    created_at: meta.createdAt,
    expires_at: meta.expiresAt,
    waypoints_requested: agent.waypointsRequested || [],
    waypoints: waypointList(meta),
    legs: legs.map((label, i) => ({ number: i + 1, label })),
    search: {
      status: agent.search ? (state === 'interrupted' && !agent.generation ? 'lost' : agent.search.status) : null,
      ...(agent.search && agent.search.error ? { error: agent.search.error } : {}),
      ...(agent.search && agent.search.overpassFailures ? { overpass_failures: agent.search.overpassFailures } : {})
    },
    sections: [],
    confirmation: agent.confirmation
      ? {
          section_numbers: agent.confirmation.sectionNumbers,
          confirmed_at: agent.confirmation.at,
          user_reply: agent.confirmation.userReply
        }
      : null,
    generation: generationView(agent.generation)
  };
  if (agent.search && agent.search.status === 'done') {
    view.sections = summariseSections(meta.candidateSections || [], legs);
    const total = view.sections.reduce((sum, s) => sum + (s.length_km || 0), 0);
    view.sections_found = view.sections.length;
    view.sections_total_length_km = Math.round(total * 10) / 10;
    if (view.sections.length === 0) {
      view.what_next = 'No railway sections were found between these waypoints. Start a new session with waypoints closer to (or on) the railway line.';
    }
  }
  if (map) {
    const overlays = await readMapOverlays(sessionPathOf(meta.id));
    view.map = {
      waypoints: view.waypoints,
      search_bboxes: meta.searchBboxes || [],
      sections: (meta.candidateSections || []).map((s, i) => ({
        number: i + 1,
        name: s.name || 'Unnamed section',
        geometry: s.geometry || []
      })),
      geometry_lines: overlays.geometryLines,
      corridor_polygons: overlays.corridorPolygons
    };
  }
  return view;
}

// ── 1. Create a session and search for sections ─────────────────────────────

function validateWaypoints(waypoints) {
  const { maxWaypoints } = agentLimits();
  if (!Array.isArray(waypoints) || waypoints.length < 2) {
    throw new AgentError('Give at least 2 waypoints, in route order.');
  }
  if (waypoints.length > maxWaypoints) {
    throw new AgentError(`At most ${maxWaypoints} waypoints per session. For a longer route, use fewer waypoints or split it into several sessions.`);
  }
  return waypoints.map((w, i) => {
    const n = i + 1;
    if (!w || typeof w !== 'object') throw new AgentError(`Waypoint ${n}: give either {"place": "..."} or {"lat": ..., "lon": ...}.`);
    const hasCoords = w.lat !== undefined || w.lon !== undefined;
    if (hasCoords) {
      const lat = Number(w.lat);
      const lon = Number(w.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        throw new AgentError(`Waypoint ${n}: lat must be -90..90 and lon -180..180 (decimal degrees).`);
      }
      const name = cleanText(w.name, MAX_PLACE);
      return name ? { lat, lon, name } : { lat, lon };
    }
    const place = cleanText(w.place, MAX_PLACE);
    if (!place) throw new AgentError(`Waypoint ${n}: give either {"place": "..."} or {"lat": ..., "lon": ...}.`);
    return { place };
  });
}

async function resolveWaypoint(w, index) {
  if (w.place) {
    const found = await deps.geocodePlace(w.place);
    if (!found) {
      return { error: `Waypoint ${index + 1}: could not find "${w.place}". Use a more specific name (e.g. the station's full name and town) or give lat/lon.` };
    }
    return { place: w.place, ...found };
  }
  const reverse = await deps.reverseGeocodePlace(w.lat, w.lon);
  const label = w.name || (reverse ? reverse.label : `Pinned (${w.lat.toFixed(4)}, ${w.lon.toFixed(4)})`);
  return {
    place: label,
    lat: w.lat,
    lon: w.lon,
    displayName: reverse ? reverse.displayName : `Pinned at ${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}`,
    source: 'coordinates'
  };
}

async function runSectionSearch({ sessionId, waypoints }, updateProgress) {
  updateAgentMetadataSync(sessionId, agent => {
    agent.search = { ...agent.search, status: 'running', startedAt: new Date().toISOString() };
  });
  try {
    const places = [];
    const errors = [];
    for (let i = 0; i < waypoints.length; i++) {
      updateProgress(Math.floor((i / waypoints.length) * 40), `Finding waypoint ${i + 1} of ${waypoints.length}`);
      if (i > 0 && deps.pauseBetweenWaypointsMs) await deps.sleep(deps.pauseBetweenWaypointsMs);
      const resolved = await resolveWaypoint(waypoints[i], i);
      if (resolved.error) errors.push(resolved.error);
      else places.push(resolved);
    }
    if (errors.length > 0) {
      throw new AgentError(errors.join(' '));
    }

    const bboxes = computeSearchBboxes(places);
    await updateSessionMetadata(sessionId, {
      geocodedPlaces: places,
      lastGeocodeTimestamp: new Date().toISOString()
    });

    updateProgress(45, 'Searching OpenStreetMap for railway sections');
    const { sections, failedBboxCount, totalBboxCount } = await deps.queryRailwaySections(bboxes);

    // Same fields the website's POST /geography/sections stores.
    await updateSessionMetadata(sessionId, {
      candidateSections: sections,
      searchBboxes: bboxes,
      lastSectionQueryTimestamp: new Date().toISOString()
    });

    if (failedBboxCount > 0 && sections.length === 0) {
      throw new AgentError(
        `The OpenStreetMap search failed for ${failedBboxCount} of ${totalBboxCount} legs and found nothing. ` +
        `This is usually a temporary problem with the map data service: try again in a few minutes.`
      );
    }

    updateAgentMetadataSync(sessionId, agent => {
      agent.search = {
        ...agent.search,
        status: 'done',
        finishedAt: new Date().toISOString(),
        ...(failedBboxCount > 0 ? { overpassFailures: { failed_legs: failedBboxCount, total_legs: totalBboxCount } } : {})
      };
    });
    updateProgress(100, 'Section search complete');
    return { sections: sections.length };
  } catch (error) {
    updateAgentMetadataSync(sessionId, agent => {
      agent.search = { ...agent.search, status: 'failed', finishedAt: new Date().toISOString(), error: error.message };
    });
    throw error;
  }
}

/**
 * @param {number} userId
 * @param {{waypoints: Array, label?: string}} body
 */
export async function createAgentSession(userId, body = {}) {
  const waypoints = validateWaypoints(body.waypoints);
  const label = cleanText(body.label, MAX_LABEL) || null;

  const { sessionsPerHour } = agentLimits();
  const allowed = sessionCreations.check(userId, sessionsPerHour);
  if (!allowed.allowed) {
    throw new AgentError(`Limit reached: at most ${sessionsPerHour} new File Generator sessions per hour. Try again in about ${allowed.retryAfterMinutes} minute(s).`, 429);
  }
  checkActiveJobs(userId);

  const session = await createSession({
    agent: {
      ownerId: userId,
      label,
      createdVia: 'traxim-controller',
      waypointsRequested: waypoints,
      search: { status: 'queued', queuedAt: new Date().toISOString() }
    }
  });
  sessionCreations.record(userId);

  const jobId = jobQueue.createJob(
    'agent-section-search',
    { ownerId: userId, sessionId: session.id, waypoints },
    (data, updateProgress) => runSectionSearch(data, updateProgress)
  );
  // The job may already be running; only add the id.
  updateAgentMetadataSync(session.id, agent => { agent.search.jobId = jobId; });

  return stateView(readSessionMetadataSync(session.id));
}

// ── 2. Session state, list, delete ──────────────────────────────────────────

export async function getAgentSessionState(userId, sessionId, { map = false } = {}) {
  return stateView(ownedSession(userId, sessionId), { map });
}

export async function listAgentSessions(userId) {
  const sessions = [];
  for (const id of listSessionIdsSync()) {
    const meta = readSessionMetadataSync(id);
    if (!meta || !meta.agent || meta.agent.ownerId !== userId || isExpired(meta)) continue;
    sessions.push({
      session_id: id,
      label: meta.agent.label || null,
      state: deriveState(meta),
      created_at: meta.createdAt,
      expires_at: meta.expiresAt,
      waypoints: (meta.geocodedPlaces || []).map(p => p.stationName || p.place),
      sections_found: meta.agent.search && meta.agent.search.status === 'done' ? (meta.candidateSections || []).length : null,
      generation_job_id: meta.agent.generation ? meta.agent.generation.jobId : null
    });
  }
  sessions.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return { sessions };
}

export async function deleteAgentSession(userId, sessionId) {
  const meta = ownedSession(userId, sessionId);
  const state = deriveState(meta);
  if (state === 'searching' || state === 'generating') {
    throw new AgentError('This session has a job waiting or running. Wait until it has finished, then delete it.', 409);
  }
  await deleteSession(sessionId);
  return { deleted: true, session_id: sessionId };
}

// ── 3. Record the user's choice of sections ─────────────────────────────────

/**
 * @param {number} userId
 * @param {string} sessionId
 * @param {{section_numbers: number[], user_reply: string}} body
 */
export async function confirmAgentSections(userId, sessionId, body = {}) {
  const meta = ownedSession(userId, sessionId);
  const state = deriveState(meta);
  if (state === 'searching') throw new AgentError('The section search is still running. Wait for it to finish, show the user the list, then confirm their choice.', 409);
  if (state === 'search_failed') throw new AgentError('The section search failed, so there is nothing to confirm. Start a new session.', 409);
  if (state === 'generating') throw new AgentError('Files are being generated for this session. Wait until generation has finished before changing the selection.', 409);
  if (!meta.agent.search || meta.agent.search.status !== 'done') {
    throw new AgentError('The section search did not finish for this session. Start a new session.', 409);
  }

  const candidates = meta.candidateSections || [];
  if (candidates.length === 0) throw new AgentError('No sections were found in this session, so there is nothing to confirm. Start a new session with different waypoints.', 409);

  const numbers = body.section_numbers;
  if (!Array.isArray(numbers) || numbers.length === 0) {
    throw new AgentError('section_numbers must list the numbers (from the section list) of the sections the user chose, e.g. [1, 3, 4].');
  }
  const chosen = [];
  for (const n of numbers) {
    if (!Number.isInteger(n) || n < 1 || n > candidates.length) {
      throw new AgentError(`Section number ${JSON.stringify(n)} is not on the list (valid numbers: 1 to ${candidates.length}).`);
    }
    if (!chosen.includes(n)) chosen.push(n);
  }
  chosen.sort((a, b) => a - b);

  const userReply = cleanText(body.user_reply, MAX_USER_REPLY);
  if (!userReply) {
    throw new AgentError('user_reply is required: quote the user\'s own message in which they chose these sections. Ask the user first; never choose sections on their behalf.');
  }

  const selected = chosen.map(n => ({ osmId: candidates[n - 1].osmId, osmType: candidates[n - 1].osmType, name: candidates[n - 1].name }));
  const confirmedSections = enrichConfirmedSections(selected, candidates, meta.searchBboxes || []);
  await updateSessionMetadata(sessionId, {
    confirmedSections,
    confirmationTimestamp: new Date().toISOString()
  });
  updateAgentMetadataSync(sessionId, agent => {
    agent.confirmation = { sectionNumbers: chosen, at: new Date().toISOString(), userReply, via: 'agent chat' };
    // A new choice replaces any earlier generation result.
    agent.generation = null;
  });
  return stateView(readSessionMetadataSync(sessionId));
}

// ── 4. Combined generation job ──────────────────────────────────────────────

async function runCombinedGeneration(data, updateProgress) {
  const { sessionId, spacingMetres, networkName, maxNodes } = data;
  const sessionPath = sessionPathOf(sessionId);
  updateAgentMetadataSync(sessionId, agent => {
    if (agent.generation) agent.generation.status = 'running';
  });
  try {
    const meta = readSessionMetadataSync(sessionId);
    const segments = buildGeometrySegments(meta);

    const geometry = await deps.runGeometryGeneration(
      { sessionId, sessionPath, spacingMetres, segments },
      (p, step) => updateProgress(Math.floor(p * 0.6), `Geometry: ${step}`)
    );
    if (!geometry.successfulSections) {
      const reasons = (geometry.results || []).map(r => `${r.section}: ${r.error || 'no result'}`).join('; ');
      throw new AgentError(`Geometry could not be generated for any leg of the route (${reasons}). Check the chosen sections cover the route, or try different waypoints.`);
    }

    const fresh = readSessionMetadataSync(sessionId);
    const infrastructure = await deps.runInfrastructureGeneration(
      {
        sessionId,
        sessionPath,
        confirmedSections: fresh.confirmedSections,
        networkName,
        geometryDir: path.join(sessionPath, 'geometry'),
        bbox: mergeSearchBboxes(fresh.searchBboxes || []),
        maxNodes
      },
      (p, step) => updateProgress(60 + Math.floor(p * 0.4), `Infrastructure: ${step}`)
    );

    const allWarnings = [
      ...(geometry.regionsWarning ? [geometry.regionsWarning] : []),
      ...(geometry.results || []).flatMap(r => (r.warnings || []).map(w => `${r.section}: ${w}`)),
      ...(infrastructure.warnings || [])
    ];
    const { warnings, omitted } = shortenWarnings(allWarnings);
    const summary = {
      routes: summariseGeometry(geometry),
      legs_generated: geometry.successfulSections,
      legs_total: geometry.totalSections,
      infrastructure_nodes: infrastructure.nodeCount,
      infrastructure_connections: infrastructure.connectionCount,
      node_limit: maxNodes
    };
    const outputs = listOutputsSync(sessionPath);
    updateAgentMetadataSync(sessionId, agent => {
      agent.generation = {
        ...agent.generation,
        status: 'completed',
        finishedAt: new Date().toISOString(),
        summary,
        warnings,
        warningsOmitted: omitted,
        outputs
      };
    });
    return { summary, warnings, outputs };
  } catch (error) {
    try {
      updateAgentMetadataSync(sessionId, agent => {
        agent.generation = { ...agent.generation, status: 'failed', finishedAt: new Date().toISOString(), error: error.message };
      });
    } catch (metaErr) {
      console.error(`[Agent] Could not record the failure for session ${sessionId}: ${metaErr.message}`);
    }
    throw error;
  }
}

/**
 * @param {number} userId
 * @param {string} sessionId
 * @param {{network_name?: string, spacing_metres?: number}} body
 */
export async function startAgentGeneration(userId, sessionId, body = {}) {
  const meta = ownedSession(userId, sessionId);
  const state = deriveState(meta);
  if (state === 'generating') throw new AgentError('Files are already being generated for this session. Follow that job with generator_get_job_status.', 409);
  if (state === 'searching') throw new AgentError('The section search is still running. Wait for it, show the user the list and record their choice first.', 409);
  if (state === 'search_failed') throw new AgentError('The section search failed for this session. Start a new session.', 409);
  if (!meta.agent.confirmation || !Array.isArray(meta.confirmedSections) || meta.confirmedSections.length === 0) {
    throw new AgentError('The user has not chosen any sections yet. Show them the numbered section list, ask which to include, and record their answer with generator_confirm_sections before generating.', 409);
  }

  let spacingMetres = SPACING_DEFAULT;
  if (body.spacing_metres !== undefined && body.spacing_metres !== null) {
    spacingMetres = Number(body.spacing_metres);
    if (!Number.isFinite(spacingMetres) || spacingMetres < SPACING_MIN || spacingMetres > SPACING_MAX) {
      throw new AgentError(`spacing_metres must be between ${SPACING_MIN} and ${SPACING_MAX} (default ${SPACING_DEFAULT}).`);
    }
  }
  const networkName = cleanText(body.network_name, MAX_LABEL) || 'Railway Network';

  const limits = agentLimits();
  const allowed = generationStarts.check(userId, limits.generationsPerHour);
  if (!allowed.allowed) {
    throw new AgentError(`Limit reached: at most ${limits.generationsPerHour} generations per hour. Try again in about ${allowed.retryAfterMinutes} minute(s).`, 429);
  }
  checkActiveJobs(userId);

  updateAgentMetadataSync(sessionId, agent => {
    agent.generation = { status: 'queued', queuedAt: new Date().toISOString(), networkName, spacingMetres };
  });
  generationStarts.record(userId);
  const jobId = jobQueue.createJob(
    'agent-generation',
    { ownerId: userId, sessionId, spacingMetres, networkName, maxNodes: limits.maxNodes },
    (data, updateProgress) => runCombinedGeneration(data, updateProgress)
  );
  updateAgentMetadataSync(sessionId, agent => { agent.generation.jobId = jobId; });

  const legs = (meta.searchBboxes || []).length;
  return {
    job_id: jobId,
    session_id: sessionId,
    status: jobStatusName((jobQueue.getJob(jobId) || {}).status || 'pending'),
    queue_position: jobQueue.queuePosition(jobId) || undefined,
    network_name: networkName,
    spacing_metres: spacingMetres,
    expected_duration: `roughly ${Math.max(1, legs)} to ${Math.max(3, legs * 3)} minutes (geometry about 30-60 s per leg, then 2-5 minutes for infrastructure)`,
    generations_used_this_hour: allowed.used + 1,
    generations_per_hour_limit: limits.generationsPerHour
  };
}

// ── 5. Job status ───────────────────────────────────────────────────────────

function findSessionForJob(userId, jobId) {
  for (const id of listSessionIdsSync()) {
    const meta = readSessionMetadataSync(id);
    if (!meta || !meta.agent || meta.agent.ownerId !== userId || isExpired(meta)) continue;
    if (meta.agent.generation && meta.agent.generation.jobId === jobId) return { meta, kind: 'generation' };
    if (meta.agent.search && meta.agent.search.jobId === jobId) return { meta, kind: 'section_search' };
  }
  return null;
}

export async function getAgentJobStatus(userId, jobId) {
  if (typeof jobId !== 'string' || !/^job-[a-z-]+-\d+-[0-9a-z]+$/.test(jobId)) {
    throw new AgentError('Job not found.', 404);
  }
  const jobMeta = jobQueue.getJobMeta(jobId);
  if (jobMeta && jobMeta.ownerId !== userId) throw new AgentError('Job not found.', 404);

  const found = findSessionForJob(userId, jobId);
  if (!found) throw new AgentError('Job not found. Finished jobs are kept for as long as their session (24 hours).', 404);
  const { meta, kind } = found;
  const record = kind === 'generation' ? meta.agent.generation : meta.agent.search;
  const job = jobQueue.getJob(jobId);

  const response = { job_id: jobId, kind, session_id: meta.id };
  if (record.status === 'completed' || record.status === 'done') {
    response.status = 'completed';
  } else if (record.status === 'failed') {
    response.status = 'failed';
    response.error = record.error;
  } else if (job) {
    response.status = jobStatusName(job.status);
    response.progress = job.progress;
    if (job.currentStep) response.current_step = job.currentStep;
    const position = jobQueue.queuePosition(jobId);
    if (position) response.queue_position = position;
  } else {
    response.status = 'lost';
    response.error = kind === 'generation'
      ? 'The File Generator restarted while this job was waiting or running, so it was lost. Start it again with generator_generate_files (the confirmed selection is kept).'
      : 'The File Generator restarted during the section search. Start a new session.';
  }

  if (kind === 'generation' && response.status === 'completed') {
    response.summary = record.summary;
    response.warnings = record.warnings;
    if (record.warningsOmitted) response.warnings_omitted = record.warningsOmitted;
    response.outputs = record.outputs;
  }
  if (kind === 'section_search' && response.status === 'completed') {
    response.next_step = 'Call generator_get_session to see the numbered list of sections.';
  }
  return response;
}

// ── 6. Outputs-only download ────────────────────────────────────────────────

/**
 * Stream the outputs-only ZIP to an HTTP response: Infrastructure.csv,
 * Regions.csv and the geometry CSVs in a Geometry/ folder. Never the OSM
 * caches, *_wayids.csv, *_topology.json, corridor_polygons.json or
 * session.json.
 */
export async function streamAgentOutputs(userId, sessionId, res) {
  const meta = ownedSession(userId, sessionId);
  if (deriveState(meta) !== 'ready') {
    throw new AgentError('The files for this session are not ready (generation has not finished successfully).', 409);
  }
  const sessionPath = sessionPathOf(sessionId);
  const outputs = listOutputsSync(sessionPath);
  if (outputs.length === 0) throw new AgentError('No output files were found for this session.', 404);

  const base = (meta.agent.label || meta.agent.generation.networkName || 'traxim-files')
    .replace(/[^A-Za-z0-9 _.-]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'traxim-files';
  const fileName = `${base}-${sessionId.slice(0, 8)}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Cache-Control', 'no-store');

  const archive = archiver('zip', { zlib: { level: 9 } });
  await new Promise((resolve, reject) => {
    archive.on('error', reject);
    res.on('close', resolve);
    archive.on('end', resolve);
    archive.pipe(res);
    for (const out of outputs) {
      const source = out.file.startsWith('Geometry/')
        ? path.join(sessionPath, 'geometry', out.file.slice('Geometry/'.length))
        : path.join(sessionPath, out.file);
      archive.file(source, { name: out.file });
    }
    archive.finalize();
  });
}
