// Customer sign-up (email OTP) and login.
//
// Sign-up flow (the OTP never leaves the server):
//   POST /auth/signup      -> validate, store {details, hashed password, hashed OTP, expiry}
//                             in signup_otps, email the 6-digit code
//   POST /auth/verify-otp  -> check the code server-side (5 attempts, 10-min expiry),
//                             then create the customer inside a transaction
//   POST /auth/login       -> bcrypt check, JWT in an httpOnly cookie

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../db');
const password = require('../lib/password');
const { enqueue } = require('../lib/queue');
const { jwtSecret, authCookieOptions } = require('../lib/config');
const { HttpError, sendError } = require('../lib/httpError');

const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const JWT_EXPIRES_IN = '1h';

const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const isPhone = (s) => typeof s === 'string' && /^\d{10}$/.test(s);
const isUsername = (s) => typeof s === 'string' && /^[A-Za-z0-9_.]{3,20}$/.test(s);

// Which unique field is already taken? (Friendly message; the UNIQUE indexes
// in the database are what actually guarantee no duplicates.)
async function findTakenField(q, { username, email, phone }) {
  const { rows } = await q.query(
    `SELECT
       bool_or(username = $1)            AS username,
       bool_or(lower(email) = lower($2)) AS email,
       bool_or(phone_number = $3)        AS phone
     FROM customers
     WHERE username = $1 OR lower(email) = lower($2) OR phone_number = $3`,
    [username, email, phone]
  );
  const r = rows[0] || {};
  if (r.username) return 'Username';
  if (r.email) return 'Email';
  if (r.phone) return 'Phone number';
  return null;
}

exports.signup = async (req, res) => {
  try {
    const { userType, name, username, phone, email, address = '' } = req.body;
    const plain = req.body.password;

    if (userType !== 'customer') throw new HttpError(400, 'Invalid user type');
    if (!name || !username || !phone || !email || !plain) throw new HttpError(400, 'Missing required fields');
    if (plain !== req.body.confirmPassword) throw new HttpError(400, 'Passwords do not match');
    if (!isUsername(username)) throw new HttpError(400, 'Username must be 3-20 letters, digits, _ or .');
    if (!isEmail(email)) throw new HttpError(400, 'Invalid email');
    if (!isPhone(phone)) throw new HttpError(400, 'Phone number must be 10 digits');
    if (plain.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');

    const taken = await findTakenField(db, { username, email, phone });
    if (taken) throw new HttpError(409, `${taken} already taken`);

    const otp = crypto.randomInt(100000, 1000000).toString(); // cryptographically random
    const payload = { name, username, phone, address, password_hash: await password.hash(plain) };

    // One pending sign-up per email; asking again replaces the old code.
    await db.query(
      `INSERT INTO signup_otps (email, payload, otp_hash, attempts, expires_at)
       VALUES (lower($1), $2, $3, 0, NOW() + make_interval(mins => $4))
       ON CONFLICT (email) DO UPDATE
         SET payload = EXCLUDED.payload, otp_hash = EXCLUDED.otp_hash,
             attempts = 0, expires_at = EXCLUDED.expires_at`,
      [email, payload, await bcrypt.hash(otp, 10), OTP_TTL_MINUTES]
    );

    await enqueue('send-email', {
      to: email,
      subject: 'QuickCrave sign-up code',
      text: `Your QuickCrave sign-up code is ${otp}. It expires in ${OTP_TTL_MINUTES} minutes.`,
    });

    const body = { success: true, message: 'OTP sent. Proceed to OTP verification.' };
    if (process.env.NODE_ENV === 'test') body.devOtp = otp; // lets automated tests finish the flow
    return res.status(200).json(body);
  } catch (err) {
    return sendError(res, err);
  }
};

exports.verifyOtp = async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!isEmail(email) || typeof otp !== 'string' || !/^\d{6}$/.test(otp)) {
      throw new HttpError(400, 'Email and a 6-digit OTP are required');
    }

    const outcome = await db.withTransaction(async (client) => {
      // Lock the pending row so two verify requests for the same email are
      // processed one after the other (attempt counting stays exact).
      const { rows } = await client.query(
        `SELECT payload, otp_hash, attempts, expires_at < NOW() AS expired
           FROM signup_otps WHERE email = lower($1) FOR UPDATE`,
        [email]
      );
      if (rows.length === 0) throw new HttpError(404, 'No pending sign-up for this email. Please sign up again.');
      const p = rows[0];

      if (p.expired) {
        throw new HttpError(410, 'OTP expired. Please sign up again.');
      }
      if (p.attempts >= OTP_MAX_ATTEMPTS) {
        throw new HttpError(429, 'Too many wrong attempts. Please sign up again.');
      }

      if (!(await bcrypt.compare(otp, p.otp_hash))) {
        // Throwing would roll back the attempt counter, so return a marker and
        // let the transaction COMMIT the incremented count.
        await client.query('UPDATE signup_otps SET attempts = attempts + 1 WHERE email = lower($1)', [email]);
        return { wrong: true, attemptsLeft: OTP_MAX_ATTEMPTS - p.attempts - 1 };
      }

      const { name, username, phone, address, password_hash } = p.payload;
      try {
        await client.query(
          `INSERT INTO customers (username, password, name, phone_number, email, wallet_balance, cart_id, address)
           VALUES ($1, $2, $3, $4, lower($5), 0, 0, $6)`,
          [username, password_hash, name, phone, email, address]
        );
      } catch (e) {
        // Someone took the username/phone between sign-up and verify.
        if (e.code === '23505') throw new HttpError(409, 'Username, email or phone already taken');
        throw e;
      }
      await client.query('DELETE FROM signup_otps WHERE email = lower($1)', [email]);
      return { created: true };
    });

    if (outcome.wrong) {
      return res.status(401).json({
        success: false,
        message: `Incorrect OTP. Attempts left: ${outcome.attemptsLeft}`,
        attemptsLeft: outcome.attemptsLeft,
      });
    }
    return res.status(201).json({ success: true, message: 'Account created' });
  } catch (err) {
    return sendError(res, err);
  }
};

exports.login = async (req, res) => {
  try {
    const { userType, username } = req.body;
    const plain = req.body.password;
    if (!userType || !username || !plain) throw new HttpError(400, 'Missing required fields');
    if (userType !== 'customer') throw new HttpError(400, 'Invalid user type');

    const { rows } = await db.query(
      `SELECT customer_id, password, name, email, phone_number, wallet_balance, img_url, address
         FROM customers WHERE username = $1`,
      [username]
    );
    const user = rows[0];
    // Same message for "no such user" and "wrong password": don't reveal which usernames exist.
    if (!user || !(await password.verify(plain, user.password))) {
      throw new HttpError(401, 'Invalid username or password');
    }

    // Upgrade old fixed-salt hashes to a per-user salt on the fly.
    if (password.isLegacy(user.password)) {
      await db.query('UPDATE customers SET password = $1 WHERE customer_id = $2', [
        await password.hash(plain),
        user.customer_id,
      ]);
    }

    const token = jwt.sign({ user_id: user.customer_id, userType: 'customer' }, jwtSecret(), {
      expiresIn: JWT_EXPIRES_IN,
      algorithm: 'HS256',
    });
    res.cookie('token', token, authCookieOptions);

    return res.status(200).json({
      message: 'Login Successful',
      name: user.name,
      email: user.email,
      phone_number: user.phone_number,
      wallet_balance: user.wallet_balance,
      img_url: user.img_url,
      address: user.address,
    });
  } catch (err) {
    return sendError(res, err);
  }
};

exports.logout = (req, res) => {
  const { maxAge, ...opts } = authCookieOptions;
  res.clearCookie('token', opts);
  return res.status(200).json({ success: true });
};
