/* GET /api/paypal-return?token=<order_id>
   PayPal redirects the buyer here after approving payment. Captures the
   order, mints the license code (idempotent — the webhook may do it too),
   then sends the buyer to the license page to copy their code.

   Idempotency: if capture fails because the order was already captured (e.g.
   the buyer refreshed this page, or the webhook captured first), the code is
   already in KV under the same key — look it up and carry on to /license. */

"use strict";

var shared = require("./_shared.js");
var paypal = require("./paypal-lib.js");

module.exports = async function (req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    return res.end("method not allowed");
  }

  var orderId = (new URL(req.url, "http://localhost").searchParams.get("token") || "").trim();
  if (!orderId) {
    res.statusCode = 400;
    return res.end("missing token");
  }

  var txnId = shared.paypalTxnId(orderId);

  var captured = null;
  var captureErr = null;
  try {
    captured = await paypal.captureOrder(orderId);
  } catch (e) {
    captureErr = e;
  }

  if (!captured) {
    /* Capture failed. If a code already exists for this order, an earlier
       attempt (webhook or a previous load of this page) did the work — go
       straight to the license page. Otherwise surface the failure. */
    var existing = await shared.kvGet(shared.envPrefix() + "lic:txn:" + txnId);
    if (existing) {
      res.statusCode = 302;
      res.setHeader("Location", "/license?txn=" + encodeURIComponent(txnId));
      return res.end();
    }
    throw captureErr;
  }

  var priceId = "";
  try {
    var capture = captured.purchase_units && captured.purchase_units[0];
    var item = capture && capture.payments && capture.payments.captures && capture.payments.captures[0];
    priceId = (item && item.custom_id) || "";
  } catch (e) { /* keep empty */ }

  var price = shared.paypalPrice(priceId);
  if (!price) {
    /* Unknown or missing custom_id: refuse rather than silently mint nothing —
       same principle as the Paddle webhook's 500-on-unknown-price. */
    res.statusCode = 500;
    return res.end("unknown price");
  }

  var ok = await shared.storeLicenseCode(price.code, txnId);
  if (ok === 0) {
    res.statusCode = 500;
    return res.end("kv write failed");
  }

  res.statusCode = 302;
  res.setHeader("Location", "/license?txn=" + encodeURIComponent(txnId));
  res.end();
};
