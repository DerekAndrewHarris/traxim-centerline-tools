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
import { getSession, getSessionFilePath } from '../utils/tempFiles.js';
import { promises as fsAsync } from 'fs';
import jobQueue from '../utils/jobQueue.js';
import { asyncHandler, AppError } from '../utils/errorHandler.js';
import { mergeSearchBboxes, runInfrastructureGeneration } from '../services/generation/pipeline.js';

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
  const mergedBbox = mergeSearchBboxes(searchBboxes);

  // Create background job (the work itself is in
  // services/generation/pipeline.js, shared with the agent's combined job)
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
    (jobData, progressCallback) => runInfrastructureGeneration(jobData, progressCallback)
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
