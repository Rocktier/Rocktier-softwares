/* 译文占位符自洽性检查 —— **不依赖任何外部 API**。
 *
 * ── 为什么先做这一层 ──
 *
 * 百度交叉审校跑了 4000+ 次请求后发现：它报的 3 条「结构问题」全部是
 * **机翻自己丢了 `{p1}`**，而 7 门现有译文一条都没错。
 *
 * 这说明一件事 —— 这一层检查**根本不需要第三方**，
 * 直接拿英文基线比自己的译文就能做，而且是第一道该做的检查。
 * 引入 API 之前就该先跑它。
 *
 * ── 检查什么 ──
 *
 * 每条译文的占位符必须与英文原文**完全一致**（个数 + 内容）：
 *   {p1} {p2}      价格（抽取器把 $14.99 换成占位符，译文里必须原样保留）
 *   {days}         动态天数
 *   RKT-XXXX-XXXX  激活码示例
 *   {{...}} $ {...} __X__   其它保留 token
 *
 * 少一个 = 信息丢失（用户看不到价格）。
 * 多一个 = 译文里凭空出现英文原文没有的东西。
 * 顺序不同 = 价格语序可能颠倒（见 audit-site-i18n.mjs 里的说明）。
 *
 * 用法：node tools/check-placeholders.mjs
 * 退出码：0 = 全部一致；1 = 有不一致
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/* 语言集单一真源：从生成器的 LOCALES 推导（en 恒在 + LANGS）。
   不再手写 —— 手写时收敛/加门必漏改一处，本仓已漏过两次。 */
const { LOCALES } = await import("./gen-site-i18n.mjs");
const LANGS = LOCALES.filter((l) => l.code !== "en").map((l) => l.code);

/* 抽不出 key 就整段跳过，所以宁可多列几个形态 */
const PLACEHOLDER =
  /\{\{[^}]+\}\}|\$\{[^}]+\}|\{[^}]*\}|__[A-Z_]+__|RKT-[A-Z0-9-]+|\$[\d.,]+/g;

const ph = (s) => (s || "").match(PLACEHOLDER) || [];

const load = (lang) => {
  const p = join(ROOT, "i18n", `${lang}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
};

const base = load("en");
if (!base) {
  console.error("  ❌ 缺少 i18n/en.json（英文基线）");
  process.exit(2);
}
const EN = base.keys;

console.log(`\n  ── 占位符自洽性（${LANGS.length} 门 × ${Object.keys(EN).length} 键）──\n`);

let total = 0;

for (const lang of LANGS) {
  const loc = load(lang);
  if (!loc) {
    console.log(`  ⚠️ ${lang}: 缺 i18n/${lang}.json`);
    continue;
  }
  const issues = [];

  for (const [key, en] of Object.entries(EN)) {
    const ours = loc.keys[key];
    if (ours === undefined) {
      issues.push({ key, why: "译文缺这条键", en, ours: "<缺失>", pe: [], po: [] });
      continue;
    }
    const pe = ph(en);
    const po = ph(ours);
    const sameSet = [...pe].sort().join("|") === [...po].sort().join("|");
    if (pe.length !== po.length) {
      issues.push({
        key,
        why: `个数不同（英文 ${pe.length} / 译文 ${po.length}）`,
        en,
        ours,
        pe,
        po,
      });
    } else if (!sameSet) {
      issues.push({ key, why: "占位符内容不同", en, ours, pe, po });
    } else if (pe.join("|") !== po.join("|")) {
      /* 集合相同但顺序不同 —— 价格 {p1}/{p2} 顺序在日语/德语里有含义 */
      issues.push({ key, why: "顺序不同（语序可能颠倒）", en, ours, pe, po });
    }
  }

  total += issues.length;
  console.log(
    `  ${issues.length ? "❌" : "✅"} ${lang}: ${issues.length} 处不一致`,
  );
  for (const it of issues) {
    console.log(`\n     ${it.key}  — ${it.why}`);
    console.log(`       英文 ${it.pe.join(" ") || "（无）"}`);
    console.log(`       译文 ${it.po.join(" ") || "（无）"}`);
    console.log(`       en   ${it.en.slice(0, 90)}`);
    console.log(`       ours ${String(it.ours).slice(0, 90)}`);
  }
}

console.log(`\n  ── 合计 ${total} 处 ──`);
if (total) {
  console.log("  这些必有一方是错的。占位符不一致 = 用户看不到价格 / 看到乱码。\n");
  process.exit(1);
}
console.log("  ✅ 全部一致\n");
