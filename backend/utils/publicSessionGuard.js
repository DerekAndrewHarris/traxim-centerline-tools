/**
 * Public API guard for sessions created by an agent.
 *
 * The website uses /api/file-generator/... without any login, exactly as
 * before. Sessions created through the agent routes (via the Traxim
 * Controller's MCP connector) have an owner, and must only be reachable
 * through the Controller, which checks the user's login. So every public
 * route that names a session or a job goes through this check first:
 *
 *   - a session id that is not a real session id (e.g. '..')  -> 404
 *   - a session that has an owner (agent session)             -> 404
 *   - a job that has an owner (agent job)                     -> 404
 *
 * 404, not 403, so nobody can tell an agent session from a missing one.
 * Website sessions (no owner) pass straight through, unchanged.
 */

import { isValidSessionId, readSessionMetadataSync } from './tempFiles.js';
import jobQueue from './jobQueue.js';

function notFound(res, what = 'Session not found or expired') {
  return res.status(404).json({ success: false, error: what });
}

function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Session id named by a public request, if any: in the path
 * (/sessions/:id/..., /sessions/files/:sessionId/...) or in the JSON body
 * ({ sessionId }). Returns undefined when the request names no session.
 */
export function sessionIdFromPublicRequest(req) {
  const segments = req.path.split('/').filter(Boolean);
  if (segments[0] === 'sessions' && segments.length >= 2) {
    const raw = segments[1] === 'files' ? segments[2] : segments[1];
    if (raw !== undefined) return safeDecode(raw);
  }
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'sessionId')) {
    return req.body.sessionId;
  }
  return undefined;
}

export function publicSessionGuard(req, res, next) {
  const segments = req.path.split('/').filter(Boolean);

  // Job status: /geometry/jobs/:jobId, /infrastructure/jobs/:jobId
  if ((segments[0] === 'geometry' || segments[0] === 'infrastructure') && segments[1] === 'jobs' && segments[2]) {
    const meta = jobQueue.getJobMeta(safeDecode(segments[2]));
    if (meta && meta.ownerId != null) return notFound(res, 'Job not found');
  }

  const sessionId = sessionIdFromPublicRequest(req);
  if (sessionId !== undefined) {
    if (!isValidSessionId(sessionId)) return notFound(res);
    const meta = readSessionMetadataSync(sessionId);
    if (meta && meta.agent && meta.agent.ownerId != null) return notFound(res);
  }

  next();
}
