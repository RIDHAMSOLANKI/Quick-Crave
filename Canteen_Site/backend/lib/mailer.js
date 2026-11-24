// Email sending. Credentials come only from the environment.
// With no EMAIL_USER/EMAIL_PASSWORD set (local dev, tests), emails are logged
// instead of sent, so sign-up still works and the OTP shows in the console.

const nodemailer = require('nodemailer');

let transporter;

function getTransporter() {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: process.env.EMAIL_SERVICE || 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD },
    });
  }
  return transporter;
}

async function sendMail({ to, subject, text, html }) {
  const t = getTransporter();
  if (!t) {
    if (process.env.NODE_ENV !== 'test') {
      console.log(`[mail:dev] to=${to} subject="${subject}" text="${text}"`);
    }
    return;
  }
  await t.sendMail({ from: process.env.EMAIL_USER, to, subject, text, html });
}

module.exports = { sendMail };
