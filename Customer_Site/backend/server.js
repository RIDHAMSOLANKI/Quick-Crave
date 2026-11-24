require('dotenv').config();
const app = require('./app');

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`Customer API running at http://localhost:${PORT}`);
  if (!process.env.REDIS_URL) {
    console.log('REDIS_URL not set: cache disabled, background jobs run in-process.');
  }
});
