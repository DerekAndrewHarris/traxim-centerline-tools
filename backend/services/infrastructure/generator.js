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
  nearestKm,
  projectOntoGeometry,
  applySpatialSeparation,
  enforceReciprocalLinks
} from './processor.js';

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
  const query = `
    [out:json][timeout:60];
    (
      node["railway"="station"](${bbox});
      node["railway"="halt"](${bbox});
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
  // pipeline.  Expand bbox by ~5 km so that ways just outside the search area
  // (e.g. bridges, tunnels) are not missed.
  const MARGIN = 0.05; // ~5 km
  const parts = bbox.split(',').map(Number);
  const expandedBbox = [
    parts[0] - MARGIN, parts[1] - MARGIN,
    parts[2] + MARGIN, parts[3] + MARGIN
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
 * Ensure connected node pairs sharing a region have km values at least
 * MIN_NODE_SPACING_M / 1000 km apart.  Iteratively pushes km values apart
 * from their midpoint when they are too close.
 */
function ensureKmSeparation(nodes, geometryBySection) {
  const minKmSpacing = MIN_NODE_SPACING_M / 1000;
  const nodeByName = new Map(nodes.map(n => [n.name, n]));

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

  for (let iter = 0; iter < 10; iter++) {
    let changed = false;
    for (const node of nodes) {
      for (const [armField, branchField] of [['fNode','fOnBranch'], ['tNode','tOnBranch'], ['dNode','dOnBranch']]) {
        const targetName = node[armField];
        if (!targetName) continue;
        const target = nodeByName.get(targetName);
        if (!target) continue;

        // Skip degree-4 F-to-F partner pairs — they share km intentionally
        if (armField === 'fNode' && node[branchField] === 'F') continue;

        // Check ALL shared geometries between the two nodes
        const sharedGeos = getGeos(node).filter(g => getGeos(target).includes(g));
        for (const geo of sharedGeos) {
          const nKm = getKmOnGeo(node, geo);
          const tKm = getKmOnGeo(target, geo);
          if (nKm == null || tKm == null) continue;

          const kmDiff = Math.abs(nKm - tKm);
          if (kmDiff < minKmSpacing) {
            const midKm = (nKm + tKm) / 2;

            // Determine which geometry range is valid
            const geomPts = geometryBySection.get(geo);
            let minGeomKm = -Infinity, maxGeomKm = Infinity;
            if (geomPts && geomPts.length > 0) {
              minGeomKm = Math.min(...geomPts.map(p => p.km));
              maxGeomKm = Math.max(...geomPts.map(p => p.km));
            }

            let kmA = midKm - minKmSpacing / 2;
            let kmB = midKm + minKmSpacing / 2;

            // Clamp to geometry bounds
            if (kmA < minGeomKm) { kmA = minGeomKm; kmB = kmA + minKmSpacing; }
            if (kmB > maxGeomKm) { kmB = maxGeomKm; kmA = kmB - minKmSpacing; }

            // Assign so the lower-km node keeps the lower value
            if (nKm <= tKm) {
              setKmOnGeo(node, geo, +kmA.toFixed(3));
              setKmOnGeo(target, geo, +kmB.toFixed(3));
            } else {
              setKmOnGeo(node, geo, +kmB.toFixed(3));
              setKmOnGeo(target, geo, +kmA.toFixed(3));
            }
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
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
        // Degree-4: diamond crossing - create two back-to-back turnouts
        // Pair ways by minimizing dot product sum (find most-opposite pairs)
        const dirs = conns.map(c => ({
          wayId: c.wayId,
          ...computeWayDirection(coordKey, c.wayId, waysById)
        }));

        const pairings = [
          [[0,1],[2,3]], [[0,2],[1,3]], [[0,3],[1,2]]
        ];
        let bestScore = Infinity, bestPairing = pairings[0];
        for (const [[a,b],[c,d]] of pairings) {
          const score =
            dirs[a].dlat*dirs[b].dlat + dirs[a].dlon*dirs[b].dlon +
            dirs[c].dlat*dirs[d].dlat + dirs[c].dlon*dirs[d].dlon;
          if (score < bestScore) {
            bestScore = score;
            bestPairing = [[a,b],[c,d]];
          }
        }

        // Through-route assignment for crossing topology
        // connsA[0] and connsB[0] form tangent X → both map to T branch
        // connsA[1] and connsB[1] form tangent Y → both map to D branch
        // The spatial offset moves nodeA in the NEGATIVE direction of the T
        // reference way.  Each node's T arm faces OUTWARD (away from its
        // partner, along the track the sub-node represents).
        // For sequential diamonds connected by a shared way, Step 8 redirects
        // the target to the partner sub-node so the through-route connects
        // same-side nodes across both crossings.
        const refWayId = conns[bestPairing[0][0]].wayId;
        const connsA = [
          { ...conns[bestPairing[0][1]], _deg4Branch: 'T' },
          { ...conns[bestPairing[1][0]], _deg4Branch: 'D' }
        ];
        const connsB = [
          { ...conns[bestPairing[0][0]], _deg4Branch: 'T' },
          { ...conns[bestPairing[1][1]], _deg4Branch: 'D' }
        ];

        // Spatially separate by ±15m
        const { dlat: dirLat, dlon: dirLon } = computeWayDirection(coordKey, refWayId, waysById);
        const dirMag = Math.sqrt(dirLat * dirLat + dirLon * dirLon) || 1;
        const normDLat = dirLat / dirMag;
        const normDLon = dirLon / dirMag;

        const offsetM = 15;
        const offsetDegLat = offsetM / 111000;
        const offsetDegLon = (offsetM / 111000) / Math.cos(lat * Math.PI / 180);

        const latA = lat - normDLat * offsetDegLat;
        const lonA = lon - normDLon * offsetDegLon;
        const latB = lat + normDLat * offsetDegLat;
        const lonB = lon + normDLon * offsetDegLon;

        const nodeA = {
          name: `${nodeName} A`,
          lat: latA, lon: lonA, km,
          region: sectionName,
          railwayType: 'junction',
          _topoKey: coordKey,
          _topoConns: connsA
        };
        nodes.push(nodeA);

        const nodeB = {
          name: `${nodeName} B`,
          lat: latB, lon: lonB, km,
          region: sectionName,
          railwayType: 'junction',
          _topoKey: `${coordKey}_deg4B`,
          _topoConns: connsB,
          _degree4Partner: nodeA
        };
        nodeA._degree4Partner = nodeB;
        nodes.push(nodeB);

        // Cross-link F branches
        nodeA.fNode = nodeB.name;
        nodeA.fOnBranch = 'F';
        nodeB.fNode = nodeA.name;
        nodeB.fOnBranch = 'F';

        topoNodes.set(coordKey, [nodeA, nodeB]);
        processedCoordKeys.set(coordKey, [nodeA, nodeB]);
        warnings.push(`Topology: degree-4 key at ${sectionName} km ${km.toFixed(3)} — created two turnout nodes "${nodeA.name}" and "${nodeB.name}".`);

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
      const realKey = key.endsWith('_deg4B') ? key.slice(0, -6) : key;
      if (!realKeyToNodes.has(realKey)) realKeyToNodes.set(realKey, []);
      const arr = Array.isArray(entry) ? entry : [entry];
      realKeyToNodes.get(realKey).push(...arr);
    }
  }

  // Build section node key sets
  const sectionNodeKeyMap = new Map();
  for (const [sectionName, topoNodes] of topoNodesBySection) {
    const keys = new Set(
      [...topoNodes.keys()].map(k => k.endsWith('_deg4B') ? k.slice(0, -6) : k)
    );
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
        const realKey = key.endsWith('_deg4B') ? key.slice(0, -6) : key;
        const conns = node._topoConns ?? adj.get(realKey) ?? [];
        if (conns.length === 0) continue;

        // Build full connection list for determineBranch (includes synthetic
        // partner link for degree-4 sub-nodes so angle analysis sees all arms)
        let sourceConns = conns;
        if (node._degree4Partner) {
          const partner = node._degree4Partner;
          sourceConns = [...conns, {
            wayId: `_synthetic_partner_${node.name}`,
            otherKey: `${partner.lat},${partner.lon}`,
            _isSynthetic: true
          }];
        }

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
          if (!farNode) continue;

          // For degree-4 targets, pick the specific sub-node that owns the
          // arriving way.  Without this, candidates.find() picks the first
          // match by insertion order, which may be the wrong sub-node.
          if (farNode._degree4Partner) {
            const partner = farNode._degree4Partner;
            const farOwnsWay = farNode._topoConns?.some(c => c.wayId === arrivedViaWayId);
            const partnerOwnsWay = partner._topoConns?.some(c => c.wayId === arrivedViaWayId);
            if (!farOwnsWay && partnerOwnsWay && partner !== node) {
              farNode = partner;
            }
          }

          // Determine which branch of the FAR node the arriving way connects to
          const farNodeKey = farNode._topoKey || reachedKey;
          let farNodeConns = farNode._topoConns || adj.get(farNodeKey) || [];
          let farBranch;
          if (farNode._degree4Partner) {
            // Use the _deg4Branch tag from the far node's tagged connections
            const taggedFarConn = farNodeConns.find(c => c.wayId === arrivedViaWayId);
            farBranch = taggedFarConn?._deg4Branch ?? null;
            if (!farBranch) {
              // Fallback: determineBranch with synthetic partner
              const partner = farNode._degree4Partner;
              const augmented = [...farNodeConns, {
                wayId: `_synthetic_partner_${farNode.name}`,
                otherKey: `${partner.lat},${partner.lon}`,
                _isSynthetic: true
              }];
              farBranch = determineBranch(
                farNodeKey, augmented, arrivedViaWayId, waysById, farNode.km, null
              );
            }
          } else {
            farBranch = determineBranch(
              farNodeKey, farNodeConns, arrivedViaWayId, waysById, farNode.km, null
            );
          }

          // Determine which branch of THIS (source) node this way belongs to.
          // For degree-4 sub-nodes, F is already set to the partner — use
          // the _deg4Branch tag assigned during node creation to ensure
          // both nodes in the pair assign the same tangent to the same branch.
          let sourceBranch;
          if (node._degree4Partner) {
            const taggedConn = conns.find(c => c.wayId === conn.wayId);
            sourceBranch = taggedConn?._deg4Branch ?? (!node.tNode ? 'T' : !node.dNode ? 'D' : null);
          } else {
            sourceBranch = determineBranch(
              realKey, sourceConns, conn.wayId, waysById, node.km, null
            );
          }
          if (!sourceBranch) continue;

          // Assign the connection to the source branch
          const nodeField = sourceBranch === 'F' ? 'fNode' : sourceBranch === 'T' ? 'tNode' : 'dNode';
          const branchField = sourceBranch === 'F' ? 'fOnBranch' : sourceBranch === 'T' ? 'tOnBranch' : 'dOnBranch';

          if (!node[nodeField]) {
            node[nodeField] = farNode.name;
            node[branchField] = farBranch;
          }
        }
      }
    }
  }

  // ── Step 8a: Sequential diamond crossing fixup ──
  // When two degree-4 diamond crossings are connected by a shared way, the
  // outward T assignment connects sub-nodes on OPPOSITE sides of their
  // respective diamonds (e.g. I↔K).  The correct topology connects sub-nodes
  // on the SAME side (e.g. K↔H).  Detect this pattern and redirect:
  //   - If source.T reached a degree-4 sub-node whose PARTNER has an empty T,
  //     redirect source.T to the partner, set the partner's T reciprocally,
  //     and clear the old reached node's reciprocal T.
  for (const node of nodes) {
    if (!node._degree4Partner || !node.tNode) continue;

    // Find the reached T-target
    const target = nodes.find(n => n.name === node.tNode);
    if (!target || !target._degree4Partner) continue;
    if (node.tOnBranch !== 'T') continue;

    const partner = target._degree4Partner;
    if (partner === node) continue; // don't redirect to self
    if (partner.tNode) continue;    // partner's T already assigned

    // Confirm the target's T points back to this node (reciprocal link)
    if (target.tNode !== node.name) continue;

    // Redirect: source.T → partner, partner.T → source, clear target.T
    node.tNode = partner.name;
    node.tOnBranch = 'T';
    partner.tNode = node.name;
    partner.tOnBranch = 'T';
    target.tNode = null;
    target.tOnBranch = null;
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
          if (nodeA.fNode === nodeB.name || nodeA.tNode === nodeB.name || nodeA.dNode === nodeB.name) continue;

          // Find free arm on each — prefer D (diverging branch to another section)
          const freeArmA = !nodeA.dNode ? 'D' : !nodeA.tNode ? 'T' : !nodeA.fNode ? 'F' : null;
          const freeArmB = !nodeB.dNode ? 'D' : !nodeB.tNode ? 'T' : !nodeB.fNode ? 'F' : null;
          if (!freeArmA || !freeArmB) continue;

          const fieldA = freeArmA === 'F' ? 'fNode' : freeArmA === 'T' ? 'tNode' : 'dNode';
          const branchA = freeArmA === 'F' ? 'fOnBranch' : freeArmA === 'T' ? 'tOnBranch' : 'dOnBranch';
          nodeA[fieldA] = nodeB.name;
          nodeA[branchA] = freeArmB;

          const fieldB = freeArmB === 'F' ? 'fNode' : freeArmB === 'T' ? 'tNode' : 'dNode';
          const branchB = freeArmB === 'F' ? 'fOnBranch' : freeArmB === 'T' ? 'tOnBranch' : 'dOnBranch';
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
      if (node.fNode && node.tNode && node.dNode) continue;
      const realKey = node._topoKey;
      if (!realKey) continue;
      const conns = node._topoConns ?? adj.get(realKey) ?? [];

      for (const conn of conns) {
        if (node.fNode && node.tNode && node.dNode) break;

        const result = followChainToNode(realKey, conn.wayId, waysById, adj, allSectionNodeKeys);
        if (!result) continue;

        const { reachedKey, arrivedViaWayId } = result;
        const candidates = realKeyToNodes.get(reachedKey) ?? [];
        const farNode = candidates.find(
          c => c !== node && c.region !== node.region
        );
        if (!farNode) continue;

        // Already connected?
        if (node.fNode === farNode.name || node.tNode === farNode.name || node.dNode === farNode.name) continue;

        // Determine source branch
        let sourceConns = conns;
        let sourceBranch;
        if (node._degree4Partner) {
          const taggedConn = conns.find(c => c.wayId === conn.wayId);
          sourceBranch = taggedConn?._deg4Branch ?? (!node.tNode ? 'T' : !node.dNode ? 'D' : null);
        } else {
          sourceBranch = determineBranch(realKey, sourceConns, conn.wayId, waysById, node.km, null);
        }
        if (!sourceBranch) continue;

        const nodeField = sourceBranch === 'F' ? 'fNode' : sourceBranch === 'T' ? 'tNode' : 'dNode';
        if (node[nodeField]) continue;

        // Determine far branch
        const farNodeKey = farNode._topoKey || reachedKey;
        let farNodeConns = farNode._topoConns || adj.get(farNodeKey) || [];
        let farBranch;
        if (farNode._degree4Partner) {
          const taggedFarConn = farNodeConns.find(c => c.wayId === arrivedViaWayId);
          farBranch = taggedFarConn?._deg4Branch ?? null;
          if (!farBranch) {
            const partner = farNode._degree4Partner;
            const augmented = [...farNodeConns, {
              wayId: `_synthetic_partner_${farNode.name}`,
              otherKey: `${partner.lat},${partner.lon}`,
              _isSynthetic: true
            }];
            farBranch = determineBranch(
              farNodeKey, augmented, arrivedViaWayId, waysById, farNode.km, null
            );
          }
        } else {
          farBranch = determineBranch(
            farNodeKey, farNodeConns, arrivedViaWayId, waysById, farNode.km, null
          );
        }
        if (!farBranch) continue;

        const branchField = sourceBranch === 'F' ? 'fOnBranch' : sourceBranch === 'T' ? 'tOnBranch' : 'dOnBranch';
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
    }
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (n.fNode || n.tNode || n.dNode) continue;
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

  updateProgress(70, 'Applying spatial separation');

  // ── Step 9: Spatial separation ──
  const separationCount = applySpatialSeparation(nodes, warnings);

  // Recalculate km values after spatial separation — nodes that were pushed
  // apart now have different coordinates but still carry the old shared km.
  if (separationCount > 0) {
    for (const node of nodes) {
      const geomPts = geometryBySection.get(node.region);
      if (geomPts && geomPts.length > 0) {
        node.km = +nearestKm({ lat: node.lat, lon: node.lon }, geomPts).toFixed(3);
      }
    }
    // Ensure connected pairs have km values ≥ MIN_NODE_SPACING_M apart
    ensureKmSeparation(nodes, geometryBySection);
  }

  updateProgress(75, 'Fetching platform nodes');

  // ── Step 10: Fetch and insert platform nodes ──
  let platforms = [];
  if (bbox) {
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

  // Insert platforms (simplified - just add as adjacent nodes for now)
  const nodeByName = new Map(nodes.map(n => [n.name, n]));
  for (const platform of platforms) {
    const { centLat, centLon, name, id } = platform;

    // Find nearest node
    let bestNode = null, bestDistSq = Infinity;
    for (const node of nodes) {
      if (!node._topoKey) continue;
      const dSq = (node.lat - centLat) ** 2 + (node.lon - centLon) ** 2;
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        bestNode = node;
      }
    }

    // Only insert if within 500m
    if (!bestNode || bestDistSq > (500 / 111320) ** 2) continue;

    const sectionName = bestNode.region;
    const geomPoints = geometryBySection.get(sectionName) ?? [];
    const km = nearestKm({ lat: centLat, lon: centLon }, geomPoints);

    // Ensure unique name
    let platName = name;
    let idx = 0;
    while (nodes.some(n => n.name === platName)) {
      platName = `${name} ${String.fromCharCode(65 + idx++)}`;
    }

    // Add as adjacent node (simplified - full link splitting would be more complex)
    nodes.push({
      name: platName,
      lat: centLat,
      lon: centLon,
      km,
      region: sectionName,
      railwayType: 'platform'
    });
  }

  updateProgress(80, 'Enforcing reciprocal links');

  // ── Step 11: Enforce reciprocal links ──
  enforceReciprocalLinks(nodes, warnings);

  // Second orphan removal pass — connections may have been cleared by
  // enforceReciprocalLinks, leaving topo nodes with no links.
  {
    const before = nodes.length;
    const isReferenced = new Set();
    for (const n of nodes) {
      if (n.fNode) isReferenced.add(n.fNode);
      if (n.tNode) isReferenced.add(n.tNode);
      if (n.dNode) isReferenced.add(n.dNode);
    }
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (n.railwayType === 'platform') continue;
      if (n.fNode || n.tNode || n.dNode) continue;
      if (isReferenced.has(n.name)) continue;
      nodes.splice(i, 1);
    }
    if (nodes.length < before) {
      warnings.push(`Removed ${before - nodes.length} post-reciprocal orphaned nodes.`);
    }
  }

  // ── Final spatial separation pass ──
  // Run again after all connections (reciprocal enforcement,
  // cross-section) are finalized so that newly-connected pairs are also pushed
  // apart to the required minimum spacing.
  const finalSepCount = applySpatialSeparation(nodes, []);
  if (finalSepCount > 0) {
    for (const node of nodes) {
      const geomPts = geometryBySection.get(node.region);
      if (geomPts && geomPts.length > 0) {
        node.km = +nearestKm({ lat: node.lat, lon: node.lon }, geomPts).toFixed(3);
      }
    }
    warnings.push(`Final spatial separation: pushed apart ${finalSepCount} additional close pair(s).`);
  }

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

  // Enforce minimum km spacing on all shared geometries (primary + alt)
  ensureKmSeparation(nodes, geometryBySection);

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
  for (const node of nodes) {
    delete node._topoKey;
    delete node._topoConns;
    delete node._degree4Partner;
  }

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

      // Apply renames: node names and all F/T/D cross-references
      for (const n of nodes) {
        if (renameMap.has(n.name))  n.name  = renameMap.get(n.name);
        if (n.fNode && renameMap.has(n.fNode)) n.fNode = renameMap.get(n.fNode);
        if (n.tNode && renameMap.has(n.tNode)) n.tNode = renameMap.get(n.tNode);
        if (n.dNode && renameMap.has(n.dNode)) n.dNode = renameMap.get(n.dNode);
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
    const scale = 4000 / Math.max(maxLat - minLat, maxLon - minLon, 0.001);

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

      // Centerline position on canvas
      node.posX = ((projLon - minLon) * scale).toFixed(4);
      node.posY = ((maxLat - projLat) * scale).toFixed(4);

      // Offset = actual geographic position minus centerline position
      node.offsetX = (((node.lon - projLon)) * scale).toFixed(4);
      node.offsetY = (((projLat - node.lat)) * scale).toFixed(4);

      // Turnout flip: determine whether the diverge is left or right when
      // looking along the through route from the node toward T.
      // Cross product of (node→T direction) × (node→D direction):
      //   positive → D diverges to the left  → flip = false (Network Editor convention)
      //   negative → D diverges to the right → flip = true
      if (node.dNode) {
        const dNeighbour = nodeByName.get(node.dNode);
        if (dNeighbour) {
          // Through direction: prefer node→T; fall back to node→F when T is empty
          let throughNeighbour;
          if (node.tNode) throughNeighbour = nodeByName.get(node.tNode);
          if (!throughNeighbour && node.fNode) throughNeighbour = nodeByName.get(node.fNode);

          if (throughNeighbour) {
            const throughLat = throughNeighbour.lat - node.lat;
            const throughLon = throughNeighbour.lon - node.lon;
            const divLat = dNeighbour.lat - node.lat;
            const divLon = dNeighbour.lon - node.lon;
            const cross = throughLon * divLat - throughLat * divLon;
            node.flip = cross < 0;
          }
        }
      }
    }


  }

  updateProgress(90, 'Validating connections');

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

  // ── Step 17: Build Infrastructure CSV ──
  const csv = buildInfrastructureCsv(nodes, networkName);
  const connectionCount = nodes.filter(n => n.tNode || n.fNode).length;

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
  const isolated = nodes.filter(n => !n.fNode && !n.tNode && !n.dNode);
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

/**
 * Build Infrastructure CSV content from nodes array
 * @param {Array<Object>} nodes - Infrastructure nodes
 * @param {string} networkName - Network name
 * @returns {string} CSV content
 */
function buildInfrastructureCsv(nodes, networkName) {
  const lines = [
    `#6,Traxim v6 - Generated by traxim-input-creator-mcp`,
    networkName,
    `#Name,F Enabled,T Enabled,D Enabled,F Node,F on branch,T Node,T on branch,D Node,D on branch,Region1,Km1,Region2,Km2,Region3,Km3,Default branch,PosX,PosY,Length,Width,Rotation,Flip,Mirror,Draw,OffsetX,OffsetY,Latitude,Longitude`,
  ];

  for (const node of nodes) {
    lines.push(
      [
        sanitiseName(node.name),
        'True',
        'True',
        'True',
        node.fNode ? sanitiseName(node.fNode) : '',
        node.fNode ? (node.fOnBranch ?? 'T') : '',
        node.tNode ? sanitiseName(node.tNode) : '',
        node.tNode ? (node.tOnBranch ?? 'F') : '',
        node.dNode ? sanitiseName(node.dNode) : '',
        node.dNode ? (node.dOnBranch ?? 'F') : '',
        node.region || '',
        (node.km ?? 0).toFixed(3),
        node.region2 || '',
        node.km2 != null ? node.km2.toFixed(3) : '',
        node.region3 || '',
        node.km3 != null ? node.km3.toFixed(3) : '',
        'T',
        node.posX ?? '0',
        node.posY ?? '0',
        '40',
        '20',
        '0',
        node.flip ? 'True' : 'False',
        'False',
        'True',
        node.offsetX ?? '0',
        node.offsetY ?? '0',
        node.lat.toFixed(8),
        node.lon.toFixed(8),
      ].join(',')
    );
  }

  return lines.join('\n') + '\n';
}

export {
  generateInfrastructureForSections,
  fetchStationsFromOverpass,
  fetchPlatformsFromOverpass,
  fetchRailwayTopologyFromOverpass,
  parseGeometryCsv,
  buildInfrastructureCsv
};
