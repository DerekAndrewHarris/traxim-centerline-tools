/**
 * Agent routes: /internal/agent/...
 *
 * Called only by the Traxim Controller (server to server, 127.0.0.1:3001),
 * never by a browser and never through nginx. See utils/internalAuth.js for
 * how the caller is identified and services/agent/agentSessions.js for the
 * workflow. Every route answers only for the calling user's own sessions
 * and jobs; anything else is 404.
 *
 *   POST   /sessions                    create a session from waypoints (starts the section search)
 *   GET    /sessions                    the user's sessions that have not expired
 *   GET    /sessions/:id                state; ?detail=map adds map data for the session view page
 *   POST   /sessions/:id/confirm        record the user's chosen sections
 *   POST   /sessions/:id/generate       start the combined generation job
 *   GET    /sessions/:id/download       outputs-only ZIP
 *   DELETE /sessions/:id                delete a session
 *   GET    /jobs/:jobId                 job status
 */

import express from 'express';
import { requireInternalCaller } from '../utils/internalAuth.js';
import {
  AgentError,
  confirmAgentSections,
  createAgentSession,
  deleteAgentSession,
  getAgentJobStatus,
  getAgentSessionState,
  listAgentSessions,
  startAgentGeneration,
  streamAgentOutputs
} from '../services/agent/agentSessions.js';

const router = express.Router();
router.use(requireInternalCaller);

function handle(fn) {
  return async (req, res) => {
    try {
      const data = await fn(req, res);
      if (data !== undefined && !res.headersSent) res.json({ success: true, ...data });
    } catch (error) {
      if (res.headersSent) {
        console.error(`[Agent API] ${req.method} ${req.path} failed after sending: ${error.message}`);
        res.destroy(error);
        return;
      }
      const status = error instanceof AgentError ? error.statusCode : 500;
      if (status >= 500) console.error(`[Agent API] ${req.method} ${req.path}:`, error);
      res.status(status).json({
        success: false,
        error: status >= 500 ? 'The File Generator hit an unexpected error. Please try again; if it keeps happening, tell the Traxim administrator.' : error.message
      });
    }
  };
}

router.post('/sessions', handle(req => createAgentSession(req.agentUserId, req.body || {})));
router.get('/sessions', handle(req => listAgentSessions(req.agentUserId)));
router.get('/sessions/:id', handle(req => getAgentSessionState(req.agentUserId, req.params.id, { map: req.query.detail === 'map' })));
router.post('/sessions/:id/confirm', handle(req => confirmAgentSections(req.agentUserId, req.params.id, req.body || {})));
router.post('/sessions/:id/generate', handle(req => startAgentGeneration(req.agentUserId, req.params.id, req.body || {})));
router.get('/sessions/:id/download', handle(async (req, res) => {
  await streamAgentOutputs(req.agentUserId, req.params.id, res);
  return undefined;
}));
router.delete('/sessions/:id', handle(req => deleteAgentSession(req.agentUserId, req.params.id)));
router.get('/jobs/:jobId', handle(req => getAgentJobStatus(req.agentUserId, req.params.jobId)));

router.use((req, res) => res.status(404).json({ success: false, error: 'Not found' }));

export default router;
