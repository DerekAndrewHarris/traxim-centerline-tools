/**
 * Admin routes: /internal/admin/...  (October 2026)
 *
 * For the Traxim Controller's admin console only, server to server on
 * 127.0.0.1:3001 with the shared secret (utils/internalAuth.js
 * requireInternalService). nginx does not forward /internal/, and a request
 * that came through nginx is refused.
 *
 *   GET /activity?after=<n>&boot=<id>
 *       jobs running and waiting now, and the job starts / finishes /
 *       failures since entry <n> of this run of the service (all kept
 *       entries if <id> is not this run's id). Job type, owner id (agent
 *       jobs; website jobs have none), times, node counts. Nothing else.
 */

import express from 'express';
import { requireInternalService } from '../utils/internalAuth.js';
import jobQueue from '../utils/jobQueue.js';

export function createInternalAdminRouter(queue = jobQueue) {
  const router = express.Router();
  router.use(requireInternalService);

  router.get('/activity', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, ...queue.activitySince(parseInt(req.query.after, 10) || 0, String(req.query.boot || '')) });
  });

  router.use((req, res) => res.status(404).json({ success: false, error: 'Not found' }));
  return router;
}

export default createInternalAdminRouter();
