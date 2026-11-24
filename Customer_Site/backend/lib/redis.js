// Optional Redis connection, used for the cache and the job queue.
//
// If REDIS_URL is not set, getRedis() returns null and the app still works:
// the cache is skipped (reads go straight to Postgres) and background jobs run
// in-process. That keeps local development simple.

const Redis = require('ioredis');

let client;

function getRedis() {
  if (!process.env.REDIS_URL) return null;
  if (!client) {
    client = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 1,      // fail fast so a Redis outage never blocks a request
      enableOfflineQueue: false,
      lazyConnect: false,
    });
    client.on('error', (err) => console.error('[redis]', err.message));
  }
  return client;
}

function redisReady() {
  const r = getRedis();
  return Boolean(r && r.status === 'ready');
}

module.exports = { getRedis, redisReady };
