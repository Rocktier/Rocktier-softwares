#!/usr/bin/env node
/**
 * 产品码双侧一致性校验（发码前必须跑）。
 *
 * 官网 CATALOG 是发码侧，8 款应用的 license.rs 是验码侧，中间只靠两字符产品码连接。
 * 历史上已经出过两次「两侧不同批」：
 *   1) SQ→PD：PDF 改了、官网没改，付款用户全部激活失败；
 *   2) JI/JO：官网目录写 JI，Journal 客户端从 2026-10 起只认 JO。
 * 两侧各自的单测都测不出这个问题——各测各的都对，合起来不通。
 *
 * 判据：每一款的「本单品码」必须同时出现在客户端白名单和官网 CATALOG；
 * 官网购买按钮、装块脚本、对表夹具里的产品码也必须能在 CATALOG 里查到。
 *
 * 用法：node tools/verify-product-codes.mjs
 * 退出码：0 = 全一致；1 = 有不一致（逐条打印）
 */
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, "..");
const MONOREPO = join(SITE, "..");
const require = createRequire(import.meta.url);
const { CATALOG } = require(join(SITE, "api/_shared.js"));

/* 应用目录名 → 该应用自己的产品码。全家桶 FL 由白名单另行校验。 */
const OWN_CODE = {
  pdf: "PD",
  pic2webp: "WP",
  markdown: "MD",
  "cad-viewer": "CV",
  ocr: "OC",
  write: "WR",
  journal: "JO",
  compressor: "CO",
};

const problems = [];
const check = (ok, message) => {
  if (!ok) problems.push(message);
};

for (const [app, own] of Object.entries(OWN_CODE)) {
  const path = join(MONOREPO, "apps", app, "src-tauri/src/license.rs");
  let src;
  try {
    src = readFileSync(path, "utf8");
  } catch {
    problems.push(`${app}: 读不到 ${path}`);
    continue;
  }
  const m = /ACCEPTED_PRODUCTS:\s*\[&str;\s*\d+\]\s*=\s*\[([^\]]+)\]/.exec(src);
  if (!m) {
    problems.push(`${app}: license.rs 里找不到 ACCEPTED_PRODUCTS 数组`);
    continue;
  }
  const accepted = [...m[1].matchAll(/"([A-Z0-9]{2,4})"/g)].map((x) => x[1]);
  check(accepted.includes(own), `${app}: 客户端白名单 [${accepted}] 不含本单品码 ${own}`);
  check(accepted.includes("FL"), `${app}: 客户端白名单 [${accepted}] 不含全家桶 FL`);
  check(Object.hasOwn(CATALOG, own), `${app}: 官网 CATALOG 无 ${own}（客户端却认它）`);
}

/* 购买按钮上的 data-product 必须能查到目录项，否则 Creem 成功回跳后换不到码。 */
for (const file of readdirSync(SITE).filter((f) => f.endsWith(".html"))) {
  const html = readFileSync(join(SITE, file), "utf8");
  for (const m of html.matchAll(/data-product="([A-Z0-9]{2,4})"/g)) {
    check(Object.hasOwn(CATALOG, m[1]), `${file}: data-product=${m[1]} 不在 CATALOG`);
  }
}

/* 装块脚本是购买区的「母版」，它写错的码会被重新铺回所有产品页。 */
const blocks = readFileSync(join(SITE, "tools/apply-buy-blocks.mjs"), "utf8");
for (const m of blocks.matchAll(/code:\s*"([A-Z0-9]{2,4})"/g)) {
  check(Object.hasOwn(CATALOG, m[1]), `apply-buy-blocks.mjs: code=${m[1]} 不在 CATALOG`);
}

/* 对表夹具用的是真正会签发的码；产品码过时等于在验一张死码。 */
const fixture = readFileSync(join(SITE, "tools/activation-fixture.mjs"), "utf8");
const fm = /const product = "([A-Z0-9]{2,4})"/.exec(fixture);
check(!!fm, "activation-fixture.mjs: 找不到 const product");
if (fm) check(Object.hasOwn(CATALOG, fm[1]), `activation-fixture.mjs: product=${fm[1]} 不在 CATALOG`);

if (problems.length) {
  console.error("产品码一致性 FAIL:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log(`产品码一致性 OK: ${Object.keys(OWN_CODE).length} 款客户端 ↔ CATALOG(${Object.keys(CATALOG).length} 项) ↔ 购买区 ↔ 夹具`);
