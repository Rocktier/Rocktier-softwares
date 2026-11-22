#!/usr/bin/env node
/**
 * 生成一份"服务端真实签出的回执"夹具，供 Rust 侧对表。
 *
 * 用法（在 rocktier.com 目录下）：
 *   node tools/activation-fixture.mjs > /tmp/activation-fixture.json
 *
 * 然后在 Rocktier PDF/src-tauri 下：
 *   ROCKTIER_ACTIVATION_FIXTURE=/tmp/activation-fixture.json cargo test activation_fixture
 *
 * 它为什么存在：应用与服务端分属两个语言、两个仓库，中间只靠"线格式"连接。
 * 字段名写成 camelCase、少一层 base64、payload 与签名用 `:` 而不是 `.` 拼接 ——
 * 任何一处不一致都会让**付了钱的用户激活不了**，而这类错误在两侧各自的单元测试里
 * 都看不出来（各测各的都对，合起来不通）。这份夹具把两侧钉在一起。
 *
 * 用临时密钥对与临时 HMAC 密钥，不触碰任何真实凭据。
 */
import { createRequire } from "node:module";
import { generateKeyPairSync } from "node:crypto";
import process from "node:process";

const require = createRequire(import.meta.url);

/* ── 造一对临时密钥，并把端点需要的环境变量铺好（必须在 require 之前）── */
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const privB64 = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" })).toString("base64");
const pubB64 = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");

process.env.LICENSE_SECRET = "test-secret-not-used-in-production";
process.env.LICENSE_PRIVATE_KEY = privB64;
process.env.LICENSE_ENV = "sandbox";

const shared = require("../api/_shared.js");
const activate = require("../api/activate.js");

/* ── 像 webhook 那样发一个码 ── */
const product = "SQ";
const txn = "txn_fixture_" + Date.now();
const code = shared.makeCode(product, txn, process.env.LICENSE_SECRET);

/* ── 用最小的 req/res 打桩，直接调用真正的端点处理器 ──
   （不复制它的逻辑：复制出来的东西不叫验证。）*/
const { EventEmitter } = require("node:events");

function fakeReq(bodyObj) {
  const req = new EventEmitter();
  req.method = "POST";
  req.headers = { "content-type": "application/json" };
  setImmediate(() => {
    req.emit("data", Buffer.from(JSON.stringify(bodyObj), "utf8"));
    req.emit("end");
  });
  return req;
}

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    end(s) { this.body = s; this.finished = true; },
  };
}

const res = fakeRes();
await activate(fakeReq({ code }), res);

if (res.statusCode !== 200) {
  console.error(`  ❌ 端点返回 ${res.statusCode}: ${res.body}`);
  process.exit(1);
}

const parsed = JSON.parse(res.body);
const out = {
  note: "由 tools/activation-fixture.mjs 生成：服务端真实签出的回执，供 Rust 侧验签对表",
  code,
  product,
  txn,
  publicKey: pubB64,
  receipt: parsed.receipt,
  cors: res.headers["Access-Control-Allow-Origin"] || null,
};

process.stdout.write(JSON.stringify(out, null, 2) + "\n");

/* 自检也走 stderr，别污染给 Rust 的 JSON */
console.error("  ✅ 夹具已生成");
console.error(`     码      : ${code}`);
console.error(`     CORS 头 : ${out.cors}（webview 跨源调用必需）`);
console.error(`     回执长度: ${parsed.receipt.length} 字符`);
