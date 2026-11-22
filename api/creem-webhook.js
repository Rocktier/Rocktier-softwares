/* POST /api/creem-webhook
   Creem 退款 / 拒付 → 作废该笔交易的授权码。

   为什么必须有这个端点：授权有效⟺ 已付款 ∧ 未退款。Creem 走「回跳+验签」
   出码，所以**付款**那一半成立；但 Creem 没有 webhook 时，退款/拒付
   永远传不到我们这里 —— 买家退款后码仍然能用。而 PayPal 那条路早就有
   paypal-webhook.js 做同样的事。两个渠道行为不一致，就是漏洞。

   Creem 后台配置：Settings → Webhooks
     URL     https://rocktier.com/api/creem-webhook
     Events  checkout.completed / refund.created / dispute.created

   ── 验签（与 paypal-webhook 完全不同，别照抄那边的）──────────────
   PayPal 是把请求转发到 PayPal 的 verify-webhook-signature 接口；
   Creem 是**本地**验：请求头 `creem-signature` = HMAC-SHA256(原始报文,
   CREEM_API_KEY) 的十六进制。

   注意与**回跳**验签是两套不同机制，别混：
     回跳  = 各参数按 URL 顺序拼串 + salt=apiKey，再 SHA-256
     webhook = 整个原始报文的 HMAC-SHA256
   两者都用 CREEM_API_KEY，但算法与输入完全不同。 */

"use strict";

var shared = require("./_shared.js");
var crypto = require("crypto");

function readBody(req) {
  return new Promise(function (resolve) {
    var chunks = [];
    req.on("data", function (c) { chunks.push(c); });
    req.on("end", function () { resolve(Buffer.concat(chunks)); });
    req.on("error", function () { resolve(Buffer.from("")); });
  });
}

/* 定长比较，避免靠比较耗时侧信道推断签名。 */
function safeEqual(a, b) {
  var ba = Buffer.from(String(a), "utf8");
  var bb = Buffer.from(String(b), "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function verifySignature(rawBody, header) {
  var key = process.env.CREEM_API_KEY;
  if (!key) return false;                 /* 没配 key 就一律拒 —— 绝不裸奔 */
  if (!header) return false;
  var sig = String(header);
  /* Creem 有时写成 sha256=<hex> 前缀形式 */
  if (sig.indexOf("=") === 6 && sig.slice(0, 6).toLowerCase() === "sha256") {
    sig = sig.slice(7);
  }
  var expect = crypto.createHmac("sha256", key).update(rawBody).digest("hex");
  return safeEqual(expect, sig);
}

/* Creem 的事件体在不同 event_type 下字段位置不一致，尽量多找几个地方。
   找不到就返回 ""，由调用方记 REVOKE-NEEDED 走人工 —— 宁可留可见日志，
   也不假装处理完了（与 paypal-webhook 同一原则）。 */
function txnIdFromEvent(event) {
  var r = event.resource || event.data || event;
  var candidates = [
    r.checkout_id, r.checkoutId,
    event.checkout_id,
    r.metadata && r.metadata.checkout_id,
    r.supplementary_data && r.supplementary_data.related_ids &&
      r.supplementary_data.related_ids.order_id,
    r.id,
  ];
  for (var i = 0; i < candidates.length; i++) {
    var v = candidates[i];
    if (v && /^(ch_|txn_)/.test(String(v))) return String(v);
  }
  return "";
}

module.exports = async function (req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end("method not allowed");
  }

  var rawBody = await readBody(req);

  /* 必须先验签再解析：未验签的报文一律 401，不做任何处理。 */
  if (!verifySignature(rawBody, req.headers["creem-signature"])) {
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
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    res.statusCode = 400;
    return res.end("bad json");
  }

  var type = String(event.event_type || event.type || "");

  /* 退款 / 拒付 / 撤销：作废这张码。撤权是幂等的 —— 重复投递同一条
     事件只是把同一个 KV 键再写一次，不会产生别的副作用。 */
  if (shared.isRevocationEvent({ event_type: type })) {
    var txn = txnIdFromEvent(event);
    if (txn) {
      await shared.markRevoked(txn, type);
      res.statusCode = 200;
      return res.end("revoked");
    }
    console.error(
      "[REVOKE-NEEDED] creem refund without checkout id:", type,
      JSON.stringify((event.resource && event.resource.id) || "")
    );
    /* 仍然 200：签名有效、已收到。不重试 —— 重试也取不到订单号，
       只会让 Creem 反复投递。人工处理由上面的日志兜底。 */
    res.statusCode = 200;
    return res.end("ok");
  }

  /* 其余事件（checkout.completed 等）一律确认即可。
     铸码走回跳那条路（verifyCreemRedirect），webhook 不重复铸码 ——
     两条路都铸会出现两张不同的码，反而麻烦。 */
  res.statusCode = 200;
  return res.end("ok");
};