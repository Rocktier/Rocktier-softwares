/* 从措辞差异里**随机抽样**给人看 —— 而不是全列。
 *
 * ── 为什么 ──
 *
 * 实测：zh 403 条里 348 条措辞不同，逐条看全是噪音
 * （常见问题 vs 常见问题解答、PDF vs PDF（便携式文档格式）、7 天 vs 7天）。
 * 全列 348 条 → 没人看 → 这份报告就废了。
 *
 * 但抽样确实有用：2026-10-09 在 ja 的 12 条随机样本里，
 * 一眼就看出**百度把品牌名 Rocktier 音译成了「ロックティア」**——
 * 那违反 `family.json` 的 `productNameStaysEnglish: true`，
 * 是全站性问题，不是单条措辞问题。
 * 这类问题**只可能靠抽样撞见**，因为它不在任何一条的差异里，
 * 而是横跨 dozens 条的共同倾向。
 *
 * 抽样不是随机数游戏，是**用最少的阅读量覆盖最多的键**。
 *
 * 用法：
 *   node tools/sample-audit.mjs --lang ja --n 12
 *   node tools/sample-audit.mjs --lang all --n 5
 *   node tools/sample-audit.mjs --lang ja --n 8 --brand
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CACHE = join(HERE, ".cache");
/* 语言集单一真源：从生成器的 LOCALES 推导（en 恒在 + LANGS）。
   不再手写 —— 手写时收敛/加门必漏改一处，本仓已漏过两次。 */
const { LOCALES } = await import("./gen-site-i18n.mjs");
const LANGS = LOCALES.filter((l) => l.code !== "en").map((l) => l.code);

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const has = (n) => argv.includes(n);

const wantLang = arg("--lang", "ja");
const N = Number(arg("--n", "12")) || 12;

/* ── 品牌名检查 ──
 *
 * `family.json` 的 brand.productNameStaysEnglish = true。
 * 机翻会把 Rocktier 音译（ロックティア / روكتيير），
 * 那是**全站性**问题，逐条看差异时很容易漏 —— 单看一条只是「译法不同」。
 */
const BRAND = "Rocktier";

/* 第一版判据是「译文含非拉丁字母且不含 Rocktier」——
 * 结果 nav.cta「スタート」这种纯日语、根本没提品牌的也被判中（351 条全是误报）。
 *
 * 正确判据：**译文里确实出现了一个「像 Rocktier 的音译」**。
 * 各语言的已知音译形态是有数的，直接列出来最准：
 *   ja ロックティア / ロクティア      ko 록티어
 *   ar روكتيير / روكتير              de/es/pt 音译不常见但也有 Rocktier→Rockttier
 * 宁可漏报（人眼抽样能补），不可误报 —— 一条假警报会让整个统计失去意义。
 */
const TRANSLITERATIONS = [
  /ロックティア/,
  /ロクティア/,
  /록티어/,
  /روكتيير/,
  /روكتير/,
  /rock\s?tier/i,
];

/* 域名不是品牌名的读法。
 * terms.payP1 里百度把 `rocktier.com` 写成 `rocktier.com`（小写），
 * 第一版判据把它当成「音译品牌名」报出来 —— 那是域名的大小写，
 * 不是把 Rocktier 音译成另一种语言。 */
const stripDomains = (s) => s.replace(/\b[a-z0-9-]+\.(?:com|net|org|io|app)\b/gi, " ");

const brandHits = (s) => {
  const t = stripDomains(s);
  if (t.includes(BRAND)) return false; /* 保留英文原样，正确 */
  return TRANSLITERATIONS.some((re) => re.test(t));
};

/* ── 「漏译（返回英文原文）」检测 ──
 *
 * 判据是「译文里残留英文长串、且非拉丁字母很少」。
 *
 * **拉丁字母门必须跳过** —— de/es/pt 的译文本身整句都是拉丁字母，
 * 「残留英文」和「正常德语/西语/葡语」在这条判据下无法区分。
 * 第一版没跳过，de 报 329 条「漏译」、es 274 条，全是假警报
 * （对拉丁语言来说，这就是我给 check-site-i18n.mjs 用过的同一条判断）。
 */
const LATIN_LANGS = new Set(["de", "es", "pt"]);
const looksUntranslated = (s, lang) => {
  /* 拉丁字母门：译文本身就是拉丁字母，「残留英文」与正常译文无法区分 */
  if (LATIN_LANGS.has(lang)) return false;
  /* 中文：判据是「汉字太少」。中文译文里混英文长串（如 PDF、RKT-）是正常的，
     第一版把 zh 也归进拉丁字母门是错的 —— 它不属于拉丁字母门，
     只是需要按汉字数判断，不能按假名/谚文那一套。 */
  if (lang === "zh") {
    if (!reLatinLong.test(s)) return false;
    if ((s.match(/[一-鿿]/g) || []).length < 6) {
      /* 「Rocktier PDF」「Rocktier OCR」0 个汉字但**完全正确** ——
       * 品牌名按 family.json 规定不译，标题本来就是纯英文。
       * 判据不该把它们算成「漏译」。
       * 排除：去掉域名与纯品牌词后，剩下的是产品名（PDF/OCR/Markdown…），
       * 那是设计如此，不是漏译。 */
      const rest = stripDomains(s)
        .replace(/\bRocktier\b/gi, " ")
        .replace(/\b[A-Za-z][A-Za-z0-9]{1,}\b/g, "");
      if (rest.trim() === "") return false;
    }
    return (s.match(/[一-鿿]/g) || []).length < 6;
  }
  if (!reLatinLong.test(s)) return false;
  /* 非拉丁字母（假名/谚文/阿拉伯字母）太少 → 是原文没翻 */
  return (s.match(/[぀-ヿ가-힯؀-ۿ]/g) || []).length < 6;
};
const reLatinLong = /\b[A-Za-z]{4,}\b(?:[ ,][A-Za-z]{3,})+/;  // 连续英文词组

console.log(`\n  ── 措辞差异随机抽样（每门 ${N} 条）──\n`);

const langs = wantLang === "all" ? LANGS : [wantLang];
let brandTotal = 0;
let untranslatedTotal = 0;

for (const lang of langs) {
  const p = join(CACHE, `audit-${lang}.jsonl`);
  if (!existsSync(p)) {
    console.log(`  ── ${lang} ── 没有报告\n`);
    continue;
  }
  const rows = readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const wording = rows.filter((r) => r.diff && r.why === "wording");
  if (!wording.length) {
    console.log(`  ── ${lang} ── 无措辞差异\n`);
    continue;
  }

  console.log(`  ── ${lang} ── 共 ${wording.length} 条差异，抽 ${Math.min(N, wording.length)} 条\n`);

  /* 固定种子：同一门每次抽样结果一致，方便逐条过 / 复核 */
  let seed = [...lang].reduce((a, c) => a + c.charCodeAt(0), 7);
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = wording.slice();
  const out = [];
  for (let i = 0; i < Math.min(N, pick.length); i++) {
    out.push(pick.splice(Math.floor(rnd() * pick.length), 1)[0]);
  }

  for (const r of out) {
    console.log(`    ${r.key}`);
    console.log(`      en   ${r.en.slice(0, 84)}`);
    console.log(`      现有 ${r.ours.slice(0, 84)}`);
    console.log(`      机翻 ${r.theirs.slice(0, 84)}`);
  }

  /* 品牌名被音译的条数（不论抽样与否）—— 这是统计，不是抽样 */
  const bad = rows.filter((r) => brandHits(r.theirs));
  if (bad.length) {
    brandTotal += bad.length;
    console.log(`\n    ⚠️  机翻把品牌名 ${BRAND} 音译了 ${bad.length} 条，例如：`);
    for (const b of bad.slice(0, 3)) {
      console.log(`       ${b.key}: ${b.theirs.slice(0, 60)}`);
    }
  }

  /* 疑似「原样返回英文」—— 拉丁字母门跳过，见 looksUntranslated 的说明。
   *
   * ⚠️ 这类里**混着两种性质相反的情况，字面上无法区分**：
   *   · 真漏译：cp.f2.t「Quality presets」—— 该翻没翻
   *   · 正确保留：cad.eyebrow「Rocktier CAD Viewer」—— 产品标题本来就
   *     是英文（family.json 的 productNameStaysEnglish）
   * 两者都是「一行纯英文」，机器分不开，必须人眼确认。
   * 所以这里不做 PASS/FAIL，只列出候选。 */
  const un = rows.filter((r) => looksUntranslated(r.theirs, lang));
  if (un.length) {
    untranslatedTotal += un.length;
    console.log(`\n    ❓ 译文疑似未翻译 ${un.length} 条（**需人眼确认**，其中可能混着「产品名本就该留英文」）：`);
    for (const u of un.slice(0, 5)) {
      console.log(`       ${u.key}: ${u.theirs.slice(0, 60)}`);
    }
  } else if (LATIN_LANGS.has(lang)) {
    console.log(`\n    ·  ${lang} 是拉丁字母门，跳过「漏译」检查（该判据在此门不成立）`);
  }
  console.log("");
}

console.log(`  ── 合计 ${brandTotal} 条品牌名被音译 · ${untranslatedTotal} 条疑似未翻译 ──`);
console.log(`
  **两类都是机翻的问题，不是译文的问题**：
  · 品牌名被音译（ロックティア / روكتيير…）违反 family.json 的
    brand.productNameStaysEnglish —— 这类是确定的错。
  · 「疑似未翻译」**无法自动判定**：字面上与「产品名本就该留英文」
    完全相同（Rocktier CAD Viewer 是正确的，Quality presets 是漏译），
    只列出候选，由人眼确认。

  ${brandTotal ? `⚠️ ${brandTotal} 条品牌名音译，各门**不要采用**机翻的译名。` : "✅ 各门机翻都保持了品牌名英文原样。"}
`);
