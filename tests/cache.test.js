// Cache-aside behaviour, using an in-memory Redis stand-in (ioredis-mock).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const RedisMock = require('ioredis-mock');

const cache = require(path.join(__dirname, '../Customer_Site/backend/lib/cache'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('single-flight: 50 concurrent misses run the loader once', async () => {
  cache.__setRedisForTests(new RedisMock());
  let calls = 0;
  const loader = async () => { calls++; await sleep(30); return [{ dish: 'Samosa' }]; };

  const results = await Promise.all(Array.from({ length: 50 }, () => cache.getOrLoad('menu:1', 60, loader)));
  assert.equal(calls, 1);
  assert.ok(results.every((r) => r[0].dish === 'Samosa'));
});

test('hit after miss, and invalidate forces a reload', async () => {
  cache.__setRedisForTests(new RedisMock());
  let version = 1;
  const loader = async () => ({ price: version === 1 ? 20 : 25 });

  assert.equal((await cache.getOrLoad('menu:2', 60, loader)).price, 20);
  version = 2; // DB changed...
  assert.equal((await cache.getOrLoad('menu:2', 60, loader)).price, 20, 'still cached');
  await cache.invalidate('menu:2'); // ...writer deletes the key after its commit
  assert.equal((await cache.getOrLoad('menu:2', 60, loader)).price, 25);
});

test('fail-open: a broken Redis falls back to the database', async () => {
  const broken = {
    get: async () => { throw new Error('ECONNREFUSED'); },
    set: async () => { throw new Error('ECONNREFUSED'); },
    del: async () => { throw new Error('ECONNREFUSED'); },
  };
  cache.__setRedisForTests(broken);
  const v = await cache.getOrLoad('menu:3', 60, async () => 'from-db');
  assert.equal(v, 'from-db');
});

test('no Redis configured: loader is called directly', async () => {
  cache.__setRedisForTests(null);
  assert.equal(await cache.getOrLoad('x', 60, async () => 42), 42);
});
