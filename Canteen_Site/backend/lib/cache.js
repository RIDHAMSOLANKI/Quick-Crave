// Cache-aside on Redis.
//
// READ:  look in Redis -> on a miss, load from Postgres -> store with a TTL.
// WRITE: update Postgres first, THEN delete the key (never write the new value
//        into the cache from the writer: two writers could leave it in the
//        wrong order; deleting is always safe, the next read refills it).
//
// Protection built in:
//  * TTL + random jitter: keys written together do not all expire together.
//  * Single-flight: when a hot key expires, only ONE request rebuilds it
//    (in-process promise sharing + a short Redis lock across servers), so a
//    lunch-rush miss does not send hundreds of identical queries to Postgres.
//  * Fail-open: if Redis is down or slow, we just read from Postgres.
//
// Money (wallet, cart totals, order status) is NEVER served from this cache.

const { getRedis } = require('./redis');

const PREFIX = 'qc:';
const inFlight = new Map(); // key -> Promise, dedupes misses inside one process

let redisOverride; // tests can inject a client
const redis = () => (redisOverride !== undefined ? redisOverride : getRedis());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withJitter = (ttl) => Math.max(1, Math.round(ttl * (0.9 + Math.random() * 0.2)));

async function safe(fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    console.error('[cache]', err.message);
    return fallback;
  }
}

async function readKey(r, key) {
  const raw = await safe(() => r.get(PREFIX + key), null);
  return raw == null ? undefined : JSON.parse(raw);
}

/**
 * Return the cached value for `key`, or call `loader()` and cache its result
 * for about `ttlSeconds`.
 */
async function getOrLoad(key, ttlSeconds, loader) {
  const r = redis();
  if (!r) return loader();

  const hit = await readKey(r, key);
  if (hit !== undefined) return hit;

  if (inFlight.has(key)) return inFlight.get(key);

  const p = (async () => {
    const lockKey = `${PREFIX}lock:${key}`;
    const gotLock = await safe(() => r.set(lockKey, '1', 'PX', 5000, 'NX'), 'OK');

    if (gotLock !== 'OK') {
      // Another server is rebuilding this key. Wait briefly for its result.
      for (let i = 0; i < 10; i++) {
        await sleep(50);
        const v = await readKey(r, key);
        if (v !== undefined) return v;
      }
      return loader(); // took too long: serve from the DB rather than fail
    }

    try {
      const value = await loader();
      await safe(() => r.set(PREFIX + key, JSON.stringify(value), 'EX', withJitter(ttlSeconds)));
      return value;
    } finally {
      await safe(() => r.del(lockKey));
    }
  })();

  inFlight.set(key, p);
  try {
    return await p;
  } finally {
    inFlight.delete(key);
  }
}

/** Delete one or more keys. Call this AFTER the database write commits. */
async function invalidate(...keys) {
  const r = redis();
  if (!r || keys.length === 0) return;
  await safe(() => r.del(...keys.map((k) => PREFIX + k)));
}

// Key names shared by both backends (the canteen backend deletes them).
const keys = {
  canteens: () => 'canteens:all',
  dishes: () => 'dishes:all',
  top5: () => 'dishes:top5',
  menu: (canteenId) => `menu:${canteenId}`,
};

module.exports = {
  getOrLoad,
  invalidate,
  keys,
  __setRedisForTests: (c) => { redisOverride = c; },
};
