/**
 * Geometry Generation API Routes
 * Handles OSM-based geometry file generation with job queue integration
 */

import express from 'express';
import { buildGeometrySegments, parseMaxGradientPercent, runGeometryGeneration } from '../services/generation/pipeline.js';
import jobQueue from '../utils/jobQueue.js';
import { asyncHandler } from '../utils/errorHandler.js';
import { getSession, getSessionFilePath } from '../utils/tempFiles.js';
import fs from 'fs/promises';

const router = express.Router();

/**
 * POST /geometry/generate
 * Start geometry generation job for confirmed sections
 * 
 * Body: {
 *   sessionId: string,
 *   spacingMetres?: number (default: 25),
 *   maxGradientPercent?: number (1-6, default 4: elevation smoothing limit)
 * }
 * 
 * Response: {
 *   jobId: string,
 *   message: string
 * }
 */
router.post('/generate', asyncHandler(async (req, res) => {
  const { sessionId, spacingMetres = 25 } = req.body;
  
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  let maxGradientPercent;
  try {
    maxGradientPercent = parseMaxGradientPercent(req.body.maxGradientPercent);
  } catch (rangeError) {
    return res.status(400).json({ error: rangeError.message });
  }
  
  // Validate session exists
  const session = await getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  // Check for confirmed sections in session metadata
  const sessionPath = getSessionFilePath(sessionId, 'session.json');
  const sessionData = JSON.parse(await fs.readFile(sessionPath, 'utf-8'));
  
  const confirmedSections = sessionData.confirmedSections;
  if (!confirmedSections || confirmedSections.length === 0) {
    return res.status(400).json({
      error: 'No confirmed sections found. Use POST /geography/confirm first.'
    });
  }
  
  const searchBboxes = sessionData.searchBboxes;
  if (!searchBboxes || searchBboxes.length === 0) {
    return res.status(400).json({
      error: 'No search bboxes found. Use POST /geography/sections first.'
    });
  }
  
  // Build segments from geocoded places + searchBboxes
  const segments = buildGeometrySegments(sessionData);
  
  console.log(`[Geometry API] Starting segment-based generation for session ${sessionId} (${segments.length} segments)`);

  // Create job (the work itself is in services/generation/pipeline.js,
  // shared with the agent's combined generation job)
  const jobId = jobQueue.createJob(
    'geometry-generation',
    {
      sessionId,
      sessionPath: session.path,
      spacingMetres,
      segments,
      maxGradientPercent
    },
    (data, updateProgress) => runGeometryGeneration(data, updateProgress)
  );
  
  res.json({
    jobId: jobId,
    message: `Geometry generation started for ${segments.length} segment(s)`,
    estimatedDuration: `${segments.length * 30}s - ${segments.length * 60}s`
  });
}));

/**
 * GET /geometry/jobs/:jobId
 * Get status of geometry generation job
 * 
 * Response: {
 *   id: string,
 *   type: string,
 *   status: string,
 *   progress: number,
 *   currentStep: string,
 *   result?: object,
 *   error?: string,
 *   createdAt: string,
 *   completedAt?: string
 * }
 */
router.get('/jobs/:jobId', asyncHandler(async (req, res) => {
  const { jobId } = req.params;
  
  const job = jobQueue.getJob(jobId);
  
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  res.json({
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    currentStep: job.currentStep,
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    completedAt: job.completedAt
  });
}));

export default router;
