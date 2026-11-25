/* Shared helpers for the Rocktier license serverless functions.
   Zero-dependency (Node built-ins only): activation codes are HMAC-signed
   base32 strings; storage is Upstash REST (Vercel KV) via fetch. */

"use strict";

var crypto = require("crypto");

/* ---------- base32 (RFC 4648, no padding) ---------- */
var B32_ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf) {
  var bits = 0, value = 0, out = "";
  for (var i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHA[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHA[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  var bits = 0, value = 0, out = [];
  for (var i = 0; i < str.length; i++) {
    var idx = B32_ALPHA.indexOf(str[i]);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/* ---------- activation codes ---------- */
/* Code shape: RKT-<base32(payload)>-<base32(hmac)>  grouped in 5s.
   payload = "<PRODUCT>:<txn_id>", so a code is self-describing.
   The HMAC here is symmetric and the secret never leaves the server: the app
   does not verify codes locally at all. It posts the code to /api/activate,
   which checks the HMAC, then signs a receipt with an Ed25519 private key that
   the app verifies offline against an embedded public key. See activate.js. */

function makeCode(productCode, txnId, secret) {
  var payload = productCode + ":" + txnId;
  var payloadB32 = base32Encode(Buffer.from(payload, "utf8"));
  var sig = crypto.createHmac("sha256", secret).update(payload).digest();
  var sigB32 = base32Encode(sig).slice(0, 10);
  var raw = payloadB32 + sigB32;
  var grouped = raw.replace(/(.{5})/g, "$1-").replace(/-$/, "");
  return "RKT-" + grouped;
}

function verifyCode(code, secret) {
  if (typeof code !== "string") return null;
  var c = code.trim().toUpperCase();
  if (!/^RKT-[A-Z2-9-]+$/.test(c)) return null;
  var raw = c.slice(4).replace(/-/g, "");
  if (raw.length < 16) return null;
  var sigB32 = raw.slice(-10);
  var payloadB32 = raw.slice(0, -10);
  var payload = base32Decode(payloadB32).toString("utf8");
  /* 前缀必须与**各渠道真正会出现的交易号**一致：
       txn_  = Paddle 遗留 + PayPal（paypalTxnId 还会再包一层 txn_paypal_）
       ch_   = Creem 的 checkout_id（实测：/payment/<prodId> 会 302 到
               /checkout/<prodId>/ch_xxx，故回跳参数就是 ch_，不是 che_）。
     这里曾写成 che_，导致 Creem 卖出的每一张码都被 /api/activate 判为无效。 */
  var m = /^([A-Z0-9]{2,4}):(txn_.+|ch_.+)$/.exec(payload);
  if (!m) return null;
  var expected = base32Encode(
    crypto.createHmac("sha256", secret).update(payload).digest()
  ).slice(0, 10);
  if (expected !== sigB32) return null;
  return { productCode: m[1], txnId: m[2] };
}

/* ---------- 目录（唯一真源）---------- */
/* 以**产品码为主键**，每个渠道的 id 是它的一个字段。
   之前是两张散表（DEFAULT_PRICE_PRODUCT_MAP / PAYPAL_PRICE_MAP）加两个
   查函数，每接一个渠道就多一张表 —— 而 Paddle 下线时其中一张注定要删。
   改成以产品码为主键后，**加渠道 = 每行多一个字段**，不会有第二张表。

   产品码是应用内license.rs 认的东西（PD / WP / MD / CV / OC / WR / JO /
   SG / CO / FL），各应用只认自己的码 + FL，所以它是天然的稳定主键。
   Journal 是 JO 不是 JI：客户端 `apps/journal/src-tauri/src/license.rs:94` 从 2026-10
   起就烤进 `["JO","FL"]`，已装机用户不会随官网改动更新——目录键只能迁就客户端，
   反过来改客户端等于让存量用户全体激活失败（同 SQ→PD 改名事故）。 */
var CATALOG = {
  PD: { label: "Rocktier PDF",        price: "9.99",
        creem: "prod_29kyJdztcwhkCkI6eoXvCe",
        paypal: "pri_01m2x14d1qapnz8z45rx76fy4f" },
  WP: { label: "Rocktier Pic2WebP",   price: "4.99",
        creem: "prod_3WGsJX0AuPkYBYCvoDD0wP",
        paypal: "pri_01m2x14apb42kcscg18k5385jn" },
  MD: { label: "Rocktier Markdown",   price: "6.99",
        creem: "prod_25g9tjygShagA9Ou7NtQu1",
        paypal: "pri_01m2x14gp1dzbjttsv6gqfw7m8" },
  CV: { label: "Rocktier CAD Viewer", price: "14.99",
        creem: "prod_2kPdg0bkPeven2QXzFG6bX",
        paypal: "pri_01m2x14jy1mmck626fb2v6k64w" },
  /* 以下 5 个产品在 PayPal 侧**没有**对应商品（后台未建），
     故 paypal 为 null —— 页面据此不渲染 PayPal 入口，而不是给一个会失败的链接。
     要开 PayPal 需先在 PayPal 后台建商品，再把 price id 填进来。 */
  OC: { label: "Rocktier OCR",        price: "14.99",
        creem: "prod_5p01aS1VOcdH9rqtozt9O5", paypal: null },
  WR: { label: "Rocktier Write",      price: "12.99",
        creem: "prod_GnHgkbJt8ahSjYcImdEBl",  paypal: null },
  JO: { label: "Rocktier Journal",    price: "9.99",
        creem: "prod_3a135PdLzq7CerGOSA6NSm", paypal: null },
  SG: { label: "Rocktier Sign",       price: "9.99",
        creem: "prod_6GZMSHYC0paDLKguyWC1Et", paypal: null },
  CO: { label: "Rocktier Compressor", price: "9.99",
        creem: "prod_7LNvNTzDcfIAP2RyNjKOg7", paypal: null },
  FL: { label: "Rocktier Whole Family", price: "29.99",
        creem: "prod_36hw8U5U2f87OIxJnNEi9J",
        paypal: "pri_01m2x14mct6vj7fyrg59wtjrtj" }
};

/* 反查：某渠道的商品 id → 产品码。找不到返回 null（**不猜**）。 */
function codeFor(channel, channelId) {
  if (!channelId) return null;
  var keys = Object.keys(CATALOG);
  for (var i = 0; i < keys.length; i++) {
    var row = CATALOG[keys[i]];
    if (row[channel] === channelId) return keys[i];
  }
  return null;
}

function creemProductCode(prodId) { return codeFor("creem", prodId); }
function paypalProductCode(priId)  { return codeFor("paypal", priId); }
function creemCheckoutUrl(prodId) { return "https://www.creem.io/payment/" + prodId; }

/* ---------- PayPal ---------- */
/* 金额取自 CATALOG，**不信任请求里的金额**（老PayPal 表的核心安全属性，
   保留这个性质）。找不到 price id 就返回 null，让调用方拒绝该请求。 */
function paypalPrice(priceId) {
  var code = paypalProductCode(priceId);
  if (!code) return null;
  return { amount: CATALOG[code].price, code: code };
}

/* PayPal order ids are not txn_/ch_ prefixed, but the license store and the
   /license lookup only accept those shapes. Wrap the order id so the whole
   existing pipeline (KV key + lookup + code payload) works unchanged. */
function paypalTxnId(orderId) {
  return "txn_paypal_" + orderId;
}

/* ---------- Vercel KV (Upstash REST, zero deps) ---------- */
function kvGet(key) {
  return fetch(process.env.KV_REST_API_URL + "/get/" + encodeURIComponent(key), {
    headers: { Authorization: "Bearer " + process.env.KV_REST_API_TOKEN }
  }).then(function (r) { return r.json(); })
    .then(function (j) { return j && j.result !== undefined ? j.result : null; })
    .catch(function () { return null; });
}

function kvSet(key, value, ttl) {
  var url = process.env.KV_REST_API_URL + "/set/" + encodeURIComponent(key);
  if (ttl) url += "?ex=" + ttl;
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + process.env.KV_REST_API_TOKEN,
      "Content-Type": "text/plain; charset=utf-8"
    },
    /* Store the raw string — Upstash stores the request body verbatim, so
       JSON.stringify would persist the surrounding quotes in the value. */
    body: value
  }).then(function (r) { return r.status; })
    .catch(function () { return 0; });
}

/* keys are namespaced per environment (sandbox vs live) */
function envPrefix() {
  return (process.env.LICENSE_ENV || "sandbox") + ":";
}

/* Mint a code for a purchase and persist it under lic:txn:<id> (TTL 1 year).
   Returns 0 on storage failure, else the Upstash status code. Idempotent —
   same (productCode, txnId) always yields the same code and key, so the
   webhook retries and the PayPal capture/return path can both call it. */
async function storeLicenseCode(productCode, txnId) {
  var code = makeCode(productCode, txnId, process.env.LICENSE_SECRET);
  return await kvSet(envPrefix() + "lic:txn:" + txnId, code, 86400 * 365);
}

/* ---------- 退款 / 拒付作废 ----------
   条款写的是"一律不退款"，但拒付（chargeback）与法定退款仍会发生 —— 那正是钱被
   真正拿走的场景，所以码必须能作废。作废只挡住**此后的兑换**：已经激活过的机器
   是离线验签的，除非引入定期回检（会牺牲"永不联网"这个卖点），否则无法远程失效。
   这是有意的取舍，见审查修复进度。 */

/* 纯函数，便于测试：这个事件是否意味着"钱退回去了"。
   用关键词而不是逐个事件名列举 —— 支付平台会加新事件，而"钱退回去"这件事的
   说法就那么几种。 */
function isRevocationEvent(event) {
  var t = String((event && event.event_type) || "");
  /* 关键词表必须覆盖**各渠道真实的事件命名**，否则退款/拒付会漏。
     Creem 用 dispute.created 表示拒付（PayPal 用 chargeback），
     一开始漏了 dispute —— 结果 Creem 争议单进来不撤权，买家拒付后
     码照样能用。测出来才补上。 */
  if (/refund|chargeback|credit|revers|cancel|dispute/i.test(t)) return true;
  /* 有些通道的 transaction.updated 只是状态变化，只有落到"已退/已拒付"才算。 */
  if (t === "transaction.updated") {
    var status = String((event && event.data && event.data.status) || "").toLowerCase();
    return /refund|chargeback|credit|revers/.test(status);
  }
  return false;
}

/* PayPal：退款事件给的是 refund 资源，订单号可能不在同一位置；取不到就返回空，
   由调用方记下 REVOKE-NEEDED 走人工处理。 */
function paypalOrderIdFromEvent(event) {
  var r = (event && event.resource) || {};
  if (r.supplementary_data && r.supplementary_data.related_ids) {
    return r.supplementary_data.related_ids.order_id || "";
  }
  return "";
}

function isPayPalRefundEvent(event) {
  return /refund|revers/i.test(String((event && event.event_type) || ""));
}

async function markRevoked(txnId, reason) {
  if (!txnId) return 0;
  /* 不设过期：退款永久有效。 */
  return await kvSet(envPrefix() + "revoked:" + txnId, reason || "refunded");
}

async function isRevoked(txnId) {
  if (!txnId) return false;
  var v = await kvGet(envPrefix() + "revoked:" + txnId);
  return !!v;
}

module.exports = {
  makeCode: makeCode,
  verifyCode: verifyCode,
  isRevocationEvent: isRevocationEvent,
  paypalOrderIdFromEvent: paypalOrderIdFromEvent,
  isPayPalRefundEvent: isPayPalRefundEvent,
  markRevoked: markRevoked,
  isRevoked: isRevoked,
  CATALOG: CATALOG,
  creemProductCode: creemProductCode,
  creemCheckoutUrl: creemCheckoutUrl,
  verifyCreemRedirect: verifyCreemRedirect,
  creemTxnId: creemTxnId,
  paypalProductCode: paypalProductCode,
  paypalPrice: paypalPrice,
  paypalTxnId: paypalTxnId,
  storeLicenseCode: storeLicenseCode,
  kvGet: kvGet,
  base32Decode: base32Decode,
  kvSet: kvSet,
  envPrefix: envPrefix
};

/* ---------- Creem：回跳验签 ---------- */
/* 付款成功后 Creem 跳回 success_url，带这几个 query 参数：
     checkout_id / order_id / customer_id / subscription_id / product_id
     / request_id / signature
   `signature` = SHA-256 hex(按 URL 里**出现的顺序**把非空参数拼成
   "k=v|k=v|…"，再追加 "salt={apiKey}")。

   ⚠️ 两个坑，都是文档明确点名的：
   1. 必须按**到达顺序**，不能按字母序重排 —— 重排必然验签失败。
   2. 值为空 / null 的参数**必须整个排除**（例如一次性支付的
      subscription_id）。写成 "subscription_id=null" 会验签失败。

   不用原始 query string（各平台的 URL 解码细节不一致），而是遍历
   searchParams —— V8 保证同键多次出现时按出现顺序返回，顺序得以保留。 */
function verifyCreemRedirect(searchParams, apiKey) {
  if (!apiKey) return false;
  var signature = searchParams.get("signature");
  if (!signature) return false;

  var parts = [];
  searchParams.forEach(function (value, key) {
    if (key === "signature") return;
    if (value === null || value === undefined || value === "") return;
    parts.push(key + "=" + value);
  });
  parts.push("salt=" + apiKey);

  var expected = crypto.createHash("sha256").update(parts.join("|")).digest("hex");
  /* 定长比较，避免按字符提前返回而泄漏信息 */
  if (expected.length !== signature.length) return false;
  var diff = 0;
  for (var i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

/* web 端取码时用的交易号：优先 checkout_id（Creem 的一次性支付必有） */
function creemTxnId(searchParams) {
  return (searchParams.get("checkout_id") || "").trim();
}
