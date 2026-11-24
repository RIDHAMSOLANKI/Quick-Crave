// Canteen-manager login and sign-up request.
// (Canteen accounts are verified by hand before they go live, so sign-up only
//  validates the details and asks the manager to wait for verification.)

const jwt = require('jsonwebtoken');
const db = require('../db');
const password = require('../lib/password');
const { jwtSecret, authCookieOptions } = require('../lib/config');
const { HttpError, sendError } = require('../lib/httpError');

exports.login = async (req, res) => {
  try {
    const { userType, username } = req.body;
    const plain = req.body.password;
    if (!userType || !username || !plain) throw new HttpError(400, 'Missing required fields');
    if (userType !== 'canteen-manager') throw new HttpError(400, 'Invalid user type');

    const { rows } = await db.query(
      `SELECT address, img_url, canteen_id, password, name, opening_time, closing_time,
              opening_status, rating, phone_number, email, auto_accept
         FROM canteens WHERE username = $1`,
      [username]
    );
    const c = rows[0];
    if (!c || !(await password.verify(plain, c.password))) {
      throw new HttpError(401, 'Invalid username or password');
    }
    if (password.isLegacy(c.password)) {
      await db.query('UPDATE canteens SET password = $1 WHERE canteen_id = $2', [
        await password.hash(plain),
        c.canteen_id,
      ]);
    }

    const token = jwt.sign({ user_id: c.canteen_id, userType: 'canteen-manager' }, jwtSecret(), {
      expiresIn: '1h',
      algorithm: 'HS256',
    });
    res.cookie('token', token, authCookieOptions);

    return res.status(200).json({
      message: 'Login Successful',
      name: c.name,
      username,
      opening_time: c.opening_time,
      closing_time: c.closing_time,
      opening_status: c.opening_status,
      rating: c.rating,
      phone_number: c.phone_number,
      email: c.email,
      auto_accept: c.auto_accept,
      address: c.address,
      img_url: c.img_url,
    });
  } catch (err) {
    return sendError(res, err);
  }
};

exports.signup = async (req, res) => {
  try {
    const { userType, name, username, phone, email } = req.body;
    const plain = req.body.password;
    if (userType !== 'canteen-manager') {
      throw new HttpError(400, 'Customers sign up on the customer app');
    }
    if (!name || !username || !phone || !email || !plain) throw new HttpError(400, 'Missing required fields');
    if (plain !== req.body.confirmPassword) throw new HttpError(400, 'Passwords do not match');

    const { rows } = await db.query(
      `SELECT bool_or(username = $1) AS username, bool_or(lower(email) = lower($2)) AS email,
              bool_or(phone_number = $3) AS phone
         FROM canteens WHERE username = $1 OR lower(email) = lower($2) OR phone_number = $3`,
      [username, email, phone]
    );
    const t = rows[0] || {};
    if (t.username) throw new HttpError(409, 'Username already taken');
    if (t.email) throw new HttpError(409, 'Email already taken');
    if (t.phone) throw new HttpError(409, 'Phone number already taken');

    return res.status(200).json({ success: true, message: 'Details received. Your canteen will be verified before activation.' });
  } catch (err) {
    return sendError(res, err);
  }
};

exports.logout = (req, res) => {
  const { maxAge, ...opts } = authCookieOptions;
  res.clearCookie('token', opts);
  return res.status(200).json({ success: true });
};
