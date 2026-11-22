/* POST /api/devices   { code, action: "list" | "release", fingerprint? }
 *
 * 设备管理的入口：查看这张码已激活哪几台、解绑一台。
 *
 * ── 为什么单独开端点而不是挂在 /api/license 上 ──
 *
 * /api/license 需要 `checkout_id`（Creem 回跳参数）或 PayPal 签名 ——
 * 那是**付款瞬间**才有的一次性上下文。用户买到码之后保存下来，
 * 换设备、��系统时再回到 /license，URL 里不会带 checkout_id，
 * 于是走 `showError()`。
 *
 * 也就是说：设备解绑**不能**依赖那个页面。这正是「重装系统后还能用」
 * 能否成立的关键路径 —— 如果超限用户被指引到一个需要 checkout_id 的
 * 页面，他会被永远锁住。
 *
 * ── 认证：持有码即可 ──
 *
 * 没有账号体系（见 devices.js 的模块说明），所以「证明自己拥有这份购买」
 * 只能靠码本身 —— 与激活时用的是同一个凭证。码是 50 bit HMAC 截断，
 * 猜不出来；且这个端点只能**减少**可用设备数，不能增加，
 * 因此拿到码的人能做的事，不超过他本来就能做的事。
 *
 * ── 频率 ──
 *
 * 无限制流。这与 /api/activate 的判断一致：码不可预测，暴力猜测不现实，
 * 且失败只返回笼统信息，不构成 oracle。
 */

"use strict";

var shared = require("./_shared.js");
var devices = require("./devices.js");

/* 解绑会影响其他设备的状态，属于有副作用的操作 —— 不像 /api/activate
   那样开放 `*`，只允许本站页面调用。

   这里刻意**不做**动态回显 origin：允许来源是写死的本站，
   动态回显等于把判断责任交给正则，而这里没有多域需求。 */
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "https://rocktier.com");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
}

function readBody(req) {
  return new Promise(function (resolve) {
    var chunks = [];
    req.on("data", function (c) { chunks.push(c); });
    req.on("end", function () { resolve(Buffer.concat(chunks)); });
    req.on("error", function () { resolve(Buffer.from("")); });
  });
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

module.exports = async function (req, res) {
  setCors(res);

  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") return json(res, 405, { error: "method allowed" });

  var code = "", action = "list", fp = "";
  try {
    var body = JSON.parse((await readBody(req)).toString("utf8")) || {};
    code = String(body.code || "").trim();
    action = String(body.action || "list").trim();
    fp = String(body.fingerprint || "").trim().slice(0, 128);
  } catch (e) {
    return json(res, 400, { error: "invalid json" });
  }
  if (!code) return json(res, 400, { error: "missing code" });

  var secret = process.env.LICENSE_SECRET;
  if (!secret) return json(res, 500, { error: "not configured" });

  var verified = shared.verifyCode(code, secret);
  if (!verified) {
    /* 不区分「格式不对」与「签名不对」，与 /api/activate 同一口径。 */
    return json(res, 400, { error: "this code is not valid" });
  }

  if (action === "release") {
    var r = await devices.releaseDevice(verified.txnId, fp);
    if (!r.ok) {
      /* "none" = 这张码一台都没激活过（也许还没激活过）。
         这不是错误 —— 用户看到的是「本来就没有需要解绑的设备」。 */
      if (r.reason === "none") {
        return json(res, 200, { released: false, reason: "none", devices: [], max: devices.MAX_DEVICES });
      }
      if (r.reason === "not_found") {
        return json(res, 404, { error: "device not found" });
      }
      return json(res, 500, { error: "storage unavailable, try again" });
    }
    var after = await devices.listDevices(verified.txnId);
    return json(res, 200, {
      released: true,
      removed: r.removed,
      devices: after.devices,
      max: after.max
    });
  }

  var list = await devices.listDevices(verified.txnId);
  return json(res, 200, { devices: list.devices, max: list.max });
};