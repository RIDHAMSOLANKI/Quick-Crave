// Background job handlers. The same functions run in two places:
//  * worker.js (BullMQ worker) when REDIS_URL is set - the normal setup;
//  * in-process (lib/queue.js fallback) when there is no Redis.
//
// Every handler is IDEMPOTENT, because queues deliver at-least-once: a job may
// run twice after a crash or a retry, and running it twice must be harmless.

const db = require('../db');
const { sendMail } = require('./mailer');
const STATUS = require('./orderStatus');

const handlers = {
  // Notification emails. Sending the same notice twice is acceptable.
  async 'send-email'({ to, subject, text }) {
    await sendMail({ to, subject, text });
  },

  // Fired ~5 minutes after an order was requested. Guarded update: it only
  // cancels if the order is STILL requested AND it is still the same request
  // (request_seq). If the canteen accepted or rejected first, or the customer
  // re-requested, this changes 0 rows and does nothing.
  async 'auto-cancel-order'({ orderId, seq }) {
    const { rowCount } = await db.query(
      `UPDATE orders
          SET status = $1, status_note = 'timeout'
        WHERE order_id = $2 AND status = $3 AND request_seq = $4`,
      [STATUS.CART, orderId, STATUS.REQUESTED, seq]
    );
    return { cancelled: rowCount === 1 };
  },
};

async function runJob(name, data) {
  const handler = handlers[name];
  if (!handler) throw new Error(`Unknown job: ${name}`);
  return handler(data);
}

module.exports = { runJob, handlers };
