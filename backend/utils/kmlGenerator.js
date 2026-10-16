/**
 * KML/KMZ Generator
 * Port of the working lib/io.js generateLinesKML method to backend.
 * buildGeometryKml() makes the same KML as the website's "Generate &
 * Download KMZ" button (whose doc.kml it is) from a session's geometry
 * folder; the agent's download ZIP includes it for checking the routes in
 * Google Earth.
 */

import path from 'path';
import { promises as fs } from 'fs';

/**
 * KML color palette (ABGR format) - matching frontend lib/io.js
 */
const KML_COLORS = [
  'ff00ff00', // Lime
  'ff0000ff', // Red
  'ffffff00', // Cyan
  'ff00a5ff', // Orange
  'ff00ffff', // Yellow
  'ffff00ff', // Magenta
  'ff9e9e5f', // CadetBlue
  'ff008cff', // DarkOrange
  'ff800000', // Navy
  'ff800080'  // Purple
];

/**
 * Escape XML special characters
 */
function escapeXml(unsafe) {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

/**
 * Generate KML styles
 */
function generateKMLStyles() {
  let styles = '';
  
  for (let i = 0; i < KML_COLORS.length; i++) {
    styles += `  <Style id="style_${i}">\n`;
    styles += '    <LineStyle>\n';
    styles += `      <color>${KML_COLORS[i]}</color>\n`;
    styles += '      <width>3</width>\n';
    styles += '    </LineStyle>\n';
    styles += '    <PolyStyle>\n';
    styles += `      <color>${KML_COLORS[i]}</color>\n`;
    styles += '    </PolyStyle>\n';
    styles += '  </Style>\n';
  }
  
  // Style for kilometrage posts
  styles += '  <Style id="post_style">\n';
  styles += '    <IconStyle>\n';
  styles += '      <color>ffffffff</color>\n';
  styles += '      <scale>0.4</scale>\n';
  styles += '      <Icon>\n';
  styles += '        <href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href>\n';
  styles += '      </Icon>\n';
  styles += '    </IconStyle>\n';
  styles += '    <LabelStyle>\n';
  styles += '      <scale>0.7</scale>\n';
  styles += '    </LabelStyle>\n';
  styles += '  </Style>\n';
  
  return styles;
}

/**
 * True when a route has real elevation data (not every altitude 0 or missing).
 * @param {Array<{altitude:number}>} points
 */
export function routeHasElevation(points) {
  return Array.isArray(points) && points.some(p => Number.isFinite(p.altitude) && p.altitude !== 0);
}

/**
 * Generate Lines KML - exact port from lib/io.js
 * @param {Object} geometryDict - Object with section names as keys, arrays of points as values
 * @param {Object} params - { altitudeMode: 'clampToGround' | 'absolute' | 'auto', exaggeration: number, offset: number }
 * @returns {string} KML content
 */
export function generateLinesKML(geometryDict, params = {}) {
  const { exaggeration = 1, offset = 0, altitudeMode = 'clampToGround' } = params;
  // 'auto' (October 2026, the generated geometry's KMZ): each route at its
  // own (smoothed) heights, altitudeMode absolute, so Google Earth shows the
  // calculated line and its elevation profile is ours (tunnels run
  // underground, embankments may float a little); a route with no elevation
  // data (every altitude 0) is clamped to the ground instead of being drawn
  // at sea level. Coordinates are lon,lat,alt as KML requires.
  const modeFor = (points) => altitudeMode === 'auto'
    ? (routeHasElevation(points) ? 'absolute' : 'clampToGround')
    : (altitudeMode === 'absolute' ? 'absolute' : 'clampToGround');
  
  console.log(`[KML Generator] Generating Lines KML with ${Object.keys(geometryDict).length} sections`);
  
  let kml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  kml += '<kml xmlns="http://www.opengis.net/kml/2.2">\n';
  kml += '<Document>\n';
  kml += '  <name>Traxim Centerlines</name>\n';
  kml += '  <description>Generated from CSV files</description>\n';
  
  // Add styles
  kml += generateKMLStyles();
  
  // Lines folder
  kml += '  <Folder>\n';
  kml += '    <name>Lines</name>\n';
  
  let colorIndex = 0;
  
  for (const [sectionName, points] of Object.entries(geometryDict)) {
    if (points.length === 0) continue;
    
    colorIndex++;
    const altMode = modeFor(points);
    
    kml += '    <Placemark>\n';
    kml += `      <name>${escapeXml(sectionName)}</name>\n`;
    kml += '      <visibility>1</visibility>\n';
    kml += `      <styleUrl>#style_${colorIndex % 10}</styleUrl>\n`;
    kml += '      <LineString>\n';
    kml += '        <extrude>0</extrude>\n';
    kml += '        <tessellate>1</tessellate>\n';
    kml += `        <altitudeMode>${altMode}</altitudeMode>\n`;
    kml += '        <coordinates>\n';
    
    for (const point of points) {
      const alt = altMode === 'absolute' ? (point.altitude + offset) * exaggeration : 0;
      kml += `          ${point.longitude.toFixed(8)},${point.latitude.toFixed(8)},${alt.toFixed(3)}\n`;
    }
    
    kml += '        </coordinates>\n';
    kml += '      </LineString>\n';
    kml += '    </Placemark>\n';
  }
  
  kml += '  </Folder>\n';

  // Posts folder (kilometrage markers), hidden by default - as lib/io.js
  kml += '  <Folder>\n';
  kml += '    <name>Posts</name>\n';
  kml += '    <visibility>0</visibility>\n';

  for (const [sectionName, points] of Object.entries(geometryDict)) {
    if (points.length === 0) continue;

    kml += '    <Folder>\n';
    kml += `      <name>${escapeXml(sectionName)}</name>\n`;
    const altMode = modeFor(points);

    for (const point of points) {
      if (point.chainage !== null && point.chainage !== undefined && !isNaN(point.chainage)) {
        const km = point.chainage.toFixed(3);
        kml += '      <Placemark>\n';
        kml += `        <name>km ${km}</name>\n`;
        kml += '        <visibility>0</visibility>\n';
        kml += '        <styleUrl>#post_style</styleUrl>\n';
        kml += '        <Point>\n';
        kml += `          <altitudeMode>${altMode}</altitudeMode>\n`;
        const alt = altMode === 'absolute' ? (point.altitude + offset) * exaggeration : 0;
        kml += `          <coordinates>${point.longitude.toFixed(8)},${point.latitude.toFixed(8)},${alt.toFixed(3)}</coordinates>\n`;
        kml += '        </Point>\n';
        kml += '      </Placemark>\n';
      }
    }

    kml += '    </Folder>\n';
  }

  kml += '  </Folder>\n';

  kml += '</Document>\n';
  kml += '</kml>';
  
  console.log(`[KML Generator] Generated KML length: ${kml.length} characters`);
  
  return kml;
}

/**
 * Read a geometry CSV. Two layouts:
 *  - Traxim geometry (what the File Generator writes):
 *      region name, latitude, longitude, elevation, kilometerage[, raw_elevation]
 *    (read like lib/io.js readCsvLatLongCharlotte, as the website does);
 *  - plain lat, lon[, elevation] per line.
 * Lines starting with # are skipped.
 * @param {string} csvContent - CSV file content
 * @param {string} sectionName - Section name from filename
 * @returns {Array<{latitude, longitude, altitude, chainage?}>}
 */
export function readGeometryCSV(csvContent, sectionName) {
  const lines = csvContent.split(/\r?\n/);
  const points = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;
    
    const delimiter = line.includes('\t') ? '\t' : ',';
    const parts = line.split(delimiter).map(p => p.trim());
    // A non-numeric first column is the region name (Traxim geometry layout).
    const named = parts.length >= 3 && !Number.isFinite(Number(parts[0]));
    const values = named ? parts.slice(1) : parts;
    if (values.length >= 2) {
      const lat = parseFloat(values[0]);
      const lon = parseFloat(values[1]);
      const alt = values.length >= 3 ? parseFloat(values[2]) : 0;
      const chainage = named && values.length >= 4 ? parseFloat(values[3]) : NaN;
      
      if (!isNaN(lat) && !isNaN(lon)) {
        points.push({
          latitude: lat,
          longitude: lon,
          altitude: isNaN(alt) ? 0 : alt,
          ...(isNaN(chainage) ? {} : { chainage })
        });
      }
    }
  }
  
  console.log(`[KML Generator] Read ${points.length} points from ${sectionName}`);
  return points;
}

/** Geometry CSVs in a folder that are routes (not *_wayids.csv diagnostics). */
function isRouteCsv(fileName) {
  return fileName.endsWith('.csv') && !fileName.includes('wayids');
}

/**
 * The KML of every geometry file in a folder: one line per route (named
 * like the website does: file name, underscores as spaces) plus a hidden
 * Posts folder of kilometre markers. Same settings as the website's KMZ
 * button: every route at its smoothed heights (altitudeMode absolute), except
 * a route with no elevation data, which is clamped to the ground
 * (groundClampedRoutes).
 * @param {string} geometryDir
 * @returns {Promise<{kml: string, routeCount: number, groundClampedRoutes: string[]}|null>} null if there are no geometry files
 */
export async function buildGeometryKml(geometryDir) {
  let files;
  try {
    files = (await fs.readdir(geometryDir)).filter(isRouteCsv).sort();
  } catch {
    return null;
  }
  const geometryDict = {};
  for (const file of files) {
    const sectionName = file.replace('.csv', '').replace(/_/g, ' ');
    const points = readGeometryCSV(await fs.readFile(path.join(geometryDir, file), 'utf-8'), sectionName);
    if (points.length > 0) geometryDict[sectionName] = points;
  }
  const routeCount = Object.keys(geometryDict).length;
  if (routeCount === 0) return null;
  return {
    kml: generateLinesKML(geometryDict, { altitudeMode: 'auto', exaggeration: 1, offset: 0 }),
    routeCount,
    groundClampedRoutes: Object.entries(geometryDict).filter(([, pts]) => !routeHasElevation(pts)).map(([name]) => name)
  };
}
