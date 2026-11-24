// Background worker: run with `npm run worker` next to `npm start`.
// Needs REDIS_URL. Processes emails and auto-cancel jobs with retries.

require('dotenv').config();
const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const { runJob } = require('./lib/jobs');
const { QUEUE_NAME } = require('./lib/queue');

if (!process.env.REDIS_URL) {
  console.error('REDIS_URL is not set. Without Redis, jobs already run inside the API server.');
  process.exit(1);
}

const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });

const worker = new Worker(QUEUE_NAME, (job) => runJob(job.name, job.data), {
  connection,
  concurrency: Number(process.env.WORKER_CONCURRENCY || 5),
});

worker.on('completed', (job) => console.log(`[worker] done ${job.name} #${job.id}`));
worker.on('failed', (job, err) =>
  console.error(`[worker] failed ${job?.name} #${job?.id} (attempt ${job?.attemptsMade}):`, err.message)
);

const shutdown = async () => {
  await worker.close();
  await connection.quit();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(`[worker] listening on queue "${QUEUE_NAME}"`);
