/**
 * In-Memory Job Queue
 * Simple job queue for background processing without Redis dependency
 * Suitable for single-user or low-traffic scenarios
 */

import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';

class JobQueue extends EventEmitter {
  constructor() {
    super();
    this.jobs = new Map(); // jobId -> job object
    this.queue = []; // Array of jobIds waiting to be processed
    this.processing = new Set(); // Set of jobIds currently being processed
    // Maximum jobs running at once (the rest wait in the queue). Set
    // MAX_CONCURRENT_JOBS in the service's environment to change it; it used
    // to be hard-coded to 3 and the variable was ignored.
    this.maxConcurrent = JobQueue.readMaxConcurrent(process.env.MAX_CONCURRENT_JOBS);
    // Activity log for the Traxim Controller's admin console (October 2026):
    // the last ACTIVITY_KEEP job starts/finishes/failures, numbered, read by
    // the Controller through GET /internal/admin/activity (routes/internalAdmin.js).
    // In memory only; bootId changes at every start so the Controller knows
    // the numbering began again. Job type, owner id, times, node counts only.
    this.bootId = randomBytes(8).toString('hex');
    this.activity = [];
    this.activitySeq = 0;
  }

  /**
   * Small, data-free summary of a finished job's result: node / connection /
   * leg counts and the number of serious problems. Never file contents,
   * place names or warnings.
   * @param {object} result
   * @returns {object}
   */
  static summariseResult(result) {
    if (!result || typeof result !== 'object') return {};
    const s = result.summary && typeof result.summary === 'object' ? result.summary : {};
    const num = (v) => (Number.isFinite(v) ? v : undefined);
    const out = {
      nodes: num(result.nodeCount) ?? num(s.infrastructure_nodes),
      connections: num(result.connectionCount) ?? num(s.infrastructure_connections),
      legs: num(result.successfulSections) ?? num(s.legs_generated),
      legs_total: num(result.totalSections) ?? num(s.legs_total),
      serious_problems: Array.isArray(result.seriousProblems) ? result.seriousProblems.length : undefined
    };
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
  }

  /** Add one entry to the activity log (see the constructor). */
  recordActivity(job, event, extra = {}) {
    this.activitySeq += 1;
    this.activity.push({
      seq: this.activitySeq,
      event,
      at: new Date().toISOString(),
      job_id: job.id,
      job_type: job.type,
      owner_id: job.data && Number.isInteger(job.data.ownerId) ? job.data.ownerId : null,
      label: job.data && typeof job.data.label === 'string' ? job.data.label.slice(0, 100) : null,
      started_at: job.startedAt ? job.startedAt.toISOString() : null,
      ...extra
    });
    if (this.activity.length > JobQueue.ACTIVITY_KEEP) this.activity.splice(0, this.activity.length - JobQueue.ACTIVITY_KEEP);
  }

  /**
   * Activity after entry `after` (all kept entries if `boot` is not this
   * run's bootId), and the jobs running and waiting now.
   * @param {number} after
   * @param {string} boot
   */
  activitySince(after, boot) {
    const from = boot === this.bootId ? (Number(after) || 0) : 0;
    const view = (job) => ({
      job_id: job.id,
      job_type: job.type,
      owner_id: job.data && Number.isInteger(job.data.ownerId) ? job.data.ownerId : null,
      created_at: job.createdAt ? job.createdAt.toISOString() : null,
      started_at: job.startedAt ? job.startedAt.toISOString() : null,
      progress: job.progress,
      current_step: job.currentStep ? String(job.currentStep).slice(0, 120) : null
    });
    return {
      boot: this.bootId,
      last_seq: this.activitySeq,
      events: this.activity.filter(a => a.seq > from),
      live: {
        running: [...this.processing].map(id => this.jobs.get(id)).filter(Boolean).map(view),
        queued: this.queue.map(id => this.jobs.get(id)).filter(Boolean).map(view),
        max_concurrent: this.maxConcurrent
      }
    };
  }

  /**
   * Parse MAX_CONCURRENT_JOBS: a whole number from 1 to 16, otherwise 3.
   * @param {string|undefined} value
   * @returns {number}
   */
  static readMaxConcurrent(value) {
    const n = parseInt(value, 10);
    return Number.isInteger(n) && n >= 1 && n <= 16 ? n : 3;
  }

  /**
   * Create a new job
   * @param {string} type - Job type (e.g., 'geometry', 'infrastructure')
   * @param {object} data - Job data/parameters
   * @param {function} processor - Async function to execute
   * @returns {string} jobId
   */
  createJob(type, data, processor) {
    const jobId = `job-${type}-${Date.now()}-${randomBytes(6).toString('hex')}`;
    
    const job = {
      id: jobId,
      type,
      data,
      processor,
      status: 'pending',
      progress: 0,
      currentStep: null,
      result: null,
      error: null,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null
    };

    this.jobs.set(jobId, job);
    this.queue.push(jobId);
    
    console.log(`[JobQueue] Created job: ${jobId} (${type})`);
    
    // Try to process immediately
    this.processNext();
    
    return jobId;
  }

  /**
   * Get job status
   * @param {string} jobId 
   * @returns {object|null}
   */
  getJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;

    return {
      id: job.id,
      type: job.type,
      status: job.status,
      progress: job.progress,
      currentStep: job.currentStep,
      result: job.result,
      error: job.error,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt
    };
  }

  /**
   * Who a job belongs to. Only jobs started through the agent routes have an
   * owner; jobs started from the website have none. Used so the public
   * job-status routes never show an agent's job, and the agent routes only
   * show the caller's own jobs.
   * @param {string} jobId
   * @returns {{ownerId: number|null, sessionId: string|null}|null}
   */
  getJobMeta(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    return {
      ownerId: job.data && job.data.ownerId != null ? job.data.ownerId : null,
      sessionId: job.data && job.data.sessionId ? job.data.sessionId : null
    };
  }

  /**
   * Number of jobs waiting or running for one agent user.
   * @param {number} ownerId
   * @returns {number}
   */
  countActiveForOwner(ownerId) {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.data && job.data.ownerId === ownerId &&
          (job.status === 'pending' || job.status === 'in_progress')) {
        count++;
      }
    }
    return count;
  }

  /**
   * 1-based position of a waiting job in the queue, or 0 if it is not waiting.
   * @param {string} jobId
   * @returns {number}
   */
  queuePosition(jobId) {
    const index = this.queue.indexOf(jobId);
    return index === -1 ? 0 : index + 1;
  }

  /**
   * Update job progress (called from within processor)
   * @param {string} jobId 
   * @param {number} progress - 0-100
   * @param {string} [currentStep] - Description of current step
   */
  updateProgress(jobId, progress, currentStep = null) {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.progress = Math.min(100, Math.max(0, progress));
    if (currentStep) {
      job.currentStep = currentStep;
    }

    this.emit('progress', {
      jobId,
      progress: job.progress,
      currentStep: job.currentStep
    });
  }

  /**
   * Process next job in queue
   */
  async processNext() {
    // Check if we can process more jobs
    if (this.processing.size >= this.maxConcurrent) {
      return;
    }

    // Get next pending job
    const jobId = this.queue.shift();
    if (!jobId) return;

    const job = this.jobs.get(jobId);
    if (!job) {
      // Should never happen, but just in case
      this.processNext();
      return;
    }

    // Mark as processing
    job.status = 'in_progress';
    job.startedAt = new Date();
    this.processing.add(jobId);

    console.log(`[JobQueue] Starting job: ${jobId}`);
    this.recordActivity(job, 'started');
    this.emit('start', { jobId });

    try {
      // Execute the processor function
      // Pass updateProgress callback
      const updateFn = (progress, step) => this.updateProgress(jobId, progress, step);
      const result = await job.processor(job.data, updateFn);

      // Job completed successfully
      job.status = 'completed';
      job.progress = 100;
      job.result = result;
      job.completedAt = new Date();

      console.log(`[JobQueue] Completed job: ${jobId} (${Math.round((job.completedAt - job.startedAt) / 1000)}s)`);
      this.recordActivity(job, 'completed', { duration_ms: job.completedAt - job.startedAt, summary: JobQueue.summariseResult(result) });
      this.emit('complete', { jobId, result });

    } catch (error) {
      // Job failed
      job.status = 'failed';
      job.error = error.message;
      job.completedAt = new Date();

      console.error(`[JobQueue] Failed job: ${jobId}`, error);
      this.recordActivity(job, 'failed', { duration_ms: job.completedAt - job.startedAt, error: String(error && error.message).slice(0, 200) });
      // Not 'error': an EventEmitter 'error' event with no listener throws,
      // which turned every failed job into an unhandled promise rejection
      // that stops the whole service (Node 15+), losing every other job.
      this.emit('failed', { jobId, error });
    } finally {
      // Remove from processing set
      this.processing.delete(jobId);

      // Process next job
      this.processNext();
    }
  }

  /**
   * Get queue statistics
   * @returns {object}  */
  getStats() {
    const pending = this.queue.length;
    const processing = this.processing.size;
    const completed = Array.from(this.jobs.values()).filter(j => j.status === 'completed').length;
    const failed = Array.from(this.jobs.values()).filter(j => j.status === 'failed').length;

    return {
      pending,
      processing,
      completed,
      failed,
      total: this.jobs.size
    };
  }

  /**
   * Clean up old completed/failed jobs
   * @param {number} maxAgeMs - Maximum age in milliseconds (default: 1 hour)
   */
  cleanup(maxAgeMs = 60 * 60 * 1000) {
    const now = new Date();
    let removed = 0;

    for (const [jobId, job] of this.jobs.entries()) {
      if (job.status === 'completed' || job.status === 'failed') {
        const age = now - job.completedAt;
        if (age > maxAgeMs) {
          this.jobs.delete(jobId);
          removed++;
        }
      }
    }

    if (removed > 0) {
      console.log(`[JobQueue] Cleaned up ${removed} old jobs`);
    }

    return removed;
  }
}

// Entries kept in the activity log for the Controller's admin console.
JobQueue.ACTIVITY_KEEP = 1000;

// Singleton instance
const jobQueue = new JobQueue();

// Export both the class and singleton
export { JobQueue };
export default jobQueue;
