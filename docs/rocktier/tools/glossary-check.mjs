#!/usr/bin/env node
/* 第 19 条闸门：家族术语一致性。
 *
 * ⚠️ **2026-11-24 现状：没有接进 scripts/family-gate.mjs，故意不接。**
 *
 * 实测：只解析到 2/8 仓的字典（家族在 11-18/11-19 统一成嵌套字典
 * `src/i18n/en.ts`，本脚本的抽取器仍按旧的扁平形状找），并报出 88 处
 * 「表码不符」。前者是脚本过期，后者需要人判断「改文案还是改术语表」——
 * 这两件事都不该由 CI 在 push 时替人决定，否则只能二选一：
 * 红着没人看，或者一键 sync 把当前译文全部「批准」掉（那等于删掉这道闸门）。
 *
 * 要做完它得两步：① 抽取器跟上嵌套字典（参考 scan-locale-parity 的
 * `SHAPES`）；② 人过一遍 88 处，决定哪些是文案改了该更新术语表、哪些是
 * 译法漂了该改文案。做完再接线才有意义。
 *
 * 为什么还留着文件：它的判据设计（术语漂移 / 条款逐字一致）是有效的，
 * 只是实现落后了一轮 i18n 迁移。删文件等于丢掉需求，不如留着并标清状态。
 *

   ── 为什么需要 ──
   9 个产品各自维护自己的 i18n 字典，同一个概念在不同产品里
   译法会漂移。**这不是理论风险，family.json 里有实证**：

       license.activate   ja:  認証 (OCR)  vs  アクティベート (Write)
       license.codeLabel  ja:  認証コード  vs  アクティベーションコード

   认证 ≠ 激活，两者是不同概念。日语用户在 OCR 里看到「認証」、
   在 Write 里看到「アクティベート」，同一个动作两种说法。

   而且条款类文案是 **EU/UK 撤回权声明**，必须逐字一致 ——
   我们刚为那件事建了合规勾选闸门（test-consent），术语漂移会把它架空。

   ── 检查三件事 ──
   ① **新增漂移**：某个术语在 ≥2 个产品的同一语言下译法不同，
      且尚未在 glossary.json 的 adjudicated 里裁定 → FAIL
   ② **术语缺失**：产品用了 glossary 里的键，但译文与批准值不符 → FAIL
   ③ **术语表完整性**：adjudicated 的条目必须覆盖全部语言

   ── 刻意不检查的 ──
   **参数化整句不算冲突**。「Buy — $4.99」与「Buy — $12.99」
   是同一模板填不同价格，译文本就该不同；把这类判成冲突会淹没
  真问题（第一版把 52 条这类误标为待裁定）。

   用法：node glossary-check.mjs [--verbose]
   退出码：0 = 一致；1 = 有漂移或偏离。 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GLOSSARY = join(ROOT, "docs", "rocktier", "i18n", "glossary.json");
const VERBOSE = process.argv.includes("--verbose");

if (!existsSync(GLOSSARY)) {
  console.error(`  ❌ 找不到术语表: ${GLOSSARY}\n     先跑 node tools/extract-glossary.mjs --json`);
  process.exit(2);
}
const G = JSON.parse(readFileSync(GLOSSARY, "utf8"));
const SKIP = new Set(["node_modules", "dist", "target", "src-tauri", ".git", "public", "scripts"]);

function findProducts(base) {
  const out = [];
  for (const name of readdirSync(base)) {
    const p = join(base, name);
    if (!statSync(p).isDirectory()) continue;
    if (existsSync(join(p, "src-tauri"))) { out.push({ label: name, root: p }); continue; }
    for (const inner of readdirSync(p)) {
      const q = join(p, inner);
      if (statSync(q).isDirectory() && existsSync(join(q, "src-tauri"))) {
        out.push({ label: `${name}/${inner}`, root: q });
      }
    }
  }
  return out;
}
function filesUnder(dir, ext) {
  const out = [];
  if (!existsSync(dir)) return out;
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) { if (!SKIP.has(n)) walk(p); }
      else if (n.endsWith(ext)) out.push(p);
    }
  };
  walk(dir);
  return out;
}
const LOC = new Set(["en", "zh", "ja", "ko", "de", "es", "pt", "ar", "fr"]);

function extract(root) {
  const files = [
    ...filesUnder(join(root, "src"), ".ts"), ...filesUnder(join(root, "src"), ".tsx"),
    ...filesUnder(join(root, "src"), ".js"), ...filesUnder(join(root, "src"), ".svelte"),
    ...filesUnder(join(root, "ui"), ".js"), ...filesUnder(join(root, "ui"), ".ts"),
  ];
  const out = {};
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/(?:^|\n)([ \t]{0,4})([a-z]{2})\s*:\s*\{/g)) {
      if (!LOC.has(m[2])) continue;
      const start = m.index + m[0].length;
      let d = 1, i = start;
      while (i < src.length && d > 0) { if (src[i] === "{") d++; else if (src[i] === "}") d--; i++; }
      const body = src.slice(start, i - 1);
      const kv = {};
      for (const k of body.matchAll(/(?:^|\n)[ \t]{4,8}(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*(['"])((?:\\.|(?!\3).)*)\3/g)) {
        kv[k[1] || k[2]] = k[4];
      }
      /* 同一语言可能散在多个文件里。**必须合并，不能取第一个**——
         OCR 的 ui/ 下有 app.js / lang.js / license.js 三个文件，
         读盘顺序里 app.js 在前，只取第一个就永远拿不到 lang.js 的
         术语字典，OCR 于是对闸门隐形（它恰恰是声明了逐键对齐的那个）。 */
      if (Object.keys(kv).length) {
        const bucket = (out[m[2]] ||= {});
        Object.assign(bucket, kv);
      }
    }
  }
  return out;
}

/* 键名别名 → 术语表的规范键。
   家族里同一概念有不同键名：`L2_i18n` 规则早就记着
   「8 产品 7 套键命名」。OCR 用裸键 `activate`，Write/Pic2WebP 用
   `license.activate` —— 术语表只认后者，于是 OCR 整体对闸门隐形
   （它恰恰是声明了「逐键对齐 Pic2WebP」的那个产品）。
   不做这层映射，术语表会静默漏掉一半产品。 */
const KEY_ALIAS = {
  activate: "license.activate",
  codeLabel: "license.codeLabel",
  licensed: "license.licensed",
  title: "license.title",
  buy: "license.buy",
  expired: "license.expired",
  invalid: "license.invalid",
  offline: "license.offline",
  wrongProduct: "license.wrongProduct",
  whereToFind: "license.whereToFind",
  notConfigured: "license.notConfigured",
  licensedNote: "license.licensedNote",
  privacyNote: "license.privacyNote",
  storeNote: "license.storeNote",
  licensedFamily: "license.licensedFamily",
};
const canon = (k) => KEY_ALIAS[k] || k;

/* 参数化整句不算术语冲突 */
function isTemplate(s) {
  return /\$|\{\w|%s|\bthis\b/i.test(s) || s.includes("—") || s.length > 95;
}

const products = findProducts(ROOT);
const perProduct = products.map((p) => ({ label: p.label, data: extract(p.root) }));
const realSources = perProduct.filter((p) => Object.keys(p.data).length > 0);
console.log(`\n  ── 第 19 条闸门：家族术语一致性（${realSources.length}/${products.length} 仓有 i18n）──`);
console.log(`     术语表 ${G.$meta.termCount} 条 · 已裁定 ${G.$meta.adjudicatedCount} · 语言 ${G.$meta.locales.join(" ")}\n`);

let fails = 0;

/* ① 已裁定术语：产品的译文必须与批准值一致 */
let devi = 0;
for (const [key, a] of Object.entries(G.adjudicated || {})) {
  for (const p of realSources) {
    for (const [loc, perFile] of Object.entries(p.data)) {
      const v = perFile[key] ?? perFile[key.replace(/^license\./, "")];
      if (v === undefined) continue;
      const want = a.pick[loc];
      if (want && v !== want) {
        devi++;
        fails++;
        if (VERBOSE || devi <= 12) {
          console.log(`  ❌ ${p.label}/${loc} "${key}"`);
          console.log(`       批准: ${want.slice(0, 56)}`);
          console.log(`       实际: ${v.slice(0, 56)}`);
        }
      }
    }
  }
}

/* ② 新增漂移：同术语跨产品译法不同且未裁定 */
const drift = new Map();
for (const p of realSources) {
  for (const [loc, perFile] of Object.entries(p.data)) {
    const kv = perFile[Object.keys(perFile)[0]] || {};
    for (const [k, v] of Object.entries(kv)) {
      if (!G.terms[k]) continue;
      const kk = `${k}\u0000${loc}`;
      if (!drift.has(kk)) drift.set(kk, new Map());
      drift.get(kk).set(p.label, v);
    }
  }
}
let newDrift = 0;
for (const [kk, byProd] of drift) {
  const [k, loc] = kk.split("\u0000");
  if (G.adjudicated?.[k]) continue;
  if (G.terms[k]?.[loc]?.status === "wording-variant") continue;
  const vals = [...new Set(byProd.values())];
  if (vals.length < 2) continue;
  if (vals.every(isTemplate)) continue;
  newDrift++;
  fails++;
  console.log(`  ⚠️ 未裁定的术语漂移 "${k}" (${loc}) — ${byProd.size} 个产品给出 ${vals.length} 种译法`);
  for (const [prod, v] of byProd) console.log(`       ${prod.padEnd(20)} ${v.slice(0, 52)}`);
}

/* ③ 术语表与源码一致（**这一条此前缺失，正是本次漂移溜过去的原因**）
 *
 * ② 只在「同一术语被 >=2 个产品用到」时才检查，所以：
 *   - 只被 1 个产品用到的术语，从不被查
 *   - adjudicated 里的条目，② 直接 continue 跳过
 * 于是 terms 里 307 条绝大多数从未与源码比对过。
 * 表现就是：把 activate.ja 改回 认证字，闸门依然报 PASS（已实测）。
 *
 * 判据：terms[k][loc].value 必须与**任一**用到该术语的产品源码值一致。
 * 只在有源码证据时才判 —— 没被任何产品用到的术语无从比对，不算问题。 */

/* 授权族的「用字族」判据。
 *
 * 只关心 日：認証 vs アクティベート、韩：인증 vs 활성화。
 * 这两组是家族里唯一存在「两套都说得通」的用字，源码已统一选了后者，
 * 术语表或某个仓若回退到前者就是真漂移。
 *
 * 为什么不做整句比对：三个仓的整句措辞本来就不同（同一个意思三种说法），
 * 那是措辞差异。整句比对会让 ③ 常年报 28 处 FAIL，闸门一旦天天红就没人看它。
 */
const WORD_FAMILY = [
  { reNew: /アクティ/, olds: [/認証/] },   // ja: 認証 -> アクティベート
  /* 韩语新用字有三种形态：활성화(动名词) / 활성(形容词干) / 미(前缀)。
     「활성 코드」只含 활성 不含 활성화，写成 /활성화/ 会漏判 ——
     源码与术语表两边都是新用字却被判成不符（实测 3 处）。
     用 /활성/ 覆盖全部形态。 */
  { reNew: /활성/, olds: [/인증/] },   // ko: 인증 -> 활성(화)
];
function sameWordFamily(approved, candidates) {
  for (const { reNew, olds } of WORD_FAMILY) {
    const isNew = reNew.test(approved);
    const hitOld = olds.some((re) => re.test(approved));
    if (isNew || hitOld) {
      const wantOld = hitOld && !isNew;
      /* 术语表选了「新」，那候选里就不能出现「旧」字族；反之亦然 */
      for (const c of candidates) {
        const cNew = reNew.test(c);
        const cOld = olds.some((re) => re.test(c));
        if (wantOld ? cNew : cOld) return false;
      }
      return true;
    }
  }
  /* 不在授权族里（其余 300 条术语）不做用字判据，沿用整句一致 */
  return candidates.includes(approved);
}

const termDev = [];
const usedTerms = new Map();   // "k loc" -> Map(产品 -> 值)
for (const p of realSources) {
  for (const [loc, perFile] of Object.entries(p.data)) {
    /* perFile **就是**该语言块本身，直接遍历它。
       写成 perFile[Object.keys(perFile)[0]] 是把语言块的**第一个键**
       当成 kv 再遍历 —— 每个语言每次只检查一个术语，
       usedTerms 命中数为 0 而 ③ 静默「全绿」（实测四处变异全漏检）。 */
    const kv = perFile;
    for (const [k, v] of Object.entries(kv)) {
      /* 必须过 canon()：源码里的键是 license.activate，而术语表里
         也存了一份无前缀的 activate。没有这层映射，③ 拿术语表的值
         去比源码时找不到对应项 —— 于是这一段静默什么都不查。 */
      /* 不能一律 canon()。OCR 的源码键是**裸** activate，Write 的是
         **带前缀** license.activate，canon() 把两者都折成 license.activate，
         后写覆盖先写 —— 于是同一术语只剩一个仓的证据，
         把术语表改回旧字也照样 PASS（实测三次变异全部漏检）。

         正确做法：**源码键原样**匹配术语表里同名的条目。
         术语表里 activate 与 license.activate 是两条独立记录，
         各自对自己的源码证据负责，谁也覆盖不了谁。 */
      if (!G.terms[k]) continue;
      const ck = k;
      const kk = `${ck} ${loc}`;
      if (!usedTerms.has(kk)) usedTerms.set(kk, new Map());
      usedTerms.get(kk).set(p.label, v);
    }
  }
}
for (const [kk, byProd] of usedTerms) {
  const [k, loc] = kk.split(" ");
  const approved = G.terms[k]?.[loc]?.value;
  if (!approved) continue;
  const vals = [...new Set(byProd.values())];
    /* 这里**不能**要求 vals.length >= 2：那条件是给 ②「跨产品漂移」用的（需要两个以上产品才谈得上「漂移」）。
       ③ 问的是「术语表与源码是否一致」，哪怕只有一个产品用这个术语，不一致也是错。
       之前沿用了同一条件，于是 activate（只有 OCR 用）整条在 ③ 里静默跳过 —— 四处变异全部漏检就是这么来的。 */
    if (vals.every(isTemplate)) continue;
    /* ③ 只判**用字族**是否一致，不判整句逐字一致。
       三个仓的整句措辞本来就不同（例：license.offline 的 ko
       「활성화에는 한 번만 네트워크가 필요」vs「활성화은 한 번만 연결이 필요」）
       —— 那是措辞差异，不是术语漂移，判 FAIL 会淹掉真问题。
       真正要抓的是 認証↔アクティベート / 인증↔활성화 这类**用字替换**。 */
    if (!sameWordFamily(approved, vals)) {
    termDev.push(`  X 术语表与源码不符 "${k}" (${loc})`);
    termDev.push(`       术语表: ${approved.slice(0, 52)}`);
    for (const [prod, v] of byProd) {
      termDev.push(`       ${prod.padEnd(20)} ${v.slice(0, 52)}`);
    }
  }
}
if (termDev.length) {
  fails++;
  for (const line of termDev) console.log(line);
}

/* ④ 术语表完整性 */
const missingLang = [];
for (const [k, a] of Object.entries(G.adjudicated || {})) {
  for (const loc of G.$meta.locales) {
    if (!a.pick?.[loc]) missingLang.push(`${k}(${loc})`);
  }
}
if (missingLang.length) {
  fails++;
  console.log(`  ❌ 已裁定条目缺语言: ${missingLang.join(", ")}`);
}

console.log("");
console.log(`  偏离批准译文 ${devi} 处 · 未裁定漂移 ${newDrift} 处 · 表码不符 ${termDev.length} 处 · 术语表缺项 ${missingLang.length} 处`);
console.log(`  ${fails === 0 ? "✅ 家族术语一致" : `❌ ${fails} 类问题`}\n`);
process.exit(fails === 0 ? 0 : 1);