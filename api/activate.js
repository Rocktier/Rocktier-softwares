/* POST /api/activate   { code: "RKT-XXXXX-XXXXX-…" }
 *
 * 把买家手里的激活码换成一张**服务端签名**的回执，应用拿到后离线验签、此后不再联网。
 *
 * 为什么要有这一步，而不是让应用自己验码：
 *   激活码是用 LICENSE_SECRET 做的 HMAC。若让应用本地验，那个 secret 就必须打进
 *   二进制 —— 等于把它交给每一位用户，谁都能自制无限激活码。所以码**只在服务端**
 *   校验（这里的 verifyCode），客户端只拿得到一份用**私钥**签出的回执，而它手里
 *   只有**公钥**，无法伪造。
 *
 * 不需要限流：码的内容是 `<产品码>:<交易号>`，交易号由收款方生成、不可预测，
 * 签名又被截到 50 bit，爆破不现实；猜错只是 HMAC 不匹配，接口不提供任何"接近了"的
 * 提示，不构成 oracle。
 *
 * 环境变量：
 *   LICENSE_SECRET       与发码同一个 HMAC 密钥（api/_shared.js 已在用）
 *   LICENSE_PRIVATE_KEY  tools/license-keygen.mjs 生成的私钥（base64 PKCS#8 DER）
 *
 * 回执正文的字段名必须与 Rust 侧 `license::Receipt` 一致（蛇形：issued_at）。
 */

"use strict";

var crypto = require("crypto");
var shared = require("./_shared.js");
var devices = require("./devices.js");

/* 跨域：这个端点从 Tauri 的 webview 里调用，来源是 tauri://localhost，
   属跨源请求。端点不读 cookie、不依赖任何凭据，开放读取即可。 */
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
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

  /* 预检：JSON 正文会触发预检，不处理它整个请求就到不了这里。 */
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") {
    return json(res, 405, { error: "method not allowed" });
  }

  var raw = await readBody(req);
  var code = "", fp = "", os = "";
  try {
    var body = JSON.parse(raw.toString("utf8")) || {};
    code = String(body.code || "").trim();
    /* 机器指纹与系统标识：用于限制一张码能激活几台设备。
       客户端可能取不到（空串），那时不计数也不拦激活 —— 见 devices.js。 */
    fp = String(body.fingerprint || "").trim().slice(0, 128);
    os = String(body.os || "").trim().slice(0, 64);
  } catch (e) {
    return json(res, 400, { error: "invalid json" });
  }
  if (!code) {
    return json(res, 400, { error: "missing code" });
  }

  var secret = process.env.LICENSE_SECRET;
  var privB64 = process.env.LICENSE_PRIVATE_KEY;
  if (!secret || !privB64) {
    /* 配置缺失是运维问题，不是用户的问题 —— 报 500 并说清缺哪一项。 */
    return json(res, 500, { error: "activation is not configured yet" });
  }

  var verified = shared.verifyCode(code, secret);
  if (!verified) {
    /* 只回一个笼统的失败：不区分"格式不对"与"签名不对"，不给探测者任何信息。 */
    return json(res, 400, { error: "this code is not valid" });
  }

  /* 码是真的，但钱已经退回去了（退款或拒付）。错误串里带 REFUNDED，应用据此给出
     与"码不对"不同的提示 —— 这两种情况的下一步完全不同。 */
  if (await shared.isRevoked(verified.txnId)) {
    return json(res, 403, { error: "REFUNDED: this purchase was refunded or reversed" });
  }

  /* 设备记账：同一张码最多绑定 MAX_DEVICES 台机器。
     放在退款检查之后 —— 已经退款的交易不该占设备名额。
     放在签发之前 —— 超限就不该签发回执。 */
  var activation = await devices.recordActivation(verified.txnId, fp, os);
  if (!activation.ok) {
    /* 错误串带 DEVICE_LIMIT，让应用能给出"去网页解绑一台"的具体指引，
       而不是笼统的"激活失败"。 */
    return json(res, 403, {
      error: "DEVICE_LIMIT: this code is already activated on " +
             devices.MAX_DEVICES + " devices. Deactivate one at rocktier.com/license",
      max: devices.MAX_DEVICES,
      devices: activation.current
    });
  }

  var receipt = {
    product: verified.productCode,
    txn: verified.txnId,
    issued_at: Math.floor(Date.now() / 1000)
  };
  var payload = Buffer.from(JSON.stringify(receipt), "utf8");

  var privateKey;
  try {
    privateKey = crypto.createPrivateKey({
      key: Buffer.from(privB64, "base64"),
      format: "der",
      type: "pkcs8"
    });
  } catch (e) {
    return json(res, 500, { error: "signing key is unreadable" });
  }

  /* Ed25519 用 crypto.sign(null, …)：算法由密钥本身决定，哈希参数须为 null。 */
  var signature = crypto.sign(null, payload, privateKey);

  return json(res, 200, {
    receipt: payload.toString("base64") + "." + signature.toString("base64"),
    product: receipt.product,
    /* 仅供界面提示，**不进回执** —— 回执一旦签发就是永久离线凭据，
       加可变字段会让"同一张码在两台机器上得到不同回执"，
       且客户端没有渠道知道第几台。 */
    devices: {
      used: activation.devices || null,
      max: devices.MAX_DEVICES,
      counted: !!activation.counted
    }
  });
};
