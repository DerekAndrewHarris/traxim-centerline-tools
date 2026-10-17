/**
 * Elevation of alternative routes at their ends (17 Oct 2026).
 *
 * The case: La Spezia Centrale - Vezzano Ligure alt4 starts inside the tunnel
 * east of Riomaggiore (the two directional tracks separate there without a
 * junction), so there is no portal at its start. The tunnel straight line
 * started from the ground height at the first point - the hillside, ~300 m -
 * and smoothing then shared that error out over the whole 4.4 km, leaving
 * the route 86 m too high where it meets the main line at La Spezia
 * Centrale (~17 m).
 *
 * All data here is synthetic (a straight route along a parallel, 25 m point
 * spacing). Run with:  npm test   (no network)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  applyGradientEnvelopeSmoothing,
  applyPortalElevationInterpolation,
  anchorRouteEnds,
  elevationNearPoint,
  largeSmoothingCorrectionWarnings,
  DEFAULT_RULING_GRADIENT
} = await import('../backend/services/geometry/processor.js');

const SPACING_M = 25;
const LENGTH_M = 4400;
const N = LENGTH_M / SPACING_M + 1;              // 177 points
const PORTAL_M = 3375;                           // the tunnel runs from km 0 to here
const LAT = 44.1;
const M_PER_DEG_LON = 111320 * Math.cos(LAT * Math.PI / 180);

const chainage = Array.from({ length: N }, (_, i) => i * SPACING_M);
const coords = chainage.map(m => ({ lat: LAT, lon: 9.76 + m / M_PER_DEG_LON }));

/** Ground height (what the elevation data gives): a hillside over the tunnel, then the coast. */
function groundAt(m) {
  if (m < PORTAL_M) return 300 - (300 - 38) * (m / PORTAL_M); // hillside above the tunnel
  return 38 - (38 - 17) * ((m - PORTAL_M) / (LENGTH_M - PORTAL_M));
}

/** The railway's real height: 20 m in the tunnel at the start, then down to 17 m. */
const TRUE_START = 20;
const TRUE_END = 17;

const tunnel = [{ startM: 0, endM: PORTAL_M }];

/** A route profile ~4 m to the side of the given point (the other directional track / the main route). */
function sideProfile(label, centre, elevation) {
  const off = 4 / 110540;
  return {
    label,
    points: [-200, 0, 200].map(dm => ({ lat: centre.lat + off, lon: centre.lon + dm / M_PER_DEG_LON, elevation }))
  };
}

function maxGradient(values) {
  let g = 0;
  for (let i = 1; i < values.length; i++) {
    g = Math.max(g, Math.abs(values[i] - values[i - 1]) / (chainage[i] - chainage[i - 1]));
  }
  return g;
}

/** The order generateAlternativeGeometry works in: ends, tunnel/bridge lines, smoothing. */
function altProfile(profiles) {
  const elevations = chainage.map(m => ({ elevation: groundAt(m) }));
  const { anchors, warnings } = anchorRouteEnds({
    elevations, coords, pointChainageM: chainage, intervals: tunnel, profiles, routeLabel: 'Test_alt4'
  });
  applyPortalElevationInterpolation(elevations, chainage, tunnel);
  const raw = elevations.map(e => e.elevation);
  const result = applyGradientEnvelopeSmoothing(raw, chainage, DEFAULT_RULING_GRADIENT, [], anchors);
  return { raw, ...result, anchors, warnings };
}

// ── The old behaviour, for reference ─────────────────────────────────────────

test('reference: without anchoring, the tunnel start error reaches the other end (the 17 Oct case)', () => {
  const elevations = chainage.map(m => ({ elevation: groundAt(m) }));
  applyPortalElevationInterpolation(elevations, chainage, tunnel);
  const raw = elevations.map(e => e.elevation);
  assert.equal(raw[0], 300, 'the tunnel line starts at the hillside height');
  const { smoothed } = applyGradientEnvelopeSmoothing(raw, chainage);
  assert.ok(smoothed[N - 1] - TRUE_END > 60, `end is far too high: ${smoothed[N - 1].toFixed(1)} m`);
});

// ── Smoothing with anchors ───────────────────────────────────────────────────

test('smoothing: an error at the start does not move an anchored end', () => {
  const raw = chainage.map(groundAt);                       // 300 m at the start: wrong
  const { smoothed } = applyGradientEnvelopeSmoothing(raw, chainage, DEFAULT_RULING_GRADIENT, [],
    [{ index: N - 1, elevation: TRUE_END }]);
  assert.equal(smoothed[N - 1], TRUE_END, 'the anchored end keeps its known height');
  assert.ok(maxGradient(smoothed) <= DEFAULT_RULING_GRADIENT + 1e-9, 'still within the maximum gradient');
  // The error is confined to where it is: the last kilometre is within a few metres of the raw data.
  for (let i = 0; i < N; i++) {
    if (chainage[i] >= PORTAL_M + 200) assert.ok(Math.abs(smoothed[i] - raw[i]) < 5, `km ${chainage[i] / 1000}`);
  }
});

test('smoothing: anchors at both ends hold both ends, within the maximum gradient', () => {
  const raw = chainage.map(groundAt);
  const { smoothed, anchorConflict } = applyGradientEnvelopeSmoothing(raw, chainage, DEFAULT_RULING_GRADIENT, [],
    [{ index: 0, elevation: TRUE_START }, { index: N - 1, elevation: TRUE_END }]);
  assert.equal(smoothed[0], TRUE_START);
  assert.equal(smoothed[N - 1], TRUE_END);
  assert.equal(anchorConflict, false);
  assert.ok(maxGradient(smoothed) <= DEFAULT_RULING_GRADIENT + 1e-9);
});

test('smoothing: no anchors gives exactly the old result; feasible data is untouched with anchors', () => {
  const raw = chainage.map(groundAt);
  const before = applyGradientEnvelopeSmoothing(raw, chainage);
  const withEmpty = applyGradientEnvelopeSmoothing(raw, chainage, DEFAULT_RULING_GRADIENT, [], []);
  assert.deepEqual(withEmpty.smoothed, before.smoothed);
  const gentle = chainage.map(m => 20 + m * 0.01);
  const g = applyGradientEnvelopeSmoothing(gentle, chainage, DEFAULT_RULING_GRADIENT, [],
    [{ index: 0, elevation: gentle[0] }, { index: N - 1, elevation: gentle[N - 1] }]);
  assert.deepEqual(g.smoothed, gentle);
  assert.equal(g.adjustedCount, 0);
});

test('smoothing: anchors too far apart in height for the gradient are reported', () => {
  const raw = chainage.map(() => 50);
  const { anchorConflict } = applyGradientEnvelopeSmoothing(raw, chainage, DEFAULT_RULING_GRADIENT, [],
    [{ index: 0, elevation: 0 }, { index: N - 1, elevation: 500 }]);   // 500 m in 4.4 km = 11%
  assert.equal(anchorConflict, true);
});

// ── Route ends ───────────────────────────────────────────────────────────────

test('nearest profile height: interpolated along the line, only within the distance limit', () => {
  const prof = { label: 'Main', points: [{ lat: LAT, lon: 9.76, elevation: 10 }, { lat: LAT, lon: 9.76 + 100 / M_PER_DEG_LON, elevation: 20 }] };
  const hit = elevationNearPoint({ lat: LAT + 5 / 110540, lon: 9.76 + 50 / M_PER_DEG_LON }, [prof]);
  assert.ok(Math.abs(hit.elevation - 15) < 0.01);
  assert.ok(Math.abs(hit.distanceM - 5) < 0.1);
  assert.equal(hit.label, 'Main');
  assert.equal(elevationNearPoint({ lat: LAT + 100 / 110540, lon: 9.76 }, [prof]), null, '100 m away: too far');
});

test('alternative starting inside a tunnel takes its start height from the route it meets', () => {
  const profiles = [
    sideProfile('Main', coords[N - 1], TRUE_END),                      // rejoins the main route at its end
    sideProfile('Previous segment_alt2', coords[0], TRUE_START)        // the other directional track, in the tunnel
  ];
  const r = altProfile(profiles);
  assert.ok(Math.abs(r.raw[0] - TRUE_START) < 0.01, `raw start ${r.raw[0]} (was the hillside, 300 m)`);
  assert.ok(Math.abs(r.smoothed[0] - TRUE_START) < 0.01, `smoothed start ${r.smoothed[0]}`);
  assert.ok(Math.abs(r.smoothed[N - 1] - TRUE_END) < 0.01, `smoothed end ${r.smoothed[N - 1]}`);
  assert.ok(maxGradient(r.smoothed) <= DEFAULT_RULING_GRADIENT + 1e-9);
  assert.equal(r.anchors.length, 2);
  // The tunnel line now runs from the start height to the far portal.
  assert.ok(r.raw[Math.round(PORTAL_M / 2 / SPACING_M)] < 40, 'mid-tunnel is near the real level, not the hillside');
  assert.ok(r.warnings.some(w => /^Elevation anchor: Test_alt4 starts inside a tunnel/.test(w)), r.warnings.join('\n'));
  assert.deepEqual(largeSmoothingCorrectionWarnings('Test_alt4', r.raw, r.smoothed, chainage), [], 'nothing left to check');
});

test('alternative starting inside a tunnel with no route nearby: level from the portal, with a warning', () => {
  const r = altProfile([sideProfile('Main', coords[N - 1], TRUE_END)]);
  const portalIdx = chainage.findIndex(m => m > PORTAL_M);
  assert.ok(Math.abs(r.raw[0] - groundAt(chainage[portalIdx])) < 0.01, `start set to the portal height, got ${r.raw[0]}`);
  assert.ok(Math.abs(r.smoothed[N - 1] - TRUE_END) < 0.01);
  const w = r.warnings.find(x => /^ELEVATION CHECK: Test_alt4 starts inside a tunnel/.test(x));
  assert.ok(w, r.warnings.join('\n'));
  assert.match(w, /guess/);
  assert.match(w, /300\.0 m/, 'names the ground height it did not use');
});

test('an end that meets a route at a very different height from the ground is flagged', () => {
  const elevations = chainage.map(() => ({ elevation: 100 }));
  const { anchors, warnings } = anchorRouteEnds({
    elevations, coords, pointChainageM: chainage, intervals: [], profiles: [sideProfile('Main', coords[0], 20)], routeLabel: 'X_alt1'
  });
  assert.deepEqual(anchors, [{ index: 0, elevation: 20 }]);
  assert.equal(elevations[0].elevation, 20);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^ELEVATION CHECK: X_alt1: where it starts it meets Main/);
});

test('ends not near any route and not in a tunnel are left alone', () => {
  const elevations = chainage.map(m => ({ elevation: groundAt(m) }));
  const { anchors, warnings } = anchorRouteEnds({
    elevations, coords, pointChainageM: chainage, intervals: [], profiles: [], routeLabel: 'X_alt1'
  });
  assert.deepEqual(anchors, []);
  assert.deepEqual(warnings, []);
  assert.equal(elevations[0].elevation, 300);
});

test('a route starting at a tunnel portal (possible ground height) keeps the ground height, without a warning', () => {
  // Ground at the start 60 m, portal end 38 m over 3.4 km: 0.65%, possible.
  const elevations = chainage.map(m => ({ elevation: m < PORTAL_M ? 60 - 22 * (m / PORTAL_M) : groundAt(m) }));
  const { anchors, warnings } = anchorRouteEnds({
    elevations, coords, pointChainageM: chainage, intervals: tunnel, profiles: [], routeLabel: 'X_alt1'
  });
  assert.deepEqual(anchors, []);
  assert.deepEqual(warnings, []);
  assert.equal(elevations[0].elevation, 60);
});

// ── Main routes: the join with the previous segment (Derek, 17 Oct 2026) ─────

const { correctRouteElevations } = await import('../backend/services/geometry/generator.js');

/** The previous segment's finished route, ending (with its overshoot) around the start of this one. */
function previousSegment(elevation) {
  const pts = [];
  for (let m = -1500; m <= 1000; m += 25) pts.push({ lat: LAT + 3 / 110540, lon: 9.76 + m / M_PER_DEG_LON, elevation });
  return { label: 'Previous segment', points: pts };
}

function mainRoute(profiles, groundFn, intervals = []) {
  const elevations = chainage.map(m => ({ elevation: groundFn(m) }));
  const { anchors, warnings } = correctRouteElevations({
    elevations, points: coords, refCoords: coords, refChainageM: chainage,
    tunnelIntervals: intervals, bridgeIntervals: [], profiles, routeLabel: 'This segment'
  });
  const raw = elevations.map(e => e.elevation);
  const result = applyGradientEnvelopeSmoothing(raw, chainage, DEFAULT_RULING_GRADIENT, [], anchors);
  return { raw, ...result, anchors, warnings };
}

test('main route: its start takes the height of the previous segment there, so the join matches', () => {
  // The elevation data gives 26 m at the shared station; the previous segment's finished line is at 12 m there.
  const r = mainRoute([previousSegment(12)], m => 26 + m * 0.002);
  assert.deepEqual(r.anchors, [{ index: 0, elevation: 12 }]);
  assert.equal(r.smoothed[0], 12, 'join height = previous segment');
  assert.ok(maxGradient(r.smoothed) <= DEFAULT_RULING_GRADIENT + 1e-9);
  // Beyond the gradient reach of the 14 m correction (14 / 0.025 = 560 m) the profile is unchanged.
  for (let i = 0; i < N; i++) if (chainage[i] > 600) assert.ok(Math.abs(r.smoothed[i] - r.raw[i]) < 0.01);
  assert.deepEqual(r.warnings, [], 'a 14 m difference is within the normal error of the data');
});

test('main route: start inside a tunnel takes the previous segment height and the tunnel line starts from it', () => {
  const r = mainRoute([previousSegment(TRUE_START)], groundAt, tunnel);
  assert.equal(r.raw[0], TRUE_START);
  assert.ok(r.raw[Math.round(PORTAL_M / 2 / SPACING_M)] < 40, 'mid-tunnel near the real level, not the hillside');
  assert.equal(r.smoothed[0], TRUE_START);
  assert.ok(r.warnings.some(w => /^Elevation anchor: This segment starts inside a tunnel/.test(w)));
});

test('main route: a join more than 50 m from the ground height is flagged', () => {
  const r = mainRoute([previousSegment(12)], () => 90);
  assert.equal(r.smoothed[0], 12);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /^ELEVATION CHECK: This segment: where it starts it meets Previous segment/);
});

test('main route: first segment (no earlier routes) is unchanged', () => {
  const r = mainRoute([], m => 26 + m * 0.002);
  assert.deepEqual(r.anchors, []);
  assert.equal(r.raw[0], 26);
});
