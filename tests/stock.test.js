// Inventory (stock) under concurrency: no overselling, no deadlocks, and a
// sold-out payment takes no money.

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

const count = (arr, pred) => arr.filter(pred).length;

let stack;
test.before(async () => { stack = await h.startStack(); });
test.after(async () => { if (stack) await stack.stop(); });

const q = (sql, params) => stack.admin.query(sql, params);

// N different students, each with their own accepted order for `items`.
async function studentsWithAcceptedOrders(prefix, n, items, wallet = 1000) {
  const students = [];
  for (let i = 0; i < n; i++) {
    const username = `${prefix}${i}`;
    const id = await h.createCustomer(stack.admin, { username, wallet });
    const c = await h.loginCustomer(stack.customerUrl, username);
    for (const dishId of items) {
      const add = await c.post('/customer/customer-add-dish', { dish_id: dishId });
      assert.ok(add.status === 200 || add.status === 201, JSON.stringify(add.data));
    }
    const r = await c.post('/customer/request-order');
    assert.equal(r.data.status, 2, 'auto-accepted');
    students.push({ id, c });
  }
  return students;
}

test('20 students race for 5 samosas: exactly 5 are sold, nobody else is charged', async () => {
  const canteen = await h.createCanteen(stack.admin, { username: 'stk_cant', autoAccept: true });
  const samosa = await h.createDish(stack.admin, canteen, 20, { stock: 5, name: 'Samosa' });
  const students = await studentsWithAcceptedOrders('stk_u', 20, [samosa]);

  const results = await Promise.all(students.map((s) => s.c.post('/customer/place-order')));
  assert.equal(count(results, (r) => r.status === 200), 5, 'exactly 5 payments succeed');
  assert.equal(count(results, (r) => r.status === 409), 15);
  assert.ok(results.filter((r) => r.status === 409).every((r) => /sold out/.test(r.data.message)));

  const stock = (await q('SELECT stock, order_count FROM dishes WHERE dish_id = $1', [samosa])).rows[0];
  assert.equal(stock.stock, 0, 'stock never goes negative');
  assert.equal(stock.order_count, 5);

  const charged = await q('SELECT count(*)::int AS n FROM customers WHERE username LIKE $1 AND wallet_balance < 1000', ['stk_u%']);
  assert.equal(charged.rows[0].n, 5, 'only the 5 winners paid');
  const earn = (await q('SELECT earnings FROM canteens WHERE canteen_id = $1', [canteen])).rows[0].earnings;
  assert.equal(earn, 100);
});

test('orders sharing dishes pay concurrently without deadlocks', async () => {
  const canteen = await h.createCanteen(stack.admin, { username: 'dl_cant', autoAccept: true });
  const a = await h.createDish(stack.admin, canteen, 10, { stock: 1000, name: 'Chai' });
  const b = await h.createDish(stack.admin, canteen, 15, { stock: 1000, name: 'Vada' });
  // Half add (a, b), half add (b, a); payment sorts by dish_id anyway.
  const s1 = await studentsWithAcceptedOrders('dl_x', 10, [a, b]);
  const s2 = await studentsWithAcceptedOrders('dl_y', 10, [b, a]);

  const results = await Promise.all([...s1, ...s2].map((s) => s.c.post('/customer/place-order')));
  assert.equal(count(results, (r) => r.status === 200), 20, JSON.stringify(results.filter((r) => r.status !== 200)));

  const rows = (await q('SELECT dish_id, stock FROM dishes WHERE dish_id = ANY($1) ORDER BY dish_id', [[a, b]])).rows;
  assert.deepEqual(rows.map((r) => r.stock), [980, 980]);
});

test('sold out at payment rolls back everything: no money, no stock, order still payable later', async () => {
  const canteen = await h.createCanteen(stack.admin, { username: 'rb_cant', autoAccept: true });
  const dish = await h.createDish(stack.admin, canteen, 40, { stock: 1, name: 'Biryani' });
  const [s] = await studentsWithAcceptedOrders('rb_u', 1, [dish], 100);

  // The canteen runs out after the order was accepted.
  const staff = await h.loginCanteen(stack.canteenUrl, 'rb_cant');
  assert.equal((await staff.post('/canteen/update-stock', { dish_id: dish, stock: 0 })).status, 200);

  const pay = await s.c.post('/customer/place-order');
  assert.equal(pay.status, 409);
  assert.match(pay.data.message, /Biryani is sold out/);

  const cust = (await q('SELECT wallet_balance, cart_id FROM customers WHERE customer_id = $1', [s.id])).rows[0];
  assert.equal(cust.wallet_balance, 100, 'no money taken');
  assert.notEqual(cust.cart_id, 0, 'order still there');
  const order = (await q('SELECT status FROM orders WHERE order_id = $1', [cust.cart_id])).rows[0];
  assert.equal(order.status, 2, 'still accepted, nothing half-done');
  const tx = await q('SELECT count(*)::int AS n FROM transactions WHERE customer_id = $1', [s.id]);
  assert.equal(tx.rows[0].n, 0);

  // Restocked -> the same order can now be paid.
  await staff.post('/canteen/update-stock', { dish_id: dish, stock: 3 });
  assert.equal((await s.c.post('/customer/place-order')).status, 200);
  assert.equal((await q('SELECT stock FROM dishes WHERE dish_id = $1', [dish])).rows[0].stock, 2);
});

test('early checks: cart and request warn before payment', async () => {
  const canteen = await h.createCanteen(stack.admin, { username: 'ec_cant' });
  const dish = await h.createDish(stack.admin, canteen, 12, { stock: 2, name: 'Puff' });
  await h.createCustomer(stack.admin, { username: 'ec_user', wallet: 100 });
  const c = await h.loginCustomer(stack.customerUrl, 'ec_user');

  assert.equal((await c.post('/customer/customer-add-dish', { dish_id: dish })).status, 201);
  assert.equal((await c.post('/customer/customer-add-dish', { dish_id: dish })).status, 200);
  const third = await c.post('/customer/customer-add-dish', { dish_id: dish });
  assert.equal(third.status, 409);
  assert.match(third.data.message, /Only 2 Puff left/);

  // Stock drops below what's in the cart -> request is refused up front.
  await q('UPDATE dishes SET stock = 1 WHERE dish_id = $1', [dish]);
  const req = await c.post('/customer/request-order');
  assert.equal(req.status, 409);
  assert.match(req.data.message, /Only 1 Puff left/);
});

test('unlimited dishes (stock = NULL) are never blocked', async () => {
  const canteen = await h.createCanteen(stack.admin, { username: 'ul_cant', autoAccept: true });
  const tea = await h.createDish(stack.admin, canteen, 10, { stock: null, name: 'Tea' });
  const students = await studentsWithAcceptedOrders('ul_u', 5, [tea]);
  const results = await Promise.all(students.map((s) => s.c.post('/customer/place-order')));
  assert.equal(count(results, (r) => r.status === 200), 5);
  assert.equal((await q('SELECT stock FROM dishes WHERE dish_id = $1', [tea])).rows[0].stock, null);
});

test('update-stock: own dishes only, and validated', async () => {
  const a = await h.createCanteen(stack.admin, { username: 'us_a' });
  await h.createCanteen(stack.admin, { username: 'us_b' });
  const dish = await h.createDish(stack.admin, a, 30, { stock: 4 });
  const b = await h.loginCanteen(stack.canteenUrl, 'us_b');
  assert.equal((await b.post('/canteen/update-stock', { dish_id: dish, stock: 999 })).status, 404);
  const ownA = await h.loginCanteen(stack.canteenUrl, 'us_a');
  assert.equal((await ownA.post('/canteen/update-stock', { dish_id: dish, stock: -1 })).status, 400);
  assert.equal((await ownA.post('/canteen/update-stock', { dish_id: dish, stock: 'lots' })).status, 400);
  assert.equal((await q('SELECT stock FROM dishes WHERE dish_id = $1', [dish])).rows[0].stock, 4);
});
