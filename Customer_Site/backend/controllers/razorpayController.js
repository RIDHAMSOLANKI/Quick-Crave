// Razorpay webhook: the ONLY place where wallet top-ups are credited.
//
// We never trust the browser to say "payment done" (it can be faked, or the
// tab closed). Razorpay's servers call this endpoint directly, and we:
//   1. verify the HMAC-SHA256 signature over the raw body (constant-time compare),
//   2. act only on payment.captured,
//   3. credit IDEMPOTENTLY: the Razorpay payment id is inserted into `payments`
//      (UNIQUE) in the same transaction as the credit. Webhooks are delivered
//      at-least-once, so a retry or a duplicate delivery hits the UNIQUE key,
//      inserts nothing, and credits nothing.

const crypto = require('crypto');
const db = require('../db');
const { razorpayWebhookSecret } = require('../lib/config');

function signatureIsValid(rawBody, signature) {
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = crypto.createHmac('sha256', razorpayWebhookSecret()).update(rawBody).digest('hex');
  // timingSafeEqual: a normal === stops at the first different character,
  // which leaks timing information an attacker could use to guess it.
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}

exports.managePayment = async (req, res) => {
  const rawBody = req.body; // Buffer, thanks to express.raw() on this route
  if (!Buffer.isBuffer(rawBody) || !signatureIsValid(rawBody, req.headers['x-razorpay-signature'])) {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // Reply 200 to events we don't handle, so Razorpay stops retrying them.
  if (event.event !== 'payment.captured') {
    return res.status(200).json({ status: 'ignored', event: event.event });
  }

  const payment = event.payload && event.payload.payment && event.payload.payment.entity;
  if (!payment || !payment.id || !Number.isInteger(payment.amount) || payment.amount <= 0) {
    return res.status(400).json({ error: 'Malformed payment payload' });
  }
  const { email, phone, username } = payment.notes || {};
  const rupees = Math.floor(payment.amount / 100); // Razorpay amounts are in paise

  try {
    const result = await db.withTransaction(async (client) => {
      const user = await client.query(
        `SELECT customer_id FROM customers
          WHERE username = $1 AND lower(email) = lower($2) AND phone_number = $3`,
        [username, email, phone]
      );
      if (user.rows.length === 0) return { status: 'unmatched' };
      const customerId = user.rows[0].customer_id;

      // Idempotency gate: only the FIRST delivery of this payment id inserts a row.
      const ins = await client.query(
        `INSERT INTO payments (razorpay_payment_id, customer_id, amount, event)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (razorpay_payment_id) DO NOTHING
         RETURNING payment_id`,
        [payment.id, customerId, rupees, event.event]
      );
      if (ins.rowCount === 0) return { status: 'duplicate' };

      await client.query(
        'UPDATE customers SET wallet_balance = wallet_balance + $1 WHERE customer_id = $2',
        [rupees, customerId]
      );
      await client.query(
        'INSERT INTO transactions (order_id, customer_id, time, amount) VALUES (0, $1, NOW(), $2)',
        [customerId, rupees]
      );
      return { status: 'credited' };
    });

    if (result.status === 'unmatched') {
      // 200 so Razorpay doesn't retry forever; logged for manual reconciliation.
      console.error(`[razorpay] payment ${payment.id}: no customer matches the notes`);
    }
    return res.status(200).json(result);
  } catch (err) {
    console.error('[razorpay] webhook failed:', err.message);
    // 500 makes Razorpay retry later; the idempotency key keeps that safe.
    return res.status(500).json({ error: 'Internal server error' });
  }
};
