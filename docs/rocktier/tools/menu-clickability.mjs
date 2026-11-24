#!/usr/bin/env node
/* 家族菜单栏可点性检测 —— CLI 入口。
   核心逻辑在 menu-clickability-lib.mjs（中央闸门 family-check.mjs 也用它，
   两份实现会漂移，所以只留一份）。

   用法：
     node tools/menu-clickability.mjs            汇总表
     node tools/menu-clickability.mjs --verbose  每仓明细（含死项定义位置）
   退出码：0 = 全有响应；1 = 有死项。 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runMenuCheck } from "./menu-clickability-lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const VERBOSE = process.argv.includes("--verbose");

const m = runMenuCheck(ROOT);
console.log(`\n  ── 家族菜单可点性检测（${m.products} 个产品仓 / 共 ${m.rows.reduce((n, r) => n + r.n, 0)} 个菜单项）──`);

if (VERBOSE) {
  for (const r of m.rows) {
    console.log(`\n  ── ${r.label} ──`);
    console.log(`      菜单项(${r.n}): ${[...r.where.keys()].join(", ")}`);
    console.log(`      分发: ${r.mode}${r.feListened === null ? "" : ` · 前端 listen=${r.feListened}`}`);
    if (r.dead.length) {
      console.log(`      ❌ 点了无反应 (${r.dead.length}):`);
      for (const d of r.dead) console.log(`         ${d.padEnd(20)} 定义于 ${r.where.get(d)}`);
    } else console.log(`      ✅ 全部有响应`);
  }
}

console.log(`\n  ${"仓库".padEnd(30)} ${"项".padEnd(4)} ${"分发".padEnd(22)} 结果`);
console.log(`  ${"-".repeat(76)}`);
for (const r of m.rows) {
  const res = r.dead.length ? `❌ ${r.dead.length} 死项: ${r.dead.join(",")}` : "✅";
  console.log(`  ${r.label.padEnd(30)} ${String(r.n).padEnd(4)} ${r.mode.padEnd(22)} ${res}`);
}
console.log("");
console.log(m.deadAll === 0
  ? "  ✅ 全部菜单项都有响应路径"
  : `  ❌ ${m.deadAll} 个菜单项点了没有任何反应`);
console.log("");
process.exit(m.deadAll === 0 ? 0 : 1);