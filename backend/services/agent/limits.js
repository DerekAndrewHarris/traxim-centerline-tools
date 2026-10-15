/**
 * Limits for agent use of the File Generator (decided 15 Oct 2026).
 *
 * Each can be changed with an environment variable in the service's .env;
 * the defaults are the decided values. Counters are kept in memory, so a
 * service restart (or deploy) resets them; that is acceptable for limits
 * meant to stop runaway use, not for billing.
 */

function intFromEnv(name, fallback, min, max) {
  const n = parseInt(process.env[name], 10);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** Current limits (read each time, so tests can change the environment). */
export function agentLimits() {
  return {
    generationsPerHour: intFromEnv('AGENT_MAX_GENERATIONS_PER_HOUR', 20, 1, 1000),
    maxNodes: intFromEnv('AGENT_MAX_NODES', 5000, 10, 1000000),
    // Not in the decision list: kept small only to stop abuse of the
    // public geocoding service (Nominatim) and the section search.
    sessionsPerHour: intFromEnv('AGENT_MAX_SESSIONS_PER_HOUR', 30, 1, 1000),
    maxWaypoints: intFromEnv('AGENT_MAX_WAYPOINTS', 25, 2, 200),
    // One user cannot take every generation slot from website users.
    maxActiveJobsPerUser: intFromEnv('AGENT_MAX_ACTIVE_JOBS_PER_USER', 2, 1, 16)
  };
}

const HOUR_MS = 60 * 60 * 1000;

/** Sliding one-hour window per user. */
class HourlyCounter {
  constructor() {
    this.events = new Map(); // userId -> number[] (timestamps)
  }

  recent(userId, now = Date.now()) {
    const list = (this.events.get(userId) || []).filter(t => now - t < HOUR_MS);
    this.events.set(userId, list);
    return list;
  }

  /**
   * @returns {{allowed: boolean, used: number, retryAfterMinutes?: number}}
   */
  check(userId, limit, now = Date.now()) {
    const list = this.recent(userId, now);
    if (list.length < limit) return { allowed: true, used: list.length };
    const oldest = Math.min(...list);
    return { allowed: false, used: list.length, retryAfterMinutes: Math.max(1, Math.ceil((oldest + HOUR_MS - now) / 60000)) };
  }

  record(userId, now = Date.now()) {
    this.recent(userId, now).push(now);
  }

  reset() {
    this.events.clear();
  }
}

export const generationStarts = new HourlyCounter();
export const sessionCreations = new HourlyCounter();
