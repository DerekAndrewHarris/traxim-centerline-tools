/**
 * Infrastructure Generation Routes
 * 
 * API endpoints for railway infrastructure generation:
 * - POST /infrastructure/generate: Start infrastructure generation job
 * - GET /infrastructure/jobs/:jobId: Poll job status
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import { getSession, getSessionFilePath, updateSessionMetadata } from '../utils/tempFiles.js';
import { promises as fsAsync } from 'fs';
import jobQueue from '../utils/jobQueue.js';
import { asyncHandler, AppError } from '../utils/errorHandler.js';
import { generateInfrastructureForSections, buildRegionsCsv } from '../services/infrastructure/generator.js';

const router = express.Router();

/**
 * POST /infrastructure/generate
 * Start infrastructure generation job for confirmed sections
 * 
 * Request body:
 * {
 *   sessionId: string,
 *   networkName?: string  // Optional network name (defaults to "Railway Network")
 * }
 * 
 * Response:
 * {
 *   jobId: string,
 *   message: string,
 *   estimatedDuration: string
 * }
 */
router.post('/generate', asyncHandler(async (req, res) => {
  const { sessionId, networkName = 'Railway Network' } = req.body;

  if (!sessionId) {
    throw new AppError('sessionId is required', 400);
  }

  // Retrieve session
  const session = await getSession(sessionId);
  if (!session || !session.exists) {
    throw new AppError('Session not found', 404);
  }

  // Read confirmed sections and bboxes directly from session.json (same pattern as geometry route)
  const sessionJsonPath = getSessionFilePath(sessionId, 'session.json');
  const sessionData = JSON.parse(await fsAsync.readFile(sessionJsonPath, 'utf-8'));

  // Validate that confirmedSections exist
  const confirmedSections = sessionData.confirmedSections;
  if (!confirmedSections || confirmedSections.length === 0) {
    throw new AppError(
      'No confirmed sections found. Please complete geography workflow first (geocode → sections → confirm).',
      400
    );
  }

  // Validate that geometry has been generated
  const geometryDir = path.join(session.path, 'geometry');
  if (!fs.existsSync(geometryDir)) {
    throw new AppError(
      'Geometry directory not found. Please generate geometry first.',
      400
    );
  }

  // Check for at least one geometry CSV
  const geometryFiles = fs.readdirSync(geometryDir).filter(f => f.endsWith('.csv'));
  if (geometryFiles.length === 0) {
    throw new AppError(
      'No geometry CSV files found. Please generate geometry first.',
      400
    );
  }

  // Get bounding boxes from session data
  const searchBboxes = sessionData.searchBboxes;
  if (!searchBboxes || searchBboxes.length === 0) {
    throw new AppError(
      'No search bounding boxes found. Please complete geography workflow first.',
      400
    );
  }

  // Merge all bounding boxes into a single bbox for Overpass query
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  for (const bbox of searchBboxes) {
    // bbox may be an object {minLat,minLon,maxLat,maxLon} or a "minLat,minLon,maxLat,maxLon" string
    if (typeof bbox === 'string') {
      const parts = bbox.split(',').map(parseFloat);
      minLat = Math.min(minLat, parts[0]); minLon = Math.min(minLon, parts[1]);
      maxLat = Math.max(maxLat, parts[2]); maxLon = Math.max(maxLon, parts[3]);
    } else {
      minLat = Math.min(minLat, bbox.minLat); minLon = Math.min(minLon, bbox.minLon);
      maxLat = Math.max(maxLat, bbox.maxLat); maxLon = Math.max(maxLon, bbox.maxLon);
    }
  }
  const mergedBbox = `${minLat},${minLon},${maxLat},${maxLon}`;

  // Create background job
  const jobId = jobQueue.createJob(
    'infrastructure-generation',
    {
      sessionId,
      confirmedSections,
      networkName,
      geometryDir,
      bbox: mergedBbox,
      sessionPath: session.path
    },
    async (jobData, progressCallback) => {
      const { confirmedSections, networkName, geometryDir, bbox, sessionPath } = jobData;

      // Generate infrastructure
      const result = await generateInfrastructureForSections(
        confirmedSections,
        networkName,
        geometryDir,
        bbox,
        progressCallback,
        sessionPath
      );

      // Write Infrastructure.csv to session directory
      const outputPath = path.join(sessionPath, 'Infrastructure.csv');
      fs.writeFileSync(outputPath, result.csv, 'utf-8');

      // Write Regions.csv alongside it, one row per confirmed section in the
      // same order they were reported to the UI, plus the fixed blank-region
      // boilerplate row the Traxim file format requires.
      const regionsCsv = buildRegionsCsv(confirmedSections);
      const regionsOutputPath = path.join(sessionPath, 'Regions.csv');
      fs.writeFileSync(regionsOutputPath, regionsCsv, 'utf-8');

      // Update session metadata
      await updateSessionMetadata(sessionId, {
        infrastructureGenerated: true,
        infrastructureFile: 'Infrastructure.csv',
        regionsFile: 'Regions.csv',
        infrastructureTimestamp: new Date().toISOString(),
        infrastructureNodeCount: result.nodeCount,
        infrastructureConnectionCount: result.connectionCount,
        infrastructureWarnings: result.warnings
      });

      return {
        filePath: outputPath,
        fileName: 'Infrastructure.csv',
        regionsFile: 'Regions.csv',
        nodeCount: result.nodeCount,
        connectionCount: result.connectionCount,
        warnings: result.warnings
      };
    }
  );

  res.json({
    jobId: jobId,
    message: 'Infrastructure generation job started',
    estimatedDuration: '2-5 minutes'
  });
}));

/**
 * GET /infrastructure/jobs/:jobId
 * Check infrastructure generation job status
 * 
 * Response:
 * {
 *   id: string,
 *   type: string,
 *   status: 'pending' | 'in_progress' | 'completed' | 'failed',
 *   progress: number,          // 0-100
 *   currentStep?: string,
 *   result?: {
 *     filePath: string,
 *     fileName: string,
 *     nodeCount: number,
 *     connectionCount: number,
 *     warnings: string[]
 *   },
 *   error?: string,
 *   createdAt: string,
 *   completedAt?: string
 * }
 */
router.get('/jobs/:jobId', asyncHandler(async (req, res) => {
  const { jobId } = req.params;

  const job = jobQueue.getJob(jobId);
  if (!job) {
    throw new AppError('Job not found', 404);
  }

  const response = {
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    createdAt: job.createdAt
  };

  if (job.currentStep) {
    response.currentStep = job.currentStep;
  }

  if (job.status === 'completed' && job.result) {
    response.result = job.result;
    response.completedAt = job.completedAt;
  }

  if (job.status === 'failed' && job.error) {
    response.error = job.error;
    response.completedAt = job.completedAt;
  }

  res.json(response);
}));

export default router;
