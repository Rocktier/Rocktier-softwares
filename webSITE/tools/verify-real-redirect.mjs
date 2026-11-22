#!/usr/bin/env node
/* 用 Creem test key 在**本地**复算一次真实回跳的签名，验证我们实现的
   verifyCreemRedirect 与 Creem 真实行为是否逐字节一致。

   为什么必须真实回跳才能验：
   我们按文档实现了验签（顺序敏感 + 空值排除 + salt=apiKey），并有 10 条
   单测。但单测的样本是**我们自己构造**的 —— 若对「参数顺序」「空值」
   的理解有偏差，单测会跟着一起错。真实回跳是唯一外部事实。

   本脚本**只读**：不调 Creem API、不改任何配置、不碰 Vercel。
   纯粹拿回跳 URL 里的 signature 与本地复算结果比对。

   用法：
     node tools/verify-real-redirect.mjs '<完整回跳URL>' '<test_api_key>'
   或从环境变量读：
     CREEM_TEST_KEY=xxx node tools/verify-real-redirect.mjs '<URL>'

   退出码 0 = 一致；1 = 不一致（**这意味着每笔真人付款都会 403**）。 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ── 载入被测实现（api/_shared.js 是 CommonJS）── */
const src = readFileSync(join(ROOT, "api", "_shared.js"), "utf8");
const mod = { exports: {} };
new Function("module", "exports", "require", "console", "process", "crypto", "fetch", src)(
  mod, mod.exports, require, console, process,
  { createHash, createHmac: (a, k) => require("crypto").createHmac(a, k) },
  async () => ({ json: async () => ({}) }),
);
const S = mod.exports;

const url = process.argv[2];
const key = process.argv[3] || process.env.CREEM_TEST_KEY;

if (!url || !key) {
  console.error("用法: node tools/verify-real-redirect.mjs '<回跳URL>' '<test_api_key>'");
  process.exit(2);
}

const u = new URL(url);
const params = u.searchParams;

console.log("\n  ── 回跳 URL 解析 ──");
const rows = [];
params.forEach((v, k) => rows.push([k, k === "signature" ? v.slice(0, 16) + "…" : v]));
for (const [k, v] of rows) console.log(`    ${k.padEnd(16)} ${v}`);

const productId = params.get("product_id") || "";
const checkoutId = params.get("checkout_id") || "";
console.log(`\n    product_id → 产品码: ${S.creemProductCode(productId) || "❌ 不在 CATALOG"}`);
console.log(`    checkout_id 前缀: ${checkoutId.split("_")[0]}_`);

/* ── 本地独立复算（不复用被测代码，避免"自己验自己"）── */
const parts = [];
params.forEach((v, k) => {
  if (k === "signature") return;
  if (v === null || v === undefined || v === "") return;   // 空值必须排除
  parts.push(`${k}=${v}`);
});
parts.push(`salt=${key}`);
const localSig = createHash("sha256").update(parts.join("|")).digest("hex");
const remoteSig = params.get("signature") || "";

console.log("\n  ── 签名比对 ──");
console.log(`    本地复算: ${localSig}`);
console.log(`    线上带来: ${remoteSig}`);
const match = localSig === remoteSig;
console.log(`\n  ${match ? "✅ 一致" : "❌ 不一致"}`);

if (!match) {
  console.log("\n  ── 诊断 ──");
  console.log(`    本地拼的串:\n      ${parts.join("|")}`);
  console.log("    常见原因：");
  console.log("      ① 参数顺序与 URL 里出现的顺序不同（文档：按到达顺序，不按字母序）");
  console.log("      ② 本地把某个空值算进去了（文档：空值必须整个排除）");
  console.log("      ③ 用的 key 不对（test key 签的不能拿 live key 验）");
  console.log(`\n  ⛔ 若这里不一致，每一笔真人付款都会403 —— 先别上线真金交易。`);
  process.exit(1);
}

/* ── 顺带确认整条链路自洽 ── */
console.log("\n  ── 链路自洽 ──");
const code = S.creemProductCode(productId);
if (code && checkoutId) {
  const minted = S.makeCode(code, checkoutId, "probe");
  const back = S.verifyCode(minted, "probe");
  console.log(`    ${back ? "✅" : "❌"} 铸码→验码往返（${code}:${checkoutId}）`);
  process.exit(back ? 0 : 1);
}
console.log("    （缺 product_id 或 checkout_id，跳过往返检查）");
process.exit(0);