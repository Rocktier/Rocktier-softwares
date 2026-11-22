#!/usr/bin/env node
/* 官网 8 语言生成器。
 *
 * ── 为什么单独一个生成器 ──
 *
 * 家族已有六种 i18n 形状（见 progress.md 阶段 38），官网是第七种：
 * **键值对全是平铺的短句**，且英文源从 HTML 抽取而来 —— 不是手写文件。
 *
 * 两条硬约束（与产品同一套，不能省）：
 *   ① 缺键即拒绝生成 —— 不产出「界面一半英文」的包；
 *   ② 结构一致由 tsc/运行时校验，键集合与 en 基线完全相同。
 *
 * ── 与产品的关键差异：价格不翻译 ──
 *
 * 用户已定：价格数字保持原样，只翻译周边说明文字。
 * 理由是 2026-10-04 移除中文字典的直接教训 —— 价格进翻译表后，
 * 每次调价要同步 8 门，漏一处就是「某语言显示旧价格」。
 *
 * 实现：含 `$数字` 的键**不进译文表**，运行时保留 HTML 原文。
 * 已在抽取阶段标出（20 个键）。
 *
 * ── 法律文本 ──
 *
 * terms/privacy 占 23% 字符。用户选择 8 门全译（含法律文本）。
 * 这些译文不具备法律效力，但让欧盟/日本用户能读懂我们在收集什么。
 *
 * 用法：node tools/gen-site-i18n.mjs [--lang ja]
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
/* 只被 JS 使用的控件名称键。它们不出现在 HTML 里，所以进不了英文基线；
   但运行时 labelControls() 要直读 dict，必须被合进 i18n/<lang>.json。 */
import { JS_ONLY_KEYS } from "./i18n/js-only-keys.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, "..");

const LANGS = ["zh"];

/* 家族标准语言表。2026-10-13 用户拍板全家族收敛为 en/zh 两种：
   非中英语种原为未审校机翻基线，家族准则既禁机翻直出上库，继续分发等于把
   违反自家规则的产物卖给付费用户。架构保留，后续有审校能力再逐门加回。 */
/* 由 LANGS 推导，**不手写第二份** —— 手写时 LANGS 缩了而这里没缩，
   4 个工具 import 这个 LOCALES 推导自己的语言集，于是它们仍是 7 门、
   闸门对已删的 6 个 json 报「缺文件」却仍给结论「全部一致」（假绿）。 */
const ENDONYM = { zh: "中文" };
export const LOCALES = [
  { code: "en", endonym: "English" },
  ...LANGS.map((c) => ({ code: c, endonym: ENDONYM[c] || c })),
];

const only = process.argv.includes("--lang")
  ? process.argv[process.argv.indexOf("--lang") + 1]
  : null;

/* ── 英文基线（由 extract-site-i18n.mjs 生成）── */
const EN_PATH = join(HERE, "site-i18n.en.json");
if (!existsSync(EN_PATH)) {
  console.error("  ❌ 找不到英文基线，先跑：node tools/extract-site-i18n.mjs");
  process.exit(2);
}
/* 读整个基线，不只是 .keys —— 运行时还需要 lookup 与 prices。
   之前写成 `.keys`，于是 payload.lookup 恒为 undefined，
   运行时每个元素都「查不到译文」而保留英文。 */
const BASE = JSON.parse(readFileSync(EN_PATH, "utf8"));
const EN = BASE.keys;
console.error(
  `  英文基线: ${Object.keys(EN).length} 键 · ` +
    `lookup ${Object.keys(BASE.lookup || {}).length} 项 · ` +
    `prices ${Object.keys(BASE.prices || {}).length} 项`,
);
if (!BASE.lookup) {
  console.error("  ❌ 基线缺 lookup —— 重跑 tools/extract-site-i18n.mjs");
  process.exit(2);
}

/* ── 主流程 ── */
const results = [];
let missingTotal = 0;

for (const lang of only ? [only] : LANGS) {
  let dict = {};
  try {
    dict = (await import(`./i18n/${lang}.mjs`)).default || {};
  } catch (e) {
    /* 不要静默吞：空 catch 会把「译文表有语法错误」伪装成「缺 N 条」，
       我据此在错方向上找了很久（Sign 阶段踩过）。区分两种情况。 */
    if (e && e.code === "ERR_MODULE_NOT_FOUND") {
      console.error(`     (tools/i18n/${lang}.mjs 尚未创建)`);
    } else {
      console.error(`  ❌ tools/i18n/${lang}.mjs 无法导入: ${String(e.message).split("\n")[0]}`);
      missingTotal++;
      continue;
    }
  }

  const missing = [];
  const unknown = [];
  for (const [k, en] of Object.entries(EN)) {
    const v = dict[k];
    if (typeof v !== "string" || !v.trim()) {
      missing.push(`${k} = ${String(en).slice(0, 44)}`);
      continue;
    }
    // 占位符必须对齐：漏一个就会在界面上露出 {name} 或丢掉变量
    const want = [...en.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort().join(",");
    const got = [...v.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort().join(",");
    if (want !== got) {
      missing.push(`${k} — 占位符不符（源 {${want}} / 译文 {${got}}）`);
    }
  }
  // 译文表里多余的键（改名后忘了删旧键，运行时是死数据）。
  // JS-only 键不在此列：它们本来就该在译文表里，只是不在英文基线里。
  for (const k of Object.keys(dict)) {
    if (!(k in EN) && !JS_ONLY_KEYS.includes(k)) unknown.push(k);
  }

  if (missing.length) {
    missingTotal += missing.length;
    console.error(`\n  ⚠️ ${lang}: 缺 ${missing.length} 条`);
    missing.forEach((m) => console.error(`      ${m}`));
  }
  if (unknown.length) {
    console.error(`  ⚠️ ${lang}: ${unknown.length} 个键在英文基线里不存在（多余）:`);
    unknown.slice(0, 8).forEach((k) => console.error(`      ${k}`));
    if (unknown.length > 8) console.error(`      … 另 ${unknown.length - 8} 个`);
  }
  if (!missing.length) {
    console.error(`  ✅ ${lang}: ${Object.keys(EN).length} 条齐全${unknown.length ? `（另有 ${unknown.length} 个多余键）` : ""}`);
    results.push([lang, dict]);
  }
}

if (!results.length) {
  console.error(`\n  ❌ 没有一门语言通过（共 ${missingTotal} 条缺译文）。\n`);
  process.exit(1);
}

/* ── 输出：每门一个 JSON，供运行时 fetch ── */
const outDir = join(SITE, "i18n");
if (!existsSync(outDir)) {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(outDir, { recursive: true });
}

const written = [];
/* en.json 也要生成 —— 运行时的 applyEn() 从它取 en_text，
   用来在切回英文时还原 DOM（元素内容已被译文覆盖，
   HTML 源码里的英文原文需要单独一份）。
   它没有「译文」可言，keys 就是英文基线本身。 */
{
  const payload = {
    _comment:
      "由 tools/gen-site-i18n.mjs 生成 —— 英文基线，供运行时切回英文时取用。",
    locale: "en",
    endonym: "English",
    keys: EN,
    lookup: BASE.lookup,
    prices: BASE.prices,
    en_text: BASE.en_text,
  };
  writeFileSync(join(outDir, "en.json"), JSON.stringify(payload, null, 0) + "\n");
  written.push("en");
}

for (const [lang, dict] of results) {
  /* 每门语言都要带全三样：
   *   keys    译文
   *   lookup  "<页面>::<原始键>" → 字典键。**每门都要带**，因为运行时
   *          靠它把页面上的 data-i18n 原值映射到字典键；缺了就找不到译文，
   *          页面静默退回英文（看起来像「只翻译了一部分」）。
   *   prices  字典键 → 价格数组，用于回填 {p1} {p2}。同样每门都要带。
   *
   * 实测踩过：最初只输出了 keys，运行时按 lookup 取值必然 undefined，
   * 于是每个元素都「查不到译文」而保留英文 —— 控制台只报一句载入失败，
   * 排查方向完全被带偏（先怀疑了 fetch 和路径）。
   */
  const payload = {
    _comment: "由 tools/gen-site-i18n.mjs 生成 —— 请勿手改。改译文请改 tools/i18n/<lang>.mjs 后重跑。",
    locale: lang,
    endonym: LOCALES.find((l) => l.code === lang)?.endonym,
    lookup: BASE.lookup,
    prices: BASE.prices,
    en_text: BASE.en_text,
    /* 基线里的键 + JS-only 的控件名称键。
       JS-only 的英文原文写在 js/i18n.js 的 fallback 参数里（en 模式根本不读 dict），
       所以它们不需要出现在 en.json 里；中文译文则必须在这里带上，
       否则运行时 dict 取不到，labelControls() 静默回退英文。 */
    keys: Object.fromEntries(
      [...Object.keys(EN), ...JS_ONLY_KEYS.filter((k) => typeof dict[k] === "string" && dict[k].trim())]
        .map((k) => [k, dict[k]]),
    ),
  };
  const p = join(outDir, `${lang}.json`);
  writeFileSync(p, JSON.stringify(payload, null, 0) + "\n");
  written.push(lang);
}

console.error(`\n  ✅ 已生成 i18n/${written.join(", ")}.json`);
console.error(`     基线 ${Object.keys(EN).length} 键，另含 ${JS_ONLY_KEYS.length} 个 JS-only 控件名称键\n`);