/**
 * Infrastructure Generator Service
 * 
 * Orchestrates the full infrastructure generation pipeline:
 * 1. Load geometry CSVs (from geometry generation output)
 * 2. Fetch OSM railway nodes (stations, halts, junctions)
 * 3. Create topology nodes from OSM way endpoints
 * 4. Follow chains of degree-2 nodes to find connections
 * 5. Assign F/T/D branches using angle analysis
 * 6. Insert platform nodes
 * 7. Apply spatial separation (30m minimum)
 * 8. Enforce reciprocal links
 * 9. Compute display positions
 * 10. Generate Infrastructure.csv
 */

import fs from 'fs';
import path from 'path';
import { overpassFetch } from '../osm/overpass.js';
import { ipv4Fetch } from '../osm/ipv4fetch.js';
import {
  MIN_NODE_SPACING_M,
  SNAP_THRESHOLD_M,
  haversineM,
  sanitiseName,
  parseCoordKey,
  makeCoordKey,
  buildTopologyAdj,
  splitWaysAtIntermediateJunctions,
  computeWayDirection,
  followChainToNode,
  determineBranch,
  computeDiamondBranchIndices,
  branchToNodeField,
  branchToBranchField,
  fieldToBranch,
  nearestKm,
  projectOntoGeometry,
  enforceReciprocalLinks
} from './processor.js';

// Relation-based topology fetching (osmGeometry.js's fetchSegmentGeometryViaRelations)
// pre-filters relation ways against each segment's bbox expanded by this margin, so
// track that curves outside the nominal segment box is still picked up. Station-anchor
// fetching must use the same margin on the same bbox - otherwise a station just outside
// the raw segment box (but within the expanded corridor) has its trackage/nodes created
// by the topology fetch while never itself becoming a naming anchor, silently pushing
// nearby nodes onto the nearest anchor that WAS fetched instead (confirmed root cause
// of nodes near a station being named after a neighbouring station instead).
const CORRIDOR_MARGIN_DEG = 0.05; // ~5 km

/**
 * Parse geometry CSV file to extract points with km values
 * @param {string} csvContent - CSV file content
 * @returns {{points: Array<{lat: number, lon: number, km: number}>}}
 */
function parseGeometryCsv(csvContent) {
  const lines = csvContent.split('\n').filter(line => line.trim() && !line.startsWith('#'));
  const points = [];
  let sectionName = null;

  for (const line of lines) {
    const parts = line.split(',').map(p => p.trim());
    if (parts.length >= 5) {
      // Column 0 stores the segmentLabel written by the geometry generator
      if (!sectionName && parts[0]) sectionName = parts[0];
      const lat = parseFloat(parts[1]);
      const lon = parseFloat(parts[2]);
      const km = parseFloat(parts[4]);
      
      if (!isNaN(lat) && !isNaN(lon) && !isNaN(km)) {
        points.push({ lat, lon, km });
      }
    }
  }

  return { points, sectionName };
}

/**
 * Fetch railway stations and halts from Overpass for naming anchors
 * @param {string} bbox - Bounding box "minLat,minLon,maxLat,maxLon"
 * @returns {Promise<Array<{id: string, lat: number, lon: number, name: string}>>}
 */
async function fetchStationsFromOverpass(bbox) {
  // Expand by the same margin the topology fetch's relation pre-filter uses (see
  // CORRIDOR_MARGIN_DEG) so a station just outside the raw segment bbox - but inside
  // the corridor the topology fetch actually considers - isn't missed as a naming anchor.
  const parts = bbox.split(',').map(Number);
  const expandedBbox = [
    parts[0] - CORRIDOR_MARGIN_DEG, parts[1] - CORRIDOR_MARGIN_DEG,
    parts[2] + CORRIDOR_MARGIN_DEG, parts[3] + CORRIDOR_MARGIN_DEG
  ].join(',');

  const query = `
    [out:json][timeout:60];
    (
      node["railway"="station"](${expandedBbox});
      node["railway"="halt"](${expandedBbox});
    );
    out body;
  `;

  const data = await overpassFetch(query);
  const stations = [];

  for (const element of data.elements || []) {
    if (element.type === 'node' && element.lat && element.lon) {
      stations.push({
        id: element.id.toString(),
        lat: element.lat,
        lon: element.lon,
        name: element.tags?.name || 'Unnamed Station',
        railwayType: element.tags?.railway || 'station'
      });
    }
  }

  return stations;
}

/**
 * Fetch railway platform ways from Overpass
 * @param {string} bbox - Bounding box "minLat,minLon,maxLat,maxLon"
 * @returns {Promise<Array<{id: string, centLat: number, centLon: number, name: string}>>}
 */
async function fetchPlatformsFromOverpass(bbox) {
  const query = `
    [out:json][timeout:60];
    (
      way["railway"="platform"](${bbox});
      way["public_transport"="platform"]["railway"](${bbox});
    );
    out geom;
  `;

  const data = await overpassFetch(query);
  const platforms = [];

  for (const element of data.elements || []) {
    if (element.type === 'way' && element.geometry && element.geometry.length > 0) {
      // Calculate centroid
      let sumLat = 0, sumLon = 0;
      for (const coord of element.geometry) {
        sumLat += coord.lat;
        sumLon += coord.lon;
      }
      const centLat = sumLat / element.geometry.length;
      const centLon = sumLon / element.geometry.length;

      platforms.push({
        id: element.id.toString(),
        centLat,
        centLon,
        name: element.tags?.name || 'Platform',
        ref: element.tags?.ref || null
      });
    }
  }

  return platforms;
}

/**
 * Fetch railway topology (all railway ways with coordinates) from Overpass
 * @param {string} bbox - Bounding box "minLat,minLon,maxLat,maxLon"
 * @returns {Promise<{ways: Array<{id: string, nodes: string[], coords: Array<{lat: number, lon: number}>}>, taggedNodes: Array}>}
 */
async function fetchRailwayTopologyFromOverpass(bbox) {
  // Fallback: used only when osm_topology.json was not written by the geometry
  // pipeline. Expand bbox by the same corridor margin used everywhere else (see
  // CORRIDOR_MARGIN_DEG) so ways just outside the search area (e.g. bridges,
  // tunnels) are not missed.
  const parts = bbox.split(',').map(Number);
  const expandedBbox = [
    parts[0] - CORRIDOR_MARGIN_DEG, parts[1] - CORRIDOR_MARGIN_DEG,
    parts[2] + CORRIDOR_MARGIN_DEG, parts[3] + CORRIDOR_MARGIN_DEG
  ].join(',');

  const query = `
    [out:json][timeout:120];
    (
      way["railway"~"^(rail|light_rail|subway|tram|narrow_gauge|preserved)$"](${expandedBbox});
    );
    (._;>;);
    out body;
  `;

  const data = await overpassFetch(query);
  
  // Build node lookup
  const nodeById = new Map();
  for (const element of data.elements || []) {
    if (element.type === 'node') {
      nodeById.set(element.id.toString(), {
        lat: element.lat,
        lon: element.lon,
        tags: element.tags || {}
      });
    }
  }

  // Extract ways with coordinates
  const ways = [];
  for (const element of data.elements || []) {
    if (element.type === 'way' && element.nodes && element.nodes.length >= 2) {
      const coords = [];
      const nodeIds = [];
      
      for (const nodeId of element.nodes) {
        const node = nodeById.get(nodeId.toString());
        if (node) {
          coords.push({ lat: node.lat, lon: node.lon });
          nodeIds.push(nodeId.toString());
        }
      }

      if (coords.length >= 2) {
        ways.push({
          id: element.id.toString(),
          nodes: nodeIds,
          coords,
          tags: element.tags || {}
        });
      }
    }
  }

  // Extract tagged nodes (switches, crossovers, signals, buffer stops)
  const taggedNodes = [];
  for (const [nodeId, nodeData] of nodeById) {
    const tags = nodeData.tags;
    if (tags.railway === 'switch' || tags.railway === 'railway_crossing' || 
        tags.railway === 'buffer_stop' || tags.railway === 'signal' ||
        tags.railway === 'level_crossing') {
      taggedNodes.push({
        id: nodeId,
        lat: nodeData.lat,
        lon: nodeData.lon,
        tags
      });
    }
  }

  return { ways, taggedNodes };
}

/**
 * Re-derive km for every node by walking the topology graph in order,
 * instead of trusting each node's own independently-projected km.
 *
 * projectOntoGeometry() picks whichever segment of the region's resampled
 * polyline is geometrically NEAREST, searched across the WHOLE line. In a
 * dense yard or tight curve - especially once parallel tracks have been
 * deduplicated onto one shared centerline (see the geometry pipeline) - a
 * node's true sequential neighbour can end up geometrically farther from it
 * than some OTHER, unrelated point on the line. Two directly-linked nodes
 * can each independently land on a locally "nearest" but sequentially wrong
 * segment, producing a non-monotonic ("dip") km sequence even though
 * neither node's own projection was unreasonable in isolation.
 *
 * Fix: walk the F/T "through" chain in topological order from a seed, and
 * project each subsequent node only onto the PART of the polyline at or
 * after its predecessor's own matched position. A match's index can then
 * only be >= the one before it, so a dip is structurally impossible for the
 * walked chain - no comparison of old km values is needed (and wouldn't
 * help: the old km is exactly what's unreliable here).
 *
 * D/X (diverging) branches are NOT walked with this forward constraint -
 * they may legitimately run back on themselves - so they keep the
 * unconstrained whole-line search, same as before. Their own further F/T
 * continuations still get the constraint, relative to wherever the branch
 * itself was found.
 *
 * The seed for each region is whichever node's EXISTING projected km is
 * closest to the region's own minimum (its topological start) - endpoints
 * are far less likely to sit in an ambiguous dense-yard/parallel-track spot
 * than nodes deep inside a busy throat, so trusting the original projection
 * there is safe. Nodes never reached by the walk (disconnected fragments)
 * keep their original independently-projected km unchanged.
 */
function reprojectKmAlongTopology(nodes, geometryBySection) {
  const nodeByName = new Map(nodes.map(n => [n.name, n]));
  const ARMS = ['fNode', 'tNode', 'dNode', 'xNode'];

  function getKmOnGeo(node, geo) {
    if (node.region === geo) return node.km;
    if (node.region2 === geo) return node.km2;
    if (node.region3 === geo) return node.km3;
    return null;
  }
  function setKmOnGeo(node, geo, val) {
    if (node.region === geo) node.km = val;
    else if (node.region2 === geo) node.km2 = val;
    else if (node.region3 === geo) node.km3 = val;
  }
  // Index of the last point whose km is <= targetKm, i.e. where a forward
  // search starting from targetKm should resume from.
  function indexAtOrBefore(points, fromIdx, targetKm) {
    let idx = fromIdx;
    for (let i = fromIdx; i < points.length; i++) {
      if (points[i].km <= targetKm) idx = i; else break;
    }
    return idx;
  }

  for (const [region, points] of geometryBySection) {
    if (!points || points.length < 2) continue;
    const regionNodes = nodes.filter(n => n.region === region || n.region2 === region || n.region3 === region);
    if (regionNodes.length === 0) continue;

    const geomMinKm = Math.min(...points.map(p => p.km));
    let seed = null, seedDist = Infinity;
    for (const n of regionNodes) {
      const k = getKmOnGeo(n, region);
      if (k == null) continue;
      const d = Math.abs(k - geomMinKm);
      if (d < seedDist) { seedDist = d; seed = n; }
    }
    if (!seed) continue;

    const seedProj = projectOntoGeometry({ lat: seed.lat, lon: seed.lon }, points);
    setKmOnGeo(seed, region, seedProj.km);
    const seedIdx = indexAtOrBefore(points, 0, seedProj.km);

    const visited = new Set([seed.name]);
    const queue = [{ node: seed, idx: seedIdx }];

    while (queue.length > 0) {
      const { node: cur, idx: curIdx } = queue.shift();
      for (const armField of ARMS) {
        const nbName = cur[armField];
        if (!nbName) continue;
        const nb = nodeByName.get(nbName);
        if (!nb || visited.has(nb.name)) continue;
        if (nb.region !== region && nb.region2 !== region && nb.region3 !== region) continue;

        const isThrough = armField === 'fNode' || armField === 'tNode';
        let projKm, nbIdx;

        if (isThrough) {
          // A "through" (F/T) arm continues the chain, but which physical
          // direction that means isn't fixed - it depends on how
          // determineBranch labelled this node's arms, not on which way the
          // walk has been going so far. Forcing every through-arm to search
          // only forward from curIdx (the fix for the original non-monotonic
          // "dip" bug) silently breaks when THIS arm actually continues
          // backward: the neighbour's true position falls outside the
          // forward slice entirely, so it gets clamped to whatever's nearest
          // at the wrong end instead (confirmed case: a node ~2.5km behind
          // curIdx got projected right on top of it). Try both directions
          // and keep whichever actually lands closer to the neighbour's real
          // coordinates - forward wins ties, preserving the original
          // anti-dip guarantee for the ordinary case.
          const fwdPoints = points.slice(curIdx);
          const bwdPoints = points.slice(0, curIdx + 1);
          const fwdProj = fwdPoints.length > 0 ? projectOntoGeometry({ lat: nb.lat, lon: nb.lon }, fwdPoints) : null;
          const bwdProj = bwdPoints.length > 0 ? projectOntoGeometry({ lat: nb.lat, lon: nb.lon }, bwdPoints) : null;
          const fwdDist = fwdProj ? haversineM(nb, { lat: fwdProj.projLat, lon: fwdProj.projLon }) : Infinity;
          const bwdDist = bwdProj ? haversineM(nb, { lat: bwdProj.projLat, lon: bwdProj.projLon }) : Infinity;

          const useForward = fwdDist <= bwdDist;
          const chosen = useForward ? fwdProj : bwdProj;
          projKm = useForward ? Math.max(chosen.km, points[curIdx].km) : Math.min(chosen.km, points[curIdx].km);
          nbIdx = useForward
            ? indexAtOrBefore(points, curIdx, projKm)
            : indexAtOrBefore(points, 0, projKm);
        } else {
          const proj = projectOntoGeometry({ lat: nb.lat, lon: nb.lon }, points);
          projKm = proj.km;
          nbIdx = indexAtOrBefore(points, 0, projKm);
        }

        setKmOnGeo(nb, region, projKm);
        visited.add(nb.name);
        queue.push({ node: nb, idx: nbIdx });
      }
    }
  }
}

/**
 * Ensure connected node pairs sharing a region have km values at least
 * MIN_NODE_SPACING_M / 1000 km apart.  Iteratively pushes km values apart
 * from their midpoint when they are too close.
 */
function ensureKmSeparation(nodes, geometryBySection) {
  const minKmSpacing = MIN_NODE_SPACING_M / 1000;
  const EPS = 1e-9;  // floating-point tolerance for km comparisons
  const nodeByName = new Map(nodes.map(n => [n.name, n]));
  const arms = [['fNode','fOnBranch'], ['tNode','tOnBranch'], ['dNode','dOnBranch'], ['xNode','xOnBranch']];

  // Helpers to read/write km for any geometry slot on a node
  function getKmOnGeo(node, geo) {
    if (node.region === geo) return node.km;
    if (node.region2 === geo) return node.km2;
    if (node.region3 === geo) return node.km3;
    return null;
  }
  function setKmOnGeo(node, geo, val) {
    if (node.region === geo) node.km = val;
    else if (node.region2 === geo) node.km2 = val;
    else if (node.region3 === geo) node.km3 = val;
  }
  function getGeos(node) {
    const geos = [node.region];
    if (node.region2) geos.push(node.region2);
    if (node.region3) geos.push(node.region3);
    return geos;
  }

  // Geometry bounds cache
  const geoBounds = new Map();
  function getBounds(geo) {
    if (geoBounds.has(geo)) return geoBounds.get(geo);
    const pts = geometryBySection.get(geo);
    const bounds = (pts && pts.length > 0)
      ? { min: Math.min(...pts.map(p => p.km)), max: Math.max(...pts.map(p => p.km)) }
      : { min: -Infinity, max: Infinity };
    geoBounds.set(geo, bounds);
    return bounds;
  }

  // Decide which of two same-geo nodes should sit at the lower km, using
  // each one's OTHER same-geo neighbours (excluding each other) as context:
  // whichever node's wider neighbourhood sits at a higher average km should
  // itself become the higher one. This is the ONLY place that decides
  // direction — both the initial pairwise pass and the cascading propagate
  // step below call it fresh for every pair, rather than propagate
  // inheriting a fixed direction from whatever pair originally triggered
  // it. A node in a densely-interconnected cluster (e.g. three diamonds
  // directly linked to each other) can have neighbours on both sides, so a
  // direction that's correct for the pair that triggered a push is not
  // necessarily correct for every OTHER neighbour that push then finds
  // itself too close to — blindly extending one direction to all of them
  // was pushing some nodes to the wrong side of a node they're directly
  // linked to.
  function decideLoHi(a, b, geo) {
    const avgOtherKm = (node, excludeName) => {
      let sum = 0, count = 0;
      for (const [af] of arms) {
        const nm = node[af];
        if (!nm || nm === excludeName) continue;
        const nb = nodeByName.get(nm);
        if (!nb) continue;
        const k = getKmOnGeo(nb, geo);
        if (k != null) { sum += k; count++; }
      }
      return count > 0 ? sum / count : null;
    };
    const avgA = avgOtherKm(a, b.name);
    const avgB = avgOtherKm(b, a.name);
    if (avgA != null && avgB != null && Math.abs(avgA - avgB) > EPS) {
      return avgA > avgB ? [b, a] : [a, b];
    }
    const kmA = getKmOnGeo(a, geo), kmB = getKmOnGeo(b, geo);
    return kmA <= kmB ? [a, b] : [b, a];
  }

  // Push two too-close nodes apart around their midpoint (clamped to
  // geometry bounds), then recursively check whichever of THEIR other
  // neighbours are now too close, re-deciding direction for each one.
  function pushApart(nodeA, nodeB, geo, visited) {
    const kmA = getKmOnGeo(nodeA, geo), kmB = getKmOnGeo(nodeB, geo);
    const midKm = (kmA + kmB) / 2;
    const { min: gMin, max: gMax } = getBounds(geo);

    let kmLow = midKm - minKmSpacing / 2;
    let kmHigh = midKm + minKmSpacing / 2;
    if (kmLow < gMin) { kmLow = gMin; kmHigh = kmLow + minKmSpacing; }
    if (kmHigh > gMax) { kmHigh = gMax; kmLow = kmHigh - minKmSpacing; }
    kmLow = Math.floor(kmLow * 1000) / 1000;
    kmHigh = Math.ceil(kmHigh * 1000) / 1000;

    const [loNode, hiNode] = decideLoHi(nodeA, nodeB, geo);
    setKmOnGeo(loNode, geo, kmLow);
    setKmOnGeo(hiNode, geo, kmHigh);

    for (const pushedNode of [loNode, hiNode]) {
      const pushedKm = getKmOnGeo(pushedNode, geo);
      for (const [armField] of arms) {
        const otherName = pushedNode[armField];
        if (!otherName) continue;
        const other = nodeByName.get(otherName);
        if (!other || other === loNode || other === hiNode || visited.has(other.name)) continue;
        const otherKm = getKmOnGeo(other, geo);
        if (otherKm == null) continue;
        if (Math.abs(pushedKm - otherKm) >= minKmSpacing - EPS) continue;

        visited.add(pushedNode.name);
        pushApart(pushedNode, other, geo, visited);
      }
    }
  }

  // Outer loop: scan all connected pairs; when a violation is found, push
  // the pair apart.
  for (let iter = 0; iter < 10; iter++) {
    let changed = false;
    for (const node of nodes) {
      for (const [armField] of arms) {
        const targetName = node[armField];
        if (!targetName) continue;
        const target = nodeByName.get(targetName);
        if (!target) continue;

        const sharedGeos = getGeos(node).filter(g => getGeos(target).includes(g));
        for (const geo of sharedGeos) {
          const nKm = getKmOnGeo(node, geo);
          const tKm = getKmOnGeo(target, geo);
          if (nKm == null || tKm == null) continue;
          if (Math.abs(nKm - tKm) >= minKmSpacing - EPS) continue;

          pushApart(node, target, geo, new Set([node.name, target.name]));
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
}

/**
 * Correct nodes whose km falls on the wrong side of neighbours it's directly
 * linked to. reprojectKmAlongTopology() assigns each node's km by walking a
 * BFS spanning tree - a node's value comes from whichever ONE edge first
 * reached it in the queue, and its OTHER edges (real connections that just
 * weren't the BFS parent) are never cross-checked. In a simple chain that's
 * fine, but in a densely-meshed junction cluster (several interlinked
 * diamonds/turnouts) a node can end up locally consistent along the path it
 * was discovered through while still disagreeing with a sibling connection -
 * exactly what the Network Editor's own validator flags (it checks a node's
 * km against ALL of its F/T/D/X neighbours, not just one).
 *
 * F is always the backward (lower- or higher-km, whichever this chain's
 * direction is - see below) side and T is always the opposite, forward
 * side. For a diamond, D is aligned with F's side and X is aligned with T's
 * side (see determineBranch()'s D/X assignment, which pairs D with F and X
 * with T by angular alignment) - so D joins the backward group and X joins
 * the forward group. For a turnout, D is itself the diverging branch
 * alongside T, both forward.
 *
 * Direction (whether "backward" means lower or higher km) isn't fixed
 * globally - it depends on which end of the region's geometry this part of
 * the topology walk started from - so it's inferred per node from the
 * neighbours' own relative values rather than assumed.
 */
function enforceKmOrdering(nodes) {
  const EPS = 1e-9;
  const nodeByName = new Map(nodes.map(n => [n.name, n]));

  function getKmOnGeo(node, geo) {
    if (node.region === geo) return node.km;
    if (node.region2 === geo) return node.km2;
    if (node.region3 === geo) return node.km3;
    return null;
  }
  function setKmOnGeo(node, geo, val) {
    if (node.region === geo) node.km = val;
    else if (node.region2 === geo) node.km2 = val;
    else if (node.region3 === geo) node.km3 = val;
  }
  function getGeos(node) {
    const geos = [node.region];
    if (node.region2) geos.push(node.region2);
    if (node.region3) geos.push(node.region3);
    return geos;
  }

  const MAX_PASSES = 8;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let anyFixed = false;

    for (const node of nodes) {
      const isDiamond = node.railwayType === 'diamond';
      const backwardArms = isDiamond ? ['fNode', 'dNode'] : ['fNode'];
      const forwardArms = isDiamond ? ['tNode', 'xNode'] : ['tNode', 'dNode'];

      for (const geo of getGeos(node)) {
        if (!geo) continue;
        const currentKm = getKmOnGeo(node, geo);
        if (currentKm == null) continue;

        const backwardKms = [];
        for (const arm of backwardArms) {
          const nb = nodeByName.get(node[arm]);
          if (!nb) continue;
          const k = getKmOnGeo(nb, geo);
          if (k != null) backwardKms.push(k);
        }
        const forwardKms = [];
        for (const arm of forwardArms) {
          const nb = nodeByName.get(node[arm]);
          if (!nb) continue;
          const k = getKmOnGeo(nb, geo);
          if (k != null) forwardKms.push(k);
        }

        if (backwardKms.length > 0 && forwardKms.length > 0) {
          // Through node: current must sit on the far side of EVERY backward
          // neighbour from EVERY forward neighbour. Mirrors the Network
          // Editor's own check exactly: current is valid if it's above the
          // backward group and at or below the forward group's max (an
          // "increasing" chain), OR below the backward group and at or
          // above the forward group's min (a "decreasing" chain) - a node's
          // own forward group can legitimately spread across a wide range
          // (e.g. a diamond's T and X ends), so only the LOOSEST forward
          // bound may be used, not the tightest, or an already-valid node
          // gets wrongly flagged.
          const backwardMax = Math.max(...backwardKms);
          const backwardMin = Math.min(...backwardKms);
          const forwardMax = Math.max(...forwardKms);
          const forwardMin = Math.min(...forwardKms);

          const validIncreasing = currentKm > backwardMax + EPS && currentKm <= forwardMax + EPS;
          const validDecreasing = currentKm < backwardMin - EPS && currentKm >= forwardMin - EPS;
          if (validIncreasing || validDecreasing) continue;

          const increasing = (backwardMax + backwardMin) < (forwardMax + forwardMin);
          if (increasing) {
            if (backwardMax >= forwardMax - EPS) continue; // neighbours themselves conflict - leave for another pass
            setKmOnGeo(node, geo, (backwardMax + forwardMax) / 2);
          } else {
            if (backwardMin <= forwardMin + EPS) continue;
            setKmOnGeo(node, geo, (backwardMin + forwardMin) / 2);
          }
          anyFixed = true;
        } else if (backwardKms.length >= 2 || forwardKms.length >= 2) {
          // Endpoint node: every same-region neighbour is on one side (e.g.
          // an alt-route spur's dead end, whose T and D both lead back into
          // the mesh but nothing continues past it). Current must sit
          // outside the span of that single group, not wedged inside it.
          const group = backwardKms.length >= 2 ? backwardKms : forwardKms;
          const groupMin = Math.min(...group);
          const groupMax = Math.max(...group);
          if (currentKm <= groupMin + EPS || currentKm >= groupMax - EPS) continue; // already outside - valid

          // Move to whichever side is the smaller adjustment, clearing it by a
          // full minimum-spacing margin rather than landing exactly on the
          // boundary (which ensureKmSeparation would then have to push apart
          // again from a zero-distance tie).
          const margin = MIN_NODE_SPACING_M / 1000;
          if (currentKm - groupMin < groupMax - currentKm) {
            setKmOnGeo(node, geo, groupMin - margin);
          } else {
            setKmOnGeo(node, geo, groupMax + margin);
          }
          anyFixed = true;
        }
      }
    }

    if (!anyFixed) break;
  }
}

/**
 * Generate infrastructure CSV for all confirmed sections
 * @param {Array<{name: string, regionName: string, osmId: string}>} confirmedSections - Confirmed railway sections
 * @param {string} networkName - Network name for CSV header
 * @param {string} geometryDir - Directory containing geometry CSVs
 * @param {string} bbox - Bounding box for Overpass queries
 * @param {Function} progressCallback - Progress callback (percent, message)
 * @param {string} [sessionPath] - Session directory for caching OSM data
 * @returns {Promise<{csv: string, nodeCount: number, connectionCount: number, warnings: string[]}>}
 */
async function generateInfrastructureForSections(confirmedSections, networkName, geometryDir, bbox, progressCallback, sessionPath) {
  const warnings = [];
  const nodes = [];

  // Progress tracking
  const updateProgress = (percent, message) => {
    if (progressCallback) progressCallback(percent, message);
  };

  updateProgress(0, 'Loading geometry CSVs');

  // ── Step 1: Load geometry CSVs ──
  // Scan the geometry directory for all centerline CSVs (main + alternates).
  // Exclude wayids diagnostic files only.
  const geometryBySection = new Map();
  const csvFiles = fs.readdirSync(geometryDir).filter(f =>
    f.endsWith('.csv') && !f.includes('_wayids')
  );

  for (const csvFile of csvFiles) {
    const csvPath = path.join(geometryDir, csvFile);
    const csvContent = fs.readFileSync(csvPath, 'utf-8');
    const { points, sectionName: csvSectionName } = parseGeometryCsv(csvContent);
    // Use the label stored inside the CSV (column 0) so it matches the geometry file exactly.
    // Fall back to the filename if column 0 is absent.
    const sectionName = csvSectionName || csvFile.replace(/\.csv$/, '').replace(/_/g, ' ');
    if (points.length >= 2) {
      geometryBySection.set(sectionName, points);
    } else {
      warnings.push(`Geometry CSV "${csvFile}" has fewer than 2 valid points — skipped.`);
    }
  }

  if (geometryBySection.size === 0) {
    warnings.push('No valid geometry CSVs found in geometry directory.');
  }

  // Step 2 removed: nodes are created only where OSM topology implies a need
  // (junctions, switches, etc.), not at arbitrary geometry file boundaries.

  updateProgress(20, 'Fetching station nodes from Overpass');

  // ── Step 3: Fetch stations for naming anchors ──
  let stationAnchors = [];
  if (bbox) {
    const cacheFile = sessionPath ? path.join(sessionPath, 'osm_stations.json') : null;
    if (cacheFile && fs.existsSync(cacheFile)) {
      stationAnchors = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      warnings.push(`Loaded ${stationAnchors.length} cached station(s) from osm_stations.json.`);
    } else {
      try {
        stationAnchors = await fetchStationsFromOverpass(bbox);
        if (cacheFile) fs.writeFileSync(cacheFile, JSON.stringify(stationAnchors), 'utf-8');
        if (stationAnchors.length > 0) {
          warnings.push(`Fetched ${stationAnchors.length} railway station(s)/halt(s) from Overpass for naming anchors.`);
        }
      } catch (error) {
        warnings.push(`Station fetch from Overpass failed: ${error.message}. Station-based naming will be unavailable.`);
      }
    }
  }
  // Diagnostic: list every station anchor actually available for the naming
  // pass, so a "wrong station won" naming complaint can be checked directly
  // against what was fetched rather than guessed at.
  if (stationAnchors.length > 0) {
    warnings.push(
      `Naming anchors available (${stationAnchors.length}): ` +
      stationAnchors.map(a => `"${a.name}" (${a.lat.toFixed(4)},${a.lon.toFixed(4)})`).join(', ')
    );
  }

  updateProgress(30, 'Fetching railway topology from Overpass');

  // ── Step 4: Fetch railway topology ──
  let topology = { ways: [], taggedNodes: [] };
  if (bbox) {
    const cacheFile = sessionPath ? path.join(sessionPath, 'osm_topology.json') : null;
    if (cacheFile && fs.existsSync(cacheFile)) {
      topology = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      warnings.push(`Loaded ${topology.ways.length} cached ways and ${topology.taggedNodes.length} tagged nodes from osm_topology.json.`);
    } else {
      try {
        topology = await fetchRailwayTopologyFromOverpass(bbox);
        if (cacheFile) fs.writeFileSync(cacheFile, JSON.stringify(topology), 'utf-8');
        warnings.push(`Fetched ${topology.ways.length} railway ways and ${topology.taggedNodes.length} tagged nodes from Overpass.`);
      } catch (error) {
        warnings.push(`Railway topology fetch failed: ${error.message}. Topology-based nodes will not be created.`);
      }
    }
  }

  updateProgress(40, 'Building topology nodes');

  // ── Step 5: Split ways at intermediate junctions ──
  const splitTopo = splitWaysAtIntermediateJunctions(topology);
  if (splitTopo._splitWaysCount > 0) {
    warnings.push(`Topology: split ${splitTopo._splitWaysCount} ways at intermediate junction nodes.`);
  }

  const waysById = new Map(splitTopo.ways.map(w => [w.id, w]));
  const adj = buildTopologyAdj(splitTopo);

  updateProgress(50, 'Creating junction and endpoint nodes');

  // Buffer-stop coordinate lookup for relaxed proximity in Step 6
  const bufferStopCoordKeys = new Set();
  if (topology.taggedNodes) {
    for (const tn of topology.taggedNodes) {
      if (tn.tags?.railway === 'buffer_stop') {
        bufferStopCoordKeys.add(makeCoordKey(tn.lat, tn.lon));
      }
    }
  }

  // ── Step 6: Create topology nodes (degree-based) ──
  const topoNodesBySection = new Map();
  // Proximity threshold: only assign a junction to a section if it falls
  // within ~50 m of that section's geometry line.  The geometry is sampled at
  // 25 m intervals so a junction on its own track is at most ~15 m from the
  // nearest sample point; 50 m gives margin while excluding adjacent tracks.
  const SECTION_PROXIMITY_SQ = (50 / 111320) ** 2;

  // Sort sections: sections with wayids files first (mainlines before alts).
  // This ensures that when multiple sections share a junction, the mainline
  // creates the primary topology nodes and alt sections defer to them.
  const sortedSections = [...geometryBySection.entries()].sort((a, b) => {
    const aHasWayids = fs.existsSync(path.join(geometryDir, a[0].replace(/ /g, '_') + '_wayids.csv'));
    const bHasWayids = fs.existsSync(path.join(geometryDir, b[0].replace(/ /g, '_') + '_wayids.csv'));
    if (aHasWayids && !bHasWayids) return -1;
    if (!aHasWayids && bHasWayids) return 1;
    return 0;
  });

  // Track which coord keys have already had topology nodes created, to avoid
  // duplicate nodes when multiple sections share a junction.
  const processedCoordKeys = new Map(); // coordKey → node or [nodeA, nodeB]

  for (const [sectionName, points] of sortedSections) {
    const topoNodes = new Map();

    for (const [coordKey, conns] of adj) {
      const degree = conns.length;
      if (degree === 2) continue; // Pure through-connection

      const { lat, lon } = parseCoordKey(coordKey);

      // Only assign this junction to the current section if it lies close to
      // that section's geometry.  This prevents distant junctions (e.g. on the
      // mainline) from being incorrectly duplicated onto alternate sections.
      // Degree-1 endpoints with buffer_stop tags use a relaxed 200m threshold
      // so that short sidings branching off the geometry are included.
      let nearestDistSq = Infinity;
      for (const pt of points) {
        const dSq = (pt.lat - lat) ** 2 + (pt.lon - lon) ** 2;
        if (dSq < nearestDistSq) nearestDistSq = dSq;
      }
      const DEADEND_PROXIMITY_SQ = (200 / 111320) ** 2;
      const isTaggedBufferStop = degree === 1 && bufferStopCoordKeys.has(coordKey);
      const proxThreshold = isTaggedBufferStop ? DEADEND_PROXIMITY_SQ : SECTION_PROXIMITY_SQ;
      if (nearestDistSq > proxThreshold) continue;

      // Cross-section deduplication: if another section already created
      // topology nodes at this coord key, reuse them.  This prevents alt
      // sections from duplicating mainline junction nodes.
      const existingAtKey = processedCoordKeys.get(coordKey);
      if (existingAtKey) {
        const km = nearestKm({ lat, lon }, points);
        const existingNodes = Array.isArray(existingAtKey) ? existingAtKey : [existingAtKey];

        // Add region2/region3 to existing nodes
        for (const en of existingNodes) {
          if (en.region !== sectionName) {
            if (!en.region2) {
              en.region2 = sectionName;
              en.km2 = km;
            } else if (en.region2 !== sectionName && !en.region3) {
              en.region3 = sectionName;
              en.km3 = km;
            }
          }
        }

        // Add to current section's topoNodes so chain following can reach here
        topoNodes.set(coordKey, existingNodes.length > 1 ? existingNodes : existingNodes[0]);
        continue;
      }

      // Check for existing node within snap threshold (same section)
      const overlapThreshSq = (SNAP_THRESHOLD_M / 111320) ** 2;
      const existingNode = nodes.find(
        n => n.region === sectionName &&
             (n.lat - lat) ** 2 + (n.lon - lon) ** 2 < overlapThreshSq
      );

      if (existingNode) {
        // Mark existing node with topology data
        if (!existingNode._topoKey) {
          existingNode._topoKey = coordKey;
          existingNode._topoConns = conns;
        }
        topoNodes.set(coordKey, existingNode);
        processedCoordKeys.set(coordKey, existingNode);
        continue;
      }

      const km = nearestKm({ lat, lon }, points);

      // Name from nearby tagged node
      const nearbyTagged = splitTopo.taggedNodes?.find(
        tn => (tn.lat - lat) ** 2 + (tn.lon - lon) ** 2 < (0.0002 ** 2)
      );
      const baseName = nearbyTagged?.tags?.name
        ? sanitiseName(nearbyTagged.tags.name)
        : `${sectionName} km ${km.toFixed(1)}`;

      // Ensure unique name (for degree-4 junctions, also check " A"/" B" suffixes)
      let nodeName = baseName;
      let idx = 0;
      while (nodes.some(n => n.name === nodeName || n.name === `${nodeName} A` || n.name === `${nodeName} B`)) {
        nodeName = `${baseName} ${String.fromCharCode(65 + idx++)}`;
      }

      if (degree >= 5) {
        // High degree - treat as single turnout
        warnings.push(`Topology: coord ${coordKey} has degree ${degree} — treating as single turnout. Manual correction may be needed.`);
        const node = {
          name: nodeName,
          lat, lon, km,
          region: sectionName,
          railwayType: 'junction',
          _topoKey: coordKey,
          _topoConns: conns
        };
        nodes.push(node);
        topoNodes.set(coordKey, node);
        processedCoordKeys.set(coordKey, node);

      } else if (degree === 4) {
        // Degree-4: diamond crossing.  Two independent tracks cross at grade
        // with no physical connection between them — a single node with all
        // four branches (F, T, D, X) connected.  Which physical track lands
        // on F/T vs D/X, and which end of each pair is which letter, is
        // resolved later by determineBranch() (processor.js) from the way
        // geometry — this step just records the raw topology.
        const node = {
          name: nodeName,
          lat, lon, km,
          region: sectionName,
          railwayType: 'diamond',
          _topoKey: coordKey,
          _topoConns: conns
        };
        nodes.push(node);
        topoNodes.set(coordKey, node);
        processedCoordKeys.set(coordKey, node);
        warnings.push(`Topology: degree-4 key at ${sectionName} km ${km.toFixed(3)} — created diamond crossing "${node.name}".`);

      } else if (degree === 3) {
        // Turnout junction
        const node = {
          name: nodeName,
          lat, lon, km,
          region: sectionName,
          railwayType: 'junction',
          _topoKey: coordKey,
          _topoConns: conns
        };
        nodes.push(node);
        topoNodes.set(coordKey, node);
        processedCoordKeys.set(coordKey, node);

      } else if (degree === 1) {
        // Buffer stop / end node
        const node = {
          name: nodeName,
          lat, lon, km,
          region: sectionName,
          railwayType: 'buffer_stop',
          _topoKey: coordKey,
          _topoConns: conns
        };
        nodes.push(node);
        topoNodes.set(coordKey, node);
        processedCoordKeys.set(coordKey, node);
      }
    }

    topoNodesBySection.set(sectionName, topoNodes);
  }

  updateProgress(60, 'Following chains and assigning branches');

  // ── Step 7: Build real key to nodes mapping ──
  const realKeyToNodes = new Map();
  for (const [, topoNodes] of topoNodesBySection) {
    for (const [key, entry] of topoNodes) {
      if (!realKeyToNodes.has(key)) realKeyToNodes.set(key, []);
      const arr = Array.isArray(entry) ? entry : [entry];
      realKeyToNodes.get(key).push(...arr);
    }
  }

  // ── Step 7b: Filter topology nodes outside the corridor bounding box ──
  // The Overpass query expands the bbox by a margin to capture ways that
  // straddle the boundary.  This can pull in junction nodes that sit outside
  // the actual corridor, creating spurious loops (e.g. balloon loops at the
  // bbox edge).  Removing them here means the chains terminate at the
  // boundary and Step 8e's boundary-node logic creates truncation points.
  // The bbox comes from confirmedSections[].corridorBbox in session.json —
  // the same source the UI draws as the orange dashed rectangle (mainline
  // geometry + 200 m buffer, computed by the geometry pipeline).
  {
    let bMinLat, bMinLon, bMaxLat, bMaxLon;
    let bboxSource;
    if (sessionPath) {
      try {
        const sessionMeta = JSON.parse(fs.readFileSync(path.join(sessionPath, 'session.json'), 'utf-8'));
        const cbs = (sessionMeta.confirmedSections || [])
          .map(s => s.corridorBbox).filter(Boolean);
        if (cbs.length > 0) {
          bMinLat = Math.min(...cbs.map(b => b.minLat));
          bMinLon = Math.min(...cbs.map(b => b.minLon));
          bMaxLat = Math.max(...cbs.map(b => b.maxLat));
          bMaxLon = Math.max(...cbs.map(b => b.maxLon));
          bboxSource = 'corridorBbox';
        }
      } catch { /* session.json read failure — fall through */ }
    }
    if (bboxSource) {
      let filteredCount = 0;
      for (const [key, entries] of [...realKeyToNodes]) {
        const { lat, lon } = parseCoordKey(key);
        if (lat < bMinLat || lat > bMaxLat || lon < bMinLon || lon > bMaxLon) {
          realKeyToNodes.delete(key);
          // Remove associated nodes from the nodes array
          const nodeList = Array.isArray(entries) ? entries : [entries];
          const namesToRemove = new Set(nodeList.map(n => n.name));
          for (let i = nodes.length - 1; i >= 0; i--) {
            if (namesToRemove.has(nodes[i].name)) nodes.splice(i, 1);
          }
          // Remove from topoNodesBySection
          for (const [, sectionTopoNodes] of topoNodesBySection) {
            sectionTopoNodes.delete(key);
          }
          filteredCount += nodeList.length;
        }
      }
      if (filteredCount > 0) {
        warnings.push(`Filtered ${filteredCount} topology node(s) outside the corridor bounding box.`);
      }
    }
  }

  // Build section node key sets
  const sectionNodeKeyMap = new Map();
  for (const [sectionName, topoNodes] of topoNodesBySection) {
    const keys = new Set(topoNodes.keys());
    for (const [k, cands] of realKeyToNodes) {
      if (cands.some(c => c.region === sectionName)) keys.add(k);
    }
    sectionNodeKeyMap.set(sectionName, keys);
  }

  // ── Step 8: Chain following and F/T/D assignment ──
  // For each topo node, call determineBranch on the SOURCE node to map each
  // outgoing way to a specific branch (F/T/D).  Then follow the chain to find
  // the far node, and call determineBranch on the FAR node to find which
  // branch the arriving way connects to.  This guarantees each way maps to
  // exactly one branch on each end — no branch conflicts.
  //
  // Chain following uses the GLOBAL topology key set so that a way leading to
  // a node on a different section (e.g. a siding that branches off the main
  // line into a yard alt-section) is correctly followed to that cross-section
  // node rather than left empty.  Section assignment (node.region / km) is
  // established during Step 6 and is not affected by this global chaining.
  const allTopoNodeKeys = new Set(realKeyToNodes.keys());

  for (const [sectionName, topoNodes] of topoNodesBySection) {
    const sectionNodeKeys = sectionNodeKeyMap.get(sectionName);

    for (const [key, entry] of topoNodes) {
      const nodeList = Array.isArray(entry) ? entry : [entry];

      for (const node of nodeList) {
        const realKey = key;
        const conns = node._topoConns ?? adj.get(realKey) ?? [];
        if (conns.length === 0) continue;

        for (const conn of conns) {
          // Follow the chain to find the far node.
          // Use the global topology key set so the chain crosses section
          // boundaries — a node on alt10 can correctly wire to a node on main.
          const result = followChainToNode(realKey, conn.wayId, waysById, adj, allTopoNodeKeys);
          if (!result) continue;

          let { reachedKey, arrivedViaWayId } = result;
          let candidates = realKeyToNodes.get(reachedKey) ?? [];
          // Phantom-junction pass-through: if the chain ended at a key with
          // no topo node, the way was split at an intermediate shared OSM node
          // but no section geometry was close enough to create a node there.
          // Loop: repeatedly follow sibling split fragments of the same base way
          // until candidates are found or no more siblings exist.
          {
            const visitedPhantoms = new Set([reachedKey]);
            while (candidates.length === 0) {
              const connsAtPhantom = adj.get(reachedKey) ?? [];
              const baseId = arrivedViaWayId.replace(/_\d+$/, '');
              const sibling = connsAtPhantom.find(c =>
                c.wayId !== arrivedViaWayId &&
                c.wayId.replace(/_\d+$/, '') === baseId
              );
              if (!sibling) break;
              const result2 = followChainToNode(reachedKey, sibling.wayId, waysById, adj, allTopoNodeKeys);
              if (!result2) break;
              if (visitedPhantoms.has(result2.reachedKey)) break; // cycle guard
              visitedPhantoms.add(result2.reachedKey);
              reachedKey = result2.reachedKey;
              arrivedViaWayId = result2.arrivedViaWayId;
              candidates = realKeyToNodes.get(reachedKey) ?? [];
            }
          }
          // Prefer a same-section candidate for determinism; if the chain
          // crossed into another section, accept that cross-section node.
          // This is the core of the section-agnostic topology approach:
          // connectivity is established globally first, section assignment
          // (for km / display) remains as set in Step 6.
          let farNode = candidates.find(c => c !== node && c.region === sectionName)
                     ?? candidates.find(c => c !== node);
          if (!farNode) {
            continue;
          }

          // Determine which branch of the FAR node the arriving way connects to
          const farNodeKey = farNode._topoKey || reachedKey;
          let farNodeConns = farNode._topoConns || adj.get(farNodeKey) || [];
          const farBranch = determineBranch(
            farNodeKey, farNodeConns, arrivedViaWayId, waysById, farNode.km, null
          );

          // Determine which branch of THIS (source) node this way belongs to.
          const sourceBranch = determineBranch(
            realKey, conns, conn.wayId, waysById, node.km, null
          );
          if (!sourceBranch) continue;

          // Assign the connection to the source branch
          const nodeField = branchToNodeField(sourceBranch);
          const branchField = branchToBranchField(sourceBranch);

          if (!node[nodeField]) {
            node[nodeField] = farNode.name;
            node[branchField] = farBranch;
          }
        }

      }
    }
  }

  // ── Step 8b: Cross-section connections ──
  // At shared OSM junctions, nodes from different sections coexist at the same
  // topology coordinate.  Connect them via their free arms so that trains can
  // traverse between sections.
  {
    // Build union of all section node keys for cross-section chain following
    const allSectionNodeKeys = new Set();
    for (const keys of sectionNodeKeyMap.values()) {
      for (const k of keys) allSectionNodeKeys.add(k);
    }

    for (const [coordKey, nodeList] of realKeyToNodes) {
      if (nodeList.length < 2) continue;

      // Find all unique sections at this key
      const sections = new Set(nodeList.map(n => n.region));
      if (sections.size < 2) continue;

      // Try to connect each pair of nodes from different sections
      for (let i = 0; i < nodeList.length; i++) {
        const nodeA = nodeList[i];
        for (let j = i + 1; j < nodeList.length; j++) {
          const nodeB = nodeList[j];
          if (nodeA.region === nodeB.region) continue;

          // Already connected?
          if (nodeA.fNode === nodeB.name || nodeA.tNode === nodeB.name ||
              nodeA.dNode === nodeB.name || nodeA.xNode === nodeB.name) continue;

          // Find free arm on each — prefer D (diverging branch to another
          // section). X is only ever a candidate for a diamond crossing.
          const freeArmA = !nodeA.dNode ? 'D' : !nodeA.tNode ? 'T' : !nodeA.fNode ? 'F'
            : (nodeA.railwayType === 'diamond' && !nodeA.xNode) ? 'X' : null;
          const freeArmB = !nodeB.dNode ? 'D' : !nodeB.tNode ? 'T' : !nodeB.fNode ? 'F'
            : (nodeB.railwayType === 'diamond' && !nodeB.xNode) ? 'X' : null;
          if (!freeArmA || !freeArmB) continue;

          const fieldA = branchToNodeField(freeArmA);
          const branchA = branchToBranchField(freeArmA);
          nodeA[fieldA] = nodeB.name;
          nodeA[branchA] = freeArmB;

          const fieldB = branchToNodeField(freeArmB);
          const branchB = branchToBranchField(freeArmB);
          nodeB[fieldB] = nodeA.name;
          nodeB[branchB] = freeArmA;

          // Set region2/km2 for cross-section visibility
          if (!nodeA.region2) { nodeA.region2 = nodeB.region; nodeA.km2 = nodeB.km; }
          if (!nodeB.region2) { nodeB.region2 = nodeA.region; nodeB.km2 = nodeA.km; }
        }
      }
    }

    // Also follow cross-section chains for junctions that don't share a key
    for (const node of nodes) {
      const armsFull = (n) => n.fNode && n.tNode && n.dNode && (n.railwayType !== 'diamond' || n.xNode);
      if (armsFull(node)) continue;
      const realKey = node._topoKey;
      if (!realKey) continue;
      const conns = node._topoConns ?? adj.get(realKey) ?? [];

      for (const conn of conns) {
        if (armsFull(node)) break;

        const result = followChainToNode(realKey, conn.wayId, waysById, adj, allSectionNodeKeys);
        if (!result) continue;

        const { reachedKey, arrivedViaWayId } = result;
        const candidates = realKeyToNodes.get(reachedKey) ?? [];
        const farNode = candidates.find(
          c => c !== node && c.region !== node.region
        );
        if (!farNode) continue;

        // Already connected?
        if (node.fNode === farNode.name || node.tNode === farNode.name ||
            node.dNode === farNode.name || node.xNode === farNode.name) continue;

        // Determine source branch
        const sourceBranch = determineBranch(realKey, conns, conn.wayId, waysById, node.km, null);
        if (!sourceBranch) continue;

        const nodeField = branchToNodeField(sourceBranch);
        if (node[nodeField]) continue;

        // Determine far branch
        const farNodeKey = farNode._topoKey || reachedKey;
        let farNodeConns = farNode._topoConns || adj.get(farNodeKey) || [];
        const farBranch = determineBranch(
          farNodeKey, farNodeConns, arrivedViaWayId, waysById, farNode.km, null
        );
        if (!farBranch) continue;

        const branchField = branchToBranchField(sourceBranch);
        node[nodeField] = farNode.name;
        node[branchField] = farBranch;

        if (!node.region2) { node.region2 = farNode.region; node.km2 = farNode.km; }
      }
    }
  }

  // Remove orphaned topo nodes — junctions that passed the proximity filter
  // but aren't topologically reachable from other nodes on their section.
  {
    const before = nodes.length;
    const isReferenced = new Set();
    for (const n of nodes) {
      if (n.fNode) isReferenced.add(n.fNode);
      if (n.tNode) isReferenced.add(n.tNode);
      if (n.dNode) isReferenced.add(n.dNode);
      if (n.xNode) isReferenced.add(n.xNode);
    }
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (n.fNode || n.tNode || n.dNode || n.xNode) continue;
      if (isReferenced.has(n.name)) continue;
      nodes.splice(i, 1);
    }
    if (nodes.length < before) {
      warnings.push(`Removed ${before - nodes.length} orphaned topo nodes with no connections.`);
    }
  }

  // ── Step 8c: Ensure F branch is always connected ──
  // Traxim requires every node to have its F branch connected.  If a turnout
  // has T and D wired but F is empty (boundary condition — the chain off the
  // F arm ran beyond the geometry), swap F↔T so the through-route forward
  // direction points into the connected part of the network.
  // IMPORTANT: Only applies to degree-≤2 nodes (through-nodes, endpoints).
  // Real turnouts (degree≥3) that have one missing arm should keep their
  // angle-based F/T/D labels even if F is unreachable — swapping would
  // misidentify T as F and leave T empty.
  {
    let rotateCount = 0;
    const nmLookup = new Map(nodes.map(n => [n.name, n]));
    for (const node of nodes) {
      if (node.fNode) continue;             // F already connected — nothing to fix
      if (!node.tNode && !node.dNode) continue; // completely unconnected — orphan pass handles it

      // Skip real turnouts — their branch labels are geometry-derived and correct
      const topoDegreeC = node._topoConns?.length ?? 0;
      if (topoDegreeC > 2) continue;

      // Determine what to swap into F
      // Case 1: T is filled → swap F←T
      // Case 2: T is empty but D is filled → swap F←D
      const sourceField = node.tNode ? 'tNode' : 'dNode';
      const sourceBrField = node.tNode ? 'tOnBranch' : 'dOnBranch';
      const sourceArmLabel = node.tNode ? 'T' : 'D';

      // The target node's reciprocal link says "I connect to [node]'s T/D arm".
      // After swap, that should say "I connect to [node]'s F arm".
      const targetName = node[sourceField];
      const target = nmLookup.get(targetName);
      if (target) {
        for (const [nf, bf] of [['fNode','fOnBranch'],['tNode','tOnBranch'],['dNode','dOnBranch']]) {
          if (target[nf] === node.name && target[bf] === sourceArmLabel) {
            target[bf] = 'F';   // was pointing at our T/D, now points at our F
          }
        }
      }

      // Swap F ← source, source ← (empty)
      node.fNode     = node[sourceField];
      node.fOnBranch = node[sourceBrField];
      node[sourceField]   = '';
      node[sourceBrField] = '';
      rotateCount++;
    }
    if (rotateCount > 0) {
      warnings.push(`F-branch fix: swapped F↔T on ${rotateCount} boundary turnout(s) to ensure F is always connected.`);
    }
  }

  // ── Step 8d: Normalise 2-connection nodes to F + T ──
  // If a node has exactly two branches connected and they are not F + T
  // (e.g. F + D, or T + D), promote the non-F branch to T.  The railway
  // principle: a node with only two connected branches is a simple through-
  // node and must use exactly F and T.
  // IMPORTANT: Only applies to nodes that are genuinely degree-2 in the
  // topology (platforms, through-nodes, mileposts).  A partial turnout —
  // where the topology shows degree-3 but one arm has no reachable section
  // node — must keep its angle-based branch labels (F/T/D) so the missing
  // arm is visible as a gap rather than silently relabelled.
  {
    let promoteCount = 0;
    const nmLookup2 = new Map(nodes.map(n => [n.name, n]));
    for (const node of nodes) {
      // Skip partial turnouts: if the topology gives this node 3+ arms,
      // it is a real junction even if only 2 currently chain to a node.
      const topoDegree = node._topoConns?.length ?? 0;
      if (topoDegree > 2) continue;

      const hasFNode = !!node.fNode;
      const hasTNode = !!node.tNode;
      const hasDNode = !!node.dNode;
      const connCount = (hasFNode ? 1 : 0) + (hasTNode ? 1 : 0) + (hasDNode ? 1 : 0);
      if (connCount !== 2) continue;

      // If F + T already, nothing to do
      if (hasFNode && hasTNode && !hasDNode) continue;

      // F + D → promote D to T
      if (hasFNode && hasDNode && !hasTNode) {
        // Update reciprocal: target has a link to this node's D arm → change to T
        const target = nmLookup2.get(node.dNode);
        if (target) {
          for (const [nf, bf] of [['fNode','fOnBranch'],['tNode','tOnBranch'],['dNode','dOnBranch']]) {
            if (target[nf] === node.name && target[bf] === 'D') {
              target[bf] = 'T';
            }
          }
        }
        node.tNode     = node.dNode;
        node.tOnBranch = node.dOnBranch;
        node.dNode     = '';
        node.dOnBranch = '';
        promoteCount++;
      }
      // T + D (F empty — shouldn't happen after Step 8c, but be safe) → swap F←T, T←D
      else if (hasTNode && hasDNode && !hasFNode) {
        const targetT = nmLookup2.get(node.tNode);
        if (targetT) {
          for (const [nf, bf] of [['fNode','fOnBranch'],['tNode','tOnBranch'],['dNode','dOnBranch']]) {
            if (targetT[nf] === node.name && targetT[bf] === 'T') {
              targetT[bf] = 'F';
            }
          }
        }
        const targetD = nmLookup2.get(node.dNode);
        if (targetD) {
          for (const [nf, bf] of [['fNode','fOnBranch'],['tNode','tOnBranch'],['dNode','dOnBranch']]) {
            if (targetD[nf] === node.name && targetD[bf] === 'D') {
              targetD[bf] = 'T';
            }
          }
        }
        node.fNode     = node.tNode;
        node.fOnBranch = node.tOnBranch;
        node.tNode     = node.dNode;
        node.tOnBranch = node.dOnBranch;
        node.dNode     = '';
        node.dOnBranch = '';
        promoteCount++;
      }
    }
    if (promoteCount > 0) {
      warnings.push(`2-branch normalisation: promoted D→T on ${promoteCount} node(s) with only 2 connections.`);
    }
  }

  // ── Step 8e: Create boundary nodes for chains exiting the network ──
  // When a turnout (degree ≥ 3) has an empty arm because the chain off that
  // arm runs beyond the bounded area without meeting another topo node, create
  // an artificial end-node at the chain's terminal coordinate.  This makes the
  // boundary visible in the infrastructure rather than leaving it as a silent
  // empty arm.  Boundary nodes are degree-1 end-nodes connected only via F.
  {
    let boundaryCount = 0;
    const nodesByName = new Map(nodes.map(n => [n.name, n]));

    for (const node of nodes) {
      const realKey = node._topoKey;
      if (!realKey) continue;
      const conns = node._topoConns ?? adj.get(realKey) ?? [];
      const topoDegree = conns.length;
      if (topoDegree < 3) continue;
      const armsFull = node.fNode && node.tNode && node.dNode && (node.railwayType !== 'diamond' || node.xNode);
      if (armsFull) continue;

      for (const conn of conns) {
        if (node.fNode && node.tNode && node.dNode && (node.railwayType !== 'diamond' || node.xNode)) break;

        const result = followChainToNode(realKey, conn.wayId, waysById, adj, allTopoNodeKeys);
        if (!result) {
          continue;
        }

        const { reachedKey, arrivedViaWayId } = result;
        const candidates = realKeyToNodes.get(reachedKey) ?? [];

        // If there IS a topo node at the end, this way is already handled
        // by Step 8 — skip it.
        if (candidates.length > 0) continue;

        // This chain exits the network boundary.  Determine which arm of
        // the source node this way belongs to.
        const sourceBranch = determineBranch(
          realKey, conns, conn.wayId, waysById, node.km, null
        );
        if (!sourceBranch) continue;

        // Only create boundary node if this arm is still empty
        const nodeField = branchToNodeField(sourceBranch);
        if (node[nodeField]) {
          continue;
        }

        // Create boundary node at the chain's terminal coordinate
        const { lat: bLat, lon: bLon } = parseCoordKey(reachedKey);
        const geomPts = geometryBySection.get(node.region);
        const bKm = geomPts ? +nearestKm({ lat: bLat, lon: bLon }, geomPts).toFixed(3) : node.km;

        // Generate unique name
        const bBaseName = `${node.region} Boundary`;
        let bName = bBaseName;
        let bIdx = 0;
        while (nodesByName.has(bName)) {
          bName = `${bBaseName} ${String.fromCharCode(65 + bIdx++)}`;
        }

        const boundaryNode = {
          name: bName,
          lat: bLat, lon: bLon, km: bKm,
          region: node.region,
          railwayType: 'buffer_stop',
          fNode: node.name,
          fOnBranch: sourceBranch,
        };
        nodes.push(boundaryNode);
        nodesByName.set(bName, boundaryNode);

        // Wire the source node's empty arm to the boundary node's F
        const branchField = branchToBranchField(sourceBranch);
        node[nodeField] = bName;
        node[branchField] = 'F';

        boundaryCount++;
      }
    }
    if (boundaryCount > 0) {
      warnings.push(`Boundary nodes: created ${boundaryCount} artificial end-node(s) where chains exit the network boundary.`);
    }
  }

  updateProgress(70, 'Applying spatial separation');

  // ── Step 9: Spatial separation (disabled) ──
  // Lat/lon positions are no longer moved.  The minimum 30 m spacing
  // requirement applies to kilometrage, not physical coordinates.
  // ensureKmSeparation (called after Step 11) handles the km rule.

  updateProgress(80, 'Enforcing reciprocal links');
  // ── Step 10: Enforce reciprocal links ──
  enforceReciprocalLinks(nodes, warnings);

  // ── Step 11: Platform nodes ──
  // Platforms are standalone OSM ways with no relation tying them to "their"
  // track (Overpass fetch below is a pure tag+bbox query) — proximity to
  // actual track geometry is the only signal available, so they have to be
  // geo-matched to an existing LINK and spliced into it, splitting that link
  // in two.
  //
  // Matching against the deduplicated per-region centerline (geometryBySection)
  // is NOT enough: the geometry pipeline collapses parallel tracks onto one
  // centerline before this stage ever runs, so a station's 2nd/3rd platform
  // track was never kept as its own line, and Step 6 doesn't create a node
  // for a plain (non-junction) point along it either — a loop track between
  // two turnouts is invisible to a centerline-only search. So instead we
  // search every real graph LINK (any two nodes already connected via an
  // arm), reconstructing each link's own true OSM geometry by walking its
  // topology chain — mainline and every loop/siding alike are candidates,
  // and each platform attaches to whichever one it's physically closest to.
  // Falls back to a straight line between endpoints only when a link's
  // topology can't be walked (e.g. one end is a synthetic boundary node).
  //
  // Scoped to platforms landing on an ordinary degree-2 stretch of track (the
  // overwhelming majority — normal wayside/through stations); a platform
  // that geo-matches close to a turnout or diamond is skipped with a warning
  // rather than risking an incorrect splice into a junction's own arm.
  // Inserted with Signalled F/T = false (the engine's new per-end signalling
  // flag) so it reads as an unsignalled waypoint rather than implying a
  // signal that isn't there.
  const PLATFORM_MATCH_THRESHOLD_M = 100;
  const PLATFORM_JUNCTION_BUFFER_M = 50;
  const PLATFORM_INSERTION_ENABLED = true;
  updateProgress(75, 'Fetching platform nodes');
  let platforms = [];
  if (PLATFORM_INSERTION_ENABLED && bbox) {
    const cacheFile = sessionPath ? path.join(sessionPath, 'osm_platforms.json') : null;
    if (cacheFile && fs.existsSync(cacheFile)) {
      platforms = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      warnings.push(`Loaded ${platforms.length} cached platform(s) from osm_platforms.json.`);
    } else {
      try {
        platforms = await fetchPlatformsFromOverpass(bbox);
        if (cacheFile) fs.writeFileSync(cacheFile, JSON.stringify(platforms), 'utf-8');
        if (platforms.length > 0) {
          warnings.push(`Fetched ${platforms.length} railway platform(s) from Overpass.`);
        }
      } catch (error) {
        warnings.push(`Platform fetch failed: ${error.message}. Platform nodes will be omitted.`);
      }
    }
  }

  if (platforms.length > 0) {
    const ARM_FIELDS = ['fNode', 'tNode', 'dNode', 'xNode'];
    const findArmTo = (node, targetName) => ARM_FIELDS.find(f => node[f] === targetName) ?? null;

    // Walk a link's real topology chain from `startKey` along `wayId`,
    // collecting every intermediate OSM vertex with a cumulative distance
    // (in km, arbitrary zero-point — NOT regional kilometrage) so the
    // resulting polyline can be handed straight to projectOntoGeometry().
    // Mirrors followChainToNode()'s own traversal/termination logic but
    // additionally records geometry instead of only the reached key.
    function reconstructLinkPolyline(startKey, wayId, targetTopoKey) {
      const { lat: sLat, lon: sLon } = parseCoordKey(startKey);
      const points = [{ lat: sLat, lon: sLon, km: 0 }];
      let cumKm = 0;
      let cursorKey = startKey;
      let currentWayId = wayId;
      const MAX_CHAIN_LENGTH = 1000;

      for (let step = 0; step < MAX_CHAIN_LENGTH; step++) {
        const way = waysById.get(currentWayId);
        if (!way || !way.coords || way.coords.length < 2) return null;

        const coords = way.coords;
        const firstKey = makeCoordKey(coords[0].lat, coords[0].lon);
        const lastKey = makeCoordKey(coords[coords.length - 1].lat, coords[coords.length - 1].lon);

        let seq, nextKey;
        if (firstKey === cursorKey) { seq = coords; nextKey = lastKey; }
        else if (lastKey === cursorKey) { seq = [...coords].reverse(); nextKey = firstKey; }
        else return null; // cursor isn't an endpoint of this way — shouldn't happen

        for (let i = 1; i < seq.length; i++) {
          cumKm += haversineM(seq[i - 1], seq[i]) / 1000;
          points.push({ lat: seq[i].lat, lon: seq[i].lon, km: cumKm });
        }

        cursorKey = nextKey;
        if (cursorKey === targetTopoKey) return { points };

        const nextConns = (adj.get(cursorKey) || []).filter(c => c.wayId !== currentWayId);
        if (nextConns.length !== 1) return null; // dead end or a different junction — not our target
        currentWayId = nextConns[0].wayId;
      }
      return null;
    }

    // Reconstruct the real geometry of the link between two adjacent nodes,
    // falling back to a straight line when either end lacks topology data
    // (e.g. a Step 8e boundary node) or the chain can't be walked.
    function linkPolyline(a, b) {
      if (a._topoConns && a._topoKey && b._topoKey) {
        for (const conn of a._topoConns) {
          const result = reconstructLinkPolyline(a._topoKey, conn.wayId, b._topoKey);
          if (result) return result.points;
        }
      }
      return [
        { lat: a.lat, lon: a.lon, km: 0 },
        { lat: b.lat, lon: b.lon, km: haversineM(a, b) / 1000 },
      ];
    }

    const nodesByName = new Map(nodes.map(n => [n.name, n]));
    // Deterministic order so repeated runs against the same data produce the
    // same result regardless of Overpass's own element ordering.
    const sortedPlatforms = [...platforms].sort((a, b) => a.name.localeCompare(b.name));
    let insertedCount = 0;

    for (const platform of sortedPlatforms) {
      const point = { lat: platform.centLat, lon: platform.centLon };

      // Rebuilt fresh each time: earlier insertions in this loop become new
      // candidate links, so a second platform landing on an already-spliced
      // link correctly narrows against the new, shorter remainder.
      const candidates = [];
      for (const node of nodes) {
        for (const armField of ARM_FIELDS) {
          const neighborName = node[armField];
          if (!neighborName) continue;
          const neighbor = nodesByName.get(neighborName);
          if (!neighbor) continue;

          const poly = linkPolyline(node, neighbor);
          const { km: polyKm, projLat, projLon } = projectOntoGeometry(point, poly);
          const distM = haversineM(point, { lat: projLat, lon: projLon });
          candidates.push({ a: node, b: neighbor, armOnA: armField, poly, polyKm, projLat, projLon, distM });
        }
      }
      candidates.sort((x, y) => x.distM - y.distM);

      // Sanity check: a link's reconstructed length should be roughly in
      // line with the straight-line distance between its own two endpoints.
      // When it isn't - confirmed case: two endpoints 48m apart from EACH
      // OTHER reconstructing to 16.6km of "track" - the chain walk has
      // wandered off through unrelated, far-away topology before finding
      // its way back to the target key, rather than reconstructing the
      // short real link between them. A platform "matching" such a link
      // within the normal distance threshold is coincidental, not real:
      // it's landing on some faraway point the wayward reconstruction
      // happens to pass through, not on the actual nearby track. Rather
      // than give up the moment the nearest candidate fails this check,
      // fall through to the next-nearest one - the genuinely correct link
      // is often right behind it in the ranking.
      const RECONSTRUCTION_SANITY_RATIO = 5;
      const RECONSTRUCTION_SANITY_FLOOR_M = 300;
      let best = null;
      let rejectedCount = 0;
      for (const c of candidates) {
        if (c.distM > PLATFORM_MATCH_THRESHOLD_M) break; // sorted - nothing further can qualify either
        const reconstructedLengthM = c.poly[c.poly.length - 1].km * 1000;
        const straightLineM = haversineM(c.a, c.b);
        if (reconstructedLengthM > RECONSTRUCTION_SANITY_FLOOR_M && reconstructedLengthM > straightLineM * RECONSTRUCTION_SANITY_RATIO) {
          rejectedCount++;
          continue;
        }
        best = c;
        break;
      }

      if (!best) {
        warnings.push(rejectedCount > 0
          ? `Platform "${platform.name}": no track within ${PLATFORM_MATCH_THRESHOLD_M}m after discarding ` +
            `${rejectedCount} candidate(s) with implausibly long track reconstructions relative to their ` +
            `endpoints' distance apart — skipped (needs manual review).`
          : `Platform "${platform.name}": no track within ${PLATFORM_MATCH_THRESHOLD_M}m — skipped.`);
        continue;
      }
      const { a, b, armOnA, projLat, projLon } = best;

      const nearJunction =
        (['junction', 'diamond'].includes(a.railwayType) && haversineM({ lat: projLat, lon: projLon }, a) < PLATFORM_JUNCTION_BUFFER_M) ||
        (['junction', 'diamond'].includes(b.railwayType) && haversineM({ lat: projLat, lon: projLon }, b) < PLATFORM_JUNCTION_BUFFER_M);
      if (nearJunction) {
        warnings.push(`Platform "${platform.name}": within ${PLATFORM_JUNCTION_BUFFER_M}m of a turnout/diamond — ` +
          `skipped (splice into a junction arm needs manual review).`);
        continue;
      }

      const armOnB = findArmTo(b, a.name);
      if (!armOnB) {
        warnings.push(`Platform "${platform.name}": matched link "${a.name}" / "${b.name}" isn't ` +
          `reciprocally linked — skipped (manual insertion needed).`);
        continue;
      }

      // Regional kilometrage: project the platform's own real coordinates
      // directly onto the shared regional centerline, the same way every
      // other node gets its km - NOT by interpolating a fraction along the
      // matched link's own reconstructed length between the two endpoints.
      // Those aren't equivalent whenever the matched link is a siding/loop
      // whose real physical length differs substantially from its two
      // endpoints' regional-km delta (confirmed case: a ~1.5km real detour
      // between two endpoints only ~90m apart in km - fraction-along-length
      // compressed the platform to within metres of one endpoint's km,
      // rather than the ~1km-away point on the centerline it actually
      // projects to). A node near a diamond or an alt-route junction can
      // carry up to 3 region slots (region/region2/region3), and the region
      // THIS link actually belongs to isn't always either node's primary
      // `region` field - search every slot combination for one they share.
      const regionSlots = (n) => [['region', 'km'], ['region2', 'km2'], ['region3', 'km3']].filter(([rf]) => n[rf]);

      let region = a.region, km = a.km ?? 0;
      outer:
      for (const [aRegionField] of regionSlots(a)) {
        for (const [bRegionField] of regionSlots(b)) {
          if (a[aRegionField] === b[bRegionField]) {
            region = a[aRegionField];
            const regionPoints = geometryBySection.get(region);
            km = regionPoints && regionPoints.length > 0
              ? projectOntoGeometry(point, regionPoints).km
              : a.km ?? 0;
            break outer;
          }
        }
      }

      // Unique name
      let platName = platform.name;
      let pIdx = 0;
      while (nodesByName.has(platName)) {
        platName = `${platform.name} ${String.fromCharCode(65 + pIdx++)}`;
      }

      const platformNode = {
        name: platName,
        lat: projLat, lon: projLon, km,
        region,
        railwayType: 'platform',
        signalledF: false,
        signalledT: false,
        fNode: a.name,
        fOnBranch: fieldToBranch(armOnA),
        tNode: b.name,
        tOnBranch: fieldToBranch(armOnB),
      };
      nodes.push(platformNode);
      nodesByName.set(platName, platformNode);

      a[armOnA] = platName;
      a[branchToBranchField(fieldToBranch(armOnA))] = 'F';
      b[armOnB] = platName;
      b[branchToBranchField(fieldToBranch(armOnB))] = 'T';

      insertedCount++;
    }

    if (insertedCount > 0) {
      warnings.push(`Platforms: inserted ${insertedCount} platform node(s), unsignalled (Signalled F/T = False).`);
    }
  }

  // Second orphan removal pass — connections may have been cleared by
  // enforceReciprocalLinks, leaving topo nodes with no links.
  {
    const before = nodes.length;
    const isReferenced = new Set();
    for (const n of nodes) {
      if (n.fNode) isReferenced.add(n.fNode);
      if (n.tNode) isReferenced.add(n.tNode);
      if (n.dNode) isReferenced.add(n.dNode);
      if (n.xNode) isReferenced.add(n.xNode);
    }
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (n.railwayType === 'platform') continue;
      if (n.fNode || n.tNode || n.dNode || n.xNode) continue;
      if (isReferenced.has(n.name)) continue;
      nodes.splice(i, 1);
    }
    if (nodes.length < before) {
      warnings.push(`Removed ${before - nodes.length} post-reciprocal orphaned nodes.`);
    }
  }

  // ── Final spatial separation pass (disabled) ──
  // See Step 9 comment — lat/lon positions are no longer moved.

  // Clamp all km values to geometry bounds — prevents negative values from
  // extrapolation and keeps values within the geometry's defined range.
  for (const node of nodes) {
    for (const [regionField, kmField] of [['region', 'km'], ['region2', 'km2'], ['region3', 'km3']]) {
      if (!node[regionField] || node[kmField] == null) continue;
      const geomPts = geometryBySection.get(node[regionField]);
      if (!geomPts || geomPts.length === 0) continue;
      const minGeoKm = Math.min(...geomPts.map(p => p.km));
      const maxGeoKm = Math.max(...geomPts.map(p => p.km));
      if (node[kmField] < minGeoKm) node[kmField] = +minGeoKm.toFixed(3);
      if (node[kmField] > maxGeoKm) node[kmField] = +maxGeoKm.toFixed(3);
    }
  }

  // Re-derive km by walking the topology graph in order, rather than trusting
  // each node's independently-projected km. See reprojectKmAlongTopology()
  // doc comment for why independent projection can produce a non-monotonic
  // ("dip") sequence between directly-linked nodes.
  reprojectKmAlongTopology(nodes, geometryBySection);

  // Enforce minimum km spacing on all shared geometries (primary + alt)
  ensureKmSeparation(nodes, geometryBySection);

  // BFS reprojection above only cross-checks the ONE edge each node was
  // discovered through, not every edge it actually has - correct any that
  // still disagree with a direct neighbour (see enforceKmOrdering doc
  // comment). Ordering and spacing are interdependent (fixing one can
  // reintroduce a violation of the other in a densely-meshed cluster), so
  // alternate the two until neither has anything left to fix, capped so a
  // genuinely conflicting cluster can't loop forever.
  for (let i = 0; i < 10; i++) {
    enforceKmOrdering(nodes);
    ensureKmSeparation(nodes, geometryBySection);
  }

  // ── Step 11b: Geometry reference pruning ──
  // Principle: each link must be unambiguously attributable to exactly one
  // geometry.  Both endpoints of a link must share at least one geometry, and
  // ideally exactly one.  A node should have no more geometry references than
  // it has connected branches.  Transition nodes (where geometry changes) are
  // kept, but chains of nodes all referencing the same two+ geometries are
  // broken so that only the endpoints of each chain remain as transitions.
  {
    const nodeByName = new Map(nodes.map(n => [n.name, n]));

    function getGeos(node) {
      const g = [node.region];
      if (node.region2) g.push(node.region2);
      if (node.region3) g.push(node.region3);
      return g;
    }

    function branchCount(node) {
      return (node.fNode ? 1 : 0) + (node.tNode ? 1 : 0) + (node.dNode ? 1 : 0);
    }

    function neighbors(node) {
      return [node.fNode, node.tNode, node.dNode]
        .filter(Boolean)
        .map(name => nodeByName.get(name))
        .filter(Boolean);
    }

    // Check if geometry g can be safely removed from node without
    // disconnecting any link (every neighbor must still share ≥1 geometry).
    // Links that already share zero geometries (broken links) are skipped —
    // removing a geometry can't make an already-broken link worse.
    function isRemovable(node, g) {
      const current = getGeos(node);
      const remaining = current.filter(x => x !== g);
      if (remaining.length === 0) return false;
      for (const nb of neighbors(node)) {
        const nbGeos = getGeos(nb);
        const currentShared = current.filter(x => nbGeos.includes(x));
        if (currentShared.length === 0) continue;  // already broken
        if (!remaining.some(r => nbGeos.includes(r))) return false;
      }
      return true;
    }

    // Check if removing g from node would make at least one ambiguous link
    // unambiguous (shared geometry count drops from >1 to exactly 1).
    function wouldReduceAmbiguity(node, g) {
      const remaining = getGeos(node).filter(x => x !== g);
      for (const nb of neighbors(node)) {
        const nbGeos = getGeos(nb);
        const oldShared = getGeos(node).filter(x => nbGeos.includes(x));
        if (oldShared.length > 1) {
          const newShared = remaining.filter(x => nbGeos.includes(x));
          if (newShared.length >= 1 && newShared.length < oldShared.length) return true;
        }
      }
      return false;
    }

    function removeGeo(node, g) {
      if (node.region === g) {
        // Promote region2 → region, region3 → region2
        node.region = node.region2; node.km = node.km2;
        node.region2 = node.region3 || null; node.km2 = node.km3 ?? null;
        node.region3 = null; node.km3 = null;
      } else if (node.region2 === g) {
        node.region2 = node.region3 || null; node.km2 = node.km3 ?? null;
        node.region3 = null; node.km3 = null;
      } else if (node.region3 === g) {
        node.region3 = null; node.km3 = null;
      }
    }

    // Pass 1: Enforce geoCount ≤ branchCount.  Process dead-ends first.
    let changed = true;
    let pass1Count = 0;
    while (changed) {
      changed = false;
      const sorted = [...nodes].sort((a, b) => branchCount(a) - branchCount(b));
      for (const node of sorted) {
        const geos = getGeos(node);
        const bc = branchCount(node);
        while (getGeos(node).length > Math.max(bc, 1)) {
          const current = getGeos(node);
          // Try removing from last to first (region3, region2, region)
          let removed = false;
          for (let i = current.length - 1; i >= 0; i--) {
            if (isRemovable(node, current[i])) {
              removeGeo(node, current[i]);
              removed = true;
              changed = true;
              pass1Count++;
              break;
            }
          }
          if (!removed) break;
        }
      }
    }

    // Pass 2: Break ambiguous chains — remove geometry references that are
    // safe to remove and would reduce at least one ambiguous link.
    changed = true;
    let pass2Count = 0;
    while (changed) {
      changed = false;
      for (const node of nodes) {
        const geos = getGeos(node);
        if (geos.length <= 1) continue;
        for (let i = geos.length - 1; i >= 0; i--) {
          if (isRemovable(node, geos[i]) && wouldReduceAmbiguity(node, geos[i])) {
            removeGeo(node, geos[i]);
            changed = true;
            pass2Count++;
            break;
          }
        }
      }
    }

    // Count results
    let ambiguousLinks = 0;
    for (const node of nodes) {
      for (const targetName of [node.fNode, node.tNode, node.dNode]) {
        if (!targetName) continue;
        const target = nodeByName.get(targetName);
        if (!target) continue;
        const shared = getGeos(node).filter(g => getGeos(target).includes(g));
        if (shared.length > 1) ambiguousLinks++;
      }
    }
    const prunedCount = nodes.filter(n => !n.region2 && !n.region3).length;
    warnings.push(`Geometry pruning: ${prunedCount} of ${nodes.length} nodes now single-geometry. ${ambiguousLinks} directed links remain ambiguous.`);
  }

  updateProgress(85, 'Computing display positions');
  // ── Step 12: Clean up internal annotations ──
  // Note: _topoKey, _topoConns are cleaned up AFTER Step 14 (flip calculation)
  // which needs them.  Only general annotations removed here.

  updateProgress(87, 'Applying station-based naming');

  // ── Step 13: Naming pass — rename nodes to [Nearest Station] [Suffix] ──
  // Rules (matching MCP convention):
  //   • platform nodes              → "[Station] [N]"  (1-based platform number, sorted by km)
  //   • D-D mutual loop pairs       → "[Station] [Cardinal]"  (N/S/E/W)
  //   • all other nodes             → "[Station] [Letter]"  (A/B/C... in km order within section)
  {
    const toRad = d => d * Math.PI / 180;

    const haversineKm = (lat1, lon1, lat2, lon2) => {
      const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
      const a = Math.sin(dLat / 2) ** 2
              + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
      return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
    };

    const getBearing = (lat1, lon1, lat2, lon2) => {
      const dLon = toRad(lon2 - lon1);
      const y = Math.sin(dLon) * Math.cos(toRad(lat2));
      const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2))
              - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
      return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    };

    const cardinalPair = (brg) => {
      if (brg >= 315 || brg <  45) return ['S', 'N'];
      if (brg >=  45 && brg < 135) return ['W', 'E'];
      if (brg >= 135 && brg < 225) return ['N', 'S'];
      return                              ['E', 'W'];
    };

    const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

    if (stationAnchors.length === 0) {
      warnings.push('Naming pass: no station/halt nodes found — node names unchanged');
    } else {
      const nearestAnchor = (node) => {
        let best = stationAnchors[0], bestDist = Infinity;
        for (const a of stationAnchors) {
          const d = haversineKm(node.lat, node.lon, a.lat, a.lon);
          if (d < bestDist) { bestDist = d; best = a; }
        }
        return best;
      };

      // Identify mutual D-D loop pairs and assign cardinal roles
      const loopRole = new Map();
      const nmMap = new Map(nodes.map(n => [n.name, n]));
      for (const n of nodes) {
        if (!n.dNode || loopRole.has(n.name)) continue;
        const p = nmMap.get(n.dNode);
        if (!p || p.dNode !== n.name) continue;
        const brg = getBearing(n.lat, n.lon, p.lat, p.lon);
        const [roleN, roleP] = cardinalPair(brg);
        loopRole.set(n.name, roleN);
        loopRole.set(p.name, roleP);
      }

      // Group every node by its nearest station anchor
      const groups = new Map(); // anchorName → { platforms[], loopEndpoints[], others[] }
      for (const n of nodes) {
        const a = nearestAnchor(n);
        const key = a.name;
        if (!groups.has(key)) groups.set(key, { platforms: [], loopEndpoints: [], others: [] });
        const g = groups.get(key);
        if      (n.railwayType === 'platform') g.platforms.push(n);
        else if (loopRole.has(n.name))         g.loopEndpoints.push(n);
        else                                   g.others.push(n);
      }

      // Allocate unique new names
      const renameMap = new Map();
      const taken = new Set();
      const claim = (desired) => {
        if (!taken.has(desired)) { taken.add(desired); return desired; }
        let i = 2; while (taken.has(`${desired}${i}`)) i++;
        const r = `${desired}${i}`; taken.add(r); return r;
      };

      for (const [aName, { platforms, loopEndpoints, others }] of groups) {
        // Platform nodes: numbered 1, 2, 3 ... in km order
        platforms.sort((a, b) => a.km - b.km);
        let pNum = 1;
        for (const n of platforms) {
          renameMap.set(n.name, claim(`${aName} ${pNum++}`));
        }

        // Loop endpoint pairs: cardinal direction suffix
        for (const n of loopEndpoints) {
          renameMap.set(n.name, claim(`${aName} ${loopRole.get(n.name)}`));
        }

        // All other nodes: letters A, B, C ... in km order within section
        others.sort((a, b) => a.region === b.region ? a.km - b.km : 0);
        let li = 0;
        for (const n of others) {
          const letter = li < ALPHA.length ? ALPHA[li] : `${ALPHA[ALPHA.length - 1]}${li - ALPHA.length + 2}`;
          renameMap.set(n.name, claim(`${aName} ${letter}`));
          li++;
        }
      }

      // Apply renames: node names and all F/T/D/X cross-references
      for (const n of nodes) {
        if (renameMap.has(n.name))  n.name  = renameMap.get(n.name);
        if (n.fNode && renameMap.has(n.fNode)) n.fNode = renameMap.get(n.fNode);
        if (n.tNode && renameMap.has(n.tNode)) n.tNode = renameMap.get(n.tNode);
        if (n.dNode && renameMap.has(n.dNode)) n.dNode = renameMap.get(n.dNode);
        if (n.xNode && renameMap.has(n.xNode)) n.xNode = renameMap.get(n.xNode);
      }

      warnings.push(`Naming pass: renamed ${renameMap.size} of ${nodes.length} nodes to nearest-station convention`);
    }
  }
  // ── Step 14: Compute display positions and turnout flip ──
  //   posX/posY   = position of the node's centerline projection on the canvas
  //   offsetX/offsetY = residual from centerline to actual geographic position
  if (nodes.length > 0) {
    const allLats = nodes.map(n => n.lat);
    const allLons = nodes.map(n => n.lon);
    const minLat = Math.min(...allLats);
    const maxLat = Math.max(...allLats);
    const minLon = Math.min(...allLons);
    const maxLon = Math.max(...allLons);
    // Geographic-to-canvas conversion matching Network Editor's own convention
    // (CentrelineDataPoint.LatitudeToY / LongitudeToX + GeopositionNodes'
    // default ScaleFactor of 30 canvas-units-per-km), rather than an
    // independently-calibrated constant. Positions are equirectangular —
    // metres from the northern/western bounding edge, with longitude
    // corrected by cos(latitude) at each point — then scaled at 30
    // canvas-units/km, exactly as the editor scales positions it geopositions
    // itself. This keeps generator-authored files behaving the same way under
    // the editor's familiar scale-field habits (10 for sparse mainlines, up to
    // 100 for dense yards) regardless of route length or orientation.
    const METERS_PER_DEGREE_LAT = 111319.5;
    const CANVAS_UNITS_PER_KM = 30; // must match Network Editor's DEFAULT_SCALE
    const CANVAS_UNITS_PER_DEGREE_LAT = (METERS_PER_DEGREE_LAT / 1000) * CANVAS_UNITS_PER_KM;

    const nodeByName = new Map(nodes.map(n => [n.name, n]));
    for (const node of nodes) {
      // Project node onto its section's centerline geometry
      const geomPts = geometryBySection.get(node.region);
      let projLat = node.lat, projLon = node.lon;
      if (geomPts && geomPts.length > 0) {
        const proj = projectOntoGeometry(node, geomPts);
        projLat = proj.projLat;
        projLon = proj.projLon;
      }

      // Longitude scale depends on latitude (degrees of longitude shrink in
      // real distance away from the equator) — use this point's own latitude,
      // matching Network Editor's LongitudeToX.
      const lonScale = CANVAS_UNITS_PER_DEGREE_LAT * Math.cos(projLat * Math.PI / 180);

      // Centerline position on canvas
      node.posX = ((projLon - minLon) * lonScale).toFixed(4);
      node.posY = ((maxLat - projLat) * CANVAS_UNITS_PER_DEGREE_LAT).toFixed(4);

      // Offset = actual geographic position minus centerline position
      node.offsetX = ((node.lon - projLon) * lonScale).toFixed(4);
      node.offsetY = ((projLat - node.lat) * CANVAS_UNITS_PER_DEGREE_LAT).toFixed(4);

      // Turnout flip: determine whether the diverge is left or right when
      // looking along the through route from the node toward T.
      // Uses the OSM way geometry tangent at the junction (from _topoConns)
      // rather than neighbour node positions, which may be far away on a
      // curve or nearly collinear with D.
      if (node.dNode && node._topoKey && node._topoConns && node._topoConns.length === 3) {
        const dirs = node._topoConns.map(c => ({
          wayId: c.wayId,
          ...computeWayDirection(node._topoKey, c.wayId, waysById)
        }));

        // Identify through pair (F-T) vs diverge (D) — same logic as determineBranch
        const baseId = (id) => id.replace(/_\d+$/, '');
        let ftIdx1 = -1, ftIdx2 = -1;
        const bases = dirs.map(d => baseId(d.wayId));
        for (let i = 0; i < 3; i++) {
          for (let j = i + 1; j < 3; j++) {
            if (bases[i] === bases[j]) { ftIdx1 = i; ftIdx2 = j; }
          }
        }
        if (ftIdx1 < 0) {
          // Angle fallback: most-opposite pair is through
          let minDot = Infinity;
          for (let i = 0; i < 3; i++) {
            for (let j = i + 1; j < 3; j++) {
              const dot = dirs[i].dlat * dirs[j].dlat + dirs[i].dlon * dirs[j].dlon;
              if (dot < minDot) { minDot = dot; ftIdx1 = i; ftIdx2 = j; }
            }
          }
        }
        const dIdx = [0, 1, 2].find(k => k !== ftIdx1 && k !== ftIdx2) ?? 0;

        // T is the through-pair member closer in angle to D
        const dot1 = dirs[ftIdx1].dlat * dirs[dIdx].dlat + dirs[ftIdx1].dlon * dirs[dIdx].dlon;
        const dot2 = dirs[ftIdx2].dlat * dirs[dIdx].dlat + dirs[ftIdx2].dlon * dirs[dIdx].dlon;
        const tIdx = dot1 > dot2 ? ftIdx1 : ftIdx2;

        // Cross product of T-direction × D-direction:
        //   positive → D diverges left  → flip = false
        //   negative → D diverges right → flip = true
        const cross = dirs[tIdx].dlon * dirs[dIdx].dlat - dirs[tIdx].dlat * dirs[dIdx].dlon;
        node.flip = cross < 0;
      } else if (node.railwayType === 'diamond' && node._topoKey && node._topoConns && node._topoConns.length === 4) {
        // The Network Editor's own unflipped diamond layout (see
        // NodeEditor.js getBasePosition) places F/T on one diagonal and D/X
        // on the other, with X sharing the corner slot a turnout's T would
        // occupy and T sharing the slot a turnout's D would occupy. Reusing
        // the turnout formula above with X standing in for T and T standing
        // in for D reproduces the same handedness test for that shared pair
        // of corners, using the SAME F/T/D/X assignment determineBranch()
        // already committed to for this node's own links (via the shared
        // computeDiamondBranchIndices helper) so the two never disagree.
        const { dirs, tIdx, xIdx } = computeDiamondBranchIndices(node._topoKey, node._topoConns, waysById);
        const cross = dirs[xIdx].dlon * dirs[tIdx].dlat - dirs[xIdx].dlat * dirs[tIdx].dlon;
        node.flip = cross < 0;
      }
    }

    // ── Auto-rotate nodes based on F/T connections ──
    // Mirrors the C# AutoRotateNodes algorithm from NetworkEditor.Shared.
    // Uses distance-weighted average of ideal rotations from F and T neighbours.
    for (const node of nodes) {
      const centerX = parseFloat(node.posX) + parseFloat(node.offsetX);
      const centerY = parseFloat(node.posY) + parseFloat(node.offsetY);

      const fTarget = node.fNode ? nodeByName.get(node.fNode) : null;
      const tTarget = node.tNode ? nodeByName.get(node.tNode) : null;

      if (!fTarget && !tTarget) continue;

      let rotation;

      if (fTarget && tTarget) {
        const fCX = parseFloat(fTarget.posX) + parseFloat(fTarget.offsetX);
        const fCY = parseFloat(fTarget.posY) + parseFloat(fTarget.offsetY);
        const tCX = parseFloat(tTarget.posX) + parseFloat(tTarget.offsetX);
        const tCY = parseFloat(tTarget.posY) + parseFloat(tTarget.offsetY);

        const dxF = fCX - centerX, dyF = fCY - centerY;
        const dxT = tCX - centerX, dyT = tCY - centerY;
        const distF = Math.sqrt(dxF * dxF + dyF * dyF);
        const distT = Math.sqrt(dxT * dxT + dyT * dyT);

        // Only bail when the weighted-average division below would be
        // unstable (both neighbours essentially coincident with this node,
        // total distance ~0) - NOT merely "close", which is a normal
        // condition in a dense yard and was previously skipping rotation
        // for any node whose neighbours were within ~33m (1 canvas unit),
        // silently leaving it at the 0 default instead of a real angle.
        if (distF + distT < 1e-6) continue;

        let angleToF = ((Math.atan2(dyF, dxF) * 180 / Math.PI) % 360 + 360) % 360;
        let angleToT = ((Math.atan2(dyT, dxT) * 180 / Math.PI) % 360 + 360) % 360;

        // F points away (backward), T points toward (forward)
        let idF = ((angleToF + 180) % 360 + 360) % 360;
        let idT = angleToT;

        const totalDist = distF + distT;
        const wF = distF / totalDist;
        let diff = idT - idF;
        if (diff > 180) diff -= 360;
        if (diff < -180) diff += 360;
        rotation = idF + diff * wF;
      } else if (fTarget) {
        const fCX = parseFloat(fTarget.posX) + parseFloat(fTarget.offsetX);
        const fCY = parseFloat(fTarget.posY) + parseFloat(fTarget.offsetY);
        const dxF = fCX - centerX, dyF = fCY - centerY;
        const angleToF = Math.atan2(dyF, dxF) * 180 / Math.PI;
        rotation = angleToF + 180;
      } else {
        const tCX = parseFloat(tTarget.posX) + parseFloat(tTarget.offsetX);
        const tCY = parseFloat(tTarget.posY) + parseFloat(tTarget.offsetY);
        const dxT = tCX - centerX, dyT = tCY - centerY;
        rotation = Math.atan2(dyT, dxT) * 180 / Math.PI;
      }

      // Normalize to 0-360, round to nearest 5°
      rotation = ((rotation % 360) + 360) % 360;
      rotation = Math.round(rotation / 5) * 5;
      rotation = ((rotation % 360) + 360) % 360;
      node.rotation = rotation;
    }

  }

  updateProgress(90, 'Validating connections');

  // ── Clean up internal annotations (deferred from Step 12) ──
  for (const node of nodes) {
    delete node._topoKey;
    delete node._topoConns;
  }

  // ── Step 15: Branch-conflict and link-mismatch validation ──
  // Matches MCP Step 8: validates the single-connection-per-branch principle.
  {
    // Helper: get the arm connection for a given arm letter on a node.
    const getArmConn = (nd, arm) => {
      if (arm === 'F') return { node: nd.fNode ?? '', branch: nd.fOnBranch ?? 'T' };
      if (arm === 'T') return { node: nd.tNode ?? '', branch: nd.tOnBranch ?? 'F' };
      /* D */          return { node: nd.dNode ?? '', branch: nd.dOnBranch ?? 'F' };
    };

    // Pass 1: duplicate-claim check — two different source nodes claiming same target arm
    const armClaims = new Map();
    for (const n of nodes) {
      const claim = (targetName, targetArm, sourceName) => {
        if (!targetName || !targetArm) return;
        const key = `${targetName}:${targetArm}`;
        if (!armClaims.has(key)) armClaims.set(key, []);
        armClaims.get(key).push(sourceName);
      };
      claim(n.fNode, n.fOnBranch ?? 'T', n.name);
      claim(n.tNode, n.tOnBranch ?? 'F', n.name);
      claim(n.dNode, n.dOnBranch ?? 'F', n.name);
    }
    for (const [key, claimers] of armClaims) {
      if (claimers.length > 1) {
        const [nodeName, arm] = key.split(':');
        warnings.push(
          `BRANCH CONFLICT: "${nodeName}" ${arm}-arm claimed by multiple nodes: ${claimers.join(', ')}`
        );
      }
    }

    // Pass 2: bidirectional consistency check
    const nodeByNameMap = new Map(nodes.map(nd => [nd.name, nd]));
    for (const n of nodes) {
      for (const srcArm of ['F', 'T', 'D']) {
        const { node: targetName, branch: targetArm } = getArmConn(n, srcArm);
        if (!targetName) continue;
        // Only report from the lexicographically earlier node to avoid duplicates
        if (n.name >= targetName) continue;
        const targetNode = nodeByNameMap.get(targetName);
        if (!targetNode) continue;
        const { node: reverseNode, branch: reverseArm } = getArmConn(targetNode, targetArm);
        if (reverseNode !== n.name) {
          warnings.push(
            `LINK MISMATCH: "${n.name}" ${srcArm}-arm → "${targetName}" ${targetArm}-arm, ` +
            `but "${targetName}" ${targetArm}-arm → "${reverseNode || '(none)'}" (expected "${n.name}")`
          );
        } else if (reverseArm !== srcArm) {
          warnings.push(
            `LINK MISMATCH: "${n.name}" ${srcArm}-arm → "${targetName}" ${targetArm}-arm, ` +
            `but "${targetName}" ${targetArm}-arm back-references "${n.name}"'s ${reverseArm}-arm ` +
            `(expected ${srcArm}-arm)`
          );
        }
      }
    }
  }

  // ── Step 16: Shared-region link validation + auto-resolution ──────────────
  // Every link must connect two nodes that share at least one region name.
  // When a pair has no shared region we try auto-resolution: if either node's
  // coordinates lie on the other section's geometry (within AMBIG_THRESHOLD
  // squared-degrees) we add a region2/km2 alias to the closer node.
  {
    const AMBIG_THRESHOLD = 1e-5; // ~260 m at 44°N — generous for OSM offsets

    function nearestInGeometry(section, lat, lon) {
      const pts = geometryBySection.get(section);
      if (!pts || !pts.length) return { km: null, dist: Infinity };
      let bestKm = null, bestDist = Infinity;
      for (const pt of pts) {
        const d = (pt.lat - lat) ** 2 + (pt.lon - lon) ** 2;
        if (d < bestDist) { bestDist = d; bestKm = pt.km; }
      }
      return { km: bestKm, dist: bestDist };
    }

    const nodeRegions = (n) => [n.region, n.region2, n.region3].filter(Boolean);
    const sharesRegion = (a, b) => nodeRegions(a).some(r => nodeRegions(b).includes(r));
    const nodeByNameMap2 = new Map(nodes.map(n => [n.name, n]));

    function tryAutoAlias(candidate, targetRegions) {
      for (const r of targetRegions) {
        if (nodeRegions(candidate).includes(r)) continue;
        const { km, dist } = nearestInGeometry(r, candidate.lat, candidate.lon);
        if (km != null && dist < AMBIG_THRESHOLD) {
          if (!candidate.region2) {
            candidate.region2 = r;
            candidate.km2 = +km.toFixed(3);
          } else if (!candidate.region3) {
            candidate.region3 = r;
            candidate.km3 = +km.toFixed(3);
          } else {
            continue; // no free alias slot
          }
          warnings.push(
            `Topology: auto-resolved ambiguous link — added ${r} km ${km.toFixed(3)} alias to "${candidate.name}" (geometry distance ${Math.sqrt(dist * 111000 * 111000).toFixed(0)} m)`
          );
          return true;
        }
      }
      return false;
    }

    const reportedPairs = new Set();
    for (const n of nodes) {
      for (const linkedName of [n.fNode, n.tNode, n.dNode]) {
        if (!linkedName) continue;
        const linked = nodeByNameMap2.get(linkedName);
        if (!linked) continue;
        if (sharesRegion(n, linked)) continue;
        const pairKey = [n.name, linked.name].sort().join('\u2194');
        if (reportedPairs.has(pairKey)) continue;
        reportedPairs.add(pairKey);

        const resolved =
          tryAutoAlias(n, nodeRegions(linked)) ||
          tryAutoAlias(linked, nodeRegions(n));

        if (!resolved) {
          warnings.push(
            `AMBIGUOUS LINK: "${n.name}" [${nodeRegions(n).join(', ')}] \u2194 "${linked.name}" [${nodeRegions(linked).join(', ')}] — no shared region. Add a regionAlias to one endpoint.`
          );
        }
      }
    }
  }

  // ── Step 16b: Post-alias geometry pruning ──
  // Step 16 may have added geometry aliases that re-introduce ambiguous links.
  // Run a lightweight Pass 2 (ambiguity breaking) to clean up.
  {
    const nodeByName3 = new Map(nodes.map(n => [n.name, n]));
    const getG = n => { const g = [n.region]; if (n.region2) g.push(n.region2); if (n.region3) g.push(n.region3); return g; };
    const nbs = n => [n.fNode, n.tNode, n.dNode].filter(Boolean).map(nm => nodeByName3.get(nm)).filter(Boolean);
    const canRemove = (node, g) => {
      const cur = getG(node), rem = cur.filter(x => x !== g);
      if (!rem.length) return false;
      for (const nb of nbs(node)) {
        const ng = getG(nb), cs = cur.filter(x => ng.includes(x));
        if (cs.length === 0) continue;
        if (!rem.some(r => ng.includes(r))) return false;
      }
      return true;
    };
    const helpsAmbig = (node, g) => {
      const rem = getG(node).filter(x => x !== g);
      for (const nb of nbs(node)) {
        const ng = getG(nb), old = getG(node).filter(x => ng.includes(x));
        if (old.length > 1 && rem.filter(x => ng.includes(x)).length < old.length) return true;
      }
      return false;
    };
    const dropGeo = (node, g) => {
      if (node.region === g) { node.region = node.region2; node.km = node.km2; node.region2 = node.region3 || null; node.km2 = node.km3 ?? null; node.region3 = null; node.km3 = null; }
      else if (node.region2 === g) { node.region2 = node.region3 || null; node.km2 = node.km3 ?? null; node.region3 = null; node.km3 = null; }
      else if (node.region3 === g) { node.region3 = null; node.km3 = null; }
    };
    let ch = true, postCount = 0;
    while (ch) {
      ch = false;
      for (const node of nodes) {
        const geos = getG(node);
        if (geos.length <= 1) continue;
        for (let i = geos.length - 1; i >= 0; i--) {
          if (canRemove(node, geos[i]) && helpsAmbig(node, geos[i])) {
            dropGeo(node, geos[i]); ch = true; postCount++; break;
          }
        }
      }
    }
    if (postCount > 0) warnings.push(`Post-alias pruning: removed ${postCount} additional geometry refs.`);
  }

  updateProgress(93, 'Building CSV output');

  // Diamond sanity check: a genuine diamond crossing's four arms should lead
  // to four DIFFERENT neighbours. Two arms landing on the same neighbour
  // means either two parallel tracks really do run directly between two
  // consecutive diamonds with nothing else between them (possible in a dense
  // multi-track yard throat), or the pairing/chain-following got it wrong —
  // flagged here rather than requiring a manual CSV read to spot.
  {
    const dupDiamonds = [];
    for (const n of nodes) {
      if (n.railwayType !== 'diamond') continue;
      const counts = new Map();
      for (const nb of [n.fNode, n.tNode, n.dNode, n.xNode]) {
        if (!nb) continue;
        counts.set(nb, (counts.get(nb) || 0) + 1);
      }
      for (const [nb, count] of counts) {
        if (count > 1) dupDiamonds.push(`"${n.name}" → "${nb}" (${count} arms)`);
      }
    }
    if (dupDiamonds.length > 0) {
      warnings.push(
        `DIAMOND DOUBLE-LINK (${dupDiamonds.length}): a diamond crossing has more than one arm ` +
        `connecting to the same neighbour — verify this is genuinely two parallel tracks and not a ` +
        `misclassified junction: ${dupDiamonds.join(', ')}`
      );
    }
  }

  // ── Step 17: Build Infrastructure CSV ──
  const connectionCount = nodes.filter(n => n.tNode || n.fNode || n.dNode || n.xNode).length;
  const csv = buildInfrastructureCsv(nodes, networkName, nodes.length, connectionCount);

  // Add final warnings
  warnings.push(
    'SIGNAL OMISSION: Intermediate block signals have been omitted. Traxim assumes signals at each turnout. ' +
    'Add intermediate signals manually using the Network Editor if needed.'
  );
  warnings.push(
    'CONNECTIONS: Node connections derived from OSM topology chain-following. ' +
    'Cross-section connections must be set manually in the Network Editor.'
  );

  // Check for isolated nodes
  const isolated = nodes.filter(n => !n.fNode && !n.tNode && !n.dNode && !n.xNode);
  if (isolated.length > 0) {
    warnings.push(
      `ISOLATED NODES (${isolated.length}): no connections — may be a separate sub-network or ` +
      `require manual linking: ${isolated.map(n => `"${n.name}"`).join(', ')}`
    );
  }

  updateProgress(100, 'Infrastructure generation complete');

  return {
    csv,
    nodeCount: nodes.length,
    connectionCount,
    warnings
  };
}

/** Format a Date as "YYYY-MM-DD HH:mm:ss" (local time), matching the Network Editor's own stamp. */
function formatTimestamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
         `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

/**
 * Build Infrastructure CSV content from nodes array (v7 format).
 * @param {Array<Object>} nodes - Infrastructure nodes
 * @param {string} networkName - Network name
 * @param {number} nodeCount - Total node count, for the version line
 * @param {number} connectionCount - Total connection count, for the version line
 * @returns {string} CSV content
 */
function buildInfrastructureCsv(nodes, networkName, nodeCount, connectionCount) {
  const lines = [
    `#7,Traxim v7 ${formatTimestamp(new Date())} nodes ${nodeCount} connections ${connectionCount}`,
    networkName,
    `#Name,F Enabled,T Enabled,D Enabled,X Enabled,F Node,F on branch,T Node,T on branch,D Node,D on branch,X Node,X on branch,Region1,Km1,Region2,Km2,Region3,Km3,Region4,Km4,Default branch,Length,Width,Rotation,Flip,Draw,Timing Point,Capacity Point,Signalled F,Signalled T,SimEntry Permitted,SimArrival Timeout,PosX,PosY,OffsetX,OffsetY,Latitude,Longitude`,
  ];

  for (const node of nodes) {
    const isDiamond = node.railwayType === 'diamond';
    lines.push(
      [
        sanitiseName(node.name),
        'True',
        'True',
        'True',
        'True',
        node.fNode ? sanitiseName(node.fNode) : '',
        node.fNode ? (node.fOnBranch ?? 'T') : '',
        node.tNode ? sanitiseName(node.tNode) : '',
        node.tNode ? (node.tOnBranch ?? 'F') : '',
        node.dNode ? sanitiseName(node.dNode) : '',
        node.dNode ? (node.dOnBranch ?? 'F') : '',
        node.xNode ? sanitiseName(node.xNode) : '',
        node.xNode ? (node.xOnBranch ?? 'F') : '',
        node.region || '',
        (node.km ?? 0).toFixed(3),
        node.region2 || '',
        node.km2 != null ? node.km2.toFixed(3) : '',
        node.region3 || '',
        node.km3 != null ? node.km3.toFixed(3) : '',
        '', // Region4 — not currently tracked (nodes span at most 3 regions)
        '', // Km4
        isDiamond ? '' : 'T', // Default branch — no default for a diamond crossing
        '40',
        isDiamond ? '10' : '20', // Width — 10 gives diamonds a better crossing angle in the Network Editor
        node.rotation ?? 0,
        node.flip ? 'True' : 'False',
        'True', // Draw
        'True', // Timing Point — mirrors Draw, preserving pre-v7 behaviour where the two were coupled
        'False', // Capacity Point
        node.signalledF === false ? 'False' : 'True',
        node.signalledT === false ? 'False' : 'True',
        'False', // SimEntry Permitted
        '60', // SimArrival Timeout
        node.posX ?? '0',
        node.posY ?? '0',
        node.offsetX ?? '0',
        node.offsetY ?? '0',
        node.lat.toFixed(8),
        node.lon.toFixed(8),
      ].join(',')
    );
  }

  return lines.join('\n') + '\n';
}

// Hand-picked, high-contrast colour names matching Network-Editor's own
// region palette (see CreateRandomColorSequence's priorityColors in
// Network-Editor/NetworkEditorWebAssembly/Pages/Home.razor) — chosen there to
// stand out against a black background and to avoid red (used there as an
// error indicator). Network-Editor falls back to a much larger stride-based
// palette beyond ~12 regions; that fallback isn't ported here, so this simply
// cycles back to the start for any additional regions.
export const REGION_COLOURS = [
  'Lime', 'Cyan', 'Gold', 'DeepSkyBlue', 'Magenta', 'SpringGreen',
  'Orange', 'DodgerBlue', 'Yellow', 'Aqua', 'Chartreuse', 'Violet'
];

/**
 * Build Regions.csv content from the confirmed sections list.
 * Row 2 is a fixed blank-region boilerplate row required by the Traxim
 * Regions file format; every column besides Region Name, Colour and Train
 * Graph Order is a fixed default, matching the standard Traxim template.
 * @param {Array<{name: string}>} confirmedSections - in UI display order
 * @returns {string} CSV content
 */
function buildRegionsCsv(confirmedSections) {
  const lines = [
    '#Region Name, Colour, Train Graph Order,Opposing delay,Following Delay,Reverse Section,Nominal Superelevation,Nominal cant deficiency,',
    ',White,1,0,0,FALSE,,Normal,Passenger'
  ];

  confirmedSections.forEach((section, i) => {
    const colour = REGION_COLOURS[i % REGION_COLOURS.length];
    const order = i + 2; // row 2 (blank region) occupies order 1
    lines.push(`${section.name},${colour},${order},90,90,FALSE,120,75,110`);
  });

  return lines.join('\n') + '\n';
}

export {
  generateInfrastructureForSections,
  fetchStationsFromOverpass,
  fetchPlatformsFromOverpass,
  fetchRailwayTopologyFromOverpass,
  parseGeometryCsv,
  buildInfrastructureCsv,
  buildRegionsCsv
};
