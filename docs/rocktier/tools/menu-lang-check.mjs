#!/usr/bin/env node
/* 第 20 条闸门：原生菜单 8 语言字段一致性。
 *
 * ── 为什么需要它 ──
 * 五个产品的 Rust 菜单都用同一个模式：每语言一个 `MenuStrings` 结构体，
 * `match` 8 个分支各填一遍全部字段。这个模式的好处是把「8 个位置参数
 * 写反 ja/ko 也能编译通过」的坑消掉了，但引入了新风险：
 *
 *   ① 某语言少填一个字段 → 结构体要求它，**编译期就会报**（这一层已被 Rust 兜住）
 *   ② 但如果哪天有人给结构体字段加默认值，或者改用别的构造方式，
 *      这道保险就没了 —— 而本地零 Rust 验证（铁律 #7）意味着只能靠 CI 发现。
 *
 * 本闸门在**提交前**用括号配对解析源文件，把这个风险挡在 CI 之前。
 *
 * ── 为什么必须用括号配对而不是正则 ──
 * 写了第一版用 `=>\s*Self \{(.*?)\n            \}` 逐块抓，做变异测试时
 * 连续两次假阴性：
 *
 *   - 删掉**块内最后一个**字段时，那一行的换行符一并消失，
 *     12 空格的 `}` 不再紧跟行首，正则跨到下一个块，
 *     把两个块合并成一个「字段超集」→ 报「无缺失」。
 *
 *   - 匹配 `Self {` 时先撞上 `-> Self {`（返回类型），
 *     把中间的注释和代码一起吞进去 → 报假差异。
 *
 * 结论同既往：**正则不是用来验证代码结构的，是用来读文本的。**
 * 结构一律交给括号配对（确定性、可证明），或交给编译器。
 *
 * 用法：node menu-lang-check.mjs [--verbose]
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.ROCKTIER_ROOT || join(HERE, "..", "..", "..");
const VERBOSE = process.argv.includes("--verbose");

const LANGS = ["zh", "ja", "ko", "de", "es", "pt", "ar"];

/* 家族 9 个产品 → Rust 菜单文件。按「哪里有 src-tauri」定位，
   不靠目录名猜（Pic2WebP 的源码在双层嵌套目录里，目录名全小写带 -main）。 */
const TARGETS = [
  ["Rocktier PDF", "src-tauri/src/main.rs"],
  ["Rocktier CAD Viewer", "src-tauri/src/menu.rs"],
  ["Rocktier Sign", "src-tauri/src/lib.rs"],
  ["Rocktier MD", "src-tauri/src/lib.rs"],
  ["Rocktier-Journal", "src-tauri/src/menu.rs"],
  ["Rocktier-Compressor", "src-tauri/src/lib.rs"],
  ["Rocktier Write", "src-tauri/src/lib.rs"],
  ["Rocktier OCR", "src-tauri/src/menu.rs"],
  ["Rocktier Pic2Webp", "src-tauri/src/main.rs"],
];

/* ── 第二个维度：字形归属 ──
 *
 * 字段数一致性抓不到**语言写反**：把 ja 与 ko 两个值对调，
 * 8 个分支仍然字段齐全，Rust 照样编译通过，运行时日语界面显示韩语。
 * 这正是 Write 的 `tr(lang, en, zh, ja, ko, fr, de, es, pt)` 位置参数写法
 * 最大的风险（9 个位置参数，写错顺序编译器不管）。
 *
 * 但内容本身能揭穿它 —— 假名只能出现在 ja 里，谚文只能出现在 ko 里，
 * 阿拉伯字母只能出现在 ar 里。值若含某语言的独有字形却挂在别的语言下，
 * 就是写反了。纯 ASCII 的值（"Rocktier OCR"、"PDF"、"…��）语言中立，跳过。
 *
 * 只查「不该出现」的三类，不查拉丁诸语言 —— ��/ü/ñ 这些无法可靠区分，
 * 按「看着像」来判断只会制造噪音。
 */
const SCRIPTS = [
  ["ja", /[\u3040-\u309F\u30A0-\u30FF]/, "假名"],
  ["ko", /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/, "谚文"],
  ["ar", /[\u0600-\u06FF\u0750-\u077F]/, "阿拉伯字母"],
];
const NEUTRAL = /^["'\s]*[\x20-\x7E]*["'\s]*$/;   // 纯 ASCII

function scriptIssues(label, lang, fields) {
  const out = [];
  for (const [owner, re, name] of SCRIPTS) {
    if (owner === lang) continue;
    for (const f of fields) {
      if (!re.test(f)) continue;
      out.push({ label, lang, field: f, why: `${name}出现在 ${lang} 的值里` });
    }
  }
  return out;
}

/** 从 `\"xx\" => Self { … }` / tr8!(…) / tr(lang, …) 各形态里抽出 语言 → 值[] */
function harvest(src) {
  const out = [];

  // 形态 A：MenuStrings 结构体分支
  for (const m of src.matchAll(/^\s{8,12}"([a-z]{2})"\s*=>\s*Self\s*\{/gm)) {
    const bo = src.indexOf("{", m.index + m[0].length - 1);
    const be = matchBrace(src, bo);
    if (be < 0) continue;
    const vals = [...src.slice(bo, be).matchAll(/(\w+)\s*:\s*"((?:\\.|[^"\\])*)"/g)]
      .map((x) => x[2].replace(/\\(.)/g, "$1"));
    out.push([m[1], vals, `MenuStrings.${m[1]}`]);
  }

  // 形态 B：tr(lang, "en", "zh", "ja", …) —— 位置参数，第 i+1 个值对应第 i 个语言
  const ORDER = ["en", "zh", "ja", "ko", "fr", "de", "es", "pt"];
  for (const m of src.matchAll(/\btr\(\s*lang\s*,\s*((?:\s*"(?:\\.|[^"\\])*"\s*,?){3,})/g)) {
    const vals = [...m[1].matchAll(/"((?:\\.|[^"\\])*)"/g)].map((x) => x[1].replace(/\\(.)/g, "$1"));
    ORDER.forEach((lg, i) => { if (vals[i] !== undefined) out.push([lg, [vals[i]], `tr()#${i}`]); });
  }

  // 形态 C：tr8!("en", "zh", "ja", …) 宏 —— 同上，取宏名里 trN 的 N
  for (const m of src.matchAll(/\btr(\d)\s*!\s*\(((?:\s*"(?:\\.|[^"\\])*"\s*,?){3,})/g)) {
    const n = Number(m[1]);
    const vals = [...m[2].matchAll(/"((?:\\.|[^"\\])*)"/g)].map((x) => x[1].replace(/\\(.)/g, "$1"));
    const order = vals.length === n ? ORDER.slice(0, n) : ORDER;
    order.forEach((lg, i) => { if (vals[i] !== undefined) out.push([lg, [vals[i]], `tr${n}!#${i}`]); });
  }

  return out;
}

const fail = [];
const rows = [];

/** 从 `open` 处的 `{` 起做括号配对，返回闭合 `}` 的下标（不含）。跳过字符串与字符字面量。 */
function matchBrace(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {                                   // 跳过字符串字面量
      i++;
      while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
      continue;
    }
    if (c === "'") {
      /* Rust 里 ' 两种含义：字符字面量 'a' / '\n'，和生命周期 &'static str。
         两者必须分开 —— 第一版把 &'static str 当字符字面量，扫到下一个 '
         才停，把大段源码吞进去，括号从此不再配对，报出「花括号不配对」的假故障。
         区分办法：字符字面量都很短，闭引号就在几个字符内；生命周期后面跟标识符。 */
      let j = i + 1, len = 0;
      while (j < src.length && src[j] !== "'" && src[j] !== "\n" && len < 12) {
        j += src[j] === "\\" ? 2 : 1;
        len++;
      }
      if (src[j] === "'") { i = j; continue; }         // 字符字面量：整段跳过
      continue;                                         // 生命周期：正常推进
    }
    if (c === "/" && src[i + 1] === "/") {             // 跳过行注释
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

/** 取该块里出现的字段名（`name: "…"` 或 `name: '…'`）。 */
function fieldsIn(block) {
  const out = new Set();
  for (const m of block.matchAll(/(?:^|[{,\s])([a-z_][a-z0-9_]*)\s*:\s*"/g)) out.add(m[1]);
  return out;
}

for (const [product, rel] of TARGETS) {
  const p = join(REPO, product, rel);
  if (!existsSync(p)) { rows.push([product, "—", "未找到菜单文件"]); continue; }
  const src = readFileSync(p, "utf8");

  const structAt = src.indexOf("struct MenuStrings {");
  if (structAt < 0) {
    // 尚未 8 语言化的产品：报告现状，不当作失败（Write/OCR/Pic2WebP 走另一套）
    const legacy = /l\("[^"]*",\s*"[^"]*"\)/.test(src);
    /* 即便没有 MenuStrings，字形归属检查照样要跑 ——
       Write 用 tr()、Pic2WebP 用 tr8! 宏，那才是写反语言最危险的地方。 */
    const scriptBad0 = harvest(src)
      .flatMap(([lg, vals, where]) => scriptIssues(where, lg, vals.filter((v) => !NEUTRAL.test(v))));
    for (const b of scriptBad0) fail.push(`${product}: ${b.why} —— ${b.field}（${b.label}）`);
    rows.push([
      product,
      legacy ? "l(zh,en) 闭包" : "tr()/宏",
      legacy
        ? "❌ 仍是双语闭包"
        : (scriptBad0.length ? `❌ ${scriptBad0.length} 处字形挂错` : "✅ 字段齐全（另一机制）"),
    ]);
    if (legacy) fail.push(`${product}: 仍用 l(zh,en) 双语闭包 —— 工具栏 8 语言但菜单只有 2 语言`);
    continue;
  }

  // 结构体字段：声明行 `name: &'static str,`
  const so = src.indexOf("{", structAt);
  const se = matchBrace(src, so);
  if (se < 0) { fail.push(`${product}: MenuStrings 花括号不配对`); continue; }
  const decl = new Set();
  for (const m of src.slice(so, se).matchAll(/^\s{4}([a-z_][a-z0-9_]*)\s*:\s*&/gm)) decl.add(m[1]);
  if (!decl.size) { fail.push(`${product}: MenuStrings 解析出 0 个字段`); continue; }

  // match 分支：`"xx" => Self { … }`，逐个配对
  const blocks = [];
  for (const m of src.matchAll(/^\s{8,12}"([a-z]{2})"\s*=>\s*Self\s*\{/gm)) {
    const bo = src.indexOf("{", m.index + m[0].length - 1);
    const be = matchBrace(src, bo);
    if (be < 0) { fail.push(`${product}: ${m[1]} 分支花括号不配对`); continue; }
    blocks.push([m[1], fieldsIn(src.slice(bo, be))]);
  }
  // 兜底分支 `_ => Self { … }`
  for (const m of src.matchAll(/^\s{8,12}_\s*=>\s*Self\s*\{/gm)) {
    const bo = src.indexOf("{", m.index + m[0].length - 1);
    const be = matchBrace(src, bo);
    if (be < 0) continue;
    blocks.push(["_", fieldsIn(src.slice(bo, be))]);
  }

  const found = blocks.map(([l]) => l);
  const missingLangs = LANGS.filter((l) => !found.includes(l));
  let bad = 0;
  for (const [lang, got] of blocks) {
    const miss = [...decl].filter((f) => !got.has(f));
    const extra = [...got].filter((f) => !decl.has(f));
    if (miss.length || extra.length) {
      bad++;
      const n = lang === "_" ? "兜底" : lang;
      fail.push(`${product}: ${n} 分支 缺 [${miss.join(", ")}] 多 [${extra.join(", ")}]`);
    }
    if (VERBOSE) {
      const n = lang === "_" ? "兜底" : lang;
      console.error(`    ${miss.length || extra.length ? "❌" : "✅"} ${n}: ${got.size}/${decl.size}`);
    }
  }
  // 字形归属检查（对三种机制都适用：结构体 / tr() / trN! 宏）
  const scriptBad = harvest(src)
    .flatMap(([lg, vals, where]) => scriptIssues(where, lg, vals.filter((v) => !NEUTRAL.test(v))));
  for (const b of scriptBad) {
    fail.push(`${product}: ${b.why} —— ${b.field}（${b.label}）`);
  }
  if (VERBOSE && scriptBad.length === 0) {
    console.error(`    ✅ 字形归属正确（无假名/谚文/阿拉伯字母挂错语言）`);
  }

  rows.push([
    product,
    `${blocks.length} 分支 × ${decl.size} 字段`,
    bad || scriptBad.length ? `❌ ${bad + scriptBad.length} 处问题` : "✅ 一致",
  ]);
  if (bad) continue;
  if (missingLangs.length) {
    fail.push(`${product}: 缺语言分支 ${missingLangs.join(", ")}（应有 ${LANGS.length} 门 + 兜底）`);
  }
}

console.error("");
for (const [product, scale, status] of rows) {
  console.error(`  ${status.includes("✅") || status === "一致" ? "✅" : "⚠️ "} ${product.padEnd(30)} ${scale.padEnd(20)} ${status}`);
}

if (fail.length) {
  console.error(`\n  ❌ 菜单 8 语言检查失败（${fail.length} 项）：`);
  for (const f of fail) console.error(`      ${f}`);
  console.error("");
  process.exit(1);
}
console.error(`\n  ✅ ${TARGETS.length} 个产品的原生菜单字段一致性检查通过\n`);