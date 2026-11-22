/* POST /api/paypal-webhook
   Receives PayPal webhooks (PAYMENT.CAPTURE.COMPLETED) and mints the license
   code — the reliable delivery path in case the buyer never lands back on
   /api/paypal-return. Signature is verified against PayPal's
   verify-webhook-signature endpoint with PAYPAL_WEBHOOK_ID.

   Configure in PayPal Developer > Webhooks: URL
   https://rocktier.com/api/paypal-webhook, event PAYMENT.CAPTURE.COMPLETED. */

"use strict";

var shared = require("./_shared.js");
var paypal = require("./paypal-lib.js");

function readBody(req) {
  return new Promise(function (resolve) {
    var chunks = [];
    req.on("data", function (c) { chunks.push(c); });
    req.on("end", function () { resolve(Buffer.concat(chunks)); });
    req.on("error", function () { resolve(Buffer.from("")); });
  });
}

module.exports = async function (req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end("method not allowed");
  }

  var rawBody = await readBody(req);
  var okSig = await paypal.verifyWebhook(req.headers, rawBody);
  if (!okSig) {
    res.statusCode = 401;
    return res.end("invalid signature");
  }

  var event;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch (e) {
    res.statusCode = 400;
    return res.end("bad json");
  }

  /* Acknowledge everything that isn't a completed capture. */
  /* 退款 / 撤销：作废这张码。PayPal 的退款资源里不一定带订单号，取不到就打上
     REVOKE-NEEDED —— 宁可留下一条可见的日志，也不要假装已经处理完了。 */
  if (shared.isPayPalRefundEvent(event)) {
    var revokeOrder = shared.paypalOrderIdFromEvent(event);
    if (revokeOrder) {
      await shared.markRevoked(shared.paypalTxnId(revokeOrder), String(event.event_type));
      res.statusCode = 200;
      return res.end("revoked");
    }
    console.error(
      "[REVOKE-NEEDED] paypal refund without order id:", event.event_type,
      JSON.stringify((event.resource && event.resource.id) || "")
    );
    res.statusCode = 200;
    return res.end("ok");
  }

  if (event.event_type !== "PAYMENT.CAPTURE.COMPLETED") {
    res.statusCode = 200;
    return res.end("ok");
  }

  var resource = event.resource || {};
  var orderId = resource.supplementary_data && resource.supplementary_data.related_ids &&
    resource.supplementary_data.related_ids.order_id;
  var priceId = resource.custom_id || "";

  if (!orderId || !shared.paypalPrice(priceId)) {
    console.error(
      "[paypal-webhook] cannot map capture to a product: order=" + orderId + " custom_id=" + priceId
    );
    /* 500 so PayPal retries; keeps "paid but no code" visible in the logs. */
    res.statusCode = 500;
    return res.end("unknown price");
  }

  var ok = await shared.storeLicenseCode(shared.paypalPrice(priceId).code, shared.paypalTxnId(orderId));
  if (ok === 0) {
    res.statusCode = 500;
    return res.end("kv write failed");
  }

  res.statusCode = 200;
  res.end("ok");
};
