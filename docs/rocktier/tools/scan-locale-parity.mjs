#!/usr/bin/env node
/** 第 21 条闸门：语言集合四边对账（registry / dict / generator / 残留）。
 *
 * ── 为什么做这个 ──
 * 2026-10-15 收口 P0 时连续抓到三件同源的事：
 *
 *   ① PDF（10-14）删了字典文件，`locales.ts` 的 LOCALES 注册表仍列 8 门
 *      —— 工具栏 8 个选项里 6 个点进去静默显示英文。
 *   ② Compressor（10-07 起）把闭包换成查表，生成器却只产 LANGS 语言，
 *      zh 块从未存在 —— 选「中文」后全站英文，静默故障 8 天，
 *      还 survive 了 10-14 的收敛复查。
 *   ③ MD / Sign / PDF / CAD / Journal 五款的 gen-i18n.mjs 仍挂着
 *      LANGS = [ja,ko,de,es,pt,ar] —— 谁跑一次生成器，删掉的 6 门全部复活。
 *
 * 三件的共同形状：**「注册表 ⊋ 字典」或「生成器 ⊋ 字典」时，用户看到选项、
 * 得到英文，且没有任何现有闸门会响**。release-i18n-check 只数语言数（≥2 即过），
 * family-check 比令牌字节 —— 都看不见集合是否对齐。
 *
 * ── 判据 ──
 * 每个产品四边必须严格相等（Compressor 的 en 例外，见下方 enImplicit 注释）：
 *
 *   registry  选择器实际列出的语言（LOCALES / UI_LANGS / LANGUAGES / LANG_ORDER）
 *   dict      真正能渲染的语言（DICTS / STRINGS / dicts / translations / 旁挂文件）
 *   union     类型层的 Lang / LangCode 联合（CAD 曾宽到 8 门，运行时靠 CODES 兜底）
 *   generator gen-i18n.mjs 的 LANGS（收敛后必须为空）
 *
 * 另扫两类残留（本轮实测清过，防复发）：
 *   死语言字面量   i18n 源码里的 'ja' / "ko" / 'ar' 等 6 个已删代码
 *   RTL 残留      ar 专属的 rtl / dir 分支
 *
 * ── 用法 ──
 *   node scan-locale-parity.mjs [家族根]     # 位置参数，与 contrast-gate 一致
 *   node scan-locale-parity.mjs --root 路径  # 也接受 --root
 *
 * 退出码：0 = 全部对齐；1 = 有 ❌（CI 据此拦住合并）。
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const rootArg = argv.includes("--root") ? resolve(argv[argv.indexOf("--root") + 1]) : null;
const posArg = argv.filter((a) => !a.startsWith("--") && a !== (argv.includes("--root") ? argv[argv.indexOf("--root") + 1] : null))[0];
const ROOT = rootArg || (posArg ? resolve(posArg) : resolve(HERE, "..", "..", ".."));

/* 2026-10-13 收敛裁定后的家族基线。出现在集合里的其他语言一律 ❌。 */
const BASELINE = ["en", "zh"];
/* 已删的 6 门。作为字面量出现在 i18n 源码里即视为残留。 */
const DEAD = ["ja", "ko", "de", "es", "pt", "ar"];
const DEAD_RE = new RegExp(`["'](?:${DEAD.join("|")})["']`);

/* ── 产品布局与 i18n 形状 ──
 *
 * 家族有四种 i18n 形态（单文件多语言块 / 每语言一文件 / 内联 per-key / 普通
 * 对象字面量），加上 Compressor 这个「完全没有字典」的特例。闸门不猜形状，
 * 每款产品的注册表与字典在哪、叫什么，都显式列在这里 ——
 * 猜过的教训在 findings D-22：用「我预期的文件名」去搜，漏了三款。
 *
 * form:
 *   locales   `export const LOCALES = [{ code: "en", … }]`
 *   ui_langs  `export const UI_LANGS = [{ id: "en", … }]`
 *   languages `const LANGUAGES = [{ code: "en", … }]`
 *   lang_order`const LANG_ORDER = ["en", "zh"]`
 *   union     `type Lang(Code) = "en" | "zh"`
 * dict form:
 *   object    顶层语言键：`STRINGS = { en: {…}, zh: {…} }`
 *   shorthand `DICTS = { en, zh }`
 *   inline    per-key 内联：`"app.title": { en: "…", zh: "…" }`
 */
const SHAPES = {
  pdf: {
    dir: "Rocktier PDF",
    registry: { file: "src/i18n/locales.ts", form: "locales" },
    union: { file: "src/i18n/locales.ts", form: "union" },
    dict: { file: "src/i18n/index.tsx", form: "shorthand", var: "DICTS" },
  },
  /* MD / Write 2026-11-18 起与 PDF 同构：注册表挪到 src/i18n/locales.ts（`LOCALES`
     + `code` 字段），字典拆成 en.ts / zh.ts 两份模块，由 index.tsx 的
     `const DICTS = { en, zh }` 收口。
     ⚠️ 旧配置指着 `src/i18n.ts`（当时是扁平键的单一文件）—— 该文件在迁移中已删除，
     抽取器读到 null → 「注册表抽取失败」。那不是产品缺语言，是本表没跟上迁移。 */
  md: {
    dir: "Rocktier MD",
    registry: { file: "src/i18n/locales.ts", form: "locales" },
    dict: { file: "src/i18n/index.tsx", form: "shorthand", var: "DICTS" },
  },
  write: {
    dir: "Rocktier Write",
    registry: { file: "src/i18n/locales.ts", form: "locales" },
    dict: { file: "src/i18n/index.tsx", form: "shorthand", var: "DICTS" },
  },
  "cad-viewer": {
    dir: "Rocktier CAD Viewer",
    registry: { file: "src/lib/state.svelte.ts", form: "locales" },
    union: { file: "src/lib/state.svelte.ts", form: "union" },
    dict: { file: "src/lib/i18n.svelte.ts", form: "object", var: "dicts" },
  },
  ocr: {
    dir: "Rocktier OCR",
    /* 2026-11-19 起与 PDF 同构：`ui/lang.js` 改名为 `ui/i18n.js`，
       字典收口到 `const DICTS = { en: {…}, zh: {…} }`，`STRINGS` 只是它的别名
       （`const STRINGS = DICTS;` 不含字面量，按 STRINGS 抽会抽到 null）。
       注册表仍以 `LANG_ORDER = ["en","zh"]` 为准。 */
    registry: { file: "ui/i18n.js", form: "lang_order" },
    dict: { file: "ui/i18n.js", form: "object", var: "DICTS" },
  },
  sign: {
    dir: "Rocktier Sign",
    registry: { file: "src/i18n.ts", form: "locales" },
    union: { file: "src/i18n.ts", form: "union" },
    dict: { file: "src/i18n.ts", form: "inline", var: "translations" },
  },
  pic2webp: {
    dir: "Rocktier Pic2Webp",
    registry: { file: "src/i18n.js", form: "languages" },
    dict: { file: "src/i18n.js", form: "object", var: "dict" },
  },
  journal: {
    dir: "Rocktier-Journal",
    /* 2026-11-18 起与 PDF 同构。注册表在 locales.ts（沿用全码 en-US / zh-CN，
       下游按主 subtag 归一）；字典由 index.ts 的
       `const STRINGS: Record<Locale, unknown> = { "en-US": en, "zh-CN": zh }`
       收口 —— 单行、值是标识符、键带引号，所以走 object 形态的引号键兜底。 */
    registry: { file: "src/i18n/locales.ts", form: "locales" },
    dict: { file: "src/i18n/index.ts", form: "object", var: "STRINGS" },
  },
  compressor: {
    dir: "Rocktier-Compressor",
    registry: { file: "src/i18n.ts", form: "locales" },
    union: { file: "src/i18n.ts", form: "union" },
    /* Compressor 的界面文案**内联在调用点**（t("中文", "English")），en/zh 由闭包
       `lang === "zh" ? zh : lookup(lang, en)` 分发，STRINGS 查表只放基线之外的
       语言（当前为空对象 —— 正常终态）。所以对账的「字典边」取 PROFILE_I18N：
       档位文案没有内联兜底，只走查表，en/zh 必须齐全。
       2026-10-15 补 PROFILE_ZH 之前，中文用户的档位名一直是英文。 */
    dict: { file: "src/i18n-strings.ts", form: "ident_index", var: "PROFILE_I18N" },
    /* 闭包不许把内联中文整个丢掉 —— 10-07 的静默故障正是 `(_zh, en) => lookup(...)`。
       10-14 的 2802de6 修的就是这个分发；这条检查防它退回去。 */
    inlineBilingual: ["src/App.tsx", "src/components/LicenseDialog.tsx"],
    /* 档位文案的**生成器输入**（scripts/i18n-profiles/<lang>.mjs）：en/zh 必须都在。
       档位只走查表、没有内联兜底 —— 缺哪个语言，哪个语言的档位名就回落英文
       （10-15 修的就是 zh 缺）。主流程里 shape.profiles 的分支 10-15 就写好了，
       却从未在任何 shape 上配置过 —— 分支存在但永远不执行，又是
       「检查脚本自身与现实脱节」。2026-10-16 补上配置让它真跑。 */
    profiles: "scripts/i18n-profiles",
  },
};

/* Journal 用带区域码的 locale（en-US / zh-CN），对账时按主 subtag 归一。 */
const norm = (c) => c.toLowerCase().split("-")[0];

function read(root, rel) {
  const p = join(root, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/* 从声明处按括号配对取到对象/数组结束，避免正则跨块误吃。
   open 指定开括号种类：注册表是数组（`[`），字典是对象（`{`）。
   必须从 **= 号之后**找开括号 —— Write/CAD 的声明带类型注解
   （`UI_LANGS: ReadonlyArray<{ id: Lang }> = [`），注解里的 `{`
   比数组的 `[` 先出现，从头找会咬到类型注解上。 */
function spanOf(src, declRe, open) {
  const m = declRe.exec(src);
  if (!m) return null;
  const eq = src.indexOf("=", m.index);
  if (eq < 0) return null;
  const start = src.indexOf(open, eq);
  if (start < 0) return null;
  const close = open === "{" ? "}" : "]";
  const stack = [];
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return null;
      if (stack.length === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

/* ── 注册表 / 联合类型 / 字典 三组抽取器 ── */

function extractRegistry(src, form) {
  if (form === "locales" || form === "languages" || form === "ui_langs") {
    const span = spanOf(src, form === "ui_langs"
      ? /UI_LANGS[^=]*=/
      : form === "languages" ? /\bLANGUAGES\s*=/ : /\bLOCALES\s*[:=]/, "[");
    if (!span) return null;
    const key = form === "ui_langs" ? "id" : "code";
    const out = [...span.matchAll(new RegExp(`\\b${key}:\\s*["']([a-z]{2}(?:-[A-Za-z]{2})?)["']`, "g"))].map((m) => m[1]);
    return out.length ? [...new Set(out)] : null;
  }
  if (form === "lang_order") {
    const m = src.match(/\bLANG_ORDER\s*=\s*\[([^\]]*)\]/);
    if (!m) return null;
    const out = [...m[1].matchAll(/["']([a-z]{2}(?:-[A-Za-z]{2})?)["']/g)].map((x) => x[1]);
    return out.length ? [...new Set(out)] : null;
  }
  return null;
}

function extractUnion(src) {
  /* type Lang = "en" | "zh" / type LangCode = … / type Locale = … */
  const out = [];
  for (const m of src.matchAll(/\btype\s+(?:Lang|LangCode|Locale|UiLang)\s*(?::[^=]+)?=\s*([^;\n]+)/g)) {
    for (const x of m[1].matchAll(/["']([a-z]{2}(?:-[A-Za-z]{2})?)["']/g)) out.push(x[1]);
  }
  /* 由 LOCALES 推导的类型（`(typeof LOCALES)[number]["code"]`）不含字面量，
     此时联合抽取为空 —— 不是缺失，是推导式。返回 null 表示「无独立联合」。 */
  return out.length ? [...new Set(out)] : null;
}

function extractDict(src, form, varName) {
  const span = spanOf(src, new RegExp(`\\b${varName}\\s*(?::[^=]+)?=`), "{");
  if (!span) return null;
  if (form === "shorthand") {
    /* DICTS = { en, zh } —— 裸标识符 */
    const body = span.replace(/[{}]/g, "");
    const out = body.split(",").map((s) => s.trim()).filter((s) => /^[a-z]{2}$/.test(s));
    return out.length ? out : null;
  }
  if (form === "object") {
    /* 顶层语言键：`  en: {` / `  en,`（import 进来的缩写）/ `  "en-US": {` */
    const out = [];
    for (const ln of span.split(/\r?\n/)) {
      const m = ln.match(/^\s{1,6}(?:"([a-z]{2}(?:-[A-Za-z]{2})?)"|([a-z]{2}))\s*[:,]\s*(?:\{|$|Record)/);
      if (m) out.push(m[1] || m[2]);
    }
    if (out.length) return [...new Set(out)];
    /* 单行、键带引号、值是标识符：Journal 的
       `const STRINGS: Record<Locale, unknown> = { "en-US": en, "zh-CN": zh };`
       行首扫描要求「行首 + 缩进」，这种全在一行的形态一条都取不到。
       只认带引号的 2 字母（可带区域码）键，避免把普通字段名当语言。 */
    const quoted = [...span.matchAll(/["']([a-z]{2}(?:-[A-Za-z]{2})?)["']\s*:/g)].map((m) => m[1]);
    if (quoted.length) return [...new Set(quoted)];
    /* 单行裸标识符（CAD：`const dicts: Record<string, Dict> = { zh, en };`）——
       按 shorthand 再试一次，别把合法形状报成抽取失败。 */
    const body = span.replace(/[{}]/g, "");
    const bare = body.split(",").map((s) => s.trim()).filter((s) => /^[a-z]{2}$/.test(s));
    return bare.length ? bare : null;
  }
  if (form === "inline") {
    /* Sign：每个键内联全部语言。取第一个条目内的语言键集合。 */
    const firstEntry = span.match(/\{\s*\n\s*(?:en|zh|[a-z]{2}):\s*["'`]/);
    if (!firstEntry) return null;
    const at = span.indexOf(firstEntry[0]);
    const seg = span.slice(at, at + 400);
    const out = [...seg.matchAll(/\b([a-z]{2}):\s*["'`]/g)].map((m) => m[1]);
    /* 截断可能漏掉尾部的语言 —— 改扫整个 span 的前 6 行键名更稳：
       直接统计整个 span 里「行首 4 空格的 xx: "」模式。 */
    const all = [...span.matchAll(/(?:^|\n)\s{4}([a-z]{2}):\s*["'`]/g)].map((m) => m[1]);
    return all.length ? [...new Set(all)] : (out.length ? [...new Set(out)] : null);
  }
  if (form === "ident_index") {
    /* PROFILE_I18N：`  "en": PROFILE_EN,` —— 值是标识符不是对象 */
    const out = [...span.matchAll(/(?:^|\n)\s{1,6}"([a-z]{2}(?:-[A-Za-z]{2})?)":\s*[A-Za-z_][A-Za-z0-9_]*/g)].map((m) => m[1]);
    return out.length ? [...new Set(out)] : null;
  }
  return null;
}

/* ── 主流程 ── */

const rows = [];
let fails = 0;

console.log(`\n  ── 第 21 条闸门：语言集合四边对账（根：${ROOT}）──\n`);
console.log(`  ${"产品".padEnd(22)} ${"注册表".padEnd(12)} ${"字典".padEnd(12)} ${"联合".padEnd(10)} ${"生成器".padEnd(8)} 判定`);
console.log(`  ${"-".repeat(78)}`);

for (const [id, shape] of Object.entries(SHAPES)) {
  const root = join(ROOT, shape.dir);
  const problems = [];

  if (!existsSync(root)) {
    rows.push({ id, problems: ["目录不存在"], reg: "-", dict: "-", uni: "-", gen: "-", ok: false });
    continue;
  }

  const regSrc = read(root, shape.registry.file);
  const registry = regSrc ? extractRegistry(regSrc, shape.registry.form) : null;
  if (!registry) problems.push(`注册表抽取失败（${shape.registry.file} / ${shape.registry.form}）`);

  const dictSrc = read(root, shape.dict.file);
  const dict = dictSrc ? extractDict(dictSrc, shape.dict.form, shape.dict.var) : null;
  if (!dict) problems.push(`字典抽取失败（${shape.dict.file} / ${shape.dict.var}）`);

  let union = null;
  if (shape.union) {
    const uSrc = read(root, shape.union.file);
    union = uSrc ? extractUnion(uSrc) : null;
    /* union 为空 = 推导式类型，不算问题；非空则必须与注册表一致 */
    if (union && registry) {
      const un = union.map(norm), rg = registry.map(norm);
      const extra = un.filter((c) => !rg.includes(c));
      if (extra.length) problems.push(`类型联合宽于注册表：${extra.join(",")}（CAD 10-15 踩过，运行时靠 CODES 兜底，编译期应拦住）`);
    }
  }

  /* 生成器 LANGS —— 收敛后必须为空 */
  let gen = "无生成器";
  const genSrc = read(root, "scripts/gen-i18n.mjs");
  if (genSrc) {
    const m = genSrc.match(/\bLANGS\s*=\s*\[([^\]]*)\]/s);
    if (!m) { gen = "❌ 未找到"; problems.push("gen-i18n.mjs 里找不到 LANGS 声明"); }
    else {
      const items = [...m[1].matchAll(/["']([a-zA-Z-]{2,5})["']/g)].map((x) => x[1]);
      gen = items.length ? `❌ ${items.join(",")}` : "✅ []";
      if (items.length) problems.push(`生成器仍产 ${items.length} 门语言：${items.join(",")} —— 跑一次就复活已删字典`);
    }
  }

  /* 档位译文物（仅 Compressor）：en/zh 必须都在 —— 档位只走查表，无内联兜底 */
  if (shape.profiles) {
    for (const l of BASELINE) {
      if (!existsSync(join(root, shape.profiles, `${l}.mjs`))) {
        problems.push(`${shape.profiles}/${l}.mjs 缺失 —— 档位文案在${l}下会回落英文`);
      }
    }
  }

  /* 内联双语闭包（仅 Compressor）：t(zh, en) 的第一个参数不许被丢掉。
     10-07 的静默故障形状就是 `(_zh, en) => lookup(lang, en)` ——
     编译通过、运行不报错，中文用户永远看到英文。
     逐闭包判：参数名叫 _zh（显式丢弃）⇒ 挂；函数体用了 lookup 却没有
     `"zh" ? zh :` 分支 ⇒ 挂。修复版（10-14 的 2802de6）形如
     `(zh, en) => lang === "zh" ? zh : lookup(lang, en)`，两条都不命中。 */
  if (shape.inlineBilingual) {
    for (const rel of shape.inlineBilingual) {
      const s = read(root, rel);
      if (!s) { problems.push(`${rel} 不存在（inlineBilingual 配置失效）`); continue; }
      const closures = [...s.matchAll(/const\s+[tL]\s*=\s*\(([^)]*)\)\s*=>\s*([\s\S]{0,240}?);/g)];
      if (!closures.length) { problems.push(`${rel} 找不到 t()/L() 闭包（inlineBilingual 配置失效？）`); continue; }
      for (const [, params, body] of closures) {
        if (/\b_zh\b/.test(params)) {
          problems.push(`${rel} 的 t() 把内联中文参数命名成 _zh 整个丢弃 —— 10-07 静默故障的形状`);
        } else if (/\blookup\s*\(/.test(body) && !/["']zh["']\s*\?\s*zh\s*:/.test(body)) {
          problems.push(`${rel} 的 t() 走查表却不给 zh 分支 —— 中文会静默回落英文`);
        }
      }
    }
  }

  /* 集合对账：注册表 == 字典 */
  if (registry && dict) {
    const rg = registry.map(norm), dc = dict.map(norm);
    const regExtra = rg.filter((c) => !dc.includes(c));
    const dictExtra = dc.filter((c) => !rg.includes(c));
    if (regExtra.length) problems.push(`注册表有、字典没有：${regExtra.join(",")} —— 用户选它会静默得到英文`);
    if (dictExtra.length) problems.push(`字典有、注册表没有：${dictExtra.join(",")} —— 死数据`);
  }

  /* 基线检查：集合必须恰为 en/zh */
  if (registry) {
    const rg = registry.map(norm).sort();
    const outside = rg.filter((c) => !BASELINE.includes(c));
    if (outside.length) problems.push(`超出 en/zh 基线：${outside.join(",")}（2026-10-13 裁定）`);
    if (!rg.includes("en") || !rg.includes("zh")) problems.push(`基线不全：${rg.join(",")}（应含 en 与 zh）`);
  }

  /* 残留扫描：死语言字面量与 RTL 分支（去重 —— registry 与 union 常指向同一文件） */
  const scanFiles = [...new Set([shape.registry.file, shape.dict.file, shape.union?.file].filter(Boolean))];
  for (const rel of scanFiles) {
    const s = read(root, rel);
    if (!s) continue;
    for (const m of s.matchAll(new RegExp(DEAD_RE, "g"))) {
      problems.push(`${rel} 残留死语言字面量 ${m[0]}`);
      break; /* 一个文件报一次就够，别刷屏 */
    }
    if (/\brtl\b|dir\s*===?\s*["']ar["']|===?\s*["']ar["']/.test(s)) {
      problems.push(`${rel} 残留 RTL / ar 分支`);
    }
  }

  const ok = problems.length === 0;
  if (!ok) fails++;
  rows.push({
    id,
    ok,
    problems,
    reg: registry ? registry.map(norm).join(",") : "?",
    dict: dict ? dict.map(norm).join(",") : "?",
    uni: union ? union.map(norm).join(",") : "—",
    gen,
  });
}

for (const r of rows) {
  console.log(`  ${r.id.padEnd(22)} ${r.reg.padEnd(12)} ${r.dict.padEnd(12)} ${r.uni.padEnd(10)} ${r.gen.padEnd(8)} ${r.ok ? "✅" : "❌"}`);
}

const bad = rows.filter((r) => !r.ok);
if (bad.length) {
  console.log("");
  for (const r of bad) {
    console.log(`  ❌ ${r.id}`);
    for (const p of r.problems) console.log(`       · ${p}`);
  }
}

console.log("");
if (fails === 0) {
  console.log(`  ✅ ${rows.length} 款产品四边对齐（registry = dict = union，generator 已清零）`);
} else {
  console.log(`  ❌ ${fails}/${rows.length} 款未对齐`);
}
console.log("  说明：注册表 = 选择器列出的语言；字典 = 真正能渲染的语言；两者不等的形状就是");
console.log("        「菜单里有这个语言、点进去是英文」——PDF（10-14）与 Compressor 档位查表");
console.log("        （b88c9f3，中文档位名一直是英文）各踩过一次；Compressor 界面级中文还曾在");
console.log("        10-07~10-14 静默回落英文（01d21c3 引入、2802de6 修复），由 inlineBilingual 判据防退。\n");
process.exit(fails === 0 ? 0 : 1);
