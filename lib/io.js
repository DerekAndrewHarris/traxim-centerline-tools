// File I/O utilities for KML and CSV handling
console.log('[io.js] Starting to load io.js...');

class IOFunctions {
    // Read KML file and extract coordinates
    static readKml(kmlContent) {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(kmlContent, 'text/xml');
        
        const points = [];
        
        // Find all Placemark elements
        const placemarks = xmlDoc.getElementsByTagName('Placemark');
        
        for (let i = 0; i < placemarks.length; i++) {
            const placemark = placemarks[i];
            
            // Get name if available
            const nameElement = placemark.getElementsByTagName('name')[0];
            const sectionName = nameElement ? nameElement.textContent : `Section_${i}`;
            
            // Get description if available
            const descElement = placemark.getElementsByTagName('description')[0];
            const description = descElement ? descElement.textContent : '';
            
            // Look for coordinates in LineString or Point
            const coordinatesElements = placemark.getElementsByTagName('coordinates');
            
            for (let j = 0; j < coordinatesElements.length; j++) {
                const coordText = coordinatesElements[j].textContent.trim();
                const coordLines = coordText.split(/[\s\n]+/);
                
                for (const line of coordLines) {
                    if (line.trim() === '') continue;
                    
                    const parts = line.split(',');
                    if (parts.length >= 2) {
                        const lon = parseFloat(parts[0]);
                        const lat = parseFloat(parts[1]);
                        const alt = parts.length >= 3 ? parseFloat(parts[2]) : 0;
                        
                        if (!isNaN(lon) && !isNaN(lat)) {
                            const point = new GeoPoint(lat, lon, alt);
                            point.section = sectionName;
                            point.description = description;
                            points.push(point);
                        }
                    }
                }
            }
        }
        
        return points;
    }

    // Read CSV in Charlotte format (Lat, Long, Altitude, ...)
    static readCsvLatLongCharlotte(csvContent) {
        const lines = csvContent.split(/\r?\n/); // Handle both \n and \r\n
        const points = [];
        
        console.log(`Reading CSV with ${lines.length} lines`);
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line === '') continue; // Skip empty lines
            
            // Skip lines starting with #
            if (line.startsWith('#')) {
                console.log(`Skipping header line: ${line.substring(0, 50)}`);
                continue;
            }
            
            // Try to detect delimiter (tab or comma)
            const delimiter = line.includes('\t') ? '\t' : ',';
            const parts = line.split(delimiter).map(p => p.trim());
            
            // Expected format: Column 0 = section name, Column 1 = latitude (YLAT), Column 2 = longitude (XLONG), Column 3 = altitude (QTY_HEIGHT), Column 4 = chainage (QTY_KM)
            if (parts.length >= 3) {
                const sectionName = parts[0];
                const lat = parseFloat(parts[1]);
                const lon = parseFloat(parts[2]);
                const alt = parts.length >= 4 ? parseFloat(parts[3]) : 0;
                const chainage = parts.length >= 5 ? parseFloat(parts[4]) : null;
                
                if (!isNaN(lat) && !isNaN(lon)) {
                    const point = new GeoPoint(lat, lon, alt);
                    
                    // Set section name and chainage
                    point.section = sectionName;
                    if (chainage !== null && !isNaN(chainage)) {
                        point.chainage = chainage;
                    }
                    
                    points.push(point);
                } else {
                    console.log(`Line ${i}: Invalid lat/lon - lat: ${lat}, lon: ${lon}, parts: ${parts.slice(0, 4).join(', ')}`);
                }
            } else {
                console.log(`Line ${i}: Not enough columns (${parts.length})`);
            }
        }
        
        console.log(`Parsed ${points.length} points from CSV`);
        if (points.length > 0) {
            console.log(`First point: lat=${points[0].latitude}, lon=${points[0].longitude}, alt=${points[0].altitude}, section=${points[0].section}`);
        }
        
        return points;
    }

    // Write points to CSV format
    static writeCsvFromPoints(points) {
        let csv = '#Section,Latitude,Longitude,Altitude,Kilometrage,CurveRadius\n';
        
        for (const point of points) {
            csv += `${point.section || ''},`;
            csv += `${point.latitude.toFixed(8)},`;
            csv += `${point.longitude.toFixed(8)},`;
            csv += `${point.altitude.toFixed(3)},`;
            csv += `${((point.chainage || 0) / 1000).toFixed(3)},`;
            csv += `${(point.curveRadius || 0).toFixed(1)}\n`;
        }
        
        return csv;
    }

    // Generate KML from geometry dictionary
    static generateKML(geometryDict, params) {
        const { exaggeration, offset, altitudeMode, singleFile } = params;
        
        console.log(`Generating KML with ${Object.keys(geometryDict).length} sections`);
        
        let kml = '<?xml version="1.0" encoding="UTF-8"?>\n';
        kml += '<kml xmlns="http://www.opengis.net/kml/2.2">\n';
        kml += '<Document>\n';
        kml += '  <name>Traxim Centerlines</name>\n';
        kml += '  <description>Generated from CSV files</description>\n';
        
        // Add styles
        kml += this.generateKMLStyles();
        
        // Add placemarks for each section
        let colorIndex = 0;
        const colors = this.getColorPalette();
        
        for (const [sectionName, points] of Object.entries(geometryDict)) {
            console.log(`Section ${sectionName}: ${points.length} points`);
            if (points.length === 0) continue;
            
            const color = colors[colorIndex % colors.length];
            colorIndex++;
            
            kml += '  <Placemark>\n';
            kml += `    <name>${this.escapeXml(sectionName)}</name>\n`;
            kml += `    <styleUrl>#style_${colorIndex % 10}</styleUrl>\n`;
            kml += '    <LineString>\n';
            kml += `      <extrude>0</extrude>\n`;
            kml += `      <tessellate>1</tessellate>\n`;
            
            const altMode = altitudeMode === 'absolute' ? 'absolute' : 'clampToGround';
            kml += `      <altitudeMode>${altMode}</altitudeMode>\n`;
            
            kml += '      <coordinates>\n';
            for (const point of points) {
                const alt = altMode === 'absolute' ? (point.altitude + offset) * exaggeration : 0;
                kml += `        ${point.longitude.toFixed(8)},${point.latitude.toFixed(8)},${alt.toFixed(3)}\n`;
            }
            kml += '      </coordinates>\n';
            kml += '    </LineString>\n';
            kml += '  </Placemark>\n';
        }
        
        kml += '</Document>\n';
        kml += '</kml>';
        
        console.log(`Generated KML length: ${kml.length} characters`);
        
        return kml;
    }

    // Generate KML styles
    static generateKMLStyles() {
        const colors = this.getKMLColors();
        let styles = '';
        
        for (let i = 0; i < colors.length; i++) {
            styles += `  <Style id="style_${i}">\n`;
            styles += '    <LineStyle>\n';
            styles += `      <color>${colors[i]}</color>\n`;
            styles += '      <width>3</width>\n';
            styles += '    </LineStyle>\n';
            styles += '    <PolyStyle>\n';
            styles += `      <color>${colors[i]}</color>\n`;
            styles += '    </PolyStyle>\n';
            styles += '  </Style>\n';
        }
                // Style for kilometrage posts (small open circles)
        styles += '  <Style id="post_style">\n';
        styles += '    <IconStyle>\n';
        styles += '      <color>ffffffff</color>\n';  // White
        styles += '      <scale>0.4</scale>\n';  // Small size
        styles += '      <Icon>\n';
        styles += '        <href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href>\n';
        styles += '      </Icon>\n';
        styles += '    </IconStyle>\n';
        styles += '    <LabelStyle>\n';
        styles += '      <scale>0.7</scale>\n';  // Smaller label text
        styles += '    </LabelStyle>\n';
        styles += '  </Style>\n';
                return styles;
    }

    // Get color palette
    static getColorPalette() {
        return [
            '#00FF00', // Lime
            '#FF0000', // Red
            '#00FFFF', // Cyan
            '#FFA500', // Orange
            '#FFFF00', // Yellow
            '#FF00FF', // Magenta
            '#5F9EA0', // CadetBlue
            '#FF8C00', // DarkOrange
            '#000080', // Navy
            '#800080'  // Purple
        ];
    }

    // Get KML colors (ABGR format)
    static getKMLColors() {
        return [
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
    }

    // Escape XML special characters
    static escapeXml(unsafe) {
        return unsafe.replace(/[<>&'"]/g, (c) => {
            switch (c) {
                case '<': return '&lt;';
                case '>': return '&gt;';
                case '&': return '&amp;';
                case '\'': return '&apos;';
                case '"': return '&quot;';
            }
        });
    }

    // Generate Network Link KML for index file
    static generateNetworkLinkKML(fileNames) {
        let kml = '<?xml version="1.0" encoding="UTF-8"?>\n';
        kml += '<kml xmlns="http://www.opengis.net/kml/2.2">\n';
        kml += '<Document>\n';
        kml += '  <name>Traxim Centerlines Index</name>\n';
        kml += '  <description>Index file linking all centerline KMZ files</description>\n';
        
        // Add NetworkLink to lines.kmz
        kml += '  <NetworkLink>\n';
        kml += '    <name>Lines</name>\n';
        kml += '    <visibility>1</visibility>\n';
        kml += '    <Link>\n';
        kml += '      <href>lines.kmz</href>\n';
        kml += '    </Link>\n';
        kml += '  </NetworkLink>\n';
        
        kml += '</Document>\n';
        kml += '</kml>';
        
        return kml;
    }

    // Generate comprehensive lines KML with folder structure
    static generateLinesKML(geometryDict, params) {
        const { exaggeration, offset, altitudeMode } = params;
        const altMode = altitudeMode === 'absolute' ? 'absolute' : 'clampToGround';
        
        console.log(`Generating Lines KML with ${Object.keys(geometryDict).length} sections`);
        
        let kml = '<?xml version="1.0" encoding="UTF-8"?>\n';
        kml += '<kml xmlns="http://www.opengis.net/kml/2.2">\n';
        kml += '<Document>\n';
        kml += '  <name>Traxim Centerlines</name>\n';
        kml += '  <description>Generated from CSV files</description>\n';
        
        // Add styles
        kml += this.generateKMLStyles();
        
        // Lines folder
        kml += '  <Folder>\n';
        kml += '    <name>Lines</name>\n';
        
        let colorIndex = 0;
        const colors = this.getColorPalette();
        
        for (const [sectionName, points] of Object.entries(geometryDict)) {
            if (points.length === 0) continue;
            
            const color = colors[colorIndex % colors.length];
            colorIndex++;
            
            // Folder for this line
            kml += '    <Folder>\n';
            kml += `      <name>${this.escapeXml(sectionName)}</name>\n`;
            
            // Normal detail line
            kml += '      <Placemark>\n';
            kml += `        <name>${this.escapeXml(sectionName)}</name>\n`;
            kml += '        <visibility>1</visibility>\n';
            kml += `        <styleUrl>#style_${colorIndex % 10}</styleUrl>\n`;
            kml += '        <LineString>\n';
            kml += '          <extrude>0</extrude>\n';
            kml += '          <tessellate>1</tessellate>\n';
            kml += `          <altitudeMode>${altMode}</altitudeMode>\n`;
            kml += '          <coordinates>\n';
            
            for (const point of points) {
                const alt = altMode === 'absolute' ? (point.altitude + offset) * exaggeration : 0;
                kml += `            ${point.longitude.toFixed(8)},${point.latitude.toFixed(8)},${alt.toFixed(3)}\n`;
            }
            
            kml += '          </coordinates>\n';
            kml += '        </LineString>\n';
            kml += '      </Placemark>\n';
            
            // Low detail line (every 10th point)
            if (points.length > 20) {
                kml += '      <Placemark>\n';
                kml += `        <name>${this.escapeXml(sectionName)} - Low Detail</name>\n`;
                kml += '        <visibility>0</visibility>\n';
                kml += `        <styleUrl>#style_${colorIndex % 10}</styleUrl>\n`;
                kml += '        <LineString>\n';
                kml += '          <extrude>0</extrude>\n';
                kml += '          <tessellate>1</tessellate>\n';
                kml += `          <altitudeMode>${altMode}</altitudeMode>\n`;
            kml += '          <coordinates>\n';                
                for (let i = 0; i < points.length; i += 10) {
                    const point = points[i];
                    const alt = altMode === 'absolute' ? (point.altitude + offset) * exaggeration : 0;                    kml += `            ${point.longitude.toFixed(8)},${point.latitude.toFixed(8)},${alt.toFixed(3)}\n`;
                }
                // Add the last point if not already included
                if ((points.length - 1) % 10 !== 0) {
                    const point = points[points.length - 1];
                    const alt = altMode === 'absolute' ? (point.altitude + offset) * exaggeration : 0;
                    kml += `            ${point.longitude.toFixed(8)},${point.latitude.toFixed(8)},${alt.toFixed(3)}\n`;
                }
                
                kml += '          </coordinates>\n';
                kml += '        </LineString>\n';
                kml += '      </Placemark>\n';
            }
            
            kml += '    </Folder>\n';
        }
        
        kml += '  </Folder>\n';
        
        // Posts folder (kilometrage markers)
        kml += '  <Folder>\n';
        kml += '    <name>Posts</name>\n';
        kml += '    <visibility>0</visibility>\n';
        
        for (const [sectionName, points] of Object.entries(geometryDict)) {
            if (points.length === 0) continue;
            
            kml += '    <Folder>\n';
            kml += `      <name>${this.escapeXml(sectionName)}</name>\n`;
            
            // Generate posts for each point with chainage data
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
        
        console.log(`Generated Lines KML length: ${kml.length} characters`);
        
        return kml;
    }

    // Parse CSV using PapaParse (if available) or simple parsing
    static parseCSV(csvContent) {
        if (typeof Papa !== 'undefined') {
            const result = Papa.parse(csvContent, {
                header: true,
                skipEmptyLines: true,
                dynamicTyping: true
            });
            return result.data;
        } else {
            // Fallback simple parser
            const lines = csvContent.split('\n');
            const headers = lines[0].split(',').map(h => h.trim());
            const data = [];
            
            for (let i = 1; i < lines.length; i++) {
                if (lines[i].trim() === '') continue;
                const values = lines[i].split(',');
                const row = {};
                headers.forEach((header, index) => {
                    row[header] = values[index];
                });
                data.push(row);
            }
            
            return data;
        }
    }
}

// Verify IOFunctions is defined globally
console.log('IOFunctions class defined:', typeof IOFunctions);
if (typeof window !== 'undefined') {
    window.IOFunctions = IOFunctions;
    console.log('IOFunctions explicitly attached to window');
}
