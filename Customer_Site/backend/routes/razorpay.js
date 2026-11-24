const express = require('express');
const razorpayController = require('../controllers/razorpayController.js');

const router = express.Router();

// app.js already applies express.raw() to /razorpay-webhook.
router.post('/', razorpayController.managePayment);

module.exports = router;
