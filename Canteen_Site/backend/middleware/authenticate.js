// JWT auth for canteen routes. The canteen id comes from the signed token, and
// every query below also filters by it, so one canteen can never touch another
// canteen's orders, dishes or coupons.

const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../lib/config');

const authenticateCanteen = (req, res, next) => {
  const token = req.cookies && req.cookies.token;
  if (!token) return res.status(401).json({ message: 'Unauthorized: No token' });

  let decoded;
  try {
    decoded = jwt.verify(token, jwtSecret(), { algorithms: ['HS256'] });
  } catch (err) {
    return res.status(401).json({ message: 'Unauthorized: Invalid or expired token' });
  }

  if (decoded.userType !== 'canteen-manager') {
    return res.status(403).json({ message: 'Forbidden: canteen account required' });
  }

  req.canteen_id = decoded.user_id;
  next();
};

module.exports = authenticateCanteen;
