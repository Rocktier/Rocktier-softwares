/* GET /api/revalidate?txn=<id>   —— 吊销复检
 *
 * ── 为什么存在 ──
 *
 * 激活后的回执是离线验签的永久凭据（隐私承诺：激活之后应用不再联网）。
 * 服务端的 isRevoked（退款/拒付吊销）因此只拦得住「新激活」，
 * 对存量客户端形同装饰。本端点给用户一个主动核对的机会：
 * 用户点一次「检查更新」，客户端就多一次发现「我已被吊销」的可能。
 * 不点击就永远不核对 —— 离线优先的承诺不因此破例。
 *
 * ── 认证与信息泄露 ──
 *
 * 只收交易号（回执里本就有的字段），只回答 revoked 一个布尔值，
 * 不回答设备、金额、邮箱等任何其它信息。txn 由收款方生成、不可预测，
 * 且答案只有一比特，不构成枚举套利。
 *
 * ── 客户端约定 ──
 *
 * 用户点「检查更新」→ 应用先查 GitHub Releases，再打本端点一次。
 * revoked=true 时客户端清除本地回执，授权状态回到未激活。
 */

"use strict";

var shared = require("./_shared.js");

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

module.exports = async function (req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "GET") {
    return json(res, 405, { error: "method not allowed" });
  }

  var txn = "";
  try {
    var u = new URL(req.url, "https://rocktier.com");
    txn = String(u.searchParams.get("txn") || "").trim().slice(0, 80);
  } catch (e) {
    txn = "";
  }
  if (!txn) {
    return json(res, 400, { error: "missing txn" });
  }

  /* fail open：服务端抖动不把人当吊销（与 devices.js 的失败方向一致）。 */
  var revoked = false;
  try {
    revoked = (await shared.isRevoked(txn)) === true;
  } catch (e) {
    revoked = false;
  }

  return json(res, 200, { ok: true, revoked: revoked });
};
