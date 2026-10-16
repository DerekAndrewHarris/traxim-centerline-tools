/**
 * Agent access (decided 15 Oct 2026): the /internal/agent routes the Traxim
 * Controller calls, the ownership rules, the limits, the outputs-only ZIP,
 * and that the website's public API cannot reach agent sessions.
 *
 * Run with:  npm test      (or: node --test test/)
 * No network: the waypoint lookup, the OpenStreetMap section search and the
 * two generation steps are replaced with stand-ins that write small files.
 * Sessions go to a throwaway temp folder, never /tmp/traxim-temp-sessions.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Must be set before the modules below are loaded (they read them at load time).
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-agent-test-'));
process.env.TEMP_FILES_DIR = tempRoot;
const KEY = 'test-internal-key-0123456789abcdef0123456789abcdef';
process.env.TRAXIM_INTERNAL_KEY = KEY;

const { createApp } = await import('../backend/createApp.js');
const agent = await import('../backend/services/agent/agentSessions.js');
const limits = await import('../backend/services/agent/limits.js');
const pipeline = await import('../backend/services/generation/pipeline.js');
const { computeSearchBboxes } = await import('../backend/services/agent/searchBoxes.js');
const { sectionLengthKm, shortenWarnings } = await import('../backend/services/agent/sectionSummary.js');
const { JobQueue } = await import('../backend/utils/jobQueue.js');

const ALICE = 101;
const BOB = 102;
let server;
let base;

// ── Stand-ins for the network and the heavy generation steps ───────────────

const SECTIONS = [
  { osmId: '111', osmType: 'relation', name: 'Linea Genova-Pisa', type: 'railway', operator: 'RFI', ref: 'GE-PI', from: 'Genova', to: 'Pisa', network: 'RFI', wayIds: ['1', '2'], segmentIndices: [0, 1], geometry: [[[44.40, 8.90], [44.41, 8.91]], [[44.41, 8.91], [44.42, 8.92]]] },
  { osmId: '222', osmType: 'relation', name: 'Regionale 11', type: 'train', operator: 'Trenitalia', ref: '', wayIds: ['1'], segmentIndices: [0], geometry: [[[44.40, 8.90], [44.41, 8.91]]] },
  { osmId: '333', osmType: 'way', name: 'Raccordo', type: 'rail', operator: '', ref: '', wayIds: ['9'], segmentIndices: [1], geometry: [] }
];

let infraNodeCount = 120;
let elevationAvailable = true;   // false: the stand-in geometry has no elevation data (as with HTTP 429)
let lastGeometryData = null;     // what the combined job passed to the geometry step

function geometryCsv(name) {
  return `#region name,latitude,longitude,elevation,kilometerage,raw_elevation\n${name},44.4,8.9,10,0,10\n${name},44.41,8.91,11,0.135,11\n`;
}

function installStandIns() {
  agent.deps.pauseBetweenWaypointsMs = 0;
  agent.deps.geocodePlace = async (place) => {
    if (/nowhere/i.test(place)) return null;
    return { lat: 44.40, lon: 8.90, displayName: `${place} station`, source: 'railway_station', stationName: `${place} Centrale` };
  };
  agent.deps.reverseGeocodePlace = async (lat, lon) => ({ label: `Town ${lat.toFixed(2)}`, displayName: `Town at ${lat}, ${lon}` });
  agent.deps.queryRailwaySections = async (bboxes) => ({
    sections: JSON.parse(JSON.stringify(SECTIONS)),
    failedBboxCount: 0,
    totalBboxCount: bboxes.length
  });
  agent.deps.runGeometryGeneration = async (data, progress) => {
    const { sessionId, sessionPath, segments } = data;
    lastGeometryData = data;
    progress(50, 'stand-in geometry');
    const dir = path.join(sessionPath, 'geometry');
    fs.mkdirSync(dir, { recursive: true });
    const results = [];
    for (const seg of segments) {
      const file = seg.label.replace(/ /g, '_');
      fs.writeFileSync(path.join(dir, `${file}.csv`), geometryCsv(seg.label));
      fs.writeFileSync(path.join(dir, `${file}_wayids.csv`), 'wayId\n1\n');
      fs.writeFileSync(path.join(dir, `${file}_topology.json`), '{}');
      results.push({
        section: seg.label, lengthKm: 12.345, pointCount: 500, alternativeCount: 0, warnings: ['a geometry warning'],
        elevation: elevationAvailable ? { ok: true, reason: null } : { ok: false, reason: 'Elevation batch 1 failed after 2 retries: Open-Elevation API returned 429 (too many requests)' },
        alternativeElevation: [],
        smoothing: { adjustedCount: 3, maxAdjustmentM: 1.26 }
      });
    }
    await pipeline.writeGeometryKml(sessionPath);
    fs.writeFileSync(path.join(sessionPath, 'Regions.csv'), '#regions\n,White,1\n');
    fs.writeFileSync(path.join(sessionPath, 'osm_topology.json'), '{"ways":[]}');
    fs.writeFileSync(path.join(sessionPath, 'corridor_polygons.json'), '[]');
    fs.writeFileSync(path.join(sessionPath, 'osm_stations.json'), '[]');
    return {
      sessionId, totalSections: segments.length, successfulSections: segments.length, results, regionsWarning: 'Regions.csv: defaults used',
      seriousProblems: pipeline.describeSeriousProblems(results)
    };
  };
  // The REAL pipeline step (so the node limit check is the real one), with a
  // stand-in for the 2,800-line generator itself.
  agent.deps.runInfrastructureGeneration = (data, progress) =>
    pipeline.runInfrastructureGeneration(data, progress, async () => ({
      csv: '#7,Traxim v7 test\n',
      nodeCount: infraNodeCount,
      connectionCount: 130,
      warnings: ['Naming anchors available (3): ' + 'x'.repeat(2000), 'SIGNAL OMISSION: ...']
    }));
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

function internalHeaders(userId, extra = {}) {
  return { 'X-Traxim-Internal-Key': KEY, 'X-Traxim-User-Id': String(userId), 'Content-Type': 'application/json', ...extra };
}

async function call(method, url, { userId = ALICE, body, headers } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: headers || internalHeaders(userId),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const buffer = Buffer.from(await res.arrayBuffer());
  let data = null;
  try { data = JSON.parse(buffer.toString('utf8')); } catch { /* not JSON */ }
  return { status: res.status, data, buffer, headers: res.headers };
}

async function waitFor(fn, label, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(r => setTimeout(r, 20));
  }
}

async function newSessionWithSections(userId = ALICE, waypoints = [{ place: 'Genova' }, { lat: 44.10, lon: 9.82 }, { place: 'Pisa' }]) {
  const created = await call('POST', '/internal/agent/sessions', { userId, body: { waypoints, label: 'Test route' } });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const id = created.data.session_id;
  const state = await waitFor(async () => {
    const r = await call('GET', `/internal/agent/sessions/${id}`, { userId });
    return r.data.state !== 'searching' ? r.data : null;
  }, 'section search');
  return { id, state };
}

async function generateAndWait(id, userId = ALICE, body = { network_name: 'Ligurian test' }) {
  const started = await call('POST', `/internal/agent/sessions/${id}/generate`, { userId, body });
  assert.equal(started.status, 200, JSON.stringify(started.data));
  const jobId = started.data.job_id;
  const status = await waitFor(async () => {
    const r = await call('GET', `/internal/agent/jobs/${jobId}`, { userId });
    return ['completed', 'failed'].includes(r.data.status) ? r.data : null;
  }, 'generation');
  return { jobId, status };
}

/** File names in a ZIP (central directory). */
function zipEntryNames(buffer) {
  const names = [];
  for (let i = 0; i < buffer.length - 46; i++) {
    if (buffer.readUInt32LE(i) === 0x02014b50) {
      const nameLength = buffer.readUInt16LE(i + 28);
      names.push(buffer.toString('utf8', i + 46, i + 46 + nameLength));
    }
  }
  return names.sort();
}

before(async () => {
  installStandIns();
  server = createApp({ serveStatic: false }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

beforeEach(() => {
  limits.generationStarts.reset();
  limits.sessionCreations.reset();
  infraNodeCount = 120;
  elevationAvailable = true;
  lastGeometryData = null;
  delete process.env.AGENT_MAX_GENERATIONS_PER_HOUR;
  delete process.env.AGENT_MAX_SESSIONS_PER_HOUR;
  process.env.TRAXIM_INTERNAL_KEY = KEY;
});

// ── Pure helpers ────────────────────────────────────────────────────────────

test('search boxes: one tight box per pair of consecutive waypoints (same rule as the web page)', () => {
  assert.deepEqual(computeSearchBboxes([{ lat: 44.4, lon: 8.9 }, { lat: 44.1, lon: 9.8 }, { lat: 43.7, lon: 10.4 }]), [
    { minLat: 44.1, minLon: 8.9, maxLat: 44.4, maxLon: 9.8 },
    { minLat: 43.7, minLon: 9.8, maxLat: 44.1, maxLon: 10.4 }
  ]);
  assert.deepEqual(computeSearchBboxes([{ lat: 1, lon: 1 }]), []);
});

test('section length from preview geometry; null when there is none', () => {
  // 0.01 degrees of latitude is about 1.11 km
  assert.equal(sectionLengthKm([[[44.40, 8.90], [44.41, 8.90]]]), 1.1);
  assert.equal(sectionLengthKm([]), null);
  assert.equal(sectionLengthKm(undefined), null);
});

test('warnings are shortened for the agent', () => {
  const { warnings, omitted } = shortenWarnings(['short', 'y'.repeat(1000), ...Array(30).fill('w')]);
  assert.equal(warnings.length, 20);
  assert.equal(omitted, 12);
  assert.equal(warnings[0], 'short');
  assert.ok(warnings[1].length < 500 && /shortened/.test(warnings[1]));
});

test('MAX_CONCURRENT_JOBS is read from the environment (1-16, otherwise 3)', () => {
  assert.equal(JobQueue.readMaxConcurrent('5'), 5);
  assert.equal(JobQueue.readMaxConcurrent(undefined), 3);
  assert.equal(JobQueue.readMaxConcurrent('0'), 3);
  assert.equal(JobQueue.readMaxConcurrent('abc'), 3);
});

test('node limit: more nodes than allowed -> clear error and no Infrastructure.csv', async () => {
  const dir = fs.mkdtempSync(path.join(tempRoot, 'nolimit-'));
  await assert.rejects(
    pipeline.runInfrastructureGeneration(
      { sessionId: 'x', sessionPath: dir, confirmedSections: [], networkName: 'n', geometryDir: dir, bbox: '0,0,1,1', maxNodes: 5000 },
      () => {},
      async () => ({ csv: 'x', nodeCount: 5001, connectionCount: 1, warnings: [] })
    ),
    err => err instanceof pipeline.NodeLimitError && /5001 nodes/.test(err.message) && /Split the route/.test(err.message)
  );
  assert.equal(fs.existsSync(path.join(dir, 'Infrastructure.csv')), false);
});

// ── Who may call ────────────────────────────────────────────────────────────

test('internal routes: refused without the shared key, through nginx, or without a user id', async () => {
  const noKey = await call('GET', '/internal/agent/sessions', { headers: { 'X-Traxim-User-Id': '101' } });
  assert.equal(noKey.status, 401);
  const wrongKey = await call('GET', '/internal/agent/sessions', { headers: internalHeaders(ALICE, { 'X-Traxim-Internal-Key': KEY + 'x' }) });
  assert.equal(wrongKey.status, 401);
  const viaNginx = await call('GET', '/internal/agent/sessions', { headers: internalHeaders(ALICE, { 'X-Forwarded-For': '203.0.113.9' }) });
  assert.equal(viaNginx.status, 404);
  const viaNginx2 = await call('GET', '/internal/agent/sessions', { headers: internalHeaders(ALICE, { 'X-Real-IP': '203.0.113.9' }) });
  assert.equal(viaNginx2.status, 404);
  for (const bad of ['', '0', 'abc', '1; DROP', '-5']) {
    const r = await call('GET', '/internal/agent/sessions', { headers: { 'X-Traxim-Internal-Key': KEY, 'X-Traxim-User-Id': bad } });
    assert.equal(r.status, 400, `user id '${bad}'`);
  }
});

test('internal routes are switched off (503) when TRAXIM_INTERNAL_KEY is missing or too short', async () => {
  delete process.env.TRAXIM_INTERNAL_KEY;
  assert.equal((await call('GET', '/internal/agent/sessions')).status, 503);
  process.env.TRAXIM_INTERNAL_KEY = 'short';
  assert.equal((await call('GET', '/internal/agent/sessions', { headers: internalHeaders(ALICE, { 'X-Traxim-Internal-Key': 'short' }) })).status, 503);
});

// ── Workflow ────────────────────────────────────────────────────────────────

test('create session: waypoints resolved, boxes worked out on the server, numbered readable section list', async () => {
  const { id, state } = await newSessionWithSections();
  assert.equal(state.state, 'awaiting_confirmation');
  assert.match(state.what_next, /Do not choose for them/);
  assert.equal(state.waypoints.length, 3);
  assert.equal(state.waypoints[0].name, 'Genova Centrale');
  assert.equal(state.waypoints[1].found_by, 'coordinates');
  assert.deepEqual(state.legs.map(l => l.label), ['Genova Centrale - Town 44.10', 'Town 44.10 - Pisa Centrale']);
  assert.equal(state.sections.length, 3);
  const [first, second, third] = state.sections;
  assert.equal(first.number, 1);
  assert.equal(first.name, 'Linea Genova-Pisa');
  assert.equal(first.from, 'Genova');
  assert.equal(first.to, 'Pisa');
  assert.equal(first.ref, 'GE-PI');
  assert.ok(first.length_km > 2 && first.length_km < 3, String(first.length_km));
  assert.deepEqual(first.found_on_legs, ['Genova Centrale - Town 44.10', 'Town 44.10 - Pisa Centrale']);
  assert.equal(first.osm_url, 'https://www.openstreetmap.org/relation/111');
  assert.match(second.kind, /service route/);
  assert.equal(third.length_km, undefined, 'no preview geometry -> no length given');
  assert.ok(!JSON.stringify(state).includes(tempRoot), 'no server paths in the response');
  assert.ok(!('geometry' in first), 'no bulky geometry in the agent view');

  const meta = JSON.parse(fs.readFileSync(path.join(tempRoot, id, 'session.json'), 'utf8'));
  assert.equal(meta.agent.ownerId, ALICE);
  assert.equal(meta.searchBboxes.length, 2, 'one search box per leg');
});

test('waypoint validation and lookup failures give clear messages', async () => {
  const one = await call('POST', '/internal/agent/sessions', { body: { waypoints: [{ place: 'Genova' }] } });
  assert.equal(one.status, 400);
  const many = await call('POST', '/internal/agent/sessions', { body: { waypoints: Array(26).fill({ place: 'X' }) } });
  assert.equal(many.status, 400);
  assert.match(many.data.error, /At most 25 waypoints/);
  const badLat = await call('POST', '/internal/agent/sessions', { body: { waypoints: [{ lat: 95, lon: 1 }, { place: 'Pisa' }] } });
  assert.equal(badLat.status, 400);
  const { state } = await newSessionWithSections(ALICE, [{ place: 'Genova' }, { place: 'Nowhere-at-all' }]);
  assert.equal(state.state, 'search_failed');
  assert.match(state.search.error, /could not find "Nowhere-at-all"/);
});

test('another user, the public website API and bad ids all get 404 for an agent session', async () => {
  const { id } = await newSessionWithSections();
  for (const [method, url] of [
    ['GET', `/internal/agent/sessions/${id}`],
    ['POST', `/internal/agent/sessions/${id}/confirm`],
    ['POST', `/internal/agent/sessions/${id}/generate`],
    ['GET', `/internal/agent/sessions/${id}/download`],
    ['DELETE', `/internal/agent/sessions/${id}`]
  ]) {
    const r = await call(method, url, { userId: BOB, body: method === 'POST' ? { section_numbers: [1], user_reply: 'yes' } : undefined });
    assert.equal(r.status, 404, `${method} ${url} as bob`);
  }
  assert.deepEqual((await call('GET', '/internal/agent/sessions', { userId: BOB })).data.sessions, []);

  // The website's own API (no login) must not see it either.
  const plain = { 'Content-Type': 'application/json' };
  for (const [method, url, body] of [
    ['GET', `/api/file-generator/sessions/${id}`],
    ['GET', `/api/file-generator/sessions/${id}/map-overlays`],
    ['GET', `/api/file-generator/sessions/${id}/download-all`],
    ['GET', `/api/file-generator/sessions/files/${id}/Regions.csv`],
    ['DELETE', `/api/file-generator/sessions/${id}`],
    ['POST', '/api/file-generator/geography/confirm', { sessionId: id, selectedSections: [{ osmId: '111', osmType: 'relation' }] }],
    ['POST', '/api/file-generator/geometry/generate', { sessionId: id }],
    ['POST', '/api/file-generator/infrastructure/generate', { sessionId: id }]
  ]) {
    const r = await call(method, url, { headers: plain, body });
    assert.equal(r.status, 404, `${method} ${url}`);
  }
  assert.ok(fs.existsSync(path.join(tempRoot, id)), 'public DELETE did not remove it');

  // Not a session id at all (would have been the parent folder before).
  const traversal = await call('DELETE', '/api/file-generator/sessions/%2E%2E', { headers: plain });
  assert.equal(traversal.status, 404);
  assert.ok(fs.existsSync(tempRoot));
  const internalBad = await call('GET', '/internal/agent/sessions/..%2F..%2Fetc');
  assert.equal(internalBad.status, 404);
});

test('the website flow is unchanged: anonymous sessions still work', async () => {
  const plain = { 'Content-Type': 'application/json' };
  const created = await call('POST', '/api/file-generator/sessions', { headers: plain });
  assert.equal(created.status, 201);
  const id = created.data.session.id;
  const got = await call('GET', `/api/file-generator/sessions/${id}`, { headers: plain });
  assert.equal(got.status, 200);
  const overlays = await call('GET', `/api/file-generator/sessions/${id}/map-overlays`, { headers: plain });
  assert.equal(overlays.status, 200);
  assert.deepEqual(overlays.data.searchBboxes, []);
  // ...and the agent routes do not list website sessions.
  assert.ok(!(await call('GET', '/internal/agent/sessions')).data.sessions.some(s => s.session_id === id));
  assert.equal((await call('GET', `/internal/agent/sessions/${id}`)).status, 404);
  assert.equal((await call('DELETE', `/api/file-generator/sessions/${id}`, { headers: plain })).status, 204);
});

test('generation needs the user\'s recorded choice; the choice is validated', async () => {
  const { id } = await newSessionWithSections();
  const early = await call('POST', `/internal/agent/sessions/${id}/generate`, { body: {} });
  assert.equal(early.status, 409);
  assert.match(early.data.error, /has not chosen any sections/);

  const noReply = await call('POST', `/internal/agent/sessions/${id}/confirm`, { body: { section_numbers: [1] } });
  assert.equal(noReply.status, 400);
  assert.match(noReply.data.error, /never choose sections on their behalf/);
  const badNumber = await call('POST', `/internal/agent/sessions/${id}/confirm`, { body: { section_numbers: [4], user_reply: 'number 4 please' } });
  assert.equal(badNumber.status, 400);
  assert.match(badNumber.data.error, /1 to 3/);
  const none = await call('POST', `/internal/agent/sessions/${id}/confirm`, { body: { section_numbers: [], user_reply: 'none' } });
  assert.equal(none.status, 400);

  const ok = await call('POST', `/internal/agent/sessions/${id}/confirm`, { body: { section_numbers: [3, 1, 1], user_reply: 'Use 1 and 3, not the Regionale.' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.state, 'confirmed');
  assert.deepEqual(ok.data.confirmation.section_numbers, [1, 3]);
  assert.equal(ok.data.confirmation.user_reply, 'Use 1 and 3, not the Regionale.');
  const meta = JSON.parse(fs.readFileSync(path.join(tempRoot, id, 'session.json'), 'utf8'));
  assert.deepEqual(meta.confirmedSections.map(s => s.osmId), ['111', '333']);
  assert.ok(meta.confirmedSections[0].corridorBbox, 'enriched like the website confirm');
});

test('combined job: geometry then infrastructure; outputs-only ZIP; owner-only download', async () => {
  const { id } = await newSessionWithSections();
  await call('POST', `/internal/agent/sessions/${id}/confirm`, { body: { section_numbers: [1], user_reply: 'Just number 1' } });

  const notYet = await call('GET', `/internal/agent/sessions/${id}/download`);
  assert.equal(notYet.status, 409);

  const { jobId, status } = await generateAndWait(id);
  assert.equal(status.status, 'completed', JSON.stringify(status));
  assert.equal(status.kind, 'generation');
  assert.ok(status.session_expires_at, 'expiry given for the download link');
  assert.equal(status.summary.infrastructure_nodes, 120);
  assert.equal(status.summary.node_limit, 5000);
  assert.equal(status.summary.legs_generated, 2);
  assert.equal(status.summary.routes[0].length_km, 12.3);
  assert.ok(status.warnings.some(w => /shortened/.test(w)), 'long warning shortened');
  // One date stamp per run on the ZIP, Infrastructure, Regions and KML; the
  // geometry files keep their names (Traxim reads region names from inside them).
  const stamp = status.summary.file_stamp;
  assert.match(stamp, /^\d{4}-\d{2}-\d{2}_\d{6}$/);
  assert.equal(lastGeometryData.outputStamp, stamp, 'the geometry step got the same stamp');
  assert.deepEqual(status.outputs.map(o => o.file), [
    `Infrastructure_${stamp}.csv`, `Regions_${stamp}.csv`, `Geometry_${stamp}.kml`,
    'Geometry/Genova_Centrale_-_Town_44.10.csv', 'Geometry/Town_44.10_-_Pisa_Centrale.csv'
  ]);
  assert.ok(status.outputs.every(o => !('source' in o)), 'no server paths in the outputs list');
  assert.equal(status.download_file_name, `Test-route_${stamp}.zip`);
  assert.equal(status.serious_problems, undefined, 'no serious problems when elevation is fine');
  assert.deepEqual(status.summary.settings, { spacing_metres: 25, max_gradient_percent: 4, network_name: 'Ligurian test' });
  assert.equal(status.summary.routes[0].elevation_data, true);
  assert.equal(status.summary.routes[0].smoothing_points_adjusted, 3);
  assert.equal(status.summary.routes[0].smoothing_largest_change_m, 1.3);
  assert.ok(!JSON.stringify(status).includes(tempRoot), 'no server paths');

  const state = await call('GET', `/internal/agent/sessions/${id}`);
  assert.equal(state.data.state, 'ready');
  assert.equal(state.data.generation.job_id, jobId);

  // The public job routes never show an agent job.
  const plain = { 'Content-Type': 'application/json' };
  assert.equal((await call('GET', `/api/file-generator/geometry/jobs/${jobId}`, { headers: plain })).status, 404);
  assert.equal((await call('GET', `/api/file-generator/infrastructure/jobs/${jobId}`, { headers: plain })).status, 404);
  assert.equal((await call('GET', `/internal/agent/jobs/${jobId}`, { userId: BOB })).status, 404);

  const zip = await call('GET', `/internal/agent/sessions/${id}/download`);
  assert.equal(zip.status, 200);
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  assert.equal(zip.headers.get('content-disposition'), `attachment; filename="Test-route_${stamp}.zip"`);
  assert.deepEqual(zipEntryNames(zip.buffer), [
    'Geometry/Genova_Centrale_-_Town_44.10.csv',
    'Geometry/Town_44.10_-_Pisa_Centrale.csv',
    `Geometry_${stamp}.kml`,
    `Infrastructure_${stamp}.csv`,
    `Regions_${stamp}.csv`
  ], 'outputs only: no osm_*.json, corridor_polygons.json, _wayids, _topology or session.json');
  const kml = fs.readFileSync(path.join(tempRoot, id, 'Geometry.kml'), 'utf8');
  assert.match(kml, /<name>Genova Centrale - Town 44\.10<\/name>/, 'one line per geometry file, named like the website does');
  assert.match(kml, /8\.91000000,44\.41000000,0\.000/, 'lon,lat order, clamped to the ground');
  assert.equal((await call('GET', `/internal/agent/sessions/${id}/download`, { userId: BOB })).status, 404);

  // Map data for the session view page.
  const map = await call('GET', `/internal/agent/sessions/${id}?detail=map`);
  assert.equal(map.data.map.sections.length, 3);
  assert.equal(map.data.map.search_bboxes.length, 2);
  assert.equal(map.data.map.geometry_lines.length, 2);
});

test('node limit stops the generation with a helpful message and no download', async () => {
  infraNodeCount = 5200;
  const { id } = await newSessionWithSections();
  await call('POST', `/internal/agent/sessions/${id}/confirm`, { body: { section_numbers: [1, 2, 3], user_reply: 'all of them' } });
  const { status } = await generateAndWait(id);
  assert.equal(status.status, 'failed');
  assert.match(status.error, /5200 nodes, more than the limit of 5000/);
  const state = await call('GET', `/internal/agent/sessions/${id}`);
  assert.equal(state.data.state, 'generation_failed');
  assert.equal((await call('GET', `/internal/agent/sessions/${id}/download`)).status, 409);
  assert.equal(fs.existsSync(path.join(tempRoot, id, 'Infrastructure.csv')), false);
});

test('limit: generations per hour per user', async () => {
  process.env.AGENT_MAX_GENERATIONS_PER_HOUR = '2';
  const { id } = await newSessionWithSections();
  await call('POST', `/internal/agent/sessions/${id}/confirm`, { body: { section_numbers: [1], user_reply: '1' } });
  await generateAndWait(id);
  await generateAndWait(id);
  const third = await call('POST', `/internal/agent/sessions/${id}/generate`, { body: {} });
  assert.equal(third.status, 429);
  assert.match(third.data.error, /at most 2 generations per hour/);
  // Another user has their own allowance.
  const bobs = await newSessionWithSections(BOB);
  await call('POST', `/internal/agent/sessions/${bobs.id}/confirm`, { userId: BOB, body: { section_numbers: [1], user_reply: '1' } });
  assert.equal((await generateAndWait(bobs.id, BOB)).status.status, 'completed');
});

test('limit: new sessions per hour per user', async () => {
  process.env.AGENT_MAX_SESSIONS_PER_HOUR = '1';
  await newSessionWithSections();
  const second = await call('POST', '/internal/agent/sessions', { body: { waypoints: [{ place: 'A' }, { place: 'B' }] } });
  assert.equal(second.status, 429);
  assert.match(second.data.error, /new File Generator sessions per hour/);
});

test('spacing is checked; a job lost in a restart shows as interrupted / lost', async () => {
  const { id } = await newSessionWithSections();
  await call('POST', `/internal/agent/sessions/${id}/confirm`, { body: { section_numbers: [1], user_reply: '1' } });
  const badSpacing = await call('POST', `/internal/agent/sessions/${id}/generate`, { body: { spacing_metres: 5 } });
  assert.equal(badSpacing.status, 400);

  // As if the service restarted mid-generation: recorded as running, job unknown.
  const file = path.join(tempRoot, id, 'session.json');
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  meta.agent.generation = { status: 'running', jobId: 'job-agent-generation-1-abc123', networkName: 'n', spacingMetres: 25 };
  fs.writeFileSync(file, JSON.stringify(meta));
  const state = await call('GET', `/internal/agent/sessions/${id}`);
  assert.equal(state.data.state, 'interrupted');
  assert.equal(state.data.generation.status, 'lost');
  const job = await call('GET', '/internal/agent/jobs/job-agent-generation-1-abc123');
  assert.equal(job.data.status, 'lost');
  assert.match(job.data.error, /restarted/);
  // It can simply be started again.
  assert.equal((await generateAndWait(id)).status.status, 'completed');
});

test('list, expiry and delete', async () => {
  const { id } = await newSessionWithSections();
  const listed = await call('GET', '/internal/agent/sessions');
  const mine = listed.data.sessions.find(s => s.session_id === id);
  assert.equal(mine.label, 'Test route');
  assert.equal(mine.sections_found, 3);

  const file = path.join(tempRoot, id, 'session.json');
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  const realExpiry = meta.expiresAt;
  meta.expiresAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(meta));
  assert.equal((await call('GET', `/internal/agent/sessions/${id}`)).status, 404);
  assert.ok(!(await call('GET', '/internal/agent/sessions')).data.sessions.some(s => s.session_id === id));
  meta.expiresAt = realExpiry;
  fs.writeFileSync(file, JSON.stringify(meta));

  const deleted = await call('DELETE', `/internal/agent/sessions/${id}`);
  assert.equal(deleted.status, 200);
  assert.equal(fs.existsSync(path.join(tempRoot, id)), false);
  assert.equal((await call('GET', `/internal/agent/sessions/${id}`)).status, 404);
});

// ── Choosing sections on the map (second pathway, October 2026) ────────────

test('map choice: recorded with source "map", who and when; only while waiting for a choice', async () => {
  const { id } = await newSessionWithSections();

  const bad = await call('POST', `/internal/agent/sessions/${id}/confirm-map`, { body: { section_numbers: [9] } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /1 to 3/);
  const none = await call('POST', `/internal/agent/sessions/${id}/confirm-map`, { body: { section_numbers: [] } });
  assert.equal(none.status, 400);
  const asBob = await call('POST', `/internal/agent/sessions/${id}/confirm-map`, { userId: BOB, body: { section_numbers: [1] } });
  assert.equal(asBob.status, 404);

  const ok = await call('POST', `/internal/agent/sessions/${id}/confirm-map`, {
    body: { section_numbers: [3, 1], confirmed_by: 'alice@example.com' }
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.state, 'confirmed');
  assert.ok(ok.data.map, 'map data returned for the page');
  const c = ok.data.confirmation;
  assert.equal(c.source, 'map');
  assert.match(c.source_explained, /map page/);
  assert.deepEqual(c.section_numbers, [1, 3]);
  assert.deepEqual(c.sections, [{ number: 1, name: 'Linea Genova-Pisa' }, { number: 3, name: 'Raccordo' }]);
  assert.equal(c.confirmed_by, 'alice@example.com');
  assert.ok(c.confirmed_at);
  assert.equal(c.user_reply, undefined);

  // The agent sees the same, with the read-back instruction.
  const state = await call('GET', `/internal/agent/sessions/${id}`);
  assert.equal(state.data.confirmation.source, 'map');
  assert.match(state.data.what_next, /read the chosen sections back to the user/);
  const meta = JSON.parse(fs.readFileSync(path.join(tempRoot, id, 'session.json'), 'utf8'));
  assert.deepEqual(meta.confirmedSections.map(s => s.osmId), ['111', '333'], 'same enrichment as the chat choice');
  assert.equal(meta.agent.confirmation.confirmedByUserId, ALICE);

  // Once chosen (either way) the map cannot choose again...
  const again = await call('POST', `/internal/agent/sessions/${id}/confirm-map`, { body: { section_numbers: [2] } });
  assert.equal(again.status, 409);
  assert.match(again.data.error, /already been chosen/);
  // ...but the chat confirmation still works, and is recorded as "chat".
  const chat = await call('POST', `/internal/agent/sessions/${id}/confirm`, { body: { section_numbers: [2], user_reply: 'Actually only 2' } });
  assert.equal(chat.status, 200);
  assert.equal(chat.data.confirmation.source, 'chat');
  assert.equal(chat.data.confirmation.user_reply, 'Actually only 2');
  assert.deepEqual(chat.data.confirmation.sections, [{ number: 2, name: 'Regionale 11' }]);

  // A map choice is enough to generate; after generation the map is closed.
  const { status } = await generateAndWait(id);
  assert.equal(status.status, 'completed');
  const late = await call('POST', `/internal/agent/sessions/${id}/confirm-map`, { body: { section_numbers: [1] } });
  assert.equal(late.status, 409);
  assert.match(late.data.error, /already been generated/);
});

test('map choice is refused while the section search is running or failed', async () => {
  const { id } = await newSessionWithSections(ALICE, [{ place: 'Genova' }, { place: 'Nowhere-at-all' }]);
  const r = await call('POST', `/internal/agent/sessions/${id}/confirm-map`, { body: { section_numbers: [1] } });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /search failed/);
});

// ── Maximum gradient ────────────────────────────────────────────────────────

test('max_gradient_percent: validated (1-6), passed to the geometry step, recorded in the summary', async () => {
  const { id } = await newSessionWithSections();
  await call('POST', `/internal/agent/sessions/${id}/confirm`, { body: { section_numbers: [1], user_reply: '1' } });
  for (const bad of [0.5, 7, 'steep', true]) {
    const r = await call('POST', `/internal/agent/sessions/${id}/generate`, { body: { max_gradient_percent: bad } });
    assert.equal(r.status, 400, `value ${JSON.stringify(bad)}`);
    assert.match(r.data.error, /between 1 and 6/);
  }
  const started = await call('POST', `/internal/agent/sessions/${id}/generate`, { body: { max_gradient_percent: 2.5 } });
  assert.equal(started.status, 200);
  assert.equal(started.data.max_gradient_percent, 2.5);
  const status = await waitFor(async () => {
    const r = await call('GET', `/internal/agent/jobs/${started.data.job_id}`);
    return r.data.status === 'completed' ? r.data : null;
  }, 'generation');
  assert.equal(lastGeometryData.maxGradientPercent, 2.5);
  assert.equal(status.summary.settings.max_gradient_percent, 2.5);
  const state = await call('GET', `/internal/agent/sessions/${id}`);
  assert.equal(state.data.generation.max_gradient_percent, 2.5);
});

// ── Serious problems (no elevation data) ────────────────────────────────────

test('no elevation data: completed_with_problems, the problem first and in full, also in the session', async () => {
  elevationAvailable = false;
  const { id } = await newSessionWithSections();
  await call('POST', `/internal/agent/sessions/${id}/confirm`, { body: { section_numbers: [1], user_reply: '1' } });
  const started = await call('POST', `/internal/agent/sessions/${id}/generate`, { body: {} });
  const status = await waitFor(async () => {
    const r = await call('GET', `/internal/agent/jobs/${started.data.job_id}`);
    return r.data.status !== 'queued' && r.data.status !== 'running' ? r.data : null;
  }, 'generation');
  assert.equal(status.status, 'completed_with_problems');
  assert.equal(Object.keys(status).filter(k => k !== 'success')[0], 'serious_problems', 'serious problems are the first thing in the answer (the Controller drops success)');
  assert.equal(status.serious_problems.length, 1);
  assert.match(status.serious_problems[0], /^No elevation data: all altitudes are 0, so this geometry cannot be used as it is/);
  assert.match(status.serious_problems[0], /429/);
  assert.match(status.serious_problems[0], /Wait 15-30 minutes/);
  assert.match(status.serious_problems_note, /Tell the user about each of these first/);
  assert.equal(status.summary.routes[0].elevation_data, false);
  assert.ok(status.outputs.length > 0, 'the files are still listed (the user may want to look at them)');

  const state = await call('GET', `/internal/agent/sessions/${id}`);
  assert.equal(state.data.state, 'ready');
  assert.match(state.data.what_next, /serious_problems/);
  assert.equal(Object.keys(state.data.generation)[0], 'serious_problems');
  assert.equal(state.data.generation.status, 'completed_with_problems');
  assert.equal((await call('GET', `/internal/agent/sessions/${id}/download`)).status, 200, 'download still possible');
});

// ── Website routes ──────────────────────────────────────────────────────────

test('website: maximum gradient checked by the geometry route; geometry ZIP named with the run\'s stamp', async () => {
  const plain = { 'Content-Type': 'application/json' };
  const created = await call('POST', '/api/file-generator/sessions', { headers: plain });
  const id = created.data.session.id;
  for (const bad of [0, 9, 'x']) {
    const r = await call('POST', '/api/file-generator/geometry/generate', { headers: plain, body: { sessionId: id, maxGradientPercent: bad } });
    assert.equal(r.status, 400, `maxGradientPercent ${bad}`);
    assert.match(r.data.error, /between 1 and 6/);
  }
  // Without the field, the route goes on to its usual checks (no sections confirmed yet).
  const noSections = await call('POST', '/api/file-generator/geometry/generate', { headers: plain, body: { sessionId: id } });
  assert.equal(noSections.status, 400);
  assert.match(noSections.data.error, /No confirmed sections/);

  // Geometry ZIP: old name without a stamp, stamped name once a run recorded one.
  const dir = path.join(tempRoot, id, 'geometry');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'A_-_B.csv'), geometryCsv('A - B'));
  const before = await call('GET', `/api/file-generator/sessions/${id}/download-geometry`, { headers: plain });
  assert.equal(before.status, 200);
  assert.match(before.headers.get('content-disposition'), new RegExp(`traxim-geometry-${id}\\.zip`));
  const file = path.join(tempRoot, id, 'session.json');
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  meta.outputStamp = '2026-10-16_093012';
  fs.writeFileSync(file, JSON.stringify(meta));
  const after = await call('GET', `/api/file-generator/sessions/${id}/download-geometry`, { headers: plain });
  assert.match(after.headers.get('content-disposition'), /filename="Geometry_2026-10-16_093012\.zip"/);
  assert.deepEqual(zipEntryNames(after.buffer), ['A_-_B.csv'], 'geometry file names unchanged');
});
