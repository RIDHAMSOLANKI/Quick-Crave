// Express app for the canteen side. server.js starts it; tests import it.

const express = require('express');
const path = require('path');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const authRoutes = require('./routes/auth.js');
const canteenRoutes = require('./routes/canteen.js');
const { jwtSecret } = require('./lib/config');

jwtSecret(); // fail at start-up if the secret is missing

const app = express();
app.disable('x-powered-by');

const origins = (process.env.CORS_ORIGINS || 'http://localhost:3001').split(',').map((s) => s.trim());
app.use(cors({ origin: origins, credentials: true }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

app.get('/health', (req, res) => res.json({ ok: true }));
app.use('/canteen', canteenRoutes);
app.use('/auth', authRoutes);

app.use(express.static(path.join(__dirname, '../frontend/build')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/build', 'index.html'), (err) => {
    if (err) res.status(404).end();
  });
});

module.exports = app;
