/**
 * Job queue: a failing job must be recorded as failed without bringing the
 * service down, and agent jobs carry an owner.
 *
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobQueue } from '../backend/utils/jobQueue.js';

async function settle(queue, jobId) {
  for (let i = 0; i < 200; i++) {
    const job = queue.getJob(jobId);
    if (job.status === 'completed' || job.status === 'failed') return job;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error('job did not finish');
}

test('a failing job is marked failed and does not cause an unhandled rejection', async () => {
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    const queue = new JobQueue();
    const failedEvents = [];
    queue.on('failed', e => failedEvents.push(e.jobId));
    const jobId = queue.createJob('test', {}, async () => { throw new Error('boom'); });
    const job = await settle(queue, jobId);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(job.status, 'failed');
    assert.equal(job.error, 'boom');
    assert.deepEqual(failedEvents, [jobId]);
    assert.deepEqual(rejections, [], 'the old emit("error") with no listener threw here');
    // The queue keeps working afterwards.
    const next = queue.createJob('test', {}, async () => 42);
    assert.equal((await settle(queue, next)).result, 42);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('owner metadata, active count per owner and queue position', async () => {
  const queue = new JobQueue();
  queue.maxConcurrent = 1;
  let release;
  const gate = new Promise(r => { release = r; });
  const running = queue.createJob('agent-x', { ownerId: 7, sessionId: 's1' }, () => gate);
  const waiting = queue.createJob('agent-x', { ownerId: 7, sessionId: 's2' }, async () => 1);
  const website = queue.createJob('geometry', { sessionId: 's3' }, async () => 1);
  assert.deepEqual(queue.getJobMeta(running), { ownerId: 7, sessionId: 's1' });
  assert.deepEqual(queue.getJobMeta(website), { ownerId: null, sessionId: 's3' });
  assert.equal(queue.getJobMeta('nope'), null);
  assert.equal(queue.countActiveForOwner(7), 2);
  assert.equal(queue.countActiveForOwner(8), 0);
  assert.equal(queue.queuePosition(running), 0);
  assert.equal(queue.queuePosition(waiting), 1);
  assert.equal(queue.queuePosition(website), 2);
  release('done');
  await settle(queue, website);
  assert.equal(queue.countActiveForOwner(7), 0);
});
