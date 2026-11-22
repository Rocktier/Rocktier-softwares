/* GET /api/paypal-checkout?price_id=<id>
   Starts a PayPal checkout for the given product and redirects the buyer to
   PayPal's hosted approval page. The amount is resolved server-side from the
   price id (never trusted from the client). */

"use strict";

var shared = require("./_shared.js");
var paypal = require("./paypal-lib.js");

module.exports = async function (req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    return res.end("method not allowed");
  }

  var priceId = (new URL(req.url, "http://localhost").searchParams.get("price_id") || "").trim();
  var price = shared.paypalPrice(priceId);
  if (!price) {
    res.statusCode = 400;
    return res.end("unknown price");
  }

  /* Return/cancel URLs follow the host that started the checkout, so a preview
     or staging deployment comes back to itself instead of jumping to
     production (which would capture a sandbox order against the live API). */
  var origin = "https://" + (req.headers.host || "rocktier.com");

  /* carry the price id through to the capture/webhook so we know which
     product code to mint; echo the reference with the order. */
  var order;
  try {
    order = await paypal.createOrder(
      price.amount,
      priceId,
      origin + "/api/paypal-return",
      origin + "/"
    );
  } catch (e) {
    /* PayPal 侧的失败（CLIENT_ID/SECRET 未配置或已失效、PayPal API 5xx）会
       在这里抛错。不加兜底，用户点「Buy with PayPal」看到的就是 Vercel 的
       server error 页面；挂着按钮却必然报错，比不挂按钮更糟，也会让人
       对该产品本身失去信任。
       只要这个产品同时配了 Creem 商品，就把用户送到 Creem 结账：金额由
       Creem 侧商品定义，客户端传不进来，所以这条降级不引入越权支付。 */
    var row = shared.CATALOG[price.code];
    var creemId = row && row.creem;
    if (creemId) {
      res.statusCode = 302;
      res.setHeader("Location", shared.creemCheckoutUrl(creemId));
      return res.end();
    }
    res.statusCode = 502;
    return res.end("payment provider unavailable");
  }

  var link = paypal.approvalLink(order);
  if (!link) {
    res.statusCode = 502;
    return res.end("no approval link");
  }

  res.statusCode = 302;
  res.setHeader("Location", link.href);
  res.end();
};
