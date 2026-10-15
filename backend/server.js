/**
 * Development Backend Server
 * Standalone server for testing the file generator API
 * In production, routes are imported into ../Traxim-Live-Control-Interface-for-Web/server.js
 */

// Must run before any other import: ES module imports are hoisted and fully
// evaluated before this file's own top-level code, so a plain `import dotenv
// from 'dotenv'` + later `dotenv.config()` call runs too late for any module
// this file imports (e.g. fileGeneratorRoutes -> ... -> overpass.js) that
// reads process.env at its own module-load time. This side-effect import
// loads .env immediately, as part of module evaluation, before anything else.
import 'dotenv/config';

import cron from 'node-cron';
import { createApp } from './createApp.js';
import { cleanupOldSessions } from './utils/tempFiles.js';
import jobQueue from './utils/jobQueue.js';

const app = createApp();
const PORT = process.env.PORT || 3001;

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     Traxim File Generator API Server (Development)        ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`🚀 Server running on: http://localhost:${PORT}`);
  console.log(`📁 Frontend available: http://localhost:${PORT}/index.html`);
  console.log(`🔌 API endpoint: http://localhost:${PORT}/api/file-generator`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log('');
  console.log('Available endpoints:');
  console.log('  GET    /api/file-generator/health');
  console.log('  POST   /api/file-generator/sessions');
  console.log('  GET    /api/file-generator/sessions/:id');
  console.log('  DELETE /api/file-generator/sessions/:id');
  console.log('  GET    /api/file-generator/sessions/:id/download-all');
  console.log('  GET    /api/file-generator/files/:sessionId/:filename');
  console.log(`  Agent routes (/internal/agent, Controller only): ${(process.env.TRAXIM_INTERNAL_KEY || '').length >= 32 ? 'on' : 'off (TRAXIM_INTERNAL_KEY not set)'}`);
  console.log(`  Jobs at once: ${jobQueue.maxConcurrent}`);
  console.log('');
  console.log('Press Ctrl+C to stop');
  console.log('════════════════════════════════════════════════════════════');
});

// Setup cron job for session cleanup (runs daily at 2 AM)
cron.schedule('0 2 * * *', async () => {
  console.log('[Cron] Running daily session cleanup...');
  await cleanupOldSessions();
});

// Setup periodic job queue cleanup (runs every hour)
const jobCleanupInterval = parseInt(process.env.JOB_CLEANUP_INTERVAL_HOURS || '1', 10);
cron.schedule(`0 */${jobCleanupInterval} * * *`, () => {
  const removed = jobQueue.cleanup();
  if (removed > 0) {
    console.log(`[Cron] Job queue cleanup: removed ${removed} old jobs`);
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Shutdown] SIGTERM received, closing server gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[Shutdown] SIGINT received, closing server gracefully...');
  process.exit(0);
});
