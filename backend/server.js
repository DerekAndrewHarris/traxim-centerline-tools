/**
 * Development Backend Server
 * Standalone server for testing the file generator API
 * In production, routes are imported into ../Traxim-Live-Control-Interface-for-Web/server.js
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import fileGeneratorRoutes from './routes/index.js';
import { cleanupOldSessions } from './utils/tempFiles.js';
import { errorHandler, notFoundHandler } from './utils/errorHandler.js';
import jobQueue from './utils/jobQueue.js';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// CORS configuration
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3001,http://localhost:5173,http://127.0.0.1:5500,http://localhost:5500').split(',');
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g., curl, Postman, MCP)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: false  // No credentials needed (public API)
}));

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Serve frontend static files
app.use(express.static(path.join(__dirname, '..')));

// Mount API routes
app.use('/api/file-generator', fileGeneratorRoutes);

// 404 handler
app.use(notFoundHandler);

// Error handler
app.use(errorHandler);

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
