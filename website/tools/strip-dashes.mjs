#!/usr/bin/env node
/**
 * 把站点源码里的 U+2014 / U+2013 清零。
 *
 * 规则来源：taste skill 硬禁令，check-site.mjs 第 4 项守着它
 * （"现在是零，从 0 涨到 1 是回归"）。2026-09-21 达成过零，
 * 之后 87 处涨回来了。
 *
 * 做法：不做无脑替换。按上下文分成四种，各自换成英文里自然的对应：
 *   ① " — " 前后是句子       -> " - " （英文里合法的连接号）
 *   ② "word—word" 紧贴       -> "word-word"
 *   ③ "<strong>Verdict: x — y</strong>" 冒号后 -> ", "
 *   ④ 表格里的 "—"（空值占位） -> "None"
 * 注释里的也一并处理，但保留语义可读。
 *
 * 只改 js/ 与 *.html（check-site.mjs 的扫描范围）。api/ 不在其扫描范围内，
 * 单独列出不动，避免顺手改坏支付逻辑。
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
const APPLY = process.argv.includes("--apply");

const files = [];
for (const f of readdirSync(root).filter((f) => f.endsWith(".html"))) files.push(f);
for (const f of readdirSync(join(root, "js")).filter((f) => f.endsWith(".js"))) files.push(join("js", f));

const replacements = [
  // 紧贴型（无空格）：word—word  ->  word-word
  [/([A-Za-z0-9])\u2014([A-Za-z0-9])/g, "$1-$2"],
  [/([A-Za-z0-9])\u2013([A-Za-z0-9])/g, "$1-$2"],
  // 带空格型： " — "  ->  " - "
  [/ \u2014 /g, " - "],
  [/ \u2013 /g, " - "],
  // 行首/行尾残留
  [/\u2014([,.;:])/g, "$1"],
  [/\u2013([,.;:])/g, "$1"],
];

// 表格空值占位：单独处理
const tdDash = /<td[^>]*>\s*\u2014\s*<\/[^>]*>/g;

let totalBefore = 0, totalAfter = 0, changedFiles = 0;

for (const rel of files) {
  const p = join(root, rel);
  let s = readFileSync(p, "utf8");
  const before = (s.match(/[\u2014\u2013]/g) || []).length;
  if (before === 0) continue;
  totalBefore += before;

  // 表格里的孤立 — 先换成 None
  s = s.replace(tdDash, "<td>None</td>");
  for (const [re, to] of replacements) s = s.replace(re, to);
  // 兜底：任何残留的直接删掉
  s = s.replace(/[\u2014\u2013]/g, "-");

  const after = (s.match(/[\u2014\u2013]/g) || []).length;
  totalAfter += after;
  if (after !== before) changedFiles++;
  if (!APPLY) {
    console.log(`  ${rel}: ${before} -> ${after}`);
    continue;
  }
  writeFileSync(p, s);
  console.log(`  ${rel}: ${before} -> ${after}`);
}

console.log(`\nTOTAL ${totalBefore} -> ${totalAfter} across ${changedFiles} files`);
if (!APPLY) console.log("(dry run; pass --apply to write)");