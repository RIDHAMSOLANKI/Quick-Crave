// Canteen-side endpoints. Two rules everywhere in this file:
//  1. OWNERSHIP: every query filters by req.canteen_id (from the JWT), so a
//     canteen can only touch its own orders, dishes, coupons, reservations.
//  2. GUARDED STATUS CHANGES: "UPDATE ... SET status = new WHERE status = old".
//     If the customer's timeout, another staff member or another tab got there
//     first, 0 rows change and we answer 409 instead of overwriting.

const db = require('../db/index.js');
const password = require('../lib/password');
const cache = require('../lib/cache');
const STATUS = require('../lib/orderStatus');
const { enqueue } = require('../lib/queue');
const { HttpError, sendError } = require('../lib/httpError');

// stock: null/undefined/'' = unlimited, otherwise an integer >= 0.
const parseStock = (v) => {
  if (v === null || v === undefined || v === '') return { ok: true, value: null };
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? { ok: true, value: n } : { ok: false };
};

const toId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// Menu data is cached on the customer side; drop it after any menu change.
const invalidateMenu = (canteenId) =>
  cache.invalidate(cache.keys.menu(canteenId), cache.keys.dishes(), cache.keys.top5());

// Guarded order transition shared by accept / reject / ready.
async function moveOrder(req, res, { from, to, note = null, okMessage, email }) {
  try {
    const orderId = toId(req.body.order_id);
    if (!orderId) throw new HttpError(400, 'order_id is required');

    const { rows } = await db.query(
      `UPDATE orders o SET status = $1, status_note = $2
         FROM customers c
        WHERE o.order_id = $3 AND o.canteen_id = $4 AND o.status = $5 AND c.customer_id = o.customer_id
        RETURNING o.order_id, c.email`,
      [to, note, orderId, req.canteen_id, from]
    );
    if (rows.length === 0) {
      const cur = await db.query('SELECT status FROM orders WHERE order_id = $1 AND canteen_id = $2', [
        orderId,
        req.canteen_id,
      ]);
      if (cur.rows.length === 0) throw new HttpError(404, 'Order not found');
      throw new HttpError(409, 'Order was already handled (accepted, rejected or timed out)', {
        status: cur.rows[0].status,
      });
    }
    if (email) await enqueue('send-email', email(rows[0]));
    return res.status(200).json({ success: true, message: okMessage });
  } catch (err) {
    return sendError(res, err);
  }
}

exports.orderQueue = async (req, res) => {
    // console.log('from canteen_controller')
    //console.log(req);

    const canteen_id = req.canteen_id;
    console.log(canteen_id);
    try {
        const orders = await db.query(`
  SELECT 
  o.order_id,
  o.canteen_id,
  o.status,
  o.payment_id,
  o.coupon_id,
  o.bill_amount,
  o.discount_amount,
  o.final_amount,
  o.time,
  o.is_delivery,
  c.name AS customer_name,
  c.address AS customer_address,
  c.img_url AS customer_image,

  json_agg(
    json_build_object(
      'dish_name', d.dish_name,
      'quantity', (dish_kv.value)::int
    )
  ) AS dishes
FROM orders o
JOIN customers c ON o.customer_id = c.customer_id
JOIN LATERAL jsonb_each(o.dish_map) AS dish_kv(dish_id_str, value) ON TRUE
JOIN dishes d ON dish_kv.dish_id_str::int = d.dish_id
WHERE o.canteen_id = $1
  AND o.time >= NOW() - INTERVAL '24 hours'
GROUP BY 
  o.order_id,
  o.canteen_id,
  o.status,
  o.payment_id,
  o.coupon_id,
  o.bill_amount,
  o.discount_amount,
  o.final_amount,
  o.time,
  o.is_delivery,
  c.name,
  c.address,
  c.img_url;
`, [canteen_id]);
        console.log('bkc',orders.rows);
        return res.status(200).json({ message: 'Order Queue Sent', orders: orders.rows });

    }
    catch (err) {
        return res.status(500).json({ message: 'Internal Server Error' });
    }
};

exports.acceptOrder = (req, res) =>
  moveOrder(req, res, {
    from: STATUS.REQUESTED,
    to: STATUS.ACCEPTED,
    okMessage: 'Order Accepted',
    email: (o) => ({ to: o.email, subject: `Order #${o.order_id} accepted`, text: 'Your order was accepted. Please complete payment in the app.' }),
  });

// Rejected orders go back to the customer's cart (nothing was paid yet),
// with status_note so the customer app can say why.
exports.rejectOrder = (req, res) =>
  moveOrder(req, res, {
    from: STATUS.REQUESTED,
    to: STATUS.CART,
    note: 'rejected',
    okMessage: 'Order Rejected',
    email: (o) => ({ to: o.email, subject: `Order #${o.order_id} rejected`, text: 'Sorry, the canteen could not take your order. Your cart is unchanged.' }),
  });

exports.readyOrder = (req, res) =>
  moveOrder(req, res, {
    from: STATUS.PAID,
    to: STATUS.READY,
    okMessage: 'Order Completed',
    email: (o) => ({ to: o.email, subject: `Order #${o.order_id} is ready`, text: 'Your food is ready for pickup.' }),
  });

exports.reservationQueue = async (req, res) => {
    const canteen_id = req.canteen_id;


    try {
        const reservations = await db.query(`
      SELECT 
    r.reservation_id,
    c.img_url AS customer_image_url,
    c.name AS customer_name,
    r.num_people,
    r.reservation_time AS date_of_reservation,
    r.additional_request,
    r.reservation_amount AS booking_amount,
    r.status,
    r.payment_id
FROM 
    reservations r
JOIN 
    customers c ON r.customer_id = c.customer_id
WHERE 
    r.request_time >= NOW() - INTERVAL '7 days'
    AND r.canteen_id = $1;`
            , [canteen_id]);


        return res.status(200).json({ message: 'Reservation Queue Sent', reservations: reservations.rows });

    }
    catch (err) {
        return res.status(500).json({ message: 'Internal Server Error' });
    }
};

exports.acceptReservation = async (req, res) => {
  try {
    const id = toId(req.body.reservation_id);
    if (!id) throw new HttpError(400, 'reservation_id is required');
    const { rowCount } = await db.query(
      'UPDATE reservations SET status = 2 WHERE reservation_id = $1 AND canteen_id = $2 AND status = 1',
      [id, req.canteen_id]
    );
    if (rowCount === 0) throw new HttpError(409, 'Reservation not found or already handled');
    return res.status(200).json({ success: true, message: 'Reservation Accepted' });
  } catch (err) {
    return sendError(res, err);
  }
};

// Rejecting a reservation REFUNDS the booking amount, in the same transaction
// as the status change, so the refund happens exactly once.
exports.rejectReservation = async (req, res) => {
  try {
    const id = toId(req.body.reservation_id);
    if (!id) throw new HttpError(400, 'reservation_id is required');

    await db.withTransaction(async (client) => {
      const r = await client.query(
        `UPDATE reservations SET status = 0
          WHERE reservation_id = $1 AND canteen_id = $2 AND status IN (1, 2)
          RETURNING customer_id, reservation_amount`,
        [id, req.canteen_id]
      );
      if (r.rowCount === 0) throw new HttpError(409, 'Reservation not found or already handled');
      const { customer_id, reservation_amount } = r.rows[0];
      const amount = Math.round(Number(reservation_amount) || 0);
      if (amount > 0) {
        await client.query('UPDATE customers SET wallet_balance = wallet_balance + $1 WHERE customer_id = $2', [amount, customer_id]);
        await client.query(
          'INSERT INTO transactions (order_id, customer_id, time, amount) VALUES (0, $1, NOW(), $2)',
          [customer_id, amount]
        );
      }
    });
    return res.status(200).json({ success: true, message: 'Reservation Rejected and refunded' });
  } catch (err) {
    return sendError(res, err);
  }
};

exports.getMenuItems = async (req, res) => {
    const canteen_id = req.canteen_id;

    try {
        const response = await db.query('SELECT * FROM dishes WHERE canteen_id = $1 AND is_active = TRUE;', [canteen_id]);
        return res.status(200).json({ message: 'Menu sent', menu: response.rows });
    }
    catch (err) {
        return res.status(500).json({ message: 'Internal Server Error' });
    }

};

exports.createCoupon = async (req, res) => {
  const c = req.body;
  try {
    await db.query(
      `INSERT INTO coupons (coupon_code, canteen_id, discount_value, min_order_value, usage_limit, valid_until)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [c.code, req.canteen_id, c.value, c.min_order_value, c.usage_limit, c.valid_until]
    );
    return res.status(200).json({ message: 'Coupon Created Successfully' });
  } catch (err) {
    // UNIQUE(coupon_code) decides, so two managers creating the same code at once can't both win.
    if (err.code === '23505') return res.status(409).json({ message: 'Coupon Code Already Exists' });
    return sendError(res, err);
  }
};

exports.createDiscounts = async (req, res) => {
  try {
    const { discount_amount, menu_items } = req.body;
    const pct = Number(discount_amount);
    if (!Number.isInteger(pct) || pct < 0 || pct > 100 || !Array.isArray(menu_items)) {
      throw new HttpError(400, 'discount_amount (0-100) and menu_items[] are required');
    }
    await db.query(
      'UPDATE dishes SET discount = $1 WHERE dish_id = ANY($2::int[]) AND canteen_id = $3',
      [pct, menu_items, req.canteen_id]
    );
    await invalidateMenu(req.canteen_id);
    return res.status(200).json({ message: 'Discounts Updated Successfully' });
  } catch (err) {
    return sendError(res, err);
  }
};

exports.getActiveDiscounts = async (req, res) => {
    const canteen_id = req.canteen_id;

    try {
        const response = await db.query(`SELECT * FROM dishes WHERE canteen_id = $1 AND discount > 0 AND is_active = TRUE;`, [canteen_id]);
        // console.log(response.rows.length);
        // console.log("sdgsgs")
        // console.log(canteen_id)
        // console.log(req);
        return res.status(200).json({ message: 'Active Discounts Sent', discounts: response.rows});

    }
    catch (err) {
        return res.status(500).json({ message: 'Internal Server Error' });
    }
};

exports.getActiveCoupons = async (req, res) => {
    const canteen_id = req.canteen_id;

    try {
        const response = await db.query(`
            SELECT
            coupon_id AS id,
            coupon_code AS code,
            discount_value AS value,
            min_order_value,
            usage_limit,
            valid_until
            FROM coupons WHERE canteen_id = $1
            AND valid_until > NOW()::DATE 
            AND usage_limit > 0;
            `, [canteen_id]);
        return res.status(200).json({ message: 'Active Coupons Sent', coupons: response.rows });
    }
    catch (err) {
        return res.status(500).json({ message: 'Internal Server Error' });
    }
};

exports.deleteCoupon = async (req, res) => {
  try {
    await db.query('UPDATE coupons SET usage_limit = 0 WHERE coupon_id = $1 AND canteen_id = $2', [
      req.body.couponId,
      req.canteen_id,
    ]);
    return res.status(200).json({ message: 'Coupon Deleted' });
  } catch (err) {
    return sendError(res, err);
  }
};

exports.deleteDiscount = async (req, res) => {
  try {
    await db.query('UPDATE dishes SET discount = 0 WHERE dish_id = $1 AND canteen_id = $2', [
      req.body.dishId,
      req.canteen_id,
    ]);
    await invalidateMenu(req.canteen_id);
    return res.status(200).json({ message: 'Discount Deleted' });
  } catch (err) {
    return sendError(res, err);
  }
};

exports.getTrendingPicks = async (req, res) => {
    const canteen_id = req.canteen_id;
    try {
        const response = await db.query(`
            SELECT d.dish_name, t.dish_id, t.total_quantity, d.img_url
            FROM (
    SELECT key AS dish_id, SUM(value::int) AS total_quantity
    FROM orders, jsonb_each_text(dish_map)
    WHERE canteen_id = $1
      AND time >= NOW() - INTERVAL '7 days'
    GROUP BY key
    ORDER BY total_quantity DESC
    LIMIT 5
) AS t
JOIN dishes d ON d.dish_id = t.dish_id::int
WHERE d.is_active = TRUE;
            `, [canteen_id]);

        return res.status(200).json({ message: 'Trending Picks Sent', trending_picks: response.rows });
    }
    catch (err) {
        return res.status(500).json({ message: 'Internal Server Error' });
    }
};

exports.getHomeOrderQueue = async (req, res) => {
    const canteen_id = req.canteen_id;
    try {
        const response = await db.query(`
        SELECT
          SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END) AS total_status_1_orders,
          SUM(CASE WHEN status = 2 THEN 1 ELSE 0 END) AS total_status_2_orders,
          SUM(CASE WHEN status = 3 THEN 1 ELSE 0 END) AS total_status_3_orders
        FROM orders
        WHERE canteen_id = $1
          AND time >= NOW() - INTERVAL '24 hours';
      `, [canteen_id]);

        const row = response.rows[0];
        const status1 = Number(row.total_status_1_orders) || 0;
        const status2 = Number(row.total_status_2_orders) || 0;
        const status3 = Number(row.total_status_3_orders) || 0;

        const ordersInQueue = status1 + status2 + status3;

        return res.status(200).json({
            message: 'Order Queue Data Sent',
            orders_in_queue: ordersInQueue,
            pending_orders: status1
        });

    } catch (err) {
        // console.error(err); // log the actual error for debugging
        return res.status(500).json({ message: 'Internal Server Error' });
    }
};

exports.getHomeReservationQueue = async (req, res) => {
    const canteen_id = req.canteen_id;
    try {
        const response = await db.query(`
        SELECT
          SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END) AS total_status_1_reservations,
          SUM(CASE WHEN status = 2 THEN 1 ELSE 0 END) AS total_status_2_reservations,
          SUM(CASE WHEN status = 3 THEN 1 ELSE 0 END) AS total_status_3_reservations
        FROM reservations
        WHERE canteen_id = $1
          AND request_time >= NOW() - INTERVAL '7 days';
      `, [canteen_id]);

        const row = response.rows[0];
        const status1 = Number(row.total_status_1_reservations) || 0;
        const status2 = Number(row.total_status_2_reservations) || 0;
        const status3 = Number(row.total_status_3_reservations) || 0;

        const PendingReservations = status1 + status2;

        return res.status(200).json({
            message: 'Reservation Queue Data Sent',
            confirmed_reservations: status3,
            pending_reservations: PendingReservations
        });

    } catch (err) {
        // console.error(err); // log the actual error for debugging
        return res.status(500).json({ message: 'Internal Server Error' });
    }
};


exports.getHomeDiscountNCoupons = async (req, res) => {
    const canteen_id = req.canteen_id;
    try {
        const response_1 = await db.query(`
        SELECT COUNT(*) AS active_coupons
        FROM coupons
        WHERE canteen_id = $1 AND usage_limit >0 AND valid_until > NOW();`, [canteen_id]);

        const response_2 = await db.query(`
        SELECT COUNT(*) AS active_discounts
        FROM dishes
        WHERE canteen_id = $1 AND discount > 0;`, [canteen_id]);

        return res.status(200).json({
            message: 'Active Discount and Coupon Data Sent',
            active_discounts: response_2.rows[0].active_discounts,
            active_coupons: response_1.rows[0].active_coupons
        });

    } catch (err) {
        // console.error(err); // log the actual error for debugging
        return res.status(500).json({ message: 'Internal Server Error' });
    }
};



exports.getProfileInfo = async (req, res) => {
    const canteen_id = req.canteen_id;
    try {
        const response = await db.query(`
            SELECT 
            username, 
            name,
            phone_number, 
            img_url, 
            email, 
            date_formed, 
            opening_time, 
            closing_time, 
            auto_accept, 
            rating,
            address,
            opening_status
            FROM canteens
            WHERE canteen_id = $1;`, [canteen_id]);
            const object = response.rows[0];
            object.role = "Canteen Manager";
        return res.status(200).json({ message: 'Profile Information Sent', profile: object });
    }
    catch (err) {
        return res.status(500).json({ message: 'Internal Server Error' });
    }
};

exports.editProfileInfo = async (req, res) => {
  const c = req.body;
  try {
    await db.query(
      `UPDATE canteens
          SET name = $2, opening_time = $3, closing_time = $4, opening_status = $5,
              auto_accept = $6, address = $7, img_url = $8, delivery_available = $9
        WHERE canteen_id = $1`,
      [req.canteen_id, c.name, c.opening_time, c.closing_time, c.opening_status, c.auto_accept, c.address, c.img_url, c.delivery_available]
    );
    await cache.invalidate(cache.keys.canteens(), cache.keys.dishes(), cache.keys.top5());

    if (c.username) {
      try {
        await db.query('UPDATE canteens SET username = $2 WHERE canteen_id = $1', [req.canteen_id, c.username]);
      } catch (e) {
        if (e.code === '23505') return res.status(201).json({ message: 'Username already exists. Other changes updated' });
        throw e;
      }
    }
    return res.status(200).json({ message: 'Profile Information Sent' });
  } catch (err) {
    return sendError(res, err);
  }
};

exports.editPassword = async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password || String(new_password).length < 8) {
      throw new HttpError(400, 'Current password and a new password of 8+ characters are required');
    }
    const r = await db.query('SELECT password FROM canteens WHERE canteen_id = $1', [req.canteen_id]);
    if (!r.rows[0] || !(await password.verify(current_password, r.rows[0].password))) {
      return res.status(409).json({ message: 'Old password does not match. Password is not updated' });
    }
    await db.query('UPDATE canteens SET password = $2 WHERE canteen_id = $1', [req.canteen_id, await password.hash(new_password)]);
    return res.status(200).json({ message: 'Password Edited Successfully' });
  } catch (err) {
    return sendError(res, err);
  }
};

exports.editDish = async (req, res) => {
  const d = req.body;
  try {
    const { rowCount } = await db.query(
      `UPDATE dishes SET price = $1, is_veg = $2, dish_name = $3, dish_tag = $4, img_url = $5, dish_category = $6
        WHERE dish_id = $7 AND canteen_id = $8`,
      [d.price, d.is_veg, d.dish_name, d.dish_tag, d.img_url, d.dish_category, d.dish_id, req.canteen_id]
    );
    if (rowCount === 0) throw new HttpError(404, 'Dish not found');
    if ('stock' in d) {
      const st = parseStock(d.stock);
      if (!st.ok) throw new HttpError(400, 'stock must be empty (unlimited) or a whole number >= 0');
      await db.query('UPDATE dishes SET stock = $1 WHERE dish_id = $2 AND canteen_id = $3', [st.value, d.dish_id, req.canteen_id]);
    }
    await invalidateMenu(req.canteen_id); // DB first, then delete the cache key
    return res.status(200).json({ message: 'Dish Details Edited Successfully' });
  } catch (err) {
    return sendError(res, err);
  }
};

exports.addDish = async (req, res) => {
  const d = req.body;
  try {
    const st = parseStock(d.stock);
    if (!st.ok) throw new HttpError(400, 'stock must be empty (unlimited) or a whole number >= 0');
    await db.withTransaction(async (client) => {
      const r = await client.query(
        `INSERT INTO dishes (canteen_id, price, discount, rating, order_count, is_veg, dish_name, dish_tag, img_url, dish_category, stock)
         VALUES ($1, $2, $3, 0, 0, $4, $5, $6, $7, $8, $9) RETURNING dish_id`,
        [req.canteen_id, d.price, d.discount || 0, d.is_veg, d.name, d.dish_tag, d.img_url, d.dish_category, st.value]
      );
      await client.query('UPDATE canteens SET menu = array_append(menu, $2) WHERE canteen_id = $1', [req.canteen_id, r.rows[0].dish_id]);
    });
    await invalidateMenu(req.canteen_id);
    return res.status(200).json({ message: 'Dish Added Successfully' });
  } catch (err) {
    return sendError(res, err);
  }
};

// POST /canteen/update-stock  { dish_id, stock }  (stock: null = unlimited)
// Sets the absolute count, e.g. "we made 40 samosas". Payments decrement it
// atomically; this just overwrites it for the canteen's own dish.
exports.updateStock = async (req, res) => {
  try {
    const dishId = toId(req.body.dish_id);
    const st = parseStock(req.body.stock);
    if (!dishId || !st.ok) throw new HttpError(400, 'dish_id and stock (empty or a whole number >= 0) are required');
    const r = await db.query(
      'UPDATE dishes SET stock = $1 WHERE dish_id = $2 AND canteen_id = $3 RETURNING dish_id, stock',
      [st.value, dishId, req.canteen_id]
    );
    if (r.rowCount === 0) throw new HttpError(404, 'Dish not found');
    await invalidateMenu(req.canteen_id);
    return res.status(200).json({ success: true, message: 'Stock updated', ...r.rows[0] });
  } catch (err) {
    return sendError(res, err);
  }
};

// Soft delete: old orders still reference the dish.
exports.deleteDish = async (req, res) => {
  try {
    const { rowCount } = await db.query('UPDATE dishes SET is_active = false WHERE dish_id = $1 AND canteen_id = $2', [
      req.body.dish_id,
      req.canteen_id,
    ]);
    if (rowCount === 0) throw new HttpError(404, 'Dish not found');
    await invalidateMenu(req.canteen_id);
    return res.status(200).json({ message: 'Dish Deleted Successfully' });
  } catch (err) {
    return sendError(res, err);
  }
};

exports.getStatistics = async(req,res) => {
    const canteen_id = req.canteen_id;

    try{
        const response_1 = await db.query(`
            SELECT 
            COALESCE(SUM(final_amount), 0) AS total_sales,
            COUNT(*) AS total_orders,
            COALESCE(AVG(final_amount), 0) AS avg_order_value,
            COUNT(DISTINCT customer_id) AS total_customers
            FROM orders
            WHERE time >= NOW() - INTERVAL '30 days'
            AND canteen_id = $1
            AND status = '4';`,[canteen_id]);

        const response_2 = await db.query(`
            SELECT 
            COALESCE(SUM(final_amount), 0) AS total_sales,
            COUNT(*) AS total_orders,
            COALESCE(AVG(final_amount), 0) AS avg_order_value,
            COUNT(DISTINCT customer_id) AS total_customers
            FROM orders
            WHERE time >= NOW() - INTERVAL '60 days'
            AND time < NOW() - INTERVAL '30 days'
            AND canteen_id = $1
            AND status = '4';`,[canteen_id]);

        const row_1 = response_1.rows[0];
        const row_2 = response_2.rows[0];

        const delta = {
            sales : row_1.total_sales -  row_2.total_sales,
            orders : row_1.total_orders - row_2.total_orders,
            avg_order_value : row_1.avg_order_value - row_2.avg_order_value,
            customers : row_1.total_customers - row_2.total_customers
        };

        return res.status(200).json({message:'Statistics Sent', curr_month:row_1, delta:delta});

    }
    catch(err){
        return res.status(500).json({ message: 'Internal Server Error' });

    }
}

exports.getGraphs = async(req,res) => {
    const canteen_id = req.canteen_id;
    try{
        const [response_1, response_2] = await Promise.all([
            db.query(`
                WITH day_intervals AS (
                SELECT 
                generate_series(
                NOW() - INTERVAL '29 days', 
                NOW(), 
                INTERVAL '1 day'
                )::DATE AS order_date)
                SELECT 
                di.order_date,
                COALESCE(SUM(o.final_amount), 0) AS total_sales,
                COUNT(o.order_id) AS total_orders,
                COALESCE(AVG(o.final_amount), 0) AS avg_order_value,
                COUNT(DISTINCT o.customer_id) AS total_customers
                FROM day_intervals di
                LEFT JOIN orders o 
                ON DATE(o.time) = di.order_date
                AND o.canteen_id = $1
                AND o.status = '4'
                GROUP BY di.order_date
                ORDER BY di.order_date;`,[canteen_id]),
            db.query(`
                WITH month_intervals AS (
                SELECT 
                generate_series(1, 12) AS month_num, 
                NOW() - INTERVAL '30 days' * generate_series(1, 12) AS start_date, 
                NOW() - INTERVAL '30 days' * (generate_series(1, 12) - 1) AS end_date)
                SELECT 
                mi.month_num,
                COALESCE(SUM(o.final_amount), 0) AS total_sales,
                COUNT(o.order_id) AS total_orders
                FROM month_intervals mi
                LEFT JOIN orders o 
                ON o.time >= mi.start_date 
                AND o.time < mi.end_date
                AND o.canteen_id = $1
                AND o.status = '4'
                GROUP BY mi.month_num
                ORDER BY mi.month_num;`,[canteen_id])]);
                // console.log('back:', response_1.monthly);
    return res.status(200).json({message:'Graph Data Sent',monthly:response_1.rows, yearly:response_2.rows});
    }
    catch(err){
        return res.status(500).json({ message: 'Internal Server Error' });
    }

};