/**
 * Job activity for the Traxim Controller's admin console (October 2026):
 * GET /internal/admin/activity, its protection (shared secret, never through
 * nginx) and the job queue's activity log (data-free summaries only).
 *
 * Run with:  npm test
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-admin-test-'));
process.env.TEMP_FILES_DIR = tempRoot;
const KEY = 'test-internal-key-0123456789abcdef0123456789abcdef';
process.env.TRAXIM_INTERNAL_KEY = KEY;

const { createApp } = await import('../backend/createApp.js');
const { JobQueue } = await import('../backend/utils/jobQueue.js');
const { default: jobQueue } = await import('../backend/utils/jobQueue.js');

let server;
let base;

before(async () => {
  const app = createApp({ serveStatic: false });
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

async function settle(queue, jobId) {
  for (let i = 0; i < 200; i++) {
    const job = queue.getJob(jobId);
    if (job.status === 'completed' || job.status === 'failed') return job;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error('job did not finish');
}

const get = (url, headers = {}) => fetch(base + url, { headers });

test('activity route: refused without the secret, with a wrong one, and through nginx', async () => {
  assert.equal((await get('/internal/admin/activity')).status, 401);
  assert.equal((await get('/internal/admin/activity', { 'X-Traxim-Internal-Key': 'wrong-key-wrong-key-wrong-key-wrong-key' })).status, 401);
  const viaNginx = await get('/internal/admin/activity', { 'X-Traxim-Internal-Key': KEY, 'X-Forwarded-For': '1.2.3.4' });
  assert.equal(viaNginx.status, 404);
  // Not reachable under the public API path either.
  assert.equal((await get('/api/file-generator/internal/admin/activity', { 'X-Traxim-Internal-Key': KEY })).status, 404);
});

test('activity route: with the secret, no user id needed; shows finished jobs with counts only', async () => {
  const id = jobQueue.createJob('infrastructure-generation', { sessionId: 's-web' }, async () => ({
    nodeCount: 321, connectionCount: 400, filePath: '/secret/path/Infrastructure.csv', warnings: ['Riomaggiore: something']
  }));
  await settle(jobQueue, id);
  const res = await get('/internal/admin/activity?after=0', { 'X-Traxim-Internal-Key': KEY });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(typeof data.boot, 'string');
  const done = data.events.find(e => e.job_id === id && e.event === 'completed');
  assert.ok(done, JSON.stringify(data.events));
  assert.equal(done.owner_id, null, 'website job: no owner');
  assert.deepEqual(done.summary, { nodes: 321, connections: 400 });
  assert.ok(Number.isFinite(done.duration_ms));
  const text = JSON.stringify(data);
  assert.ok(!text.includes('/secret/path') && !text.includes('Riomaggiore'), 'no paths or warnings leave the File Generator');
  assert.ok(data.events.some(e => e.job_id === id && e.event === 'started'));
  assert.ok(data.live && Array.isArray(data.live.running) && Array.isArray(data.live.queued));

  // Only newer entries when the caller already has them (same boot).
  const again = await (await get(`/internal/admin/activity?after=${data.last_seq}&boot=${data.boot}`, { 'X-Traxim-Internal-Key': KEY })).json();
  assert.deepEqual(again.events, []);
  // A different boot id (the service restarted): everything kept is sent again.
  const other = await (await get(`/internal/admin/activity?after=${data.last_seq}&boot=old`, { 'X-Traxim-Internal-Key': KEY })).json();
  assert.ok(other.events.length >= 2);
});

test('activity log: agent owner, failures with a short message, running and waiting jobs, size cap', async () => {
  const queue = new JobQueue();
  queue.maxConcurrent = 1;
  let release;
  const gate = new Promise(r => { release = r; });
  const running = queue.createJob('agent-generation', { ownerId: 7, sessionId: 'a' }, () => gate);
  const waiting = queue.createJob('agent-section-search', { ownerId: 8, sessionId: 'b' }, async () => { throw new Error('x'.repeat(500)); });
  let view = queue.activitySince(0, queue.bootId);
  assert.deepEqual(view.live.running.map(j => j.job_id), [running]);
  assert.deepEqual(view.live.queued.map(j => j.job_id), [waiting]);
  assert.equal(view.live.running[0].owner_id, 7);
  release({ summary: { infrastructure_nodes: 50, infrastructure_connections: 60, legs_generated: 2, legs_total: 3 }, seriousProblems: ['p'] });
  await settle(queue, running);
  await settle(queue, waiting);
  view = queue.activitySince(0, queue.bootId);
  const ok = view.events.find(e => e.job_id === running && e.event === 'completed');
  assert.deepEqual(ok.summary, { nodes: 50, connections: 60, legs: 2, legs_total: 3, serious_problems: 1 });
  assert.equal(ok.owner_id, 7);
  const failed = view.events.find(e => e.job_id === waiting && e.event === 'failed');
  assert.equal(failed.owner_id, 8);
  assert.ok(failed.error.length <= 200);

  const small = new JobQueue();
  for (let i = 0; i < JobQueue.ACTIVITY_KEEP + 50; i++) small.recordActivity({ id: `j${i}`, type: 't', data: {} }, 'started');
  assert.equal(small.activity.length, JobQueue.ACTIVITY_KEEP);
  assert.equal(small.activity[small.activity.length - 1].seq, JobQueue.ACTIVITY_KEEP + 50);
});
