// Order life cycle. A cart is just an order that has not been requested yet.
//
//   CART(0) --request--> REQUESTED(1) --accept--> ACCEPTED(2) --pay--> PAID(3) --ready--> READY(4)
//                           |
//                           +--reject / 5-min timeout--> back to CART(0), status_note says why
//
// Every status change is a guarded UPDATE: "... SET status = new WHERE status = old".
// If two actors race (canteen accepts while the timeout fires), exactly one
// UPDATE matches the row and the other changes 0 rows and is told so (409).

module.exports = Object.freeze({
  CART: 0,
  REQUESTED: 1,
  ACCEPTED: 2,
  PAID: 3,
  READY: 4,
});
