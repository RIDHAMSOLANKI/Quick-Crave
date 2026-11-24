const express = require('express');
const rateLimit = require('express-rate-limit');
const authController = require('../controllers/authController.js');

const router = express.Router();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { success: false, message: 'Too many attempts. Please try again later.' },
});

// The old /add-user (created accounts with no OTP) and /reset-password
// (changed ANY user's password with no proof of identity) were removed.
router.post('/signup', limiter, authController.signup);
router.post('/login', limiter, authController.login);
router.post('/logout', authController.logout);

module.exports = router;
