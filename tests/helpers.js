// Test harness: a real, throwaway PostgreSQL (embedded-postgres), both APIs
// started on random ports, and a tiny cookie-aware HTTP client.
// Redis is NOT used here: the cache is skipped and jobs run in-process.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function startStack() {
  const EmbeddedPostgres = require('embedded-postgres').default;
  const pgPort = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-pg-'));
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port: pgPort,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('quickcrave');

  // Settings must exist BEFORE the backends are required (they read env on load).
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DB_HOST: 'localhost',
    DB_PORT: String(pgPort),
    DB_USER: 'postgres',
    DB_PASS: 'postgres',
    DB_NAME: 'quickcrave',
    DB_POOL_MAX: '20',
    JWT_SECRET: 'test-secret-0123456789abcdef',
    RAZORPAY_WEBHOOK_SECRET: 'whsec_test_secret',
    ORDER_RESPONSE_TIMEOUT_MS: '1500',
  });
  delete process.env.REDIS_URL;

  const { Client } = require(path.join(ROOT, 'Customer_Site/backend/node_modules/pg'));
  const admin = new Client({ host: 'localhost', port: pgPort, user: 'postgres', password: 'postgres', database: 'quickcrave' });
  await admin.connect();
  let schema = fs.readFileSync(path.join(ROOT, 'database/001_schema.sql'), 'utf8');
  try {
    await admin.query(schema);
  } catch (e) {
    // Some embedded builds lack contrib extensions; they only power fuzzy search.
    schema = schema.replace(/CREATE EXTENSION[^\n]*\n/g, '');
    await admin.query(schema);
  }
  let hardening = fs.readFileSync(path.join(ROOT, 'database/002_hardening.sql'), 'utf8');
  try {
    await admin.query(hardening);
  } catch (e) {
    hardening = hardening.replace(/CREATE INDEX IF NOT EXISTS dishes_name_trgm_idx[^\n]*\n/, '');
    await admin.query(hardening);
  }
  await admin.query(fs.readFileSync(path.join(ROOT, 'database/003_stock.sql'), 'utf8'));

  const customerApp = require(path.join(ROOT, 'Customer_Site/backend/app'));
  const canteenApp = require(path.join(ROOT, 'Canteen_Site/backend/app'));
  const customerSrv = customerApp.listen(0);
  const canteenSrv = canteenApp.listen(0);
  await Promise.all([customerSrv, canteenSrv].map((s) => new Promise((r) => s.once('listening', r))));

  const stack = {
    admin,
    customerUrl: `http://localhost:${customerSrv.address().port}`,
    canteenUrl: `http://localhost:${canteenSrv.address().port}`,
    async stop() {
      customerSrv.close();
      canteenSrv.close();
      await admin.end();
      await require(path.join(ROOT, 'Customer_Site/backend/db')).pool.end();
      await require(path.join(ROOT, 'Canteen_Site/backend/db')).pool.end();
      await pg.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return stack;
}

// Minimal HTTP client that keeps the auth cookie like a browser would.
function client(baseUrl) {
  let cookie = '';
  return {
    async post(p, body, headers = {}) {
      const res = await fetch(baseUrl + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
        body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body || {}),
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      let data = null;
      try { data = await res.json(); } catch {}
      return { status: res.status, data };
    },
  };
}

// Seed helpers -------------------------------------------------------------

const bcrypt = require(path.join(ROOT, 'Customer_Site/backend/node_modules/bcryptjs'));

async function createCustomer(admin, { username, wallet = 0 }) {
  const hash = await bcrypt.hash('password123', 4);
  const { rows } = await admin.query(
    `INSERT INTO customers (username, password, name, phone_number, email, wallet_balance, cart_id)
     VALUES ($1, $2, $1, $3, $4, $5, 0) RETURNING customer_id`,
    [username, hash, String(Math.floor(1e9 + Math.random() * 9e9)), `${username}@test.dev`, wallet]
  );
  return rows[0].customer_id;
}

async function createCanteen(admin, { username, autoAccept = false }) {
  const hash = await bcrypt.hash('password123', 4);
  const { rows } = await admin.query(
    `INSERT INTO canteens (username, name, password, auto_accept, opening_status, earnings, menu, email, phone_number)
     VALUES ($1, $1, $2, $3, true, 0, '{}', $4, $5) RETURNING canteen_id`,
    [username, hash, autoAccept, `${username}@canteen.dev`, String(Math.floor(1e9 + Math.random() * 9e9))]
  );
  return rows[0].canteen_id;
}

async function createDish(admin, canteenId, price, { stock = null, name } = {}) {
  const { rows } = await admin.query(
    `INSERT INTO dishes (canteen_id, price, dish_name, is_veg, is_active, is_available, stock)
     VALUES ($1, $2, $3, true, true, true, $4) RETURNING dish_id`,
    [canteenId, price, name || "Dish " + price, stock]
  );
  return rows[0].dish_id;
}

async function loginCustomer(url, username) {
  const c = client(url);
  const r = await c.post('/auth/login', { userType: 'customer', username, password: 'password123' });
  if (r.status !== 200) throw new Error('login failed ' + JSON.stringify(r));
  return c;
}

async function loginCanteen(url, username) {
  const c = client(url);
  const r = await c.post('/auth/login', { userType: 'canteen-manager', username, password: 'password123' });
  if (r.status !== 200) throw new Error('canteen login failed ' + JSON.stringify(r));
  return c;
}

// Same user, N "devices" (independent cookie jars with the same token).
async function devices(url, username, n) {
  const list = [];
  for (let i = 0; i < n; i++) list.push(await loginCustomer(url, username));
  return list;
}

module.exports = {
  startStack, client, createCustomer, createCanteen, createDish, loginCustomer, loginCanteen, devices,
};
