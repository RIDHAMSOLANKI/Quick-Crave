const express = require('express');
const rateLimit = require('express-rate-limit');
const authController = require('../controllers/authController.js');

const router = express.Router();

// Slow down password guessing and OTP brute force: per IP, per window.
const isTest = process.env.NODE_ENV === 'test';
const limiter = (max) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => isTest,
    message: { success: false, message: 'Too many attempts. Please try again later.' },
  });

router.post('/signup', limiter(10), authController.signup);
router.post('/verify-otp', limiter(20), authController.verifyOtp);
router.post('/login', limiter(20), authController.login);
router.post('/logout', authController.logout);

module.exports = router;
