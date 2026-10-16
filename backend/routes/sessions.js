/**
 * Session Management Routes
 * Handles temporary session creation, retrieval, and ZIP downloads
 */

import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import archiver from 'archiver';
import { 
  createSession, 
  getSession, 
  deleteSession, 
  getSessionFilePath 
} from '../utils/tempFiles.js';
import { generateSessionZip } from '../utils/zipGenerator.js';
import { generateLinesKML, readGeometryCSV } from '../utils/kmlGenerator.js';
import { asyncHandler, AppError } from '../utils/errorHandler.js';
import { readMapOverlays } from '../services/generation/pipeline.js';
import { readSessionMetadataSync } from '../utils/tempFiles.js';
import { stampedName, isValidOutputStamp } from '../utils/outputNames.js';

const router = express.Router();

/**
 * POST /api/file-generator/sessions
 * Create a new temporary session
 */
router.post('/', asyncHandler(async (req, res) => {
  const session = await createSession();
  
  res.status(201).json({
    success: true,
    session: {
      id: session.id,
      createdAt: session.createdAt.toISOString(),
      expiresAt: session.expiresAt.toISOString()
    }
  });
}));

/**
 * GET /api/file-generator/sessions/:id
 * Get session information and file list
 */
router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const session = await getSession(id);
  
  if (!session.exists) {
    throw new AppError('Session not found or expired', 404);
  }
  
  res.json({
    success: true,
    session: {
      id: session.id,
      createdAt: session.createdAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      files: session.files
    }
  });
}));

/**
 * DELETE /api/file-generator/sessions/:id
 * Delete a session and all its files
 */
router.delete('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const deleted = await deleteSession(id);
  
  if (!deleted) {
    throw new AppError('Session not found', 404);
  }
  
  res.status(204).send();
}));

/**
 * GET /api/file-generator/sessions/:id/download-all
 * Download all session files as ZIP
 */
router.get('/:id/download-all', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const session = await getSession(id);
  
  if (!session.exists) {
    throw new AppError('Session not found or expired', 404);
  }
  
  if (session.files.length === 0) {
    throw new AppError('No files to download', 400);
  }
  
  // Generate ZIP file
  const zipPath = path.join(session.path, `traxim-files-${id}.zip`);
  const zipInfo = await generateSessionZip(session.path, zipPath);
  
  // Send ZIP file
  res.download(zipPath, `traxim-files-${id}.zip`, async (err) => {
    if (err) {
      console.error('[Download] Error sending ZIP:', err);
    }
    
    // Clean up ZIP file after sending
    try {
      await fs.unlink(zipPath);
    } catch (cleanupErr) {
      console.warn('[Download] Could not clean up ZIP:', cleanupErr.message);
    }
  });
}));

/**
 * GET /api/file-generator/sessions/:id/map-overlays
 * Return map overlay data (bboxes, geometry lines, topology ways) for
 * progressive visualisation on the frontend Leaflet map.
 */
router.get('/:id/map-overlays', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const session = await getSession(id);
  if (!session.exists) throw new AppError('Session not found or expired', 404);

  // Shared with the agent session view (services/generation/pipeline.js)
  const result = await readMapOverlays(session.path);

  res.json(result);
}));

/**
 * GET /api/file-generator/sessions/:id/download-geometry
 * Download geometry files as ZIP
 */
router.get('/:id/download-geometry', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const session = await getSession(id);
  
  if (!session.exists) {
    throw new AppError('Session not found or expired', 404);
  }
  
  const geometryDir = path.join(session.path, 'geometry');
  
  // Check if geometry directory exists
  try {
    await fs.access(geometryDir);
  } catch {
    throw new AppError('No geometry files found. Please generate geometry first.', 404);
  }
  
  // Check for geometry files
  const files = await fs.readdir(geometryDir);
  const geometryFiles = files.filter(f => f.endsWith('.csv'));
  
  if (geometryFiles.length === 0) {
    throw new AppError('No geometry CSV files found', 404);
  }
  
  // Generate ZIP file from geometry directory
  const zipPath = path.join(session.path, `geometry-${id}.zip`);
  const output = createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });
  
  archive.pipe(output);
  // Topology JSON (internal diagnostic artifact for infrastructure
  // generation) and *_wayids.csv (a diagnostic list of OSM way IDs, not a
  // geometry file — including it risks a user mistaking it for one and
  // feeding it back in as track geometry) aren't useful to a user
  // downloading geometry — exclude both.
  archive.directory(geometryDir, false, (data) =>
    (data.name.endsWith('.json') || data.name.endsWith('_wayids.csv')) ? false : data
  );
  await archive.finalize();
  
  // Wait for zip to finish writing
  await new Promise((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
  });
  
  // Send ZIP file: "Geometry_<stamp>.zip" with the run's date stamp
  // (utils/outputNames.js); the old name for a session without one.
  let stamp = null;
  try { stamp = (readSessionMetadataSync(id) || {}).outputStamp; } catch { /* no stamp */ }
  const zipName = isValidOutputStamp(stamp) ? stampedName('Geometry.zip', stamp) : `traxim-geometry-${id}.zip`;
  res.download(zipPath, zipName, async (err) => {
    if (err) {
      console.error('[Download] Error sending geometry ZIP:', err);
    }
    
    // Clean up ZIP file after sending
    try {
      await fs.unlink(zipPath);
    } catch (cleanupErr) {
      console.warn('[Download] Could not clean up ZIP:', cleanupErr.message);
    }
  });
}));

/**
 * POST /api/file-generator/sessions/:id/generate-kml
 * Generate KMZ file from geometry CSVs (using exact lib/io.js method)
 */
router.post('/:id/generate-kml', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const session = await getSession(id);
  
  if (!session.exists) {
    throw new AppError('Session not found or expired', 404);
  }
  
  const geometryDir = path.join(session.path, 'geometry');
  
  // Check if geometry directory exists
  try {
    await fs.access(geometryDir);
  } catch {
    throw new AppError('No geometry files found. Please generate geometry first.', 404);
  }
  
  // Read geometry CSV files and build geometryDict
  const files = await fs.readdir(geometryDir);
  const geometryFiles = files.filter(f => f.endsWith('.csv') && !f.includes('wayids'));
  
  if (geometryFiles.length === 0) {
    throw new AppError('No geometry CSV files found', 404);
  }
  
  console.log(`[Sessions] Reading ${geometryFiles.length} geometry files for KMZ generation`);
  
  const geometryDict = {};
  
  for (const file of geometryFiles) {
    const filePath = path.join(geometryDir, file);
    const content = await fs.readFile(filePath, 'utf-8');
    const sectionName = file.replace('.csv', '').replace(/_/g, ' ');
    
    // Use the utility function to read CSV
    const points = readGeometryCSV(content, sectionName);
    
    if (points.length > 0) {
      geometryDict[sectionName] = points;
    }
  }
  
  console.log(`[Sessions] Loaded ${Object.keys(geometryDict).length} sections for KMZ`);
  
  // Generate KML using the exact lib/io.js method
  const kml = generateLinesKML(geometryDict, {
    altitudeMode: 'clampToGround',
    exaggeration: 1,
    offset: 0
  });
  
  // Create KMZ file (ZIP with doc.kml inside) - matching frontend app.js
  const kmzPath = path.join(session.path, `geometry-${id}.kmz`);
  const output = createWriteStream(kmzPath);
  const archive = archiver('zip', { 
    zlib: { level: 9 } // Maximum compression like frontend
  });
  
  archive.pipe(output);
  archive.append(kml, { name: 'doc.kml' }); // KMZ format requires doc.kml
  await archive.finalize();
  
  // Wait for zip to finish writing
  await new Promise((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
  });
  
  console.log(`[Sessions] KMZ file created: ${kmzPath} (${archive.pointer()} bytes)`);
  
  res.json({
    success: true,
    message: 'KMZ file generated successfully',
    fileCount: Object.keys(geometryDict).length
  });
}));

/**
 * GET /api/file-generator/sessions/:id/download-kml
 * Download generated KMZ file
 */
router.get('/:id/download-kml', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const session = await getSession(id);
  
  if (!session.exists) {
    throw new AppError('Session not found or expired', 404);
  }
  
  const kmzPath = path.join(session.path, `geometry-${id}.kmz`);
  
  // Check if KMZ file exists
  try {
    await fs.access(kmzPath);
  } catch {
    throw new AppError('KMZ file not found. Please generate KMZ first.', 404);
  }
  
  // Send KMZ file
  res.download(kmzPath, `traxim-geometry-${id}.kmz`);
}));

/**
 * GET /api/file-generator/files/:sessionId/:filename
 * Download a specific file from a session
 */
router.get('/files/:sessionId/:filename(*)', asyncHandler(async (req, res) => {
  const { sessionId, filename } = req.params;
  
  // Validate session exists
  const session = await getSession(sessionId);
  if (!session.exists) {
    throw new AppError('Session not found or expired', 404);
  }
  
  // Get file path (with security validation)
  const filePath = getSessionFilePath(sessionId, filename);
  
  // Check file exists
  try {
    await fs.access(filePath);
  } catch {
    throw new AppError('File not found', 404);
  }
  
  // Send file
  res.download(filePath, path.basename(filename));
}));

export default router;
