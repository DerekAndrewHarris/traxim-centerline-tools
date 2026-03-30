/**
 * Geometry Generation API Routes
 * Handles OSM-based geometry file generation with job queue integration
 */

import express from 'express';
import { generateGeometryForSegment } from '../services/geometry/generator.js';
import { prefetchRelationWayIds } from '../services/osm/osmGeometry.js';
import jobQueue from '../utils/jobQueue.js';
import { asyncHandler } from '../utils/errorHandler.js';
import { getSession, getSessionFilePath } from '../utils/tempFiles.js';
import path from 'path';
import fs from 'fs/promises';

const router = express.Router();

/**
 * POST /geometry/generate
 * Start geometry generation job for confirmed sections
 * 
 * Body: {
 *   sessionId: string,
 *   spacingMetres?: number (default: 25)
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
  const geocodedPlaces = sessionData.geocodedPlaces || [];
  const segments = [];
  for (let i = 0; i < searchBboxes.length; i++) {
    const placeA = geocodedPlaces[i];
    const placeB = geocodedPlaces[i + 1];
    const labelA = placeA ? (placeA.stationName || placeA.place || `Place_${i}`) : `Place_${i}`;
    const labelB = placeB ? (placeB.stationName || placeB.place || `Place_${i + 1}`) : `Place_${i + 1}`;
    
    // Find confirmed sections whose segmentIndices include this segment index
    const relevantSections = confirmedSections.filter(
      s => Array.isArray(s.segmentIndices) && s.segmentIndices.includes(i)
    );
    
    segments.push({
      label: `${labelA} - ${labelB}`,
      bbox: searchBboxes[i],
      startPoint: placeA ? { lat: placeA.lat, lon: placeA.lon } : null,
      endPoint: placeB ? { lat: placeB.lat, lon: placeB.lon } : null,
      sections: relevantSections
    });
  }
  
  console.log(`[Geometry API] Starting segment-based generation for session ${sessionId} (${segments.length} segments)`);
  
  // Create job
  const jobId = jobQueue.createJob(
    'geometry-generation',
    {
      sessionId,
      spacingMetres,
      segments
    },
    async (data, updateProgress) => {
      const { sessionId, spacingMetres, segments } = data;
      const results = [];
      const geometryDir = path.join(session.path, 'geometry');

      // Pre-fetch relation way IDs once for all unique relations used across segments.
      // This avoids repeating expensive Overpass family-expansion queries (one per
      // unique relation, not once per segment × per relation).
      const allSections = segments.flatMap(seg => seg.sections ?? []);
      const relationWayIdCache = allSections.length > 0
        ? await prefetchRelationWayIds(allSections)
        : null;

      // Process each segment (pair of adjacent places)
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        
        const segProgress = Math.floor((i / segments.length) * 100);
        await updateProgress(
          segProgress,
          `Processing segment ${i + 1}/${segments.length}: ${segment.label}`
        );
        
        try {
          const result = await generateGeometryForSegment(
            segment.label,
            segment.bbox,
            geometryDir,
            spacingMetres,
            segment.startPoint,
            segment.endPoint,
            (progress, step) => {
              const overallProgress = segProgress + Math.floor((progress / 100) * (100 / segments.length));
              updateProgress(overallProgress, `${segment.label}: ${step}`);
            },
            segment.sections,
            relationWayIdCache,
            session.path
          );
          
          results.push({
            section: segment.label,
            ...result
          });
          
        } catch (error) {
          console.error(`[Geometry API] Failed to generate geometry for segment '${segment.label}':`, error.message);
          results.push({
            section: segment.label,
            error: error.message
          });
        }
      }

      // Merge infrastructure-format topology from all segments and write a
      // single osm_topology.json so the infrastructure pipeline can skip its
      // own Overpass query.
      try {
        const seenWayIds = new Set();
        const seenNodeIds = new Set();
        const allWays = [];
        const allTaggedNodes = [];

        for (const r of results) {
          if (!r.infraTopology) continue;
          for (const w of r.infraTopology.ways) {
            if (!seenWayIds.has(w.id)) { seenWayIds.add(w.id); allWays.push(w); }
          }
          for (const n of r.infraTopology.taggedNodes) {
            if (!seenNodeIds.has(n.id)) { seenNodeIds.add(n.id); allTaggedNodes.push(n); }
          }
        }

        if (allWays.length > 0) {
          const topoPath = path.join(session.path, 'osm_topology.json');
          await fs.writeFile(topoPath, JSON.stringify({ ways: allWays, taggedNodes: allTaggedNodes }), 'utf-8');
          console.log(`[Geometry API] Wrote osm_topology.json (${allWays.length} ways, ${allTaggedNodes.length} tagged nodes)`);
        }
      } catch (topoErr) {
        console.warn(`[Geometry API] Failed to write osm_topology.json: ${topoErr.message}`);
      }

      // Strip infraTopology from results before returning (large payload)
      for (const r of results) delete r.infraTopology;

      // Update session metadata with real corridorBboxes derived from centerline
      // geometry (replacing the preliminary ones set at /confirm from searchBboxes).
      // Also write corridor_polygons.json for map visualization.
      try {
        const corridorBboxes = [];
        const corridorPolygons = [];
        for (const r of results) {
          if (r.corridorBbox) corridorBboxes.push(r.corridorBbox);
          if (r.bufferPolygon && r.bufferPolygon.length > 0) corridorPolygons.push(r.bufferPolygon);
        }

        if (corridorBboxes.length > 0) {
          const freshData = JSON.parse(await fs.readFile(sessionPath, 'utf-8'));
          // Assign corridorBbox per confirmedSection based on its segmentIndices
          if (freshData.confirmedSections) {
            for (const cs of freshData.confirmedSections) {
              const relevant = (cs.segmentIndices || [])
                .filter(idx => idx < corridorBboxes.length)
                .map(idx => corridorBboxes[idx]);
              if (relevant.length > 0) {
                cs.corridorBbox = {
                  minLat: Math.min(...relevant.map(b => b.minLat)),
                  maxLat: Math.max(...relevant.map(b => b.maxLat)),
                  minLon: Math.min(...relevant.map(b => b.minLon)),
                  maxLon: Math.max(...relevant.map(b => b.maxLon))
                };
              }
            }
          }
          freshData.corridorBboxes = corridorBboxes;
          await fs.writeFile(sessionPath, JSON.stringify(freshData, null, 2), 'utf-8');
          console.log(`[Geometry API] Updated session with ${corridorBboxes.length} real corridorBbox(es)`);
        }

        if (corridorPolygons.length > 0) {
          const polyPath = path.join(session.path, 'corridor_polygons.json');
          await fs.writeFile(polyPath, JSON.stringify(corridorPolygons), 'utf-8');
          console.log(`[Geometry API] Wrote corridor_polygons.json (${corridorPolygons.length} polygon(s))`);
        }
      } catch (cbErr) {
        console.warn(`[Geometry API] Failed to update corridorBbox: ${cbErr.message}`);
      }

      // Strip corridor data from results (already persisted)
      for (const r of results) {
        delete r.corridorBbox;
        delete r.bufferPolygon;
      }
      
      await updateProgress(100, 'All segments processed');
      
      return {
        sessionId,
        totalSections: segments.length,
        successfulSections: results.filter(r => !r.error).length,
        results
      };
    }
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
