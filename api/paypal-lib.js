/* PayPal REST helpers for rocktier.com — zero dependencies, Node built-ins.
   Uses the standard OAuth2 client_credentials flow against the live PayPal
   API (api-m.paypal.com). Configure PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET
   (REST app credentials) and PAYPAL_WEBHOOK_ID (for signature verification). */

"use strict";

var crypto = require("crypto");

/* Live by default. Point PAYPAL_API_BASE at https://api-m.sandbox.paypal.com
   on a preview/staging deployment to exercise the whole flow with sandbox
   credentials — production must never set it. */
var BASE = process.env.PAYPAL_API_BASE || "https://api-m.paypal.com";

/* ---------- OAuth2 access token (cached per invocation) ---------- */
async function getAccessToken() {
  var clientId = process.env.PAYPAL_CLIENT_ID;
  var clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    var e = new Error("PAYPAL_CLIENT_ID/SECRET not configured");
    e.statusCode = 500;
    throw e;
  }
  var res = await fetch(BASE + "/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(clientId + ":" + clientSecret).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });
  var j = await res.json().catch(function () { return {}; });
  if (!res.ok || !j.access_token) {
    var err = new Error("paypal oauth failed: " + res.status);
    err.statusCode = 502;
    throw err;
  }
  return j.access_token;
}

/* ---------- checkout orders ---------- */
async function createOrder(amount, customId, returnUrl, cancelUrl) {
  var token = await getAccessToken();
  var res = await fetch(BASE + "/v2/checkout/orders", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{
        amount: { currency_code: "USD", value: amount },
        custom_id: customId,
        description: "Rocktier software license"
      }],
      application_context: {
        brand_name: "Rocktier",
        user_action: "PAY_NOW",
        return_url: returnUrl,
        cancel_url: cancelUrl
      }
    })
  });
  var j = await res.json().catch(function () { return {}; });
  if (!res.ok || !j.id) {
    var err = new Error("paypal create order failed: " + res.status);
    err.statusCode = 502;
    throw err;
  }
  return j;
}

function approvalLink(order) {
  return (order.links || []).filter(function (l) { return l.rel === "approve"; })[0] || null;
}

async function captureOrder(orderId) {
  var token = await getAccessToken();
  var res = await fetch(BASE + "/v2/checkout/orders/" + encodeURIComponent(orderId) + "/capture", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: "{}"
  });
  var j = await res.json().catch(function () { return {}; });
  if (!res.ok || j.status !== "COMPLETED") {
    var err = new Error("paypal capture failed: " + res.status + " " + (j.status || ""));
    err.statusCode = 502;
    throw err;
  }
  return j;
}

/* ---------- webhook signature verification ---------- */
/* Per PayPal docs: POST the original event + transmission headers to the
   verify-webhook-signature endpoint. Returns true only when verification
   succeeds and the webhook id matches our configured PAYPAL_WEBHOOK_ID. */
async function verifyWebhook(headers, rawBody) {
  var webhookId = process.env.PAYPAL_WEBHOOK_ID;
  var token = await getAccessToken();
  var body = {
    auth_algo: headers["paypal-auth-algo"],
    cert_url: headers["paypal-cert-url"],
    transmission_id: headers["paypal-transmission-id"],
    transmission_sig: headers["paypal-transmission-sig"],
    transmission_time: headers["paypal-transmission-time"],
    webhook_id: webhookId,
    webhook_event: JSON.parse(rawBody.toString("utf8"))
  };
  var res = await fetch(BASE + "/v1/notifications/verify-webhook-signature", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  var j = await res.json().catch(function () { return {}; });
  return res.ok && j.verification_status === "SUCCESS";
}

module.exports = {
  createOrder: createOrder,
  approvalLink: approvalLink,
  captureOrder: captureOrder,
  verifyWebhook: verifyWebhook
};
