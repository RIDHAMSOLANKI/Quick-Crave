// Job queue (BullMQ on Redis) for work that must not slow down a request:
// emails and the delayed "auto-cancel unanswered order" job.
//
// Why a queue instead of setTimeout / awaiting inside the request:
//  * jobs are stored in Redis, so a server restart does not lose them;
//  * failed jobs retry with exponential backoff (e.g. the mail server is down);
//  * the HTTP request returns immediately instead of waiting on slow work.
//
// Without REDIS_URL the same handlers run in-process (dev/test fallback).

const { runJob } = require('./jobs');

const QUEUE_NAME = 'quickcrave';
const DEFAULT_OPTS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: 1000,
  removeOnFail: 5000, // kept for inspection: this is our dead-letter list
};

let queue;
function getQueue() {
  if (!process.env.REDIS_URL) return null;
  if (!queue) {
    const { Queue } = require('bullmq');
    const IORedis = require('ioredis');
    const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
    connection.on('error', (err) => console.error('[queue]', err.message));
    queue = new Queue(QUEUE_NAME, { connection });
  }
  return queue;
}

function runInProcess(name, data, delayMs = 0) {
  const t = setTimeout(() => {
    runJob(name, data).catch((err) => console.error(`[job:${name}]`, err.message));
  }, delayMs);
  if (t.unref) t.unref();
}

/**
 * Add a job. Call this only AFTER the database transaction has committed, so
 * a job never refers to data that was rolled back.
 * opts.delay (ms) schedules it for later; opts.jobId de-duplicates.
 */
async function enqueue(name, data, opts = {}) {
  const q = getQueue();
  if (!q) return runInProcess(name, data, opts.delay || 0);
  try {
    await q.add(name, data, { ...DEFAULT_OPTS, ...opts });
  } catch (err) {
    // Redis unreachable: do the work in-process rather than drop it.
    console.error('[queue] enqueue failed, running in-process:', err.message);
    runInProcess(name, data, opts.delay || 0);
  }
}

module.exports = { enqueue, QUEUE_NAME };
