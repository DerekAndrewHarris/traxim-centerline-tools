/**
 * Geography API Routes
 * Handles geocoding and railway section discovery
 */

import express from 'express';
import fs from 'fs/promises';
import { geocodePlace, reverseGeocodePlace } from '../services/osm/geocoding.js';
import { queryRailwaySections } from '../services/osm/sections.js';
import { asyncHandler } from '../utils/errorHandler.js';
import { getSession, getSessionFilePath, updateSessionMetadata } from '../utils/tempFiles.js';

const router = express.Router();

/**
 * POST /geography/geocode
 * Geocode one or more place names to coordinates
 * 
 * Body: {
 *   sessionId: string,
 *   places: string[]
 * }
 * 
 * Response: {
 *   sessionId: string,
 *   results: Array<{
 *     place: string,
 *     lat: number,
 *     lon: number,
 *     displayName: string,
 *     source: string,
 *     stationName?: string,
 *     centerSource?: string
 *   }>
 * }
 */
router.post('/geocode', asyncHandler(async (req, res) => {
  const { sessionId, places, appendToSession } = req.body;
  
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }
  
  if (!places || !Array.isArray(places) || places.length === 0) {
    return res.status(400).json({ error: 'places must be a non-empty array' });
  }
  
  // Validate session exists
  const session = await getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  console.log(`[Geography API] Geocoding ${places.length} places for session ${sessionId}`);
  
  // Geocode each place
  const results = [];
  for (const place of places) {
    const geocoded = await geocodePlace(place);
    
    if (geocoded) {
      results.push({
        place,
        ...geocoded
      });
    } else {
      results.push({
        place,
        error: 'Could not geocode place'
      });
    }
  }
  
  // Store geocoded results in session metadata.
  // If appendToSession=true, merge with existing geocodedPlaces (for incremental one-at-a-time calls).
  let geocodedPlaces = results;
  if (appendToSession) {
    const sessionPath = getSessionFilePath(sessionId, 'session.json');
    const sessionData = JSON.parse(await fs.readFile(sessionPath, 'utf-8'));
    geocodedPlaces = [...(sessionData.geocodedPlaces || []), ...results];
  }

  await updateSessionMetadata(sessionId, {
    geocodedPlaces,
    lastGeocodeTimestamp: new Date().toISOString()
  });
  
  res.json({
    sessionId,
    results
  });
}));

/**
 * POST /geography/reverse-geocode
 * Give a map-clicked waypoint a display name, and record it in the session's
 * geocodedPlaces (same shape /geocode writes) so downstream segment labels
 * use it instead of a generic placeholder.
 *
 * Body: {
 *   sessionId: string,
 *   lat: number,
 *   lon: number,
 *   appendToSession?: boolean
 * }
 *
 * Response: {
 *   sessionId: string,
 *   result: { place, lat, lon, displayName, source }
 * }
 */
router.post('/reverse-geocode', asyncHandler(async (req, res) => {
  const { sessionId, lat, lon, appendToSession } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  if (typeof lat !== 'number' || typeof lon !== 'number') {
    return res.status(400).json({ error: 'lat and lon must be numbers' });
  }

  const session = await getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  console.log(`[Geography API] Reverse geocoding (${lat}, ${lon}) for session ${sessionId}`);

  const reverse = await reverseGeocodePlace(lat, lon);
  const label = reverse ? reverse.label : `Pinned (${lat.toFixed(4)}, ${lon.toFixed(4)})`;

  const result = {
    place: label,
    lat,
    lon,
    displayName: reverse ? reverse.displayName : `Pinned at ${lat.toFixed(5)}, ${lon.toFixed(5)}`,
    source: 'map_click'
  };

  // Store in session metadata, same append/reset contract as /geocode, so
  // pinned and searched waypoints share one correctly-ordered list.
  let geocodedPlaces = [result];
  if (appendToSession) {
    const sessionPath = getSessionFilePath(sessionId, 'session.json');
    const sessionData = JSON.parse(await fs.readFile(sessionPath, 'utf-8'));
    geocodedPlaces = [...(sessionData.geocodedPlaces || []), result];
  }

  await updateSessionMetadata(sessionId, {
    geocodedPlaces,
    lastGeocodeTimestamp: new Date().toISOString()
  });

  res.json({ sessionId, result });
}));

/**
 * POST /geography/sections
 * Discover railway sections within bounding boxes
 * 
 * Body: {
 *   sessionId: string,
 *   bboxes: Array<{minLat, minLon, maxLat, maxLon}>
 * }
 * 
 * Response: {
 *   sessionId: string,
 *   sections: Array<{
 *     osmId: string,
 *     osmType: string,
 *     name: string,
 *     type: string,
 *     operator: string,
 *     ref: string,
 *     wayIds: string[],
 *     segmentIndices: number[],
 *     altOsmId?: string
 *   }>
 * }
 */
router.post('/sections', asyncHandler(async (req, res) => {
  const { sessionId, bboxes } = req.body;
  
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }
  
  if (!bboxes || !Array.isArray(bboxes) || bboxes.length === 0) {
    return res.status(400).json({ error: 'bboxes must be a non-empty array' });
  }
  
  // Validate bbox structure
  for (const bbox of bboxes) {
    if (typeof bbox.minLat !== 'number' || typeof bbox.minLon !== 'number' ||
        typeof bbox.maxLat !== 'number' || typeof bbox.maxLon !== 'number') {
      return res.status(400).json({ error: 'Each bbox must have minLat, minLon, maxLat, maxLon (numbers)' });
    }
  }
  
  // Validate session exists
  const session = await getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  console.log(`[Geography API] Discovering railway sections for session ${sessionId} (${bboxes.length} bboxes)`);
  
  // Query railway sections
  const { sections, failedBboxCount, totalBboxCount } = await queryRailwaySections(bboxes);
  
  // Store sections in session metadata
  await updateSessionMetadata(sessionId, {
    candidateSections: sections,
    searchBboxes: bboxes,
    lastSectionQueryTimestamp: new Date().toISOString()
  });
  
  res.json({
    sessionId,
    sections,
    overpassFailures: failedBboxCount > 0 ? { failed: failedBboxCount, total: totalBboxCount } : undefined
  });
}));

/**
 * POST /geography/confirm
 * Confirm selected railway sections for geometry generation
 * 
 * Body: {
 *   sessionId: string,
 *   selectedSections: Array<{osmId: string, osmType: string}>
 * }
 * 
 * Response: {
 *   sessionId: string,
 *   confirmedSections: Array,
 *   message: string
 * }
 */
router.post('/confirm', asyncHandler(async (req, res) => {
  const { sessionId, selectedSections } = req.body;
  
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }
  
  if (!selectedSections || !Array.isArray(selectedSections) || selectedSections.length === 0) {
    return res.status(400).json({ error: 'selectedSections must be a non-empty array' });
  }
  
  // Validate session exists
  const session = await getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  console.log(`[Geography API] Confirming ${selectedSections.length} sections for session ${sessionId}`);
  
  // Read session data to look up candidateSections and searchBboxes
  const sessionPath = getSessionFilePath(sessionId, 'session.json');
  let sessionData = {};
  try {
    const { promises: fs } = await import('fs');
    sessionData = JSON.parse(await fs.readFile(sessionPath, 'utf-8'));
  } catch (_) {}
  
  const candidateSections = sessionData.candidateSections || [];
  const searchBboxes = sessionData.searchBboxes || [];
  
  // Enrich selected sections with data from candidateSections
  const confirmedSections = selectedSections.map(sel => {
    // Find matching candidate to get altOsmId, segmentIndices, wayIds, etc.
    const candidate = candidateSections.find(
      c => String(c.osmId) === String(sel.osmId) && c.osmType === sel.osmType
    );
    
    const enriched = {
      osmId: sel.osmId,
      osmType: sel.osmType,
      name: sel.name || (candidate ? candidate.name : `Section_${sel.osmId}`),
      ...(candidate ? {
        altOsmId: candidate.altOsmId || undefined,
        type: candidate.type,
        operator: candidate.operator,
        ref: candidate.ref,
        wayIds: candidate.wayIds,
        segmentIndices: candidate.segmentIndices
      } : {})
    };
    
    // Compute corridorBbox from searchBboxes + segmentIndices
    const indices = enriched.segmentIndices || [0];
    const relevantBboxes = indices
      .filter(i => i < searchBboxes.length)
      .map(i => searchBboxes[i]);
    
    if (relevantBboxes.length > 0) {
      enriched.corridorBbox = {
        minLat: Math.min(...relevantBboxes.map(b => b.minLat)),
        minLon: Math.min(...relevantBboxes.map(b => b.minLon)),
        maxLat: Math.max(...relevantBboxes.map(b => b.maxLat)),
        maxLon: Math.max(...relevantBboxes.map(b => b.maxLon))
      };
    }
    
    return enriched;
  });
  
  // Store confirmed sections in session metadata
  await updateSessionMetadata(sessionId, {
    confirmedSections,
    confirmationTimestamp: new Date().toISOString()
  });
  
  res.json({
    sessionId,
    confirmedSections,
    message: `${confirmedSections.length} sections confirmed. Ready for geometry generation.`
  });
}));

export default router;
