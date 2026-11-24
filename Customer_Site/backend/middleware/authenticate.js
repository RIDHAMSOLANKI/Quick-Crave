// JWT auth for customer routes.
// The user id ALWAYS comes from the signed token, never from the request body,
// so one customer can never act as another (no IDOR through ids in the body).

const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../lib/config');

const authenticateCustomer = (req, res, next) => {
  const token = req.cookies && req.cookies.token;
  if (!token) {
    return res.status(401).json({ message: 'Unauthorized: No token' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, jwtSecret(), { algorithms: ['HS256'] });
  } catch (err) {
    return res.status(401).json({ message: 'Unauthorized: Invalid or expired token' });
  }

  // A canteen manager's token must not open customer routes.
  if (decoded.userType !== 'customer') {
    return res.status(403).json({ message: 'Forbidden: customer account required' });
  }

  req.customer_id = decoded.user_id;
  next();
};

module.exports = authenticateCustomer;
