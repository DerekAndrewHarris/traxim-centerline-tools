/**
 * Who is calling the agent routes (/internal/agent/...).
 *
 * The File Generator has no logins of its own. For agent use it trusts the
 * Traxim Controller, which has already checked the user's connector login,
 * and which calls this service directly on 127.0.0.1:3001 with two headers:
 *
 *   X-Traxim-Internal-Key  the shared secret TRAXIM_INTERNAL_KEY, which both
 *                          services read from their environment
 *   X-Traxim-User-Id       the Controller's numeric user id
 *
 * Three independent protections stop anyone else from claiming a user id:
 *   1. nginx only forwards /api/file-generator/... to this service, so
 *      /internal/... cannot be reached from the internet at all;
 *   2. a request that came through nginx carries X-Forwarded-For /
 *      X-Real-IP (nginx always sets them) and is refused here;
 *   3. without the shared secret every request is refused.
 * If TRAXIM_INTERNAL_KEY is not set (or is too short), the agent routes are
 * switched off (503) and the website works exactly as before.
 */

import { createHash, timingSafeEqual } from 'crypto';

const MIN_KEY_LENGTH = 32;

function digest(value) {
  return createHash('sha256').update(String(value)).digest();
}

export function requireInternalCaller(req, res, next) {
  const configured = process.env.TRAXIM_INTERNAL_KEY || '';
  if (configured.length < MIN_KEY_LENGTH) {
    return res.status(503).json({
      success: false,
      error: 'Agent access to the File Generator is not set up on the server (TRAXIM_INTERNAL_KEY is missing).'
    });
  }

  // Came through nginx: never an internal call. Answer as if nothing is here.
  if (req.headers['x-forwarded-for'] || req.headers['x-real-ip']) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }

  const given = req.get('x-traxim-internal-key') || '';
  if (!given || !timingSafeEqual(digest(given), digest(configured))) {
    return res.status(401).json({ success: false, error: 'Not allowed' });
  }

  const userId = req.get('x-traxim-user-id') || '';
  if (!/^[1-9][0-9]{0,9}$/.test(userId)) {
    return res.status(400).json({ success: false, error: 'Missing or invalid user id' });
  }
  req.agentUserId = Number(userId);
  next();
}
