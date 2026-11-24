// Express app for the customer side. server.js starts it; tests import it.

const express = require('express');
const path = require('path');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const authRoutes = require('./routes/auth.js');
const customerRoutes = require('./routes/customer.js');
const razorpayRoutes = require('./routes/razorpay.js');
const { jwtSecret } = require('./lib/config');

jwtSecret(); // fail at start-up if the secret is missing

const app = express();
app.disable('x-powered-by');

// The Razorpay webhook must see the RAW body: the HMAC signature is computed
// over the exact bytes Razorpay sent, so this route is mounted BEFORE
// express.json() (which would parse and change them).
app.use('/razorpay-webhook', express.raw({ type: 'application/json', limit: '100kb' }), razorpayRoutes);

const origins = (process.env.CORS_ORIGINS || 'http://localhost:3000').split(',').map((s) => s.trim());
app.use(cors({ origin: origins, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/health', (req, res) => res.json({ ok: true }));
app.use('/auth', authRoutes);
app.use('/customer', customerRoutes);

// Serve the React build (after `npm run build` in ../frontend).
app.use(express.static(path.join(__dirname, '../frontend/build')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/build', 'index.html'), (err) => {
    if (err) res.status(404).end();
  });
});

module.exports = app;
