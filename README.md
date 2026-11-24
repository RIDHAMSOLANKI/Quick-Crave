# Quick-Crave: Canteen Ordering System

Students order food from campus canteens and pay from a digital wallet.
Canteen managers accept orders, run their menu and handle table bookings.

The backend is built to stay correct when many requests overlap: two devices
paying at once, double clicks, webhook retries, a canteen clicking "accept"
at the same moment the order times out.

**Stack:** React · Node.js / Express · PostgreSQL · Redis (cache-aside + BullMQ job queue) · Razorpay

---

## Architecture

```
 Student (React, :3000)                    Canteen manager (React, :3001)
        │  JWT in httpOnly cookie                    │
        ▼                                            ▼
 Customer API (Express, :4000)              Canteen API (Express, :4001)
   /auth/*  /customer/*                       /auth/*  /canteen/*
   /razorpay-webhook  (HMAC verified)               │
        │        │        │                         │
        │        │        └──────────┐   ┌──────────┘
        │        ▼                   ▼   ▼
        │   Redis cache  ◄────── PostgreSQL (single source of truth)
        │   (menus, lists)             ▲
        │        │                     │
        │   BullMQ queue ──► worker.js ┘  (emails, auto-cancel unanswered orders)
        ▼
    Razorpay ── payment.captured webhook ──► wallet credit (exactly once)
```

### Order life cycle

```
CART(0) ──request──► REQUESTED(1) ──accept──► ACCEPTED(2) ──pay──► PAID(3) ──ready──► READY(4)
                         │
                         └── reject / 5-min timeout ──► back to CART(0)  (status_note = rejected | timeout)
```

A cart is just an order row with status 0, and items live in a JSONB map
`{dish_id: quantity}`. Every status change is a **guarded update**
(`UPDATE ... SET status = new WHERE status = old`), so when two actors race,
exactly one wins and the other gets `409 Conflict`.

---

## Concurrency control: what can race, and how it's handled

| Race | What would go wrong | Fix |
|---|---|---|
| Two "pay" requests (two devices / double click) | Both see the same balance → charged twice, wallet negative | Transaction on one connection + `SELECT … FOR UPDATE` on the customer row + check-and-debit in one statement (`WHERE wallet_balance >= amount`) + `CHECK (wallet_balance >= 0)` |
| Two "first add to cart" requests | Two carts created, one item lost | Customer row lock + partial unique index `orders(customer_id) WHERE status = 0` |
| Two "+1" on the same dish | Lost update (3 taps → 2 items) | Atomic JSONB update inside SQL, never read-modify-write in JS |
| Cart edited while paying | Pay old total, get extra food | Order row locked during payment; cart edits only apply `WHERE status = 0` |
| Canteen accepts while the timeout fires / two staff click | Last write wins, kitchen and customer disagree | Guarded status transitions → one winner, the other gets 409 |
| Old timeout timer fires after the customer re-requested | New request cancelled by a stale timer | `request_seq` column; the job only cancels the request it was scheduled for |
| Razorpay delivers the webhook twice | Wallet credited twice | Idempotency key: `payments.razorpay_payment_id UNIQUE` inserted in the same transaction as the credit |
| Two table bookings with low balance | Wallet overdrawn, unpaid booking left behind | Debit first with a conditional update, then insert, in one transaction |
| Reservation rejected twice | Refunded twice | Guarded update + refund in the same transaction |
| Two sign-ups with the same username | Duplicate accounts | `UNIQUE` indexes; error `23505` → "already taken" |
| Deadlocks | Two flows wait on each other forever | Fixed lock order (customer → order → canteen) + automatic retry on `40P01` / `40001` |

All of these are covered by tests that fire many identical requests **at the
same instant** against a real PostgreSQL and then check the invariants
(see `tests/concurrency.test.js`).

---

## Caching (Redis, cache-aside)

- **Cached:** canteen list, all dishes, each canteen's menu, top-5 dishes.
- **Never cached:** wallet, cart, order status (anything that decides money).
- **Read:** Redis → on a miss, Postgres → store with TTL (+ random jitter so keys don't all expire together).
- **Write:** the canteen API updates Postgres **first, then deletes** the key; the next read refills it.
- **Stampede protection:** single-flight. On a miss only one request rebuilds the key (in-process promise sharing plus a short Redis `SET NX` lock across servers).
- **Fail-open:** if Redis is down, reads go straight to Postgres.

## Background jobs (BullMQ)

- `send-email`: OTP and order notifications, 5 attempts with exponential backoff.
- `auto-cancel-order`: delayed job, 5 minutes after an order is requested.
- Jobs are enqueued **after** the transaction commits, and every handler is idempotent (queues deliver at-least-once).
- Without `REDIS_URL`, the same handlers run in-process, so local development needs no Redis.

## Security

- Sign-up OTP generated with `crypto.randomInt`, stored **hashed on the server** with a 10-minute expiry and a 5-attempt limit. The browser never sees the code or its hash.
- Passwords: bcrypt with a per-password salt. Old fixed-salt hashes still verify and are upgraded on login.
- JWT in an **httpOnly** cookie, `SameSite=Lax`, `Secure` in production. Secrets come only from the environment, and the app refuses to start without them.
- Role checks: customer tokens can't call canteen APIs and vice versa.
- Ownership checks: every canteen query filters by the canteen id from the token, so there's no editing another canteen's dishes or orders.
- Razorpay webhook: HMAC-SHA256 over the raw body, compared with `crypto.timingSafeEqual`. The browser can no longer credit the wallet.
- Rate limiting on login, sign-up and OTP verification. Parameterized SQL everywhere.

## Indexes

See `database/002_hardening.sql`: `orders(canteen_id, time)`, `orders(customer_id, time)`,
`dishes(canteen_id) WHERE is_active`, `dishes(order_count) WHERE is_active`,
`transactions(customer_id, time)`, reservation indexes, and a trigram index for dish search.

---

## Running it

### 1. Database

```bash
createdb quickcrave
psql -d quickcrave -f database/001_schema.sql
psql -d quickcrave -f database/002_hardening.sql
```

### 2. Backends

```bash
cd Customer_Site/backend && cp .env.example .env   # fill in the values
npm install && npm start                            # http://localhost:4000

cd Canteen_Site/backend && cp .env.example .env
npm install && npm start                            # http://localhost:4001
```

Optional, with Redis running (`REDIS_URL` set in both `.env` files):

```bash
cd Customer_Site/backend && npm run worker
```

### 3. Frontends

```bash
cd Customer_Site/frontend && npm install && npm start   # :3000
cd Canteen_Site/frontend  && npm install && npm start   # :3001
```

### 4. Razorpay wallet top-ups

1. In the Razorpay dashboard (Test mode), create a **Payment Button** with a
   customer-chosen amount and the input fields `username`, `email` and `phone`.
2. Expose the backend for webhooks during development: `ngrok http 4000`.
3. Under **Developers → Webhooks**, add `<ngrok-url>/razorpay-webhook`, choose a
   secret, and enable `payment.captured`.
4. Put the same secret in `RAZORPAY_WEBHOOK_SECRET` in `Customer_Site/backend/.env`.

### 5. Tests

The tests start a throwaway PostgreSQL automatically (no install needed):

```bash
cd Customer_Site/backend && npm install
cd ../../Canteen_Site/backend && npm install
cd ../../tests && npm install && npm test
```

---

## Known limits / next steps

- Payment buttons identify the customer by the username, email and phone typed
  into Razorpay's form. A server-created Razorpay Order tied to the logged-in
  user would be stronger.
- The queue path (BullMQ + worker) runs only when Redis is configured. The tests
  cover the in-process path and the cache logic with an in-memory Redis.
- Polling for order status could become WebSocket/SSE push.
- Jobs are enqueued after commit. A transactional outbox would also cover a
  crash between the commit and the enqueue.

Original project documents (SRS, design, test plan, user manual) are in `docs/`.
