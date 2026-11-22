#!/usr/bin/env node
/* 译文质量闸门。
 *
 * ── 为什么需要它 ──
 *
 * 写 ja 译文时，387 键 × 7 门这个量级超出了肉眼自查的可靠范围 ——
 * 实际产出了一份混着中文（「干净で携帯できる執筆」）和无意义片段
 * （`|km配信する度に高くなる`、`sniffed Capitoliな作品`）的译文，
 * 而它在生成器眼里是「387 条齐全」。
 *
 * 缺键检查只验证**存在性**，验证不了**内容是否正确**。
 * 这一层补的就是后者：脚本混用、空壳、占位符外的乱码。
 *
 * 用法：node tools/check-site-i18n.mjs [--lang ja] [--strict]
 * 退出码 0 = 通过。
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, "..");

const EN = JSON.parse(readFileSync(join(HERE, "site-i18n.en.json"), "utf8"));
/* 语言集单一真源：从生成器的 LOCALES 推导（en 恒在 + LANGS）。
   不再手写 —— 手写时收敛/加门必漏改一处，本仓已漏过两次。 */
const { LOCALES } = await import("./gen-site-i18n.mjs");
const LANGS = LOCALES.filter((l) => l.code !== "en").map((l) => l.code);

/* 每种文字的判定区间。用码点范围而不是 Unicode 属性脚本 ——
   属性脚本会把「々」「ヶ」这类假名修饰符算错。 */
const SCRIPTS = {
  han: /[一-鿿㐀-䶿]/,
  kana: /[぀-ゟ゠-ヿ]/,
  hangul: /[가-힯ᄀ-ᇿ]/,
  arabic: /[؀-ۿݐ-ݿ]/,
  latin: /[A-Za-z]/,
  cyrillic: /[Ѐ-ӿ]/,
};

/* 允许出现在任何语言译文里的**非目标语言**片段：
   ① 品牌名与产品名（不译）② 技术术语 ③ 单位与符号。 */
const ALLOWED_FOREIGN = [
  "Rocktier", "PDF", "Markdown", "Pic2WebP", "OCR", "CAD", "DWG", "DXF",
  "Windows", "macOS", "Intel", "WebGL", "AES", "GCM", "PBKDF2", "PKCS",
  "ZIP", "DOCX", "HTML", "JPG", "PNG", "AVIF", "GIF", "WebP",
  "Ctrl", "Microsoft", "Store", "Apple", "App", "Vercel", "PayPal", "GDPR",
  "CCPA", "CPRA", "PIPL", "DPAPI", "Keychain", "localStorage",
  "Times", "New", "Roman", "AI", "AutoCAD", "Viewer", "Tier", "Rock",
  "Write", "Compressor", "Journal", "Sign", "Office", "md", "Free",
  "GitHub", "CPU", "License", "Mac", "bug", "MB", "GB", "MIT", "Beta",
  "F", "Silicon", "rocktier", "com", "SDK", "cookie", "pt",
  "Web", "VAT", "Cookie",
  /* 2026-10-18 网站披露 P0 新增：SmartScreen 是 Windows 功能名、
     SHA 属 SHA-256 校验和标准、Bug 为技术术语（句首大写形态）。 */
  "SmartScreen", "SHA", "Bug",
  /* 2026-10-31 对比页补齐后新增：竞品名、合规法名、镜像格式与来源域名。 */
  "iLovePDF", "ilovepdf", "Smallpdf", "HIPAA", "DMG", "Premium", "pricing",
  /* 2026-11-14 首页功能清单新增：成串的办公与图片格式名。
     `inside.cmp` / `reel.compressor.1b` 一条句子里连排七个格式名，
     缺一个就整句被判成「拉丁碎片」—— 报出来的只是恰好第一个未登记的。 */
  "Word", "Excel", "PPT", "TIFF", "BMP",
  /* 白名单是**穷举**的：站点固定，词集固定，所以可以穷举。
     它抓到的写飞的东西长得完全不一样 —— 实测样本：
     hausen / Supporting / adanet / Hypone / ortion / Shipping。
     共同点是嵌在非拉丁语句中的小写碎片，与白名单词没有交集。 */
];

/* 长度比阈值 —— 必须按语言分。
   中文「产品」(2 字) 对 English "Products"(8) 是 0.25×，完全正常；
   用统一的 0.3 下限会把 87 条正常中文全报成问题，闸门一旦满屏误报就没人看它了。 */
const RATIO = {
  zh: [0.12, 3.0],   // 汉字信息密度高
  ja: [0.15, 3.5],
  ko: [0.20, 3.5],
  de: [0.45, 3.5],
  es: [0.45, 3.5],
  pt: [0.45, 3.5],
  /* 阿拉伯语：词的平均长度比拉丁/中日韩都长得多，同义表达往往更短。
     「ضغط」(4 字) 对 "Compress"(8) 是 0.5×，「الأسئلة الشائعة」(15) 对 "FAQ"(3)
     是 5× —— 两个都是正常译法，下限必须放宽，否则闸门天天误报。 */
  ar: [0.30, 5.5],
};

/* 每门语言的「必须含有的文字」。纯数字/符号/品牌名的键豁免。 */
const REQUIRED_SCRIPT = {
  zh: "han",
  ja: "kana", // 日语可整句用汉字，故不强制 han
  ko: "hangul",
  de: "latin",
  es: "latin",
  pt: "latin",
  ar: "arabic",
};

/* 拉丁字母门（de/es/pt）**整门跳过**拉丁碎片检查。
 *
 * 这不是放水，是判据本身不适用：它们的译文整句都是拉丁字母，
 * 「拉丁片段」的定义就是「句子本身」。写 de 时它报了 370 处
 * 「Produkte」「ist」「Der」—— 全是正文里的正常词。
 *
 * 拉丁字母门的真风险在别处：语法（词尾、冠词、格）与漏译。
 * 漏译由「长度比 + 结构（问句）」两道覆盖，语法交给人工终审。
 */
const LATIN_SCRIPT_LANGS = new Set(["de", "es", "pt"]);

/* 品牌名里含缩写的（AutoCAD、Rocktier）单独匹配会漏（CAD 是 DWG 的一部分），
   所以按词边界匹配，长名优先。 */
function stripForeign(s) {
  let out = s.replace(/\{p\d+\}/g, ""); // 占位符先去掉，否则 {p1} 会被当成拉丁
  const words = [...ALLOWED_FOREIGN].sort((a, b) => b.length - a.length);
  for (const w of words) out = out.split(w).join("");
  return out;
}

const problems = [];
const dicts = {};   // lang -> 译文表（跨语言检查要用）
const note = (lang, kind, key, detail) =>
  problems.push({ lang, kind, key, detail });

let checked = 0;

for (const lang of LANGS) {
  const modPath = join(HERE, "i18n", `${lang}.mjs`);
  if (!existsSync(modPath)) continue;
  const dict = (await import(pathToFileURL(modPath).href)).default;
  dicts[lang] = dict;
  checked++;

  for (const [key, en] of Object.entries(EN.keys)) {
    const v = dict[key];
    if (typeof v !== "string" || !v.trim()) continue; // 缺键由生成器管

    const rest = stripForeign(v);
    const need = REQUIRED_SCRIPT[lang];

    /* ① 混用他种文字 —— 最该抓的一类。
       实测 ja 文件里出现「干净で携帯できる執筆」（中）+ 无意义拉丁片段。 */
    for (const [name, re] of Object.entries(SCRIPTS)) {
      if (name === need) continue;
      if (name === "latin" && ["de", "es", "pt"].includes(lang)) continue;
      if (name === "han" && (lang === "zh" || lang === "ja")) continue;
      if (!re.test(rest)) continue;

      /* 中文与日文共用汉字区，无法靠「是否含汉字」区分对错。
         改为标记：ja 译文里的孤立汉字块 + 周围有假名，是可疑的混排。
         真正的中日混排会同时出现 han 与 kana，需要人工看。 */
      const hits = rest.match(new RegExp(re.source, "g")) || [];
      /* 与 latin-fragment 同理：≤2 字符的拉丁片段是单位与按键，不是混用。 */
      if (name === "latin") {
        if (LATIN_SCRIPT_LANGS.has(lang)) continue;      // 整门是拉丁
        if (!rest.match(/[A-Za-z][A-Za-z'-]{2,}/)) continue;  // 单位/按键
      }
      note(
        lang,
        "foreign-script",
        key,
        `${name} ×${hits.length}（本门应为 ${need}）: ${JSON.stringify(v.slice(0, 54))}`,
      );
      break;
    }

    /* ② 未登记的拉丁片段。
       闸门此前完全没这一类，而它抓到的正是最糟的一批：
       「7 日間hausen」这种把拉丁碎片插进日语句中的损坏，
       混用文字检查（韩文/中文/阿拉伯文）看不见拉丁碎片。
       剥离品牌名与占位符后，剩下的拉丁词只可能是写飞的。 */
    /* 最小长度 3：站点里合法的短拉丁全是单位与按键（Ctrl+F、A4、12 pt、
       IP），而实测写飞的样本长度都在 6 以上（hausen / Supporting /
       adanet / Hypone / ortion）。用长度把它们分开，比维护长白名单可靠。 */
    for (const m of LATIN_SCRIPT_LANGS.has(lang)
      ? []
      : rest.match(/[A-Za-z][A-Za-z'-]{2,}/g) || []) {
      note(lang, "latin-fragment", key, `${m} : ${JSON.stringify(v.slice(0, 54))}`);
      break;
    }

    /* ③ 空壳：剥掉品牌名后几乎没剩东西。
       但英文本身就只有品牌名时（about.rock.title = "Rock"）不算问题 —— 那是对的。 */
    /* 只有当英文**本身**含有非品牌词时才判空壳。
       "The Rock" → "Rock" 是对的，不是漏译；
       "Products" → "产品" 也不是漏译（rest 非空，本来就不会命中）。
       真正要抓的是：英文有实质内容，译文却只剩品牌名。 */
    const enWords = stripForeign(en).match(/[a-zA-Z]{2,}/g) || [];
    if (rest.replace(/[\s\p{P}\p{N}]/gu, "").length < 2 && enWords.length >= 2) {
      note(lang, "empty-shell", key, JSON.stringify(v.slice(0, 54)));
    }

    /* ④ 长度比。阈值按语言分，见 RATIO。 */
    const [lo, hi] = RATIO[lang];
    const ratio = v.length / Math.max(1, en.length);
    if (ratio > hi) {
      note(lang, "too-long", key, `${ratio.toFixed(1)}× : ${JSON.stringify(v.slice(0, 54))}`);
    }
    if (ratio < lo) {
      note(lang, "too-short", key, `${ratio.toFixed(2)}× : ${JSON.stringify(v.slice(0, 54))}`);
    }

    /* ⑤ 译文里出现换行符而英文没有 → 排版事故 */
    if (!en.includes("\n") && v.includes("\n")) {
      note(lang, "stray-newline", key, JSON.stringify(v.slice(0, 54)));
    }

  }
}

/* ── 中文漏进日语的检测 ──
 *
 * 日语与中文共用汉字区，「是否含汉字」区分不了；比字符重合度也不可靠 ——
 * 试过「与中文值的最长公共子串 ≥ 5 字」，56 处命中里全是品牌名、
 * 占位符和 "Windows 版" 这类本来就该重合的部分，闸门直接废了。
 *
 * 改用一条站得住的判据：**日语值里一个假名都没有，且汉字 ≥ 6 个**。
 * 本站日语文案全是口语化句子，纯汉字只可能是把中文整段照抄了过来。
 * 纯品牌名的值（Rock、Rocktier PDF）汉字数为 0，自动豁免。
 *
 * 覆盖不到的：中日混排（实测样本「干净で携帯できる執筆」，中文只漏了
 * 「干净携」三字）。这类靠 tools/site-i18n.review.md 人工过一遍。
 */
const KANA = /[぀-ゟ゠-ヿ]/;
const HAN = /[一-鿿㐀-䶿]/g;

{
  const jaPath = join(HERE, "i18n", "ja.mjs");
  if (existsSync(jaPath)) {
    const jaDict = (await import(pathToFileURL(jaPath).href)).default;
    for (const [key, v] of Object.entries(jaDict)) {
      if (typeof v !== "string" || !v.trim()) continue;
      if (KANA.test(v)) continue;
      /* 「最終更新: 2026 年 9 月。」这类是日语本来就有的标签式表达，
         不加假名也完全正常（数字与冒号夹在汉字之间）。
         上一版用「长度 ≤12」豁免，但带日期的就超了，仍误报。
         改成形态判据：整串是「短汉字词 + 冒号 + 数字」→ 豁免。
         中文整段照抄的形态是长句，不会命中这个模式。 */
      if (/^[\u4e00-\u9fff]{2,6}[:：]/.test(v)) continue;
      const han = (v.match(HAN) || []).length;
      if (han >= 6) {
        note("ja", "zh-leak", key, `无假名 + ${han} 个汉字: ${JSON.stringify(v.slice(0, 54))}`);
      }
    }
  }
}

/* ── 跨语言结构一致性 ──
 *
 * 抓的是**值贴错键**：生成器只查缺键/多键，387 条齐全时它一声不响，
 * 但把 A 的译文贴到 B 的键上它完全看不见。
 *
 * 实测就踩了：webp 的三个问题（「どの形式に変換できますか？」等）被贴到了
 * cp 的键上，而 cp.q1.t 该答的是「どのファイル形式を圧縮できますか？」。
 *
 * 判据用中文当基准（它先做、且结构最规整）：
 *   中文是问句 → 目标语言也必须是问句，反之亦然。
 * 问句在七种语言里的句末标点各不相同：
 *   zh ？ ja ？ ko ? de/es/pt ? ar ؟
 * 只要「是不是问句」一致就行，不比较具体标点。
 */
const QA = {
  zh: "？", ja: "？", ko: "?", de: "?", es: "?", pt: "?", ar: "؟",
};
const zhRef = (await import(pathToFileURL(join(HERE, "i18n", "zh.mjs")).href)).default;

for (const [lang, mod] of Object.entries(dicts)) {
  if (lang === "zh") continue;
  const mark = QA[lang];
  for (const [key, v] of Object.entries(mod)) {
    const z = zhRef[key];
    if (typeof v !== "string" || typeof z !== "string") continue;
    const zQ = z.trim().endsWith("？");
    const tQ = v.trim().endsWith(mark);
    if (zQ !== tQ) {
      note(lang, "structure-mismatch", key,
        `中文${zQ ? "是" : "非"}问句，目标语言${tQ ? "是" : "非"}问句 — 多半是译文贴错了键` +
        `\n       中文: ${z.slice(0, 44)}\n       ${lang}: ${v.slice(0, 44)}`);
    }
  }
}

/* ── 报告 ── */

console.error("");
if (!checked) {
  console.error("  ❌ 没有任何译文文件");
  process.exit(1);
}

if (!problems.length) {
  console.error(`  ✅ ${checked} 门译文通过内容检查\n`);
  process.exit(0);
}

const byLang = {};
for (const p of problems) (byLang[p.lang] ||= []).push(p);

for (const [lang, list] of Object.entries(byLang)) {
  const kinds = {};
  for (const p of list) kinds[p.kind] = (kinds[p.kind] || 0) + 1;
  console.error(`  ❌ ${lang}: ${list.length} 处`);
  for (const [k, n] of Object.entries(kinds)) console.error(`       ${k}: ${n}`);
  for (const p of list.slice(0, 12)) console.error(`       ${p.key} — ${p.detail}`);
  if (list.length > 12) console.error(`       … 另 ${list.length - 12} 处`);
}
console.error("");
process.exit(1);