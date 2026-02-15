// Main Application Logic
class TraximCenterlineTools {
    constructor() {
        this.kmlFiles = [];
        this.csvFiles = [];
        this.initializeEventListeners();
    }

    initializeEventListeners() {
        // Toggle advanced options
        document.getElementById('btnToggleAdvancedCsv').addEventListener('click', () => {
            this.togglePanel('panelAdvancedToCsv', 'instructionsKml', 'btnToggleAdvancedCsv');
        });

        document.getElementById('btnToggleAdvancedKml').addEventListener('click', () => {
            this.togglePanel('panelAdvancedKml', 'instructionsGE', 'btnToggleAdvancedKml');
        });

        // File inputs
        document.getElementById('kmlFileInput').addEventListener('change', (e) => {
            this.handleFileSelection(e, 'kml');
        });

        document.getElementById('csvFileInput').addEventListener('change', (e) => {
            this.handleFileSelection(e, 'csv');
        });

        // Conversion buttons
        document.getElementById('btnKmlToTraxim').addEventListener('click', () => {
            this.convertKmlToTraxim();
        });

        document.getElementById('btnToNetworkGE').addEventListener('click', () => {
            this.convertCsvToGoogleEarth();
        });

        // Restore defaults button
        document.getElementById('btnRestoreDefaults').addEventListener('click', () => {
            this.restoreDefaults();
        });

        // Input validation
        const numberInputs = document.querySelectorAll('input[type="number"]');
        numberInputs.forEach(input => {
            input.addEventListener('input', this.validateNumberInput);
        });
    }

    togglePanel(panelId, instructionId, buttonId) {
        const panel = document.getElementById(panelId);
        const instructions = document.getElementById(instructionId);
        const button = document.getElementById(buttonId);
        
        if (panel.style.display === 'none') {
            panel.style.display = 'block';
            instructions.style.display = 'none';
            button.textContent = button.textContent.replace('?', '?');
        } else {
            panel.style.display = 'none';
            instructions.style.display = 'block';
            button.textContent = button.textContent.replace('?', '?');
        }
    }

    handleFileSelection(event, type) {
        const files = Array.from(event.target.files);
        if (type === 'kml') {
            this.kmlFiles = files;
            this.displayFileList(files, 'kmlFileList');
            document.getElementById('btnKmlToTraxim').disabled = files.length === 0;
        } else {
            this.csvFiles = files;
            this.displayFileList(files, 'csvFileList');
            document.getElementById('btnToNetworkGE').disabled = files.length === 0;
        }
    }

    displayFileList(files, containerId) {
        const container = document.getElementById(containerId);
        container.innerHTML = '';
        files.forEach(file => {
            const div = document.createElement('div');
            div.className = 'file-item';
            div.textContent = file.name;
            container.appendChild(div);
        });
    }

    validateNumberInput(event) {
        const input = event.target;
        const value = parseFloat(input.value);
        if (isNaN(value)) {
            input.style.borderColor = '#ff6b6b';
            input.style.backgroundColor = '#ffe0e0';
        } else {
            input.style.borderColor = '#ddd';
            input.style.backgroundColor = 'white';
        }
    }

    restoreDefaults() {
        document.getElementById('tboxMaxSpace').value = 800;
        document.getElementById('tboxDensifySpace').value = 600;
        document.getElementById('tboxOutMinSpace').value = 25;
        document.getElementById('tboxSplineDetail').value = 60;
        document.getElementById('tboxCurveArc').value = 100;
        document.getElementById('tboxCurveMin').value = 5000;
    }

    async convertKmlToTraxim() {
        if (this.kmlFiles.length === 0) {
            alert('Please select KML files first');
            return;
        }

        // Get parameters
        const params = {
            findCurves: document.getElementById('chkboxFindCurves').checked,
            maxSegmentLength: parseFloat(document.getElementById('tboxMaxSpace').value),
            densifySpacing: parseFloat(document.getElementById('tboxDensifySpace').value),
            outputSpacing: parseFloat(document.getElementById('tboxOutMinSpace').value),
            splineDetail: parseInt(document.getElementById('tboxSplineDetail').value),
            curveArcLength: parseFloat(document.getElementById('tboxCurveArc').value),
            straightLineThreshold: parseFloat(document.getElementById('tboxCurveMin').value)
        };

        // Validate parameters
        if (Object.values(params).some(v => isNaN(v) && typeof v !== 'boolean')) {
            alert('Error reading advanced options. Please check your inputs.');
            return;
        }

        // Show progress
        const progressContainer = document.getElementById('progressKml');
        const progressFill = document.getElementById('progressFillKml');
        const progressText = document.getElementById('progressTextKml');
        progressContainer.style.display = 'block';
        progressFill.style.width = '0%';
        
        document.getElementById('btnKmlToTraxim').disabled = true;

        try {
            const allResults = [];
            
            for (let i = 0; i < this.kmlFiles.length; i++) {
                const file = this.kmlFiles[i];
                const progress = ((i + 1) / this.kmlFiles.length) * 100;
                progressFill.style.width = progress + '%';
                progressText.textContent = `Processing ${file.name} (${i + 1}/${this.kmlFiles.length})...`;

                const kmlContent = await this.readFileAsText(file);
                const result = await this.processKmlToCenterline(kmlContent, file.name, params);
                allResults.push(result);
            }

            // Create ZIP with all CSV files
            const zip = new JSZip();
            allResults.forEach(result => {
                zip.file(result.filename, result.csvContent);
            });

            const blob = await zip.generateAsync({ type: 'blob' });
            this.downloadFile(blob, 'traxim_centerlines.zip');

            this.showAlert('success', 'Done! The output has been downloaded as a ZIP file.');
        } catch (error) {
            this.showAlert('error', 'Something went wrong: ' + error.message);
            console.error(error);
        } finally {
            progressContainer.style.display = 'none';
            document.getElementById('btnKmlToTraxim').disabled = false;
        }
    }

    async processKmlToCenterline(kmlContent, filename, params) {
        // Parse KML
        const points = IOFunctions.readKml(kmlContent);
        
        if (points.length === 0) {
            throw new Error(`No points found in ${filename}`);
        }

        // Group points by section
        const pointsDict = {};
        points.forEach(point => {
            const section = point.section || 'default';
            if (!pointsDict[section]) {
                pointsDict[section] = [];
            }
            pointsDict[section].push(point);
        });

        const outPoints = [];
        const gcalc = new GeodeticCalculator();

        // Process each section
        for (const [section, sectionPoints] of Object.entries(pointsDict)) {
            if (sectionPoints.length > 3) {
                const processed = this.processCenterlineSection(
                    sectionPoints, 
                    params, 
                    gcalc
                );
                
                // Calculate chainage (cumulative distance)
                let chainage = 0;
                for (let i = 0; i < processed.length; i++) {
                    processed[i].chainage = chainage;
                    if (i < processed.length - 1) {
                        chainage += processed[i].distance(processed[i + 1], gcalc);
                    }
                }
                
                outPoints.push(...processed);
            }
        }

        // Generate CSV
        const csvContent = IOFunctions.writeCsvFromPoints(outPoints);
        const outputFilename = filename.replace('.kml', '.csv');

        return {
            filename: outputFilename,
            csvContent: csvContent
        };
    }

    processCenterlineSection(points, params, gcalc) {
        const { maxSegmentLength, densifySpacing, outputSpacing, splineDetail, curveArcLength, straightLineThreshold, findCurves } = params;
        
        // Step 1: Densify long segments to prevent spline overshoot
        // Matches C# implementation: recalculates bearing after each intermediate point
        const densifiedPoints = [];
        let prev = null;
        
        for (let i = 0; i < points.length; i++) {
            const point = points[i];
            
            if (prev !== null) {
                let dist = prev.distance(point, gcalc);
                
                // Keep adding intermediate points while gap is too large
                while (dist > maxSegmentLength) {
                    // Recalculate bearing from current position to endpoint
                    const bearing = prev.bearingToPoint(point, gcalc);
                    const newPoint = prev.projectNewOnBearingDist(bearing, densifySpacing, gcalc);
                    newPoint.section = point.section;
                    densifiedPoints.push(newPoint);
                    
                    // Update prev and recalculate distance for next iteration
                    dist = newPoint.distance(point, gcalc);
                    prev = newPoint;
                }
            }
            
            // Add the original point
            densifiedPoints.push(point);
            prev = point;
        }
        
        // Step 2: Generate Bezier control points using cardinal spline
        const controlPoints = Curves.cardinalSpline2(densifiedPoints, 0.5);

        // Step 3: Interpolate smooth curve using Bezier
        const smoothPoints = Curves.interpolateBezier(controlPoints, splineDetail);

        // Step 4: Resample at regular intervals
        const resampledPoints = this.resampleAtInterval(smoothPoints, outputSpacing, gcalc);

        // Step 5: Calculate curve radius if requested
        if (findCurves) {
            return this.findCurvesInPoints(resampledPoints, curveArcLength, straightLineThreshold, gcalc);
        }

        return resampledPoints;
    }

    resampleAtInterval(points, interval, gcalc) {
        if (points.length < 2) return points;

        const result = [points[0]];
        let distSinceLastOutput = 0; // Distance since we last output a point
        let lastOutputPoint = points[0]; // The last point we added to result
        
        for (let i = 0; i < points.length - 1; i++) {
            const segmentStart = points[i];
            const segmentEnd = points[i + 1];
            const segmentLength = segmentStart.distance(segmentEnd, gcalc);
            
            let distCoveredInSegment = 0; // How far into this segment we've moved
            
            // Process this segment
            while (distCoveredInSegment < segmentLength) {
                const distToNextOutput = interval - distSinceLastOutput;
                const distRemainingInSegment = segmentLength - distCoveredInSegment;
                
                if (distToNextOutput <= distRemainingInSegment) {
                    // We can place the next output point within this segment
                    distCoveredInSegment += distToNextOutput;
                    
                    const bearing = segmentStart.bearingToPoint(segmentEnd, gcalc);
                    const newPoint = segmentStart.projectNewOnBearingDist(bearing, distCoveredInSegment, gcalc);
                    newPoint.section = segmentStart.section;
                    
                    result.push(newPoint);
                    lastOutputPoint = newPoint;
                    distSinceLastOutput = 0;
                } else {
                    // This segment ends before we reach the next output point
                    distSinceLastOutput += distRemainingInSegment;
                    distCoveredInSegment = segmentLength; // Exit the while loop
                }
            }
        }

        // Always add the last point if it's not already there
        const lastPoint = points[points.length - 1];
        if (result[result.length - 1] !== lastPoint) {
            const distToLast = lastOutputPoint.distance(lastPoint, gcalc);
            if (distToLast > 0.001) { // Only add if it's not essentially the same point
                result.push(lastPoint);
            }
        }

        return result;
    }

    findCurvesInPoints(points, curveArcLength, straightLineThreshold, gcalc) {
        // Calculate how many points to skip based on arc length
        // Arc length is total, so we go half distance on each side
        const actualSpacing = points.length > 1 ? points[0].distance(points[1], gcalc) : 25;
        const pointsToSkip = Math.max(1, Math.round((curveArcLength / 2) / actualSpacing));
        
        // Calculate curve radius for each point
        for (let i = 0; i < points.length; i++) {
            const prevIndex = i - pointsToSkip;
            const nextIndex = i + pointsToSkip;
            const curr = points[i];
            
            // Need points on both sides
            if (prevIndex >= 0 && nextIndex < points.length) {
                const prev = points[prevIndex];
                const next = points[nextIndex];

                const bearing1 = prev.bearingToPoint(curr, gcalc);
                const bearing2 = curr.bearingToPoint(next, gcalc);
                
                let deltaBearing = Math.abs(bearing2 - bearing1);
                if (deltaBearing > Math.PI) deltaBearing = 2 * Math.PI - deltaBearing;

                if (deltaBearing > 0.0001) { // Some curvature detected
                    const dist = prev.distance(next, gcalc) / 2;
                    const radius = dist / Math.sin(deltaBearing / 2);
                    
                    // If radius is greater than threshold, treat as straight line
                    curr.curveRadius = (radius > straightLineThreshold) ? 0 : radius;
                } else {
                    // Essentially straight
                    curr.curveRadius = 0;
                }
            } else {
                // Not enough points on one or both sides
                curr.curveRadius = 0;
            }
        }
        
        return points;
    }

    async convertCsvToGoogleEarth() {
        if (this.csvFiles.length === 0) {
            alert('Please select CSV files first');
            return;
        }

        // Get parameters
        const params = {
            exaggeration: parseFloat(document.getElementById('textBoxExaggeration').value) || 1,
            offset: parseFloat(document.getElementById('textBoxOffset').value) || 3,
            findColours: document.getElementById('ckboxFindColours').checked,
            writeColours: document.getElementById('ckboxWriteColours').checked,
            altitudeMode: document.querySelector('input[name="altitudeMode"]:checked').value
        };

        // Show progress
        const progressContainer = document.getElementById('progressGE');
        const progressFill = document.getElementById('progressFillGE');
        const progressText = document.getElementById('progressTextGE');
        progressContainer.style.display = 'block';
        progressFill.style.width = '0%';
        
        document.getElementById('btnToNetworkGE').disabled = true;

        try {
            const allGeometry = {};
            
            // Read all CSV files
            for (let i = 0; i < this.csvFiles.length; i++) {
                const file = this.csvFiles[i];
                const baseName = file.name.replace('.csv', '');
                
                const progress = ((i + 1) / this.csvFiles.length) * 50; // 50% for reading
                progressFill.style.width = progress + '%';
                progressText.textContent = `Reading ${file.name}...`;

                const csvContent = await this.readFileAsText(file);
                const points = IOFunctions.readCsvLatLongCharlotte(csvContent);
                allGeometry[baseName] = points;
            }

            progressFill.style.width = '60%';
            progressText.textContent = 'Generating KML with folder structure...';

            // Generate comprehensive lines.kmz
            const linesKML = IOFunctions.generateLinesKML(allGeometry, params);
            
            progressFill.style.width = '80%';
            progressText.textContent = 'Creating lines.kmz...';

            const linesZip = new JSZip();
            linesZip.file('doc.kml', linesKML);
            const linesBlob = await linesZip.generateAsync({ 
                type: 'blob',
                compression: 'DEFLATE',
                compressionOptions: { level: 9 }
            });

            progressFill.style.width = '100%';
            this.downloadFile(linesBlob, 'lines.kmz');

            this.showAlert('success', 'Done! Created lines.kmz. Open it in Google Earth to view all centerlines with low-detail versions and kilometrage markers.');
        } catch (error) {
            this.showAlert('error', 'Something went wrong: ' + error.message);
            console.error(error);
        } finally {
            progressContainer.style.display = 'none';
            document.getElementById('btnToNetworkGE').disabled = false;
        }
    }

    readFileAsText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = (e) => reject(e);
            reader.readAsText(file);
        });
    }

    downloadFile(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    showAlert(type, message) {
        // Remove existing alerts
        const existingAlerts = document.querySelectorAll('.alert');
        existingAlerts.forEach(alert => alert.remove());

        // Create new alert
        const alert = document.createElement('div');
        alert.className = `alert alert-${type}`;
        alert.textContent = message;
        
        const main = document.querySelector('main');
        main.insertBefore(alert, main.firstChild);

        // Auto-remove after 10 seconds
        setTimeout(() => {
            alert.remove();
        }, 10000);
    }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    new TraximCenterlineTools();
});
