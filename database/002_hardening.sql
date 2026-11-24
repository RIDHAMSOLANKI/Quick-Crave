-- Quick-Crave hardening: constraints, idempotency tables and indexes.
-- Safe to run more than once.
--
-- Rule of thumb used here: the application checks things to give friendly
-- error messages, but the DATABASE is what guarantees correctness, because
-- two requests can always slip between an application-level check and a write.

------------------------------------------------------------------------------
-- 1. Money can never go negative (last line of defence against races).
------------------------------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE customers ADD CONSTRAINT wallet_non_negative CHECK (wallet_balance >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

------------------------------------------------------------------------------
-- 2. No duplicate accounts, even if two sign-ups race.
------------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS customers_username_uq ON customers (username);
CREATE UNIQUE INDEX IF NOT EXISTS customers_email_uq    ON customers (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS customers_phone_uq    ON customers (phone_number);
CREATE UNIQUE INDEX IF NOT EXISTS canteens_username_uq  ON canteens (username);
CREATE UNIQUE INDEX IF NOT EXISTS coupons_code_uq       ON coupons (coupon_code);

------------------------------------------------------------------------------
-- 3. At most one open cart (status 0) per customer.
--    Two "first add to cart" requests at the same moment can no longer
--    create two carts and lose an item.
------------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS orders_one_open_cart_uq
  ON orders (customer_id) WHERE status = 0;

------------------------------------------------------------------------------
-- 4. Order request bookkeeping.
--    request_seq: bumped on every "request order". The auto-cancel job carries
--    the seq it was scheduled for, so a timer from an OLD request can never
--    cancel a NEWER request (stale-timer race).
--    status_note: why the order went back to the cart ('rejected' / 'timeout').
------------------------------------------------------------------------------
ALTER TABLE orders ADD COLUMN IF NOT EXISTS request_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS status_note VARCHAR(20);

------------------------------------------------------------------------------
-- 5. Razorpay idempotency: one row per Razorpay payment id.
--    Webhooks are delivered at-least-once; the UNIQUE key makes a duplicate
--    delivery a no-op instead of a double credit.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  payment_id          SERIAL PRIMARY KEY,
  razorpay_payment_id VARCHAR(100) NOT NULL UNIQUE,
  customer_id         INTEGER NOT NULL REFERENCES customers(customer_id),
  amount              INTEGER NOT NULL CHECK (amount > 0),
  event               VARCHAR(50) NOT NULL,
  received_at         TIMESTAMP NOT NULL DEFAULT NOW()
);

------------------------------------------------------------------------------
-- 6. Server-side OTP for sign-up (the OTP never leaves the server).
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS signup_otps (
  email      VARCHAR(100) PRIMARY KEY,
  payload    JSONB NOT NULL,          -- name, username, phone, address, password_hash
  otp_hash   VARCHAR(100) NOT NULL,   -- bcrypt hash of the 6-digit code
  attempts   INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMP NOT NULL
);

------------------------------------------------------------------------------
-- 7. Indexes for the hot queries.
------------------------------------------------------------------------------
-- Canteen order queue / dashboard: WHERE canteen_id = $1 AND time >= now() - 24h
CREATE INDEX IF NOT EXISTS orders_canteen_time_idx   ON orders (canteen_id, time DESC);
-- Customer order history
CREATE INDEX IF NOT EXISTS orders_customer_time_idx  ON orders (customer_id, time DESC);
-- Menus: dishes of one canteen
CREATE INDEX IF NOT EXISTS dishes_canteen_active_idx ON dishes (canteen_id) WHERE is_active;
-- Top dishes on the home page
CREATE INDEX IF NOT EXISTS dishes_order_count_idx    ON dishes (order_count DESC) WHERE is_active;
-- Wallet history
CREATE INDEX IF NOT EXISTS transactions_customer_time_idx ON transactions (customer_id, time DESC);
-- Reservation queues
CREATE INDEX IF NOT EXISTS reservations_canteen_time_idx  ON reservations (canteen_id, request_time DESC);
CREATE INDEX IF NOT EXISTS reservations_customer_idx      ON reservations (customer_id);
-- Fuzzy dish search (pg_trgm)
CREATE INDEX IF NOT EXISTS dishes_name_trgm_idx ON dishes USING gin (dish_name gin_trgm_ops);
