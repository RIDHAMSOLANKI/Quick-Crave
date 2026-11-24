const express = require('express');
const customer = require('../controllers/customerController.js');
const order = require('../controllers/orderController.js');
const authenticate = require('../middleware/authenticate.js');

const router = express.Router();

// Every customer route needs a valid customer JWT. The customer id is taken
// from the token, never from the body.
router.use(authenticate);

// Browse (Redis cache-aside)
router.post('/customer-fetch-canteens', customer.fetchCanteens);
router.post('/customer-fetch-dishes', customer.fetchDishes);
router.post('/customer-fetch-menu', customer.fetchMenu);
router.post('/customer-fetch-top5', customer.fetchTop5);
router.post('/customer-search-canteen', customer.searchCanteen);
router.post('/customer-search-dish', customer.searchDish);

// Cart and orders (transactions + row locks + guarded status changes)
router.post('/customer-view-cart', customer.viewCart);
router.post('/customer-add-dish', order.addDishToCart);
router.post('/customer-remove-dish', order.removeDishFromCart);
router.post('/set-order-type', order.setOrderType);
router.post('/request-order', order.requestOrder);
router.post('/order-status', order.orderStatus);
router.post('/place-order', order.placeOrder);
router.post('/customer-view-order-history', customer.viewOrderHistory);

// Wallet (credits only come from the Razorpay webhook)
router.post('/customer-wallet', customer.viewWallet);
router.post('/fetch-transactions', customer.fetchTransactions);

// Reservations
router.post('/customer-add-reservations', order.addReservations);
router.post('/customer-fetch-reservations', customer.fetchReservations);

// Favourites and profile
router.post('/customer-add-favourite', customer.addFavourites);
router.post('/customer-remove-favourite', customer.removeFavourites);
router.post('/customer-view-favourites', customer.viewFavourites);
router.post('/customer-view-profile', customer.viewProfile);
router.post('/customer-update-profile', customer.updateProfile);
router.post('/customer-update-profilephoto', customer.updateProfilePhoto);
router.post('/customer-change-password', customer.changePassword);

module.exports = router;
