/* audit-site-i18n.mjs 的差异判定变异测试。
 *
 * 为什么单独成文件：这个判定只有 3 行，却决定 2821 条报告的**信噪比**。
 * 判据一偏，要么满屏误报没人看（闸门效应），要么漏报真问题（更糟）。
 *
 * 两次真实翻车记录：
 *   ① placeholders() 写了 .sort() —— 价格 {p1}/{p2} 语序颠倒被判「一致」。
 *      排序是想忽略顺序，但价格顺序在日语里恰恰有含义。
 *   ② 拿真实价格 $14.99 造测试用例，而实际数据里价格**已经是 {p1} 占位符**
 *      —— 测试的是不存在的数据形态，结论无效。
 *
 * 用法：node tools/test-audit-diff.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "audit-site-i18n.mjs");
const src = readFileSync(SRC, "utf8");

/* 从被测文件里**抠出**判据，而不是在这里重抄一份 ——
   重抄会与实现漂移，测的就不是被测对象了。 */
const grab = (name) => {
  const m = src.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
  if (!m) throw new Error(`抠不出 ${name}`);
  return m[0];
};
const PLACEHOLDER = /\{\{[^}]+\}\}|\$\{[^}]+\}|\{[^}]*\}|__[A-Z_]+__|RKT-[A-Z0-9-]+|\$[\d.,]+/g;
const fns = new Function(
  "PLACEHOLDER",
  grab("placeholders") + "\n" + grab("normalize") + "\n" + grab("diffOf") +
  "\nreturn {placeholders, normalize, diffOf};",
)(PLACEHOLDER);
const { diffOf } = fns;

/* 用例形态必须与真实数据一致：**价格是 {p1} 占位符，不是 $14.99** */
const CASES = [
  ["价格占位符·结构同",   "One-time {p1}",           "買い切り {p1}",           "wording"],
  ["机翻吃掉 {p1}",       "One-time {p1}",           "One-time",                "placeholder"],
  ["机翻改占位符名",      "One-time {p1}",           "One-time {price}",        "placeholder"],
  ["双价格·顺序颠倒",     "{p1} per app, {p2}",      "{p2}、{p1}",              "placeholder"],
  ["双价格·顺序一致",     "{p1} per app, {p2}",      "{p1} ごと、{p2}",         "wording"],
  ["7天试用·结构同",      "7-day trial, then {p1}",  "7 日間、その後 {p1}",      "wording"],
  ["纯空白差异",          "Get started",             " Get  started ",          "identical"],
  ["全角半角·纯标点",     "one, two.",               "one, two.",               "identical"],
  ["RKT 码丢失",          "Enter RKT-XXXX",          "Enter your code",         "placeholder"],
  ["天数占位符丢失",      "{days} days left",        "days left",               "placeholder"],
  ["措辞不同",            "はじめる",                 "始めましょう",              "wording"],
  ["引号样式差异",        "the “Pro” plan",          "the “Pro” plan",          "identical"],
  /* 下面三条来自实测：百度机翻在这三处把 {p1} 整个吞掉了，
     「一次 {p1}，没有订阅」→「只需一次购买，无需订阅」。
     写进测试是因为这类「占位符丢失」正是审校唯一能给的高信噪比结论，
     不能靠人眼在 403 条里发现。 */
  ["价格占位符被吞(实测)", "no lock-in — {p1} once",  "无需锁定——只需一次购买",   "placeholder"],
  ["试用+价格都丢(实测)",  "7-day trial, {p1} once.", "提供7天免费试用，仅限一次", "placeholder"],
  ["占位符数量不同",       "{p1} per app, {p2}",      "{p1}",                     "placeholder"],
];

let pass = 0;
console.log("");
for (const [name, ours, theirs, want] of CASES) {
  /* why 带明细（"placeholder {p1} vs "）—— 那是刻意保留的可诊断性，
     报告里要靠它看差在哪。断言只比前缀，不比全串。 */
  const got = diffOf("", ours, theirs).why;
  const ok = got.startsWith(want);
  if (ok) pass++;
  console.log(
    `  ${ok ? "✅" : "❌"} ${name.padEnd(20)} 期望=${want.padEnd(12)} 实得=${got}`,
  );
}
console.log(`\n  ${pass}/${CASES.length} 通过\n`);
process.exit(pass === CASES.length ? 0 : 1);
