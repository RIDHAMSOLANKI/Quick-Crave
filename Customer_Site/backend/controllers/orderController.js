// Cart, order and reservation flows: everything that moves money or changes
// an order's status. Each flow is written to stay correct when requests race
// (two devices, double clicks, retries, a canteen click vs. a timer).
//
// Techniques used, and where:
//   * Transaction on ONE connection (db.withTransaction): all-or-nothing.
//   * Row locks (SELECT ... FOR UPDATE) on the customer row: serialises every
//     cart/payment action of one customer, so check-then-act is safe.
//   * Guarded updates (UPDATE ... WHERE status = <expected>): a status change
//     only happens if nobody changed it first; otherwise 0 rows -> 409.
//   * Atomic single statements (balance = balance - x, JSONB +1).
//   * DB constraints as the last line of defence (CHECK wallet >= 0, one open
//     cart per customer) - see database/002_hardening.sql.
//
// Lock order is always customers -> orders -> dishes (by dish_id) -> canteens,
// so two flows can never wait on each other in a circle (deadlock).

const db = require('../db');
const STATUS = require('../lib/orderStatus');
const cache = require('../lib/cache');
const { enqueue } = require('../lib/queue');
const { HttpError, sendError } = require('../lib/httpError');

const ORDER_RESPONSE_TIMEOUT_MS = Number(process.env.ORDER_RESPONSE_TIMEOUT_MS || 5 * 60 * 1000);
const RESERVATION_PRICE_PER_PERSON = 10;

const toPositiveInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// Lock the customer's row for the rest of the transaction and return it.
async function lockCustomer(client, customerId) {
  const { rows } = await client.query(
    'SELECT customer_id, cart_id, wallet_balance, email FROM customers WHERE customer_id = $1 FOR UPDATE',
    [customerId]
  );
  if (rows.length === 0) throw new HttpError(404, 'Customer not found');
  return rows[0];
}

/**
 * Take stock for every dish in the order. Must run inside the payment
 * transaction. Returns true if any stock-tracked dish changed.
 *
 * Race it prevents (overselling): 1 Samosa left, two students pay at once.
 * Each UPDATE carries its own check ("stock >= qty"). Postgres locks the row
 * while updating, so the second student's UPDATE waits, re-checks against the
 * NEW stock (0), changes 0 rows, and we throw -> the whole payment rolls back.
 *
 * Deadlock it prevents: order A = {Samosa, Chai}, order B = {Chai, Samosa}.
 * If A locked Samosa then Chai while B locked Chai then Samosa, they could
 * wait on each other forever. Sorting by dish_id makes every payment take the
 * dish locks in the same order.
 *
 * The same statement bumps order_count (for "top dishes") and re-checks that
 * the dish is still on sale (the canteen may have switched it off).
 */
async function takeStock(client, dishMap) {
  const items = Object.entries(dishMap || {})
    .map(([id, qty]) => [Number(id), Number(qty)])
    .filter(([id, qty]) => Number.isInteger(id) && qty > 0)
    .sort((a, b) => a[0] - b[0]);

  let stockChanged = false;
  for (const [dishId, qty] of items) {
    const r = await client.query(
      `UPDATE dishes
          SET stock = CASE WHEN stock IS NULL THEN NULL ELSE stock - $2 END,
              order_count = COALESCE(order_count, 0) + $2
        WHERE dish_id = $1 AND is_active AND is_available
          AND (stock IS NULL OR stock >= $2)
        RETURNING stock`,
      [dishId, qty]
    );
    if (r.rowCount === 0) {
      const d = await client.query('SELECT dish_name, stock, is_active, is_available FROM dishes WHERE dish_id = $1', [dishId]);
      const info = d.rows[0];
      const name = (info && info.dish_name) || `Dish ${dishId}`;
      const left = info && info.is_active && info.is_available ? info.stock : 0;
      throw new HttpError(409, left > 0 ? `Only ${left} ${name} left` : `${name} is sold out`, {
        dish_id: dishId,
        stock_left: left || 0,
      });
    }
    if (r.rows[0].stock !== null) stockChanged = true;
  }
  return stockChanged;
}

// Friendly early check used by add-to-cart and request-order. NOT the real
// guard (stock can still change after this); takeStock() at payment is.
async function findShortDish(q, dishMap) {
  const { rows } = await q.query(
    `SELECT d.dish_id, d.dish_name, d.stock, d.is_active, d.is_available, (m.qty)::int AS qty
       FROM jsonb_each_text($1::jsonb) AS m(dish_id, qty)
       JOIN dishes d ON d.dish_id = m.dish_id::int
      WHERE NOT (d.is_active AND d.is_available) OR (d.stock IS NOT NULL AND d.stock < (m.qty)::int)
      ORDER BY d.dish_id
      LIMIT 1`,
    [JSON.stringify(dishMap || {})]
  );
  return rows[0] || null;
}

const shortMessage = (d) =>
  d.is_active && d.is_available && d.stock > 0 ? `Only ${d.stock} ${d.dish_name} left` : `${d.dish_name} is sold out`;

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------

exports.addDishToCart = async (req, res) => {
  try {
    const dishId = toPositiveInt(req.body.dish_id);
    if (!dishId) throw new HttpError(400, 'dish_id is required');

    const result = await db.withTransaction(async (client) => {
      const customer = await lockCustomer(client, req.customer_id);

      const dish = await client.query(
        'SELECT canteen_id, price, stock, dish_name FROM dishes WHERE dish_id = $1 AND is_active AND is_available',
        [dishId]
      );
      if (dish.rows.length === 0) throw new HttpError(404, 'Dish not found');
      const { canteen_id: canteenId, price, stock, dish_name: dishName } = dish.rows[0];

      // Early, friendly stock check (the real guard is takeStock() at payment).
      // The customer row is locked, so this customer's cart can't change meanwhile.
      if (stock !== null) {
        let inCart = 0;
        if (customer.cart_id) {
          const c = await client.query('SELECT COALESCE((dish_map->>$2::text)::int, 0) AS qty FROM orders WHERE order_id = $1', [
            customer.cart_id,
            String(dishId),
          ]);
          inCart = c.rows[0] ? c.rows[0].qty : 0;
        }
        if (inCart + 1 > stock) {
          throw new HttpError(409, stock > 0 ? `Only ${stock} ${dishName} left` : `${dishName} is sold out`, {
            stock_left: stock,
          });
        }
      }

      if (!customer.cart_id) {
        // First item: create the cart. The customer row is locked, so a second
        // "first add" waits here and then sees the new cart_id instead of
        // creating a second cart (the partial UNIQUE index backs this up).
        const created = await client.query(
          `INSERT INTO orders (customer_id, canteen_id, status, payment_id, coupon_id, bill_amount,
                               discount_amount, final_amount, time, is_delivery, dish_map)
           VALUES ($1, $2, $3, '', NULL, $4, 0, $4, NOW(), false, jsonb_build_object($5::text, 1))
           RETURNING order_id, dish_map, final_amount`,
          [req.customer_id, canteenId, STATUS.CART, price, String(dishId)]
        );
        await client.query('UPDATE customers SET cart_id = $1 WHERE customer_id = $2', [
          created.rows[0].order_id,
          req.customer_id,
        ]);
        return { status: 201, message: 'New cart created', cart: created.rows[0] };
      }

      // Existing cart: one atomic UPDATE, and only while it is still a cart
      // (once the order is requested or paid, edits change 0 rows).
      const updated = await client.query(
        `UPDATE orders
            SET dish_map = dish_map || jsonb_build_object($2::text, COALESCE((dish_map->>$2::text)::int, 0) + 1),
                final_amount = final_amount + $3,
                bill_amount  = bill_amount + $3
          WHERE order_id = $1 AND status = $4 AND canteen_id = $5
          RETURNING dish_map, final_amount`,
        [customer.cart_id, String(dishId), price, STATUS.CART, canteenId]
      );
      if (updated.rowCount === 1) {
        return { status: 200, message: 'Dish added to existing cart', cart: updated.rows[0] };
      }

      // Find out why it did not match, for a precise error.
      const cart = await client.query('SELECT status, canteen_id FROM orders WHERE order_id = $1', [customer.cart_id]);
      if (cart.rows[0] && cart.rows[0].status !== STATUS.CART) {
        throw new HttpError(409, 'Your order is already being processed; the cart cannot change now.');
      }
      throw new HttpError(409, 'The current canteen of the customer is different from the canteen of the dish selected.');
    });

    return res.status(result.status).json({ success: true, message: result.message, cart: result.cart });
  } catch (err) {
    return sendError(res, err);
  }
};

exports.removeDishFromCart = async (req, res) => {
  try {
    const dishId = toPositiveInt(req.body.dish_id);
    if (!dishId) throw new HttpError(400, 'dish_id is required');

    const cart = await db.withTransaction(async (client) => {
      const customer = await lockCustomer(client, req.customer_id);
      if (!customer.cart_id) throw new HttpError(404, 'No active cart found');

      const dish = await client.query('SELECT price FROM dishes WHERE dish_id = $1', [dishId]);
      if (dish.rows.length === 0) throw new HttpError(404, 'Dish not found');

      // Decrement (or drop) the item in one statement, only while it is a cart.
      const updated = await client.query(
        `UPDATE orders
            SET dish_map = CASE WHEN (dish_map->>$2::text)::int > 1
                                THEN dish_map || jsonb_build_object($2::text, (dish_map->>$2::text)::int - 1)
                                ELSE dish_map - $2::text END,
                final_amount = final_amount - $3,
                bill_amount  = bill_amount - $3
          WHERE order_id = $1 AND status = $4 AND dish_map ? $2::text
          RETURNING dish_map, final_amount`,
        [customer.cart_id, String(dishId), dish.rows[0].price, STATUS.CART]
      );
      if (updated.rowCount === 0) throw new HttpError(409, 'Dish not in cart, or the order is already being processed');

      if (Object.keys(updated.rows[0].dish_map).length === 0) {
        // Empty cart: delete it so the "one open cart" slot is free again.
        await client.query('DELETE FROM orders WHERE order_id = $1', [customer.cart_id]);
        await client.query('UPDATE customers SET cart_id = 0 WHERE customer_id = $1', [req.customer_id]);
      }
      return updated.rows[0];
    });

    return res.status(200).json({ success: true, message: 'Dish removed from cart', cart });
  } catch (err) {
    return sendError(res, err);
  }
};

exports.setOrderType = async (req, res) => {
  try {
    if (typeof req.body.is_delivery !== 'boolean') throw new HttpError(400, 'is_delivery must be true or false');
    const { rowCount } = await db.query(
      `UPDATE orders o SET is_delivery = $1
         FROM customers c
        WHERE c.customer_id = $2 AND o.order_id = c.cart_id AND o.status = $3`,
      [req.body.is_delivery, req.customer_id, STATUS.CART]
    );
    if (rowCount === 0) throw new HttpError(400, 'No open cart for this customer');
    return res.status(200).json({ success: true, message: 'Order type (is_delivery) updated successfully' });
  } catch (err) {
    return sendError(res, err);
  }
};

// ---------------------------------------------------------------------------
// Ordering: request -> (canteen accepts) -> pay
// ---------------------------------------------------------------------------

// POST /customer/request-order
// Returns immediately. The frontend then polls GET-style /customer/order-status.
// (The old version held the HTTP request open for up to 5 minutes and kept the
// timer in server memory, so a restart lost it.)
exports.requestOrder = async (req, res) => {
  try {
    const outcome = await db.withTransaction(async (client) => {
      const customer = await lockCustomer(client, req.customer_id);
      if (!customer.cart_id) throw new HttpError(404, 'No active cart found for this customer');

      const order = await client.query(
        `SELECT o.order_id, o.status, o.final_amount, o.dish_map, c.auto_accept, c.opening_status
           FROM orders o JOIN canteens c ON c.canteen_id = o.canteen_id
          WHERE o.order_id = $1 FOR UPDATE OF o`,
        [customer.cart_id]
      );
      if (order.rows.length === 0) throw new HttpError(404, 'Order not found');
      const o = order.rows[0];

      if (o.status !== STATUS.CART) {
        // Second click / second device: report the current state, change nothing.
        return { orderId: o.order_id, status: o.status, duplicate: true };
      }
      if (o.opening_status === false) throw new HttpError(409, 'This canteen is closed right now');
      // Don't bother the canteen with an order it can't fill (early check only).
      const short = await findShortDish(client, o.dish_map);
      if (short) throw new HttpError(409, shortMessage(short), { dish_id: short.dish_id, stock_left: short.stock || 0 });
      if (Number(o.final_amount) > Number(customer.wallet_balance)) {
        throw new HttpError(402, 'Insufficient wallet balance');
      }

      const next = o.auto_accept ? STATUS.ACCEPTED : STATUS.REQUESTED;
      const upd = await client.query(
        `UPDATE orders SET status = $1, status_note = NULL, request_seq = request_seq + 1, time = NOW()
          WHERE order_id = $2 AND status = $3
          RETURNING request_seq`,
        [next, o.order_id, STATUS.CART]
      );
      return { orderId: o.order_id, status: next, seq: upd.rows[0].request_seq };
    });

    // Schedule the auto-cancel AFTER commit. jobId makes a duplicate schedule a no-op.
    if (!outcome.duplicate && outcome.status === STATUS.REQUESTED) {
      await enqueue(
        'auto-cancel-order',
        { orderId: outcome.orderId, seq: outcome.seq },
        { delay: ORDER_RESPONSE_TIMEOUT_MS, jobId: `cancel-${outcome.orderId}-${outcome.seq}` }
      );
    }

    return res.status(200).json({
      success: true,
      order_id: outcome.orderId,
      status: outcome.status,
      message: outcome.status === STATUS.ACCEPTED ? 'Order auto-accepted by canteen' : 'Order sent to canteen',
    });
  } catch (err) {
    return sendError(res, err);
  }
};

// POST /customer/order-status  -> where is my current order?
exports.orderStatus = async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT o.order_id, o.status, o.status_note
         FROM customers c JOIN orders o ON o.order_id = c.cart_id
        WHERE c.customer_id = $1`,
      [req.customer_id]
    );
    if (rows.length === 0) return res.status(200).json({ success: true, status: null });
    return res.status(200).json({ success: true, ...rows[0] });
  } catch (err) {
    return sendError(res, err);
  }
};

// POST /customer/place-order  -> pay for the accepted order from the wallet.
exports.placeOrder = async (req, res) => {
  try {
    const paid = await db.withTransaction(async (client) => {
      // 1. Lock the customer. A second "pay" (other device, double click)
      //    waits here; when it continues, cart_id is already 0 -> rejected.
      const customer = await lockCustomer(client, req.customer_id);
      if (!customer.cart_id) throw new HttpError(409, 'No order to pay for (it may already be paid)');

      // 2. Lock the order so the amount cannot change while we charge it.
      const order = await client.query(
        'SELECT order_id, status, final_amount, canteen_id, dish_map FROM orders WHERE order_id = $1 FOR UPDATE',
        [customer.cart_id]
      );
      if (order.rows.length === 0) throw new HttpError(404, 'Order not found');
      const o = order.rows[0];
      if (o.status !== STATUS.ACCEPTED) throw new HttpError(409, 'The canteen has not accepted this order');

      const amount = Math.round(Number(o.final_amount));

      // 3. Take the stock (see takeStock). If any dish is sold out this throws,
      //    and the whole transaction rolls back: no money, no stock taken.
      const stockChanged = await takeStock(client, o.dish_map);

      // 4. Check-and-debit in ONE statement. The CHECK (wallet_balance >= 0)
      //    constraint is a second guard if anything ever bypasses this.
      const debit = await client.query(
        `UPDATE customers SET wallet_balance = wallet_balance - $1, cart_id = 0
          WHERE customer_id = $2 AND wallet_balance >= $1
          RETURNING wallet_balance`,
        [amount, req.customer_id]
      );
      if (debit.rowCount === 0) throw new HttpError(402, 'Insufficient wallet balance');

      // 5. The rest of the money movement, all in the same transaction.
      await client.query('UPDATE orders SET status = $1 WHERE order_id = $2 AND status = $3', [
        STATUS.PAID,
        o.order_id,
        STATUS.ACCEPTED,
      ]);
      await client.query('UPDATE canteens SET earnings = COALESCE(earnings, 0) + $1 WHERE canteen_id = $2', [
        amount,
        o.canteen_id,
      ]);
      await client.query(
        'INSERT INTO transactions (order_id, customer_id, time, amount) VALUES ($1, $2, NOW(), $3)',
        [o.order_id, req.customer_id, -amount]
      );

      return {
        orderId: o.order_id,
        amount,
        balance: debit.rows[0].wallet_balance,
        email: customer.email,
        canteenId: o.canteen_id,
        stockChanged,
      };
    });

    // Stock changed -> the cached menu shows old "portions left". Drop it
    // (after commit, like every other cache invalidation).
    if (paid.stockChanged) {
      await cache.invalidate(cache.keys.menu(paid.canteenId), cache.keys.dishes());
    }

    await enqueue('send-email', {
      to: paid.email,
      subject: `QuickCrave order #${paid.orderId} confirmed`,
      text: `We received Rs ${paid.amount} for order #${paid.orderId}. We'll tell you when it's ready.`,
    });

    return res.status(200).json({
      success: true,
      message: 'Order placed successfully',
      order_id: paid.orderId,
      wallet_balance: paid.balance,
    });
  } catch (err) {
    return sendError(res, err);
  }
};

// ---------------------------------------------------------------------------
// Reservations (Rs 10 per person, paid from the wallet)
// ---------------------------------------------------------------------------

exports.addReservations = async (req, res) => {
  try {
    const { canteen_id, date, time, additional_requests } = req.body;
    const canteenId = toPositiveInt(canteen_id);
    const people = toPositiveInt(req.body.num_people);
    if (!canteenId || !people || people > 50 || !date || !time) {
      throw new HttpError(400, 'canteen_id, num_people (1-50), date and time are required');
    }
    const when = new Date(`${date} ${time}`);
    if (Number.isNaN(when.getTime())) throw new HttpError(400, 'Invalid date or time');
    const amount = RESERVATION_PRICE_PER_PERSON * people;

    const result = await db.withTransaction(async (client) => {
      // Take the money FIRST, with the check inside the UPDATE. If this fails,
      // nothing else happens (the old code created the reservation first).
      const debit = await client.query(
        `UPDATE customers SET wallet_balance = wallet_balance - $1
          WHERE customer_id = $2 AND wallet_balance >= $1
          RETURNING wallet_balance`,
        [amount, req.customer_id]
      );
      if (debit.rowCount === 0) throw new HttpError(402, 'Insufficient balance');

      const r = await client.query(
        `INSERT INTO reservations (customer_id, canteen_id, request_time, reservation_time,
                                   num_people, status, reservation_amount, additional_request)
         VALUES ($1, $2, NOW(), $3, $4, 1, $5, $6) RETURNING reservation_id`,
        [req.customer_id, canteenId, when, people, amount, additional_requests || null]
      );
      const t = await client.query(
        'INSERT INTO transactions (order_id, customer_id, time, amount) VALUES (0, $1, NOW(), $2) RETURNING transaction_id',
        [req.customer_id, -amount] // money OUT is negative
      );
      return {
        reservation_id: r.rows[0].reservation_id,
        transaction_id: t.rows[0].transaction_id,
        wallet_balance: debit.rows[0].wallet_balance,
      };
    });

    return res.status(200).json({ success: true, message: 'Reservation requested', ...result });
  } catch (err) {
    if (err.code === '23503') return res.status(404).json({ success: false, message: 'Canteen not found' });
    return sendError(res, err);
  }
};
