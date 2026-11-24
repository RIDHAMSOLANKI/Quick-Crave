// Concurrency and security tests against a REAL PostgreSQL.
// Each race test fires many identical requests at the same instant and then
// checks the invariants that must always hold (no double charge, no negative
// wallet, one cart, one credit per payment, one winner per status change).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const h = require('./helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const count = (arr, pred) => arr.filter(pred).length;

let stack;
test.before(async () => { stack = await h.startStack(); });
test.after(async () => { if (stack) await stack.stop(); });

const q = (sql, params) => stack.admin.query(sql, params);

test('double payment: 20 simultaneous "pay" requests charge exactly once', async () => {
  const canteen = await h.createCanteen(stack.admin, { username: 'pay_cant', autoAccept: true });
  const dish = await h.createDish(stack.admin, canteen, 80);
  const cust = await h.createCustomer(stack.admin, { username: 'pay_user', wallet: 100 });

  const [first, ...others] = await h.devices(stack.customerUrl, 'pay_user', 20);
  assert.equal((await first.post('/customer/customer-add-dish', { dish_id: dish })).status, 201);
  const req = await first.post('/customer/request-order');
  assert.equal(req.data.status, 2, 'auto-accepted');

  const results = await Promise.all([first, ...others].map((d) => d.post('/customer/place-order')));
  assert.equal(count(results, (r) => r.status === 200), 1, 'exactly one payment succeeds');
  assert.equal(count(results, (r) => r.status === 409 || r.status === 402), 19);

  const c = (await q('SELECT wallet_balance, cart_id FROM customers WHERE customer_id = $1', [cust])).rows[0];
  assert.equal(c.wallet_balance, 20);
  assert.equal(c.cart_id, 0);
  const tx = await q('SELECT amount FROM transactions WHERE customer_id = $1', [cust]);
  assert.deepEqual(tx.rows.map((r) => Number(r.amount)), [-80]);
  const earn = (await q('SELECT earnings FROM canteens WHERE canteen_id = $1', [canteen])).rows[0].earnings;
  assert.equal(earn, 80);
});

test('first add to cart: 20 simultaneous adds create ONE cart with all 20 items', async () => {
  const canteen = await h.createCanteen(stack.admin, { username: 'cart_cant' });
  const dish = await h.createDish(stack.admin, canteen, 15);
  const cust = await h.createCustomer(stack.admin, { username: 'cart_user' });
  const devs = await h.devices(stack.customerUrl, 'cart_user', 20);

  const results = await Promise.all(devs.map((d) => d.post('/customer/customer-add-dish', { dish_id: dish })));
  assert.equal(count(results, (r) => r.status === 200 || r.status === 201), 20, 'no request lost');
  assert.equal(count(results, (r) => r.status === 201), 1, 'one request created the cart');

  const carts = await q('SELECT order_id, dish_map, final_amount FROM orders WHERE customer_id = $1 AND status = 0', [cust]);
  assert.equal(carts.rows.length, 1, 'exactly one open cart');
  assert.equal(carts.rows[0].dish_map[String(dish)], 20, 'no lost update on quantity');
  assert.equal(Number(carts.rows[0].final_amount), 300);
});

test('cart is frozen once the order is requested (no free food mid-payment)', async () => {
  const canteen = await h.createCanteen(stack.admin, { username: 'frz_cant', autoAccept: true });
  const dish = await h.createDish(stack.admin, canteen, 30);
  await h.createCustomer(stack.admin, { username: 'frz_user', wallet: 500 });
  const d = await h.loginCustomer(stack.customerUrl, 'frz_user');

  await d.post('/customer/customer-add-dish', { dish_id: dish });
  await d.post('/customer/request-order');
  const add = await d.post('/customer/customer-add-dish', { dish_id: dish });
  assert.equal(add.status, 409);
  const rem = await d.post('/customer/customer-remove-dish', { dish_id: dish });
  assert.equal(rem.status, 409);
});

test('reservations: 10 simultaneous bookings never overdraw the wallet', async () => {
  const canteen = await h.createCanteen(stack.admin, { username: 'res_cant' });
  const cust = await h.createCustomer(stack.admin, { username: 'res_user', wallet: 30 });
  const devs = await h.devices(stack.customerUrl, 'res_user', 10);

  const body = { canteen_id: canteen, num_people: 2, date: '2030-01-01', time: '13:00' };
  const results = await Promise.all(devs.map((d) => d.post('/customer/customer-add-reservations', body)));
  assert.equal(count(results, (r) => r.status === 200), 1, 'only one booking fits Rs 30');

  const bal = (await q('SELECT wallet_balance FROM customers WHERE customer_id = $1', [cust])).rows[0].wallet_balance;
  assert.equal(bal, 10);
  const res = await q('SELECT count(*)::int AS n FROM reservations WHERE customer_id = $1', [cust]);
  assert.equal(res.rows[0].n, 1, 'no unpaid reservation left behind');
});

function signedWebhook(paymentId, notes, amountPaise, event = 'payment.captured') {
  const body = JSON.stringify({
    event,
    payload: { payment: { entity: { id: paymentId, amount: amountPaise, notes } } },
  });
  const sig = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex');
  return { body, sig };
}

test('razorpay: duplicate webhook deliveries credit the wallet exactly once', async () => {
  const cust = await h.createCustomer(stack.admin, { username: 'rzp_user', wallet: 0 });
  const { rows } = await q('SELECT email, phone_number FROM customers WHERE customer_id = $1', [cust]);
  const notes = { username: 'rzp_user', email: rows[0].email, phone: rows[0].phone_number };
  const { body, sig } = signedWebhook('pay_TEST123', notes, 50000);

  const c = h.client(stack.customerUrl);
  const results = await Promise.all(
    Array.from({ length: 10 }, () => c.post('/razorpay-webhook', body, { 'x-razorpay-signature': sig }))
  );
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(count(results, (r) => r.data.status === 'credited'), 1);
  assert.equal(count(results, (r) => r.data.status === 'duplicate'), 9);

  const bal = (await q('SELECT wallet_balance FROM customers WHERE customer_id = $1', [cust])).rows[0].wallet_balance;
  assert.equal(bal, 500);
});

test('razorpay: bad signature is rejected, other events are ignored', async () => {
  const c = h.client(stack.customerUrl);
  const { body } = signedWebhook('pay_BAD', {}, 100);
  const bad = await c.post('/razorpay-webhook', body, { 'x-razorpay-signature': 'a'.repeat(64) });
  assert.equal(bad.status, 400);

  const other = signedWebhook('pay_X', {}, 100, 'payment.failed');
  const ign = await c.post('/razorpay-webhook', other.body, { 'x-razorpay-signature': other.sig });
  assert.equal(ign.status, 200);
  assert.equal(ign.data.status, 'ignored');
});

test('order status: simultaneous accept and reject -> exactly one wins', async () => {
  const canteen = await h.createCanteen(stack.admin, { username: 'race_cant' });
  const dish = await h.createDish(stack.admin, canteen, 20);
  await h.createCustomer(stack.admin, { username: 'race_user', wallet: 100 });
  const d = await h.loginCustomer(stack.customerUrl, 'race_user');
  await d.post('/customer/customer-add-dish', { dish_id: dish });
  const r = await d.post('/customer/request-order');
  assert.equal(r.data.status, 1);

  const staffA = await h.loginCanteen(stack.canteenUrl, 'race_cant');
  const staffB = await h.loginCanteen(stack.canteenUrl, 'race_cant');
  const [acc, rej] = await Promise.all([
    staffA.post('/canteen/accept-order', { order_id: r.data.order_id }),
    staffB.post('/canteen/reject-order', { order_id: r.data.order_id }),
  ]);
  assert.deepEqual([acc.status, rej.status].sort(), [200, 409]);
});

test('auto-cancel: unanswered order returns to cart; a stale timer cannot cancel a newer request', async () => {
  const canteen = await h.createCanteen(stack.admin, { username: 'tmo_cant' });
  const dish = await h.createDish(stack.admin, canteen, 20);
  await h.createCustomer(stack.admin, { username: 'tmo_user', wallet: 100 });
  const d = await h.loginCustomer(stack.customerUrl, 'tmo_user');
  const staff = await h.loginCanteen(stack.canteenUrl, 'tmo_cant');
  await d.post('/customer/customer-add-dish', { dish_id: dish });

  // Request #1 (timer #1 due at +1.5s), rejected at once, then request #2 at +1.0s.
  const t0 = Date.now();
  const r1 = await d.post('/customer/request-order');
  await staff.post('/canteen/reject-order', { order_id: r1.data.order_id });
  await sleep(1000 - (Date.now() - t0));
  await d.post('/customer/request-order');

  await sleep(1750 - (Date.now() - t0)); // timer #1 has fired
  let s = await d.post('/customer/order-status');
  assert.equal(s.data.status, 1, 'stale timer #1 did not cancel request #2');

  await sleep(2900 - (Date.now() - t0)); // timer #2 (+2.5s) has fired
  s = await d.post('/customer/order-status');
  assert.equal(s.data.status, 0);
  assert.equal(s.data.status_note, 'timeout');

  const late = await staff.post('/canteen/accept-order', { order_id: r1.data.order_id });
  assert.equal(late.status, 409, 'cannot accept an order that already timed out');
});

test('ownership: a canteen cannot touch another canteen\'s orders or dishes', async () => {
  const a = await h.createCanteen(stack.admin, { username: 'own_a' });
  await h.createCanteen(stack.admin, { username: 'own_b' });
  const dish = await h.createDish(stack.admin, a, 25);
  await h.createCustomer(stack.admin, { username: 'own_user', wallet: 100 });
  const d = await h.loginCustomer(stack.customerUrl, 'own_user');
  await d.post('/customer/customer-add-dish', { dish_id: dish });
  const r = await d.post('/customer/request-order');

  const b = await h.loginCanteen(stack.canteenUrl, 'own_b');
  assert.equal((await b.post('/canteen/accept-order', { order_id: r.data.order_id })).status, 404);
  assert.equal((await b.post('/canteen/edit-dish', { dish_id: dish, price: 1, dish_name: 'hacked' })).status, 404);
  const still = await q('SELECT price FROM dishes WHERE dish_id = $1', [dish]);
  assert.equal(Number(still.rows[0].price), 25);
});

test('rejecting a reservation refunds it exactly once', async () => {
  const canteen = await h.createCanteen(stack.admin, { username: 'ref_cant' });
  const cust = await h.createCustomer(stack.admin, { username: 'ref_user', wallet: 40 });
  const d = await h.loginCustomer(stack.customerUrl, 'ref_user');
  const r = await d.post('/customer/customer-add-reservations', { canteen_id: canteen, num_people: 3, date: '2030-01-01', time: '12:00' });
  assert.equal(r.status, 200);

  const s1 = await h.loginCanteen(stack.canteenUrl, 'ref_cant');
  const s2 = await h.loginCanteen(stack.canteenUrl, 'ref_cant');
  const both = await Promise.all([
    s1.post('/canteen/reject-reservation', { reservation_id: r.data.reservation_id }),
    s2.post('/canteen/reject-reservation', { reservation_id: r.data.reservation_id }),
  ]);
  assert.deepEqual(both.map((x) => x.status).sort(), [200, 409]);
  const bal = (await q('SELECT wallet_balance FROM customers WHERE customer_id = $1', [cust])).rows[0].wallet_balance;
  assert.equal(bal, 40, 'refunded once, not twice');
});

test('sign-up OTP is checked on the server, with an attempt limit', async () => {
  const c = h.client(stack.customerUrl);
  const form = {
    userType: 'customer', name: 'Otp User', username: 'otp_user', phone: '9876500001',
    email: 'otp_user@test.dev', password: 'secret-pass-1', confirmPassword: 'secret-pass-1',
  };
  const s = await c.post('/auth/signup', form);
  assert.equal(s.status, 200);
  assert.equal(s.data.otp, undefined, 'no OTP or OTP hash is sent to the browser');
  const otp = s.data.devOtp;
  const wrong = otp === '123456' ? '654321' : '123456';

  const w = await c.post('/auth/verify-otp', { email: form.email, otp: wrong });
  assert.equal(w.status, 401);
  assert.equal(w.data.attemptsLeft, 4);

  const ok = await c.post('/auth/verify-otp', { email: form.email, otp });
  assert.equal(ok.status, 201);
  const login = await c.post('/auth/login', { userType: 'customer', username: 'otp_user', password: 'secret-pass-1' });
  assert.equal(login.status, 200);
  assert.equal(login.data.token, undefined, 'token stays in the httpOnly cookie only');

  // brute force: 5 wrong tries lock the pending sign-up
  await c.post('/auth/signup', { ...form, username: 'otp_user2', phone: '9876500002', email: 'otp2@test.dev' });
  for (let i = 0; i < 5; i++) await c.post('/auth/verify-otp', { email: 'otp2@test.dev', otp: '000000' });
  const locked = await c.post('/auth/verify-otp', { email: 'otp2@test.dev', otp: '000000' });
  assert.equal(locked.status, 429);

  // the old OTP-bypass endpoint is gone
  assert.equal((await c.post('/auth/add-user', form)).status, 404);
});

test('roles: a customer token cannot call canteen APIs', async () => {
  await h.createCustomer(stack.admin, { username: 'role_user' });
  const d = await h.loginCustomer(stack.customerUrl, 'role_user');
  // reuse the same cookie against the canteen API
  const cookieJarClient = h.client(stack.canteenUrl);
  const login = await fetch(stack.customerUrl + '/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userType: 'customer', username: 'role_user', password: 'password123' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const r = await cookieJarClient.post('/canteen/order-queue', {}, { cookie });
  assert.equal(r.status, 403);
  assert.ok(d);
});

test('legacy fixed-salt passwords still log in and are upgraded', async () => {
  const bcrypt = require(path.join(__dirname, '../Customer_Site/backend/node_modules/bcryptjs'));
  const legacy = await bcrypt.hash('oldpass99', '$2b$10$abcdefghijklmnopqrstuv');
  await q(
    `INSERT INTO customers (username, password, name, phone_number, email, wallet_balance, cart_id)
     VALUES ('legacy_user', $1, 'L', '9000000009', 'legacy@test.dev', 0, 0)`,
    [legacy]
  );
  const c = h.client(stack.customerUrl);
  const r = await c.post('/auth/login', { userType: 'customer', username: 'legacy_user', password: 'oldpass99' });
  assert.equal(r.status, 200);
  const now = (await q("SELECT password FROM customers WHERE username = 'legacy_user'")).rows[0].password;
  assert.notEqual(now, legacy, 'hash re-salted');
  assert.ok(await bcrypt.compare('oldpass99', now));
});
