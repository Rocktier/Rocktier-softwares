#!/usr/bin/env node
/**
 * 生成授权体系的 Ed25519 密钥对。
 *
 * 为什么是非对称而不是对称密钥：应用要**离线**验签，而离线验签若用对称密钥，
 * 那把密钥就必须打进每一个用户的二进制里 —— 谁都能反编译取出，然后自制无限
 * 激活码。非对称下，应用只持有**公钥**（泄露无害），签名只有服务端能做。
 *
 * 用法：
 *   node tools/license-keygen.mjs
 *
 * 输出两项，分别放到不同的地方 —— 这是本脚本存在的全部意义：
 *
 *   LICENSE_PRIVATE_KEY  → **只进服务端环境变量**（Vercel），绝不进仓库、绝不进应用。
 *   LICENSE_PUBLIC_KEY   → 进应用源码 `Rocktier PDF/src-tauri/src/license.rs`
 *                          的 `PUBLIC_KEY_B64` 常量（公开内容，可入仓库）。
 *
 * 应用侧只有在**公钥已配置**且渠道为直链版时才会启用试用拦截（见 license.rs 的
 * `enforced()`）—— 这样"忘了配密钥"不会变成"用户被锁在门外"。
 */
import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

/* 私钥用 PKCS#8 DER 的 base64：单行，适合放进环境变量（PEM 的多行在 env 里很别扭）。
   服务端用 crypto.createPrivateKey({ key: Buffer.from(b64,"base64"), format:"der", type:"pkcs8" }) 读回。 */
const privDer = privateKey.export({ format: "der", type: "pkcs8" });
const privB64 = Buffer.from(privDer).toString("base64");

/* 公钥用 JWK 的 x 字段：那正好是 Ed25519 的 32 字节裸公钥，而 rust 侧
   ed25519_dalek::VerifyingKey::from_bytes 要的就是这 32 字节。
   直接导出 SPKI 会多出 12 字节 DER 前缀，反而要再剥一次。 */
const jwk = publicKey.export({ format: "jwk" });
const pubBytes = Buffer.from(jwk.x, "base64url");

console.log("");
console.log("  ── 1) 服务端环境变量（Vercel → Settings → Environment Variables）");
console.log("      注意：私钥只放这里，不要写进任何仓库文件。");
console.log("");
console.log(`  LICENSE_PRIVATE_KEY=${privB64}`);
console.log("");
console.log("  ── 2) 应用源码常量");
console.log("      文件：Rocktier PDF/src-tauri/src/license.rs");
console.log("      常量：PUBLIC_KEY_B64");
console.log("");
console.log(`  pub const PUBLIC_KEY_B64: &str = "${pubBytes.toString("base64")}";`);
console.log("");
console.log("  ── 3) 自检（可选，建议做一次）");
console.log("      生成一对新密钥会作废此前所有已发出的激活码 —— 因为码本身是用");
console.log("      LICENSE_SECRET 签的（不变），但**回执**是这份新私钥签的。");
console.log("      换句话说：换密钥不需要重新卖，老买家重新激活一次即可。");
console.log("");
