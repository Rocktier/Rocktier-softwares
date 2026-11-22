#!/usr/bin/env node
/**
 * 验证「服务端私钥」与「应用源码里的公钥」确实是同一对。
 *
 * 为什么需要它：这两半分散在两个地方 —— 私钥在 Vercel 的环境变量里，公钥在应用的
 * 源码常量里，由人**手工**粘贴（而生成脚本每跑一次都会产生一对新的）。若拿错了配对：
 * 服务端照样签名、照样返回回执，应用却永远验不过 —— **症状与"用户把激活码输错了"
 * 完全一样**，所以只有付过钱的人才会发现。
 *
 * 用法（私钥走 stdin，不进 shell 历史、也不出现在命令行里）：
 *
 *   cd rocktier.com
 *   read -rs PRIV
 *   <粘贴私钥后回车>
 *   LICENSE_PRIVATE_KEY="$PRIV" node tools/verify-keypair.mjs
 *
 * 它会去读 `Rocktier PDF/src-tauri/src/license.rs` 里的 `PUBLIC_KEY_B64` —— 也就是
 * **应用真正嵌入的那一个**。仓库路径不同的话用 `LICENSE_RS=<path>` 指定，
 * 或直接给公钥：`LICENSE_PUBLIC_KEY=<base64> ...`。
 *
 * 只打印结论，不打印任何密钥。
 */
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function fail(msg) {
  console.error(`\n  ❌ ${msg}\n`);
  process.exit(1);
}

/** 从 license.rs 里抠出 PUBLIC_KEY_B64 的字面量。 */
function readEmbeddedPublicKey(path) {
  let src;
  try {
    src = readFileSync(path, "utf8");
  } catch {
    fail(
      `找不到应用源码：${path}\n` +
        `     用 LICENSE_RS=<license.rs 的路径> 指定，或直接给公钥：LICENSE_PUBLIC_KEY=<base64>`
    );
  }
  const m = /pub const PUBLIC_KEY_B64:\s*&str\s*=\s*"([^"]*)"/.exec(src);
  if (!m) fail(`在 ${path} 里没找到 PUBLIC_KEY_B64`);
  if (!m[1]) fail(`应用里的 PUBLIC_KEY_B64 是空的 —— 那就还没有可配对的公钥`);
  return m[1];
}

const privB64 = (process.env.LICENSE_PRIVATE_KEY || "").trim();
if (!privB64) {
  fail(
    "没有拿到私钥。请按脚本文档里的用法，用 stdin 传入：\n" +
      "       read -rs PRIV  →  粘贴后回车  →  LICENSE_PRIVATE_KEY=\"$PRIV\" node tools/verify-keypair.mjs"
  );
}

const pubB64 = (
  process.env.LICENSE_PUBLIC_KEY ||
  readEmbeddedPublicKey(process.env.LICENSE_RS || join(here, "..", "..", "Rocktier PDF", "src-tauri", "src", "license.rs"))
).trim();

/* 私钥建不建得起来，本身就说明 base64/格式对不对。 */
let privateKey;
try {
  privateKey = createPrivateKey({
    key: Buffer.from(privB64, "base64"),
    format: "der",
    type: "pkcs8",
  });
} catch (e) {
  fail(`私钥读不出来（多半是复制时漏了字符）：${e.message}`);
}

/* 公钥是 **32 字节裸密钥**（Ed25519 的 JWK `x`），不是 DER/SPKI —— 按 DER 解会得到
   一把垃圾密钥，于是"明明配对了"也会被判成不配。这一步曾在双向测试里被当场抓到。 */
const pubRaw = Buffer.from(pubB64, "base64");
if (pubRaw.length !== 32) {
  fail(`公钥应为 32 字节，实际 ${pubRaw.length} 字节 —— 粘贴时多半漏了字符`);
}
let publicKey;
try {
  publicKey = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: pubRaw.toString("base64url") },
    format: "jwk",
  });
} catch (e) {
  fail(`公钥读不出来：${e.message}`);
}

/* 拿固定内容签一次，再用公钥验一次。这一条能同时发现：配对拿错、粘贴不全、格式不符。
   注意 Node 的签名/验签都是 (algorithm, data, key[, signature]) —— Ed25519 的
   algorithm 传 null。少传这个参数会把 data 当成 algorithm，报的却是
   "The algorithm argument must be of type string"，很容易看错方向（曾在此处栽过）。 */
const challenge = Buffer.from("rocktier-keypair-check", "utf8");
let signature;
try {
  signature = sign(null, challenge, privateKey);
} catch (e) {
  fail(`签名失败：${e.message}`);
}
console.log(`     签名长度 ${signature.length} 字节（Ed25519 应为 64）`);

let ok = false;
try {
  ok = verify(null, challenge, publicKey, signature);
} catch (e) {
  fail(`验签失败：${e.message}`);
}

/* 短的公钥指纹，便于与别处对照；不泄漏任何秘密。 */
const fp = pubRaw.toString("hex").slice(0, 12);

if (ok) {
  console.log("");
  console.log("  ✅ 配对了：服务端私钥与「应用里嵌入的公钥」是同一对。");
  console.log(`     公钥指纹（前 12 位，可对账用）: ${fp}`);
  console.log("");
  console.log("     下一步可以放心做一次真实购买的走通测试。");
  console.log("");
} else {
  fail(
    "配不上：私钥与「应用里嵌入的公钥」不是同一对。\n" +
      "     后果是服务端会正常签名，但应用永远验不过 —— 与「激活码输错了」表现一致。\n" +
      `     当前读到的公钥指纹: ${fp}\n` +
      "     处理办法：重新生成一对（node tools/license-keygen.mjs），私钥进 Vercel、\n" +
      "     公钥粘进 license.rs 的 PUBLIC_KEY_B64，**两半必须来自同一次输出**。"
  );
}
