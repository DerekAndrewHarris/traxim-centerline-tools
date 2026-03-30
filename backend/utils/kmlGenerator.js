/**
 * KML/KMZ Generator
 * Port of the working lib/io.js generateLinesKML method to backend
 */

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
 * Generate Lines KML - exact port from lib/io.js
 * @param {Object} geometryDict - Object with section names as keys, arrays of points as values
 * @param {Object} params - { altitudeMode: 'clampToGround' | 'absolute', exaggeration: number, offset: number }
 * @returns {string} KML content
 */
export function generateLinesKML(geometryDict, params = {}) {
  const { exaggeration = 1, offset = 0, altitudeMode = 'clampToGround' } = params;
  const altMode = altitudeMode === 'absolute' ? 'absolute' : 'clampToGround';
  
  console.log(`[KML Generator] Generating Lines KML with ${Object.keys(geometryDict).length} sections`);
  
  let kml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  kml += '<kml xmlns="http://www.opengis.net/kml/2.2">\n';
  kml += '<Document>\n';
  kml += '  <name>Traxim Centerlines</name>\n';
  kml += '  <description>Generated from geometry CSV files</description>\n';
  
  // Add styles
  kml += generateKMLStyles();
  
  // Lines folder
  kml += '  <Folder>\n';
  kml += '    <name>Lines</name>\n';
  
  let colorIndex = 0;
  
  for (const [sectionName, points] of Object.entries(geometryDict)) {
    if (points.length === 0) continue;
    
    colorIndex++;
    
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
  kml += '</Document>\n';
  kml += '</kml>';
  
  console.log(`[KML Generator] Generated KML length: ${kml.length} characters`);
  
  return kml;
}

/**
 * Read backend geometry CSV format (lat,lon,ele per line)
 * @param {string} csvContent - CSV file content
 * @param {string} sectionName - Section name from filename
 * @returns {Array} Array of point objects
 */
export function readGeometryCSV(csvContent, sectionName) {
  const lines = csvContent.split(/\r?\n/);
  const points = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;
    
    const parts = line.split(',');
    if (parts.length >= 2) {
      const lat = parseFloat(parts[0]);
      const lon = parseFloat(parts[1]);
      const alt = parts.length >= 3 ? parseFloat(parts[2]) : 0;
      
      if (!isNaN(lat) && !isNaN(lon)) {
        points.push({
          latitude: lat,
          longitude: lon,
          altitude: isNaN(alt) ? 0 : alt
        });
      }
    }
  }
  
  console.log(`[KML Generator] Read ${points.length} points from ${sectionName}`);
  return points;
}
