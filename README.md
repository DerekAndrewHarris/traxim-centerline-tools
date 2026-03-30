# Traxim File Generator

**Unified web application for generating Traxim input files from OpenStreetMap data and converting between Google Earth KML and Traxim CSV formats.**

## Overview

This tool combines two major capabilities:

1. **OSM-Based Generation** (NEW): Generate complete Traxim input files (Geometry, Infrastructure, Regions, Speedboards) from OpenStreetMap railway data
2. **Centerline Conversion**: Convert between Google Earth KML files and Traxim centerline CSV files (original functionality preserved)

The backend provides a REST API for automation (agents), while the frontend offers an interactive visual interface for human users.

## Project Status

### ✅ Phase 1 Complete (Backend Infrastructure)
- Session management (temporary storage + 24hr cleanup)
- ZIP file downloads
- In-memory job queue
- REST API foundation
- Development server + integration guide

### 🚧 Phase 2 In Progress (OSM Services)
**Geography Services (Completed):**
- ✅ IPv4-only fetch wrapper (prevents Windows IPv6 hangs)
- ✅ Overpass API client (endpoint failover, rate limiting)
- ✅ Place name geocoding (admin boundaries + railway stations + Nominatim fallback)
- ✅ Railway section discovery (bidirectional deduplication, multi-bbox support)
- ✅ Geography API routes (/geocode, /sections, /confirm)

**Geometry Generation (Completed):**
- ✅ OSM geometry fetcher (full way coordinates from Overpass)
- ✅ Parallel track deduplication (20m threshold)
- ✅ Way chaining via graph traversal (F→T heuristic)
- ✅ Spline smoothing + resampling (simplified for backend)
- ✅ Chainage computation
- ✅ CSV writer (Traxim format)
- ✅ Job queue integration (background processing with progress tracking)
- ✅ Geometry API routes (POST /geometry/generate, GET /geometry/jobs/:jobId)
- ✅ Elevation service integration (Open-Elevation API with sub-sampling and interpolation)

**Infrastructure Generation (Completed):**
- ✅ Topology adjacency graph construction
- ✅ Junction detection (degree-based analysis)
- ✅ Chain following through degree-2 nodes
- ✅ F/T/D branch assignment (angle analysis for turnouts)
- ✅ Diamond crossing handling (degree-4 nodes split into two back-to-back turnouts)
- ✅ Spatial separation enforcement (30m minimum between connected nodes)
- ✅ Platform node insertion
- ✅ Reciprocal link enforcement (bidirectional connections)
- ✅ Display position computation
- ✅ Infrastructure API routes (POST /infrastructure/generate, GET /infrastructure/jobs/:jobId)

**Next Steps:**
- Frontend UI for OSM workflow (Leaflet map, visual panels, progress tracking)

## Features

### Centerline Conversion (Original Functionality)

- **KML to Traxim Centerlines**: Convert Google Earth KML path files to Traxim-compatible CSV centerline files
- **CSV to Google Earth KMZ**: Convert Traxim centerline CSV files to Google Earth KMZ format
- **Advanced Options**: Configure curve fitting, spacing, and other parameters
- **Client-Side Processing**: All processing happens in your browser - your files never leave your machine
- **Progress Indication**: Visual feedback during processing

### OSM-Based File Generation (NEW Backend)

- **Geocoding**: Convert place names to railway station coordinates
- **OSM Section Discovery**: Find railway relations and ways in OpenStreetMap
- **Geometry Generation**: Create centerline CSV files from OSM data with:
  - Curve detection and radius calculation
  - Parallel track deduplication
  - Elevation data integration
  - Configurable point spacing
- **Infrastructure Generation** (Coming Soon): Generate Infrastructure.csv with junctions and platforms
- **Additional Files** (Coming Soon): Regions.csv, Speedboards.csv
- **REST API**: All functionality available via HTTP API for agent automation
- **Session Management**: Temporary storage with automatic cleanup (24 hours)
- **ZIP Downloads**: Download all generated files as a single archive

## Quick Start

### Frontend (Centerline Conversion)

1. Open `index.html` in a modern web browser
2. Select your files using the file input buttons
3. Configure options if needed
4. Click the conversion button
5. Your converted files will be downloaded automatically

### Backend (OSM Generation)

#### Development Server

```bash
# Install dependencies
npm install

# Run development server
npm run dev
```

Server starts on `http://localhost:3001`

#### API Usage

See [BACKEND_README.md](./BACKEND_README.md) for complete API documentation.

**Quick example:**

```bash
# Create a session
curl -X POST http://localhost:3001/api/file-generator/sessions

# Response: {"success": true, "session": {"id": "abc-123", ...}}
```

#### Integration with Traxim Controller

For production deployment, see [INTEGRATION_GUIDE.md](./INTEGRATION_GUIDE.md) for instructions on integrating the backend with your existing Traxim Controller server.

## Architecture & File Structure

```
traxim-centerline-tools/
├── Frontend (Centerline Conversion)
│   ├── index.html              # Main UI
│   ├── app.js                  # Frontend logic
│   ├── styles.css              # Styling
│   └── lib/
│       ├── geopoint.js         # GeoPoint class
│       ├── geodetic.js         # Geodetic calculations
│       ├── curves.js           # Curve fitting (bug-free!)
│       └── io.js               # File I/O utilities
│
├── Backend (OSM Generation API)
│   ├── server.js               # Development server
│   ├── routes/                 # API endpoints
│   ├── services/               # (TODO) Business logic
│   └── utils/                  # Helpers & utilities
│
└── Documentation
    ├── README.md               # This file
    ├── BACKEND_README.md       # Backend API docs
    └── INTEGRATION_GUIDE.md    # Integration instructions
```

## Using VS Code Live Server (Frontend Development)

1. Install the **Live Server** extension in VS Code
2. Right-click on `index.html` and select "Open with Live Server"
3. Your browser will open with the application
4. Any changes you make will auto-reload

## How It Works
4. Click the conversion button
5. Your converted files will be downloaded automatically

### Using VS Code Live Server (Recommended for Development)

1. Install the **Live Server** extension in VS Code
2. Right-click on `index.html` and select "Open with Live Server"
3. Your browser will open with the application
4. Any changes you make will auto-reload

### File Structure

```
WebVersion/
??? index.html              # Main HTML page
??? styles.css              # Styling
??? app.js                  # Main application logic
??? lib/
?   ??? geopoint.js        # GeoPoint class
?   ??? geodetic.js        # Geodetic calculations (Vincenty)
?   ??? curves.js          # Curve fitting algorithms
?   ??? io.js              # File I/O utilities
??? README.md              # This file
```

## How It Works

### KML to Traxim Conversion

1. User selects one or more KML files from Google Earth
2. Application parses the KML XML to extract coordinate points
3. Points are grouped by section/placemark name
4. Cardinal spline interpolation is applied for smooth curves
5. Points are resampled at regular intervals (default 25m)
6. Optional curve detection calculates curve radii
7. Results are exported as CSV files in a ZIP archive

### CSV to Google Earth Conversion

1. User selects multiple CSV centerline files
2. Application reads and parses each CSV file
3. Points are organized by section
4. KML is generated with styled line strings
5. KML is compressed into a KMZ file (zipped KML)
6. KMZ file is downloaded for opening in Google Earth

## Advanced Options

### KML to Traxim Options

- **Max Space**: Maximum spacing between input points (meters)
- **Min Space**: Minimum spacing for interpolation (meters)
- **Output Min Space**: Target spacing for output points (meters)
- **Spline Detail**: Number of intermediate points in spline interpolation
- **Curve Min**: Minimum radius to be considered a curve (meters)
- **Find Curves**: Enable curve detection and radius calculation

### CSV to Google Earth Options

- **Exaggeration**: Vertical exaggeration factor for altitude
- **Offset**: Vertical offset to apply (meters)
- **Altitude Mode**: Clamp to ground or use absolute altitude
- **Single File Output**: Combine all sections into one KMZ
- **Find Colours**: Automatically assign colors to sections
- **Write Colours**: Export color mapping to CSV

## Preset Configurations

### Default for Google Earth
- Optimized for paths drawn in Google Earth with sparse points
- Max Space: 800m
- Min Space: 600m
- Output Min Space: 25m

### Default for Curve Finding
- Optimized for finding curves in regular GPS data
- Max Space: 300m
- Min Space: 200m
- Output Min Space: 5m

## Technical Details

### Libraries Used

- **JSZip** (v3.10.1): For creating ZIP and KMZ files
- **PapaParse** (v5.4.1): For robust CSV parsing (optional fallback)

### Algorithms

- **Geodetic Calculations**: Vincenty's formulae for accurate distance and bearing calculations on WGS84 ellipsoid
- **Curve Fitting**: Cardinal spline interpolation (Hermite curves)
- **Resampling**: Geodetic distance-based resampling for regular intervals

### Browser Compatibility

- Chrome 90+
- Firefox 88+
- Edge 90+
- Safari 14+

Older browsers may not support all features, particularly the File API and modern JavaScript features.

## Differences from WinForms Version

### Limitations

1. **Folder Selection**: Cannot browse and select entire folders - must select individual files
2. **Output Location**: Cannot write to source directory - files are downloaded to browser's download folder
3. **Multi-threading**: Uses Web Workers instead of BackgroundWorker
4. **File System**: No direct file system access - uses HTML5 File API

### Improvements

1. **Cross-Platform**: Works on Windows, Mac, Linux, and even mobile devices
2. **No Installation**: Runs directly in browser
3. **Privacy**: All processing happens locally - no server uploads
4. **Modern UI**: Responsive design works on different screen sizes

## Troubleshooting

### Files Not Processing

- Check browser console (F12) for error messages
- Ensure files are valid KML or CSV format
- Try with smaller files first to test

### Performance Issues

- Large files (>1000 points) may take longer
- Close other browser tabs to free up memory
- Try processing files one at a time

### Download Not Working

- Check browser's download settings
- Ensure pop-ups are not blocked
- Try a different browser

## Development Notes

### Porting from C#

The following C# classes were ported to JavaScript:

- `GeodeticCalculator` ? `geodetic.js`
- `GeoPoint` ? `geopoint.js`
- `Curves` ? `curves.js`
- `IO` functions ? `io.js`

The core algorithms remain identical to maintain compatibility with the original application.

### Extending the Application

To add new features:

1. **New conversion formats**: Add parsing functions to `io.js`
2. **New algorithms**: Add to `curves.js` or create new library file
3. **UI enhancements**: Modify `index.html`, `styles.css`, and `app.js`

## License

This is a port of the original Traxim Centerline Tools. Maintain the same license as the original application.

## Support

For issues related to:
- **Original WinForms app**: Consult original documentation
- **Web version**: Check browser console for errors and ensure you're using a modern browser

## Version History

- **1.0**: Initial web port with core functionality
  - KML to CSV conversion
  - CSV to KMZ conversion
  - Cardinal spline interpolation
  - Geodetic calculations
  - Advanced options UI

---

Enjoy using the web version of Traxim Centerline Tools!
