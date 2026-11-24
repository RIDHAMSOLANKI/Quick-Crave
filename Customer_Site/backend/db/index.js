// PostgreSQL access: one shared connection pool plus a transaction helper.

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || undefined,
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'postgres',
  max: Number(process.env.DB_POOL_MAX || 10),
});

pool.on('error', (err) => {
  // An idle client died (e.g. the DB restarted). The pool replaces it, so log
  // and carry on instead of killing the whole server.
  console.error('[db] idle client error:', err.message);
});

// Errors where simply running the same transaction again is the right fix.
const RETRYABLE = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
]);

/**
 * Run `fn(client)` inside BEGIN ... COMMIT on ONE connection.
 *
 * Why one connection matters: pool.query() may send each statement on a
 * different connection, so a BEGIN sent through pool.query() does not cover
 * the statements after it. Here every statement goes through the same client.
 *
 * On any error the transaction is rolled back. Deadlocks and serialization
 * failures are retried a few times with a small random backoff.
 */
async function withTransaction(fn, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (RETRYABLE.has(err.code) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 10 + Math.random() * 40 * (attempt + 1)));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  withTransaction,
  pool,
};
