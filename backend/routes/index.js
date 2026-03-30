/**
 * Route Aggregator
 * Combines all API routes for the file generator backend
 */

import express from 'express';
import sessionsRouter from './sessions.js';
import geographyRouter from './geography.js';
import geometryRouter from './geometry.js';
import infrastructureRouter from './infrastructure.js';
// Import additional route modules as they're created:
// import centerlineRouter from './centerline.js';

const router = express.Router();

// Mount route modules
router.use('/sessions', sessionsRouter);
router.use('/geography', geographyRouter);
router.use('/geometry', geometryRouter);
router.use('/infrastructure', infrastructureRouter);

// Additional routes will be mounted here as they're implemented:
// router.use('/centerline', centerlineRouter);

// Health check endpoint
router.get('/health', (req, res) => {
  res.json({
    success: true,
    service: 'Traxim File Generator API',
    version: '1.0.0',
    status: 'operational',
    timestamp: new Date().toISOString()
  });
});

export default router;
