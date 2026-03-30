/**
 * In-Memory Job Queue
 * Simple job queue for background processing without Redis dependency
 * Suitable for single-user or low-traffic scenarios
 */

import { EventEmitter } from 'events';

class JobQueue extends EventEmitter {
  constructor() {
    super();
    this.jobs = new Map(); // jobId -> job object
    this.queue = []; // Array of jobIds waiting to be processed
    this.processing = new Set(); // Set of jobIds currently being processed
    this.maxConcurrent = 3; // Maximum concurrent jobs
  }

  /**
   * Create a new job
   * @param {string} type - Job type (e.g., 'geometry', 'infrastructure')
   * @param {object} data - Job data/parameters
   * @param {function} processor - Async function to execute
   * @returns {string} jobId
   */
  createJob(type, data, processor) {
    const jobId = `job-${type}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
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
      this.emit('complete', { jobId, result });

    } catch (error) {
      // Job failed
      job.status = 'failed';
      job.error = error.message;
      job.completedAt = new Date();

      console.error(`[JobQueue] Failed job: ${jobId}`, error);
      this.emit('error', { jobId, error });
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

// Singleton instance
const jobQueue = new JobQueue();

// Export both the class and singleton
export { JobQueue };
export default jobQueue;
