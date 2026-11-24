#!/usr/bin/env node
/* 从已对齐的产品里反推**家族批准术语**。

   ── 为什么反推而不是重新翻译 ──
   OCR 的 ui/lang.js 写着：
       「许可文案逐键对齐 Pic2WebP i18n.js（4f669ac 起），家族术语保持一致」
   也就是说 OCR 与 Pic2WebP 的条款文案**已经人工确认过、且 8 语言对齐**。
   这批译文是家族里唯一「已知正确」的语料 —— 拿它当术语基线，
   比重新翻译一遍更准，也省掉一轮校对。

   三个已达标产品（Write 9 语言 / OCR 8 / Pic2WebP 8）里，
   **同名键**上的译文就是「同一个概念在不同产品里必须一致」的地方。

   用法：
     node tools/extract-glossary.mjs                预览
     node tools/extract-glossary.mjs --json        输出 JSON
     node tools/extract-glossary.mjs --locale ja   只看某语言
*/

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ARGS = process.argv.slice(2);
const AS_JSON = ARGS.includes("--json");
const ONLY = ARGS.includes("--locale") ? ARGS[ARGS.indexOf("--locale") + 1] : null;

/* 已对齐的产品。OCR 与 Pic2WebP 明确声明「逐键对齐」，
   Write 是家族里语言最全的（9 种，含独有的 fr）。 */
const SOURCES = [
  { id: "ocr", file: "Rocktier OCR/ui/lang.js" },
  { id: "pic2webp", file: "Rocktier Pic2Webp/src/i18n.js" },
  { id: "write", file: "Rocktier Write/src/i18n.ts" },
];

/* 从源码里抽出 { locale: { key: value } }。
   三种键写法都要认 —— 这是提取器最容易翻车的地方：
     en: {            ← 语言块（裸标识符）
     "subtitle": "…"  ← Pic2WebP：带引号的键
     toolbar: {       ← 嵌套对象组（不是语言）
   曾三次提取失败：①只认裸键 → Pic2WebP 返回 0 条
                  ②用 `:` 计数 → 把嵌套对象算成键，报「键数不齐」的假警报
                  ③把局部变量 `const nl = …` 当语言 */
function extract(file) {
  const src = readFileSync(file, "utf8");
  const LOC = new Set(["en", "zh", "ja", "ko", "de", "es", "pt", "ar", "fr", "it", "ru", "nl", "pl", "tr", "vi"]);
  const out = {};

  for (const m of src.matchAll(/(?:^|\n)([ \t]{0,4})([a-z]{2})\s*:\s*\{/g)) {
    if (!LOC.has(m[2])) continue;
    const start = m.index + m[0].length;
    /* 配对花括号取出该语言块 */
    let d = 1, i = start;
    while (i < src.length && d > 0) {
      if (src[i] === "{") d++;
      else if (src[i] === "}") d--;
      i++;
    }
    const body = src.slice(start, i - 1);

    /* 只收叶子级键：带引号或裸标识符，值为字符串字面量。
       函数值（OCR 的 `(s) => ...`）跳过 —— 它是插值模板不是术语。 */
    const kv = {};
    for (const k of body.matchAll(/(?:^|\n)[ \t]{4,8}(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*(['"])((?:\\.|(?!\3).)*)\3/g)) {
      kv[k[1] || k[2]] = k[4];
    }
    if (Object.keys(kv).length) out[m[2]] = kv;
  }
  return out;
}

/* 只保留**至少两个产品都有**的键：单产品独有的键不构成家族术语，
   它是那个产品自己的措辞。 */
const perSource = SOURCES.map((s) => ({ id: s.id, data: extract(join(ROOT, s.file)) }));

for (const s of perSource) {
  const n = Object.keys(s.data).length;
  if (n === 0) { console.error(`  ❌ ${s.id} 提取到 0 种语言 —— 提取器对该文件失效`); process.exit(2); }
  const en = Object.keys(s.data.en || {}).length;
  console.error(`  ${s.id.padEnd(9)} ${n} 语言 · en ${en} 键`);
}

/* 汇总：key → { locale → { sourceId → value } } */
const terms = new Map();
for (const s of perSource) {
  for (const [loc, kv] of Object.entries(s.data)) {
    for (const [k, v] of Object.entries(kv)) {
      if (!terms.has(k)) terms.set(k, {});
      const t = terms.get(k);
      if (!t[loc]) t[loc] = {};
      t[loc][s.id] = v;
    }
  }
}

/* 出现在 ≥2 个产品里的键 = 家族术语 */
const shared = [...terms.entries()].filter(([, t]) =>
  Object.values(t).reduce((n, perLoc) => n + Object.keys(perLoc).length, 0) >= 2
).sort((a, b) => a[0].localeCompare(b[0]));

if (AS_JSON) {
  const glossary = {};
  for (const [k, t] of shared) {
    const entry = {};
    for (const loc of Object.keys(t).sort()) {
      const vals = Object.values(t[loc]);
      /* 同一 key 在同一语言下多个产品给了不同译文 → 有歧义，必须人工裁定 */
      entry[loc] = { value: vals[0], sources: Object.keys(t[loc]) };
      if (new Set(vals).size > 1) entry[loc].conflict = [...new Set(vals)];
    }
    glossary[k] = entry;
  }
  console.log(JSON.stringify(glossary, null, 2));
  process.exit(0);
}

const locales = ["en", "zh", "ja", "ko", "de", "es", "pt", "ar", "fr"];
console.log(`\n  ── 家族候选术语（出现在 ≥2 个产品）：${shared.length} 条 ──\n`);
if (ONLY) {
  for (const [k, t] of shared) {
    if (t[ONLY]) {
      const vals = Object.values(t[ONLY]);
      const bad = new Set(vals).size > 1;
      console.log(`  ${bad ? "⚠️" : "  "} ${k.padEnd(24)} ${ONLY}: ${vals[0].slice(0, 56)}`
        + (bad ? `   ← 冲突: ${[...new Set(vals)].join(" / ")}` : ""));
    }
  }
  process.exit(0);
}
for (const [k, t] of shared) {
  const en = t.en ? Object.values(t.en)[0] : "";
  console.log(`  ${k}`);
  console.log(`    en: ${en.slice(0, 76)}`);
  for (const loc of locales) {
    if (loc === "en" || !t[loc]) continue;
    const vals = Object.values(t[loc]);
    const bad = new Set(vals).size > 1;
    console.log(`    ${bad ? "⚠️" : " "} ${loc}: ${vals[0].slice(0, 70)}${bad ? `  ← 冲突: ${[...new Set(vals)].join(" / ")}` : ""}`);
  }
}
console.log(`\n  ⚠️ = 同一术语在不同产品给了不同译文，必须人工裁定后才能进术语表\n`);