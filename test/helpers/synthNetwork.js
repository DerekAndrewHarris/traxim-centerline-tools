/**
 * Synthetic railway networks for tests (no network access).
 *
 * The infrastructure generator normally gets its OpenStreetMap data from
 * Overpass, but it first looks for the cache files a geometry run leaves in
 * the session folder (osm_topology.json, osm_stations.json,
 * osm_platforms.json). These helpers write made-up versions of those files,
 * plus geometry CSVs, into a throwaway folder, so the real generator can be
 * run on small, known track layouts.
 *
 * Coordinates: everything is built on a local grid in METRES (x east, y
 * north) around a base point near La Spezia and converted to lat/lon here,
 * so tests can say "4.5 m north of the main line" directly.
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';

export const BASE = { lat: 44.1, lon: 9.8 };
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LON = 111320 * Math.cos(BASE.lat * Math.PI / 180);

/** Local metres -> {lat, lon}. */
export function ll(x, y) {
  return {
    lat: +(BASE.lat + y / M_PER_DEG_LAT).toFixed(9),
    lon: +(BASE.lon + x / M_PER_DEG_LON).toFixed(9)
  };
}

/**
 * A small OSM-like network builder: named points (OSM nodes) and ways
 * through them. Points shared by two ways are junctions, as in OSM.
 */
export class Net {
  constructor() {
    this.points = new Map(); // name -> {id, lat, lon}
    this.ways = [];
    this.taggedNodes = [];
    this.nextId = 1000;
  }

  point(name, x, y) {
    if (!this.points.has(name)) this.points.set(name, { id: String(this.nextId++), ...ll(x, y) });
    return this;
  }

  /** A way through the named points, in order. */
  way(id, pointNames, tags = { railway: 'rail' }) {
    const pts = pointNames.map(n => {
      const p = this.points.get(n);
      if (!p) throw new Error(`Unknown point ${n}`);
      return p;
    });
    this.ways.push({
      id: String(id),
      nodes: pts.map(p => p.id),
      coords: pts.map(p => ({ lat: p.lat, lon: p.lon })),
      tags
    });
    return this;
  }

  /** Tag an existing point (e.g. railway=switch, railway:switch=double_slip). */
  tag(name, tags) {
    const p = this.points.get(name);
    this.taggedNodes.push({ id: p.id, lat: p.lat, lon: p.lon, tags });
    return this;
  }

  topology() {
    return { ways: this.ways, taggedNodes: this.taggedNodes };
  }
}

/** Geometry CSV text for a straight-ish polyline given in local metres, sampled every `step` m. */
export function geometryCsv(region, polylineXY, step = 25) {
  const lines = ['#region name,latitude,longitude,elevation,kilometerage,raw_elevation'];
  let km = 0;
  const emit = (x, y) => {
    const p = ll(x, y);
    lines.push(`${region},${p.lat.toFixed(8)},${p.lon.toFixed(8)},10.00,${km.toFixed(5)},10.00`);
  };
  emit(polylineXY[0][0], polylineXY[0][1]);
  for (let i = 1; i < polylineXY.length; i++) {
    const [x0, y0] = polylineXY[i - 1];
    const [x1, y1] = polylineXY[i];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.round(len / step));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      km += len / n / 1000;
      emit(x0 + t * (x1 - x0), y0 + t * (y1 - y0));
    }
  }
  return lines.join('\n') + '\n';
}

/** A platform as the cache stores it (a closed outline given in local metres). */
export function platform(id, name, outlineXY, ref = null) {
  const geometry = outlineXY.map(([x, y]) => ll(x, y));
  const centLat = geometry.reduce((s, p) => s + p.lat, 0) / geometry.length;
  const centLon = geometry.reduce((s, p) => s + p.lon, 0) / geometry.length;
  return { id: String(id), centLat, centLon, geometry, name, ref };
}

/** Rectangle outline [x0..x1] x [y0..y1], closed. */
export function rect(x0, x1, y0, y1) {
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
}

/**
 * Write a session folder for the infrastructure generator.
 * @param {{geometry: Object<string,string>, net: Net, platforms?: Array|null, stations?: Array, corridorBbox?: object}} spec
 *   geometry: file name -> CSV text
 * @returns {Promise<{sessionPath: string, geometryDir: string, bbox: string}>}
 */
export async function writeSession(spec) {
  const sessionPath = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-synth-'));
  const geometryDir = path.join(sessionPath, 'geometry');
  await fs.mkdir(geometryDir);
  for (const [name, csv] of Object.entries(spec.geometry)) {
    await fs.writeFile(path.join(geometryDir, name), csv, 'utf-8');
  }
  await fs.writeFile(path.join(sessionPath, 'osm_topology.json'), JSON.stringify(spec.net.topology()), 'utf-8');
  // platforms: null = no cache file, so the generator fetches platforms
  // (tests then pass a stand-in Overpass request).
  if (spec.platforms !== null) {
    await fs.writeFile(path.join(sessionPath, 'osm_platforms.json'), JSON.stringify(spec.platforms || []), 'utf-8');
  }
  await fs.writeFile(path.join(sessionPath, 'osm_stations.json'), JSON.stringify(spec.stations || []), 'utf-8');
  const meta = { id: path.basename(sessionPath) };
  if (spec.corridorBbox) meta.confirmedSections = [{ name: 'test', corridorBbox: spec.corridorBbox }];
  await fs.writeFile(path.join(sessionPath, 'session.json'), JSON.stringify(meta), 'utf-8');
  // Any non-empty bbox: the generator only uses it to decide whether to look
  // for OSM data, and finds everything in the cache files above.
  return { sessionPath, geometryDir, bbox: `${BASE.lat - 0.05},${BASE.lon - 0.05},${BASE.lat + 0.05},${BASE.lon + 0.05}` };
}

/** Parse the generator's Infrastructure CSV (v7) into row objects keyed by header name. */
export function parseInfrastructureCsv(csv) {
  const lines = csv.split('\n').filter(l => l.length > 0);
  const header = lines[2].replace(/^#/, '').split(',');
  return lines.slice(3).map(line => {
    const fields = line.split(',');
    const row = { _fields: fields };
    header.forEach((h, i) => { row[h] = fields[i]; });
    return row;
  });
}

export async function removeSession(sessionPath) {
  await fs.rm(sessionPath, { recursive: true, force: true });
}
