-- Quick-Crave base schema.
-- Run this first, then 002_hardening.sql.
--   psql -d quickcrave -f database/001_schema.sql
--   psql -d quickcrave -f database/002_hardening.sql

CREATE EXTENSION IF NOT EXISTS pg_trgm;        -- fuzzy dish search (% operator)
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;  -- levenshtein() in dish search

CREATE TABLE IF NOT EXISTS canteens (
  canteen_id         SERIAL PRIMARY KEY,
  username           VARCHAR(20),
  name               VARCHAR(30),
  password           VARCHAR(60),
  opening_time       TIME,
  closing_time       TIME,
  opening_status     BOOLEAN,
  menu               INTEGER[] DEFAULT '{}',
  auto_accept        BOOLEAN DEFAULT FALSE,
  order_queue        INTEGER[],
  reservation_queue  INTEGER[],
  tables             INTEGER[],
  rating             REAL,
  active             BOOLEAN,
  date_formed        DATE,
  email              VARCHAR(100),
  phone_number       VARCHAR(10),
  img_url            VARCHAR(500),
  favourites_list    INTEGER[],
  address            VARCHAR(100),
  earnings           INTEGER DEFAULT 0,
  delivery_available BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS customers (
  customer_id    SERIAL PRIMARY KEY,
  username       VARCHAR(20),
  password       VARCHAR(60),
  name           VARCHAR(30),
  phone_number   VARCHAR(10),
  email          VARCHAR(100),
  wallet_balance INTEGER DEFAULT 0,
  cart_id        INTEGER DEFAULT 0,
  favourites     INTEGER[] DEFAULT '{}',
  img_url        VARCHAR(500),
  address        VARCHAR(200)
);

CREATE TABLE IF NOT EXISTS dishes (
  dish_id       SERIAL PRIMARY KEY,
  canteen_id    INTEGER,
  price         REAL,
  discount      INTEGER DEFAULT 0,
  rating        REAL,
  order_count   INTEGER DEFAULT 0,
  dish_name     VARCHAR(60),
  dish_tag      VARCHAR(30),
  is_veg        BOOLEAN,
  img_url       VARCHAR(500),
  dish_category VARCHAR(20),
  is_active     BOOLEAN DEFAULT TRUE,
  is_available  BOOLEAN DEFAULT TRUE
);

-- A cart is an order row with status 0. See backend lib/orderStatus.js.
CREATE TABLE IF NOT EXISTS orders (
  order_id         SERIAL PRIMARY KEY,
  customer_id      INTEGER,
  canteen_id       INTEGER,
  status           INTEGER,
  payment_id       VARCHAR(100),
  coupon_id        INTEGER,
  bill_amount      REAL,
  discount_amount  REAL,
  final_amount     REAL,
  time             TIMESTAMP,
  is_delivery      BOOLEAN,
  dish_map         JSONB,
  delivery_address VARCHAR(50)
);

CREATE TABLE IF NOT EXISTS reservations (
  reservation_id     SERIAL PRIMARY KEY,
  customer_id        INTEGER,
  canteen_id         INTEGER,
  request_time       TIMESTAMP,
  reservation_time   TIMESTAMP,
  num_people         INTEGER,
  status             INTEGER,
  reservation_amount REAL,
  additional_request VARCHAR(100),
  payment_id         VARCHAR(100)
);

-- Wallet ledger: positive = money in, negative = money out.
CREATE TABLE IF NOT EXISTS transactions (
  transaction_id SERIAL PRIMARY KEY,
  order_id       INTEGER,
  customer_id    INTEGER,
  time           TIMESTAMP,
  amount         REAL
);

CREATE TABLE IF NOT EXISTS coupons (
  coupon_id       SERIAL PRIMARY KEY,
  coupon_code     VARCHAR(20),
  canteen_id      INTEGER,
  discount_value  REAL,
  min_order_value REAL,
  usage_limit     INTEGER,
  valid_until     DATE
);

CREATE TABLE IF NOT EXISTS comments (
  comment_id  SERIAL PRIMARY KEY,
  customer_id INTEGER,
  dish_id     INTEGER,
  comment     VARCHAR(300)
);
