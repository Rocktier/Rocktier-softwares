#!/usr/bin/env node
/**
 * 人工作废一个激活码（按交易号作废，不按激活码本身）。
 *
 * 什么时候需要它：
 *   1. 支付平台的退款事件里拿不到交易号 —— 那时日志会出现 `[REVOKE-NEEDED]`，
 *      这就是补刀的地方；
 *   2. 争议、例外退款，或需要立刻停掉某个码（比如滥用）。
 *
 * 为什么按交易号而不是按激活码：激活码的内容就是 `<产品码>:<交易号>`，交易号才是
 * 那笔钱的唯一标识；用它做键，作废与发码用的是同一套命名空间（见 _shared.js）。
 *
 * 用法（需要 Vercel KV 的那两个环境变量；LICENSE_ENV 要与站点当前使用的一致）：
 *
 *   export KV_REST_API_URL=... KV_REST_API_TOKEN=...
 *   export LICENSE_ENV=live
 *
 *   node tools/revoke.mjs txn_01hxxx "refunded by support"   # 作废
 *   node tools/revoke.mjs txn_01hxxx --check                 # 只查状态，不写入
 *
 * 作废只影响**此后的兑换** —— 已经激活过的机器是离线验签的，不会被远程失效。
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const shared = require("../api/_shared.js");

const args = process.argv.slice(2);
const onlyCheck = args.includes("--check");
const rest = args.filter((a) => a !== "--check");
const txnId = rest[0];
const reason = rest.slice(1).join(" ") || "revoked manually";

if (!txnId) {
  console.error("\n  用法: node tools/revoke.mjs <交易号> [原因 | --check]\n");
  process.exit(1);
}

const prefix = shared.envPrefix();
console.log(`\n  环境前缀: ${prefix}  （由 LICENSE_ENV 决定，缺省 sandbox）`);

if (onlyCheck) {
  const revoked = await shared.isRevoked(txnId);
  console.log(`  交易号  : ${txnId}`);
  console.log(`  状态    : ${revoked ? "已作废 ❌（换不到回执）" : "正常 ✅"}\n`);
  process.exit(0);
}

const status = await shared.markRevoked(txnId, reason);
if (status === 0) {
  console.error("  ❌ 写入 KV 失败（检查 KV_REST_API_URL / KV_REST_API_TOKEN）");
  process.exit(1);
}
console.log(`  ✅ 已作废: ${txnId}`);
console.log(`     原因  : ${reason}`);
console.log("     此后该码换不到回执；已激活的机器不受影响（离线验签）。\n");
