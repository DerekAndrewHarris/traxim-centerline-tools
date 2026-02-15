# Traxim Centerline Tools - Web Version

This is a web-based port of the original WinForms Traxim Centerline Tools application. It provides the same core functionality for converting between Google Earth KML files and Traxim centerline CSV files.

## Features

- **KML to Traxim Centerlines**: Convert Google Earth KML path files to Traxim-compatible CSV centerline files
- **CSV to Google Earth KMZ**: Convert Traxim centerline CSV files to Google Earth KMZ format
- **Advanced Options**: Configure curve fitting, spacing, and other parameters
- **Client-Side Processing**: All processing happens in your browser - your files never leave your machine
- **Progress Indication**: Visual feedback during processing

## Getting Started

### Quick Start

1. Open `index.html` in a modern web browser (Chrome, Firefox, Edge, or Safari)
2. Select your files using the file input buttons
3. Configure options if needed
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
