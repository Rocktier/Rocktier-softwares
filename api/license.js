/* GET /api/license?txn=<id>
       GET /api/license?checkout_id=…&product_id=…&signature=…   (Creem 回跳)

   返回某笔已完成购买的激活码。两条路径的**信任基础完全不同**：

   ── 路径 A：?txn=<id>（Paddle 遗留 / PayPal）──
   只凭一个 id 去 KV 查。安全靠的是「这个 id 由支付方生成、不可预测，
   且只有 webhook 知道」—— 买家猜不到别人的 id。

   ── 路径 B：Creem 回跳 ──
   Creem 跳回时带product_id 与 signature。signature 是用**我们的 API key**
   算出来的，所以验签通过就等于「这笔付款确实发生了、且买的是这个产品」。

   关键：**路径 B 不读 KV**。makeCode() 是确定性 HMAC（同一
   产品码 + 交易号永远得到同一个码），所以验签通过后可以直接铸码 ——
   不依赖 webhook 是否已送达，重试与时序都不会出问题。 */

"use strict";

var shared = require("./_shared.js");

module.exports = async function (req, res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "method not allowed" }));
  }

  var params = new URL(req.url, "http://localhost").searchParams;

  /* ---------- 路径 B：Creem 回跳（优先）---------- */
  if (params.get("signature")) {
    var apiKey = process.env.CREEM_API_KEY;
    if (!shared.verifyCreemRedirect(params, apiKey)) {
      /* 验签失败 = 这条回跳不是 Creem 发出的（或被改过）。
         一律拒绝，且**不透露**是签名不符还是产品不存在 —— 让攻击者
         无法用错误信息区分「伪造」与「猜中id 但无签名」。 */
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: "bad signature" }));
    }

    var prodId = params.get("product_id") || "";
    var code0 = shared.creemProductCode(prodId);
    if (!code0) {
      /* 验签过了但产品不在目录里 —— 说明我们卖了这个产品却没在CATALOG
         登记。这是**我方配置漏了**，不是买家的问题，如实说清。 */
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "unknown product" }));
    }

    var txn = shared.creemTxnId(params);
    if (!txn) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "missing checkout_id" }));
    }

    /* 仍然写一份 KV：① /license 页刷新能直接取 ② 将来若改成
       「必须 webhook 已确认」的严格策略时有据可依。写失败不影响出码。 */
    try {
      await shared.storeLicenseCode(code0, txn);
    } catch (e) {
      console.error("[license] KV 写入失败（不影响本次出码）:", e && e.message);
    }
    return res.end(JSON.stringify({ code: shared.makeCode(code0, txn, process.env.LICENSE_SECRET), code0: code0, product: code0 }));
  }

  /* ---------- 路径 A：?txn=<id> ---------- */
  var id = (params.get("txn") || "").trim();
  if (!id || !/^(ch_|txn_)/.test(id)) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: "missing txn" }));
  }

  /* 一律按 lic:txn: 取 —— storeLicenseCode() 写的就是这个前缀。
     原先对 che_ 走 lic:che: 是查不到的（而且 Creem 的 id 是 ch_ 不是 che_）。 */
  var p = shared.envPrefix();
  var key = p + "lic:txn:" + id;
  var code = await shared.kvGet(key);

  if (!code) {
    res.statusCode = 404;
    return res.end(JSON.stringify({ error: "not found" }));
  }

  /* product 从码本身恢复：码 = "RKT-" + base32("PRODUCT:txn") + 10位签名。
     license 页据此给全家桶买家显示「一码通用九款」的指引。解不出来
     不报错——product 只是 UI 提示，不是安全边界。 */
  var flat = code.replace(/-/g, "").slice(3); /* "RKT-" 的横线已被去掉，前缀只剩 3 字符 */
  var product = "";
  try {
    product = (shared.base32Decode(flat.slice(0, flat.length - 10)).toString("utf8").split(":")[0]) || "";
  } catch (e) { product = ""; }

  res.end(JSON.stringify({ code: code, product: product }));
};