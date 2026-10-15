/**
 * Builds the File Generator's Express app (used by server.js, and by the
 * tests, which start it on a spare port).
 *
 *   /api/file-generator/...  the website's API (no login, unchanged). nginx
 *                            forwards this path from the internet.
 *   /internal/agent/...      agent routes, for the Traxim Controller only.
 *                            nginx does NOT forward this path; see
 *                            utils/internalAuth.js.
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fileGeneratorRoutes from './routes/index.js';
import agentRoutes from './routes/agent.js';
import { errorHandler, notFoundHandler } from './utils/errorHandler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp({ serveStatic = true } = {}) {
  const app = express();

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

  // Agent routes (Controller only) - mounted before the static files
  app.use('/internal/agent', agentRoutes);

  // Serve frontend static files
  if (serveStatic) {
    app.use(express.static(path.join(__dirname, '..')));
  }

  // Mount API routes
  app.use('/api/file-generator', fileGeneratorRoutes);

  // 404 handler
  app.use(notFoundHandler);

  // Error handler
  app.use(errorHandler);

  return app;
}
