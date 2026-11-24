// Central place for required settings, so a missing secret fails loudly at
// start-up instead of silently falling back to a guessable default.

require('dotenv').config();

function jwtSecret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 16) {
    throw new Error('JWT_SECRET must be set (at least 16 characters). See .env.example');
  }
  return s;
}

function razorpayWebhookSecret() {
  const s = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!s) throw new Error('RAZORPAY_WEBHOOK_SECRET must be set. See .env.example');
  return s;
}

const isProd = process.env.NODE_ENV === 'production';

// Cookie that carries the JWT. httpOnly: page JavaScript cannot read it, so an
// XSS bug cannot steal the session.
const authCookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: 'lax',
  maxAge: 60 * 60 * 1000,
};

module.exports = { jwtSecret, razorpayWebhookSecret, isProd, authCookieOptions };
