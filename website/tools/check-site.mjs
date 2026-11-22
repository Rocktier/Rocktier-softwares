#!/usr/bin/env node
/**
 * 官网静态自检。
 *
 * 用法: node tools/check-site.mjs
 *
 * 这个站是纯静态 HTML + 一个 JS 文案表，没有构建步骤，也就没有类型检查替我们
 * 兜底。以下每一项都是「坏了不会报错、只会静默变差」的类型：
 *
 *   1. data-i18n 的键漏在中文表里 → 中文访客看到英文（不是报错，是没人发现）
 *   2. 内部链接指向不存在的页面 → 404（只有点进去才知道）
 *   3. 标签没配对 → 布局从那一处开始整体塌掉
 *   4. `—` 破折号 → taste skill 的硬禁令，是本项目最容易被无意引入的一项
 *   5. 首页 eyebrow 数量 → skill 规定不超过 ceil(sections / 3)
 *
 * 只报告，不改文件。
 */
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
/* 与生成器共用一份「只被 JS 使用」的键名单，见下面孤儿判据的说明 */
import { JS_ONLY_KEYS } from "./i18n/js-only-keys.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const htmlFiles = readdirSync(root).filter((f) => f.endsWith(".html")).sort();
const mainJs = readFileSync(join(root, "js", "main.js"), "utf8");

// ── 资产存在性（<img> / <link> / <script> / og:image）───────────────────
// 2026-11-21 补这一项是因为一次真实的破图事故：369459c「清掉闲置底图」删了
// markdown-2 / ocr-2 / cad-viewer-2 三张，第二天 cfce50b 的主题提交又在三个
// 产品页 hero 里引用了它们。线上三页首屏全空，而本脚本当时只查 <a href>，
// 照样全绿放行 —— 图片 404 在控制台不报错，只有肉眼才能发现。
//
// 判据：站内路径必须能在仓库里找到同名文件。
//   跳过：data: / mailto: / tel: / javascript: / #锚点 / 站外 http(s)；
//   站内绝对地址（https://rocktier.com/x）按本地路径解析，覆盖 og:image；
//   带查询串或锚点的剥掉再查；<link> 只看资源类 rel，
//     canonical / alternate 指向的是「路由」不是文件（vercel rewrite 兜着），
//     混进来会造一批恒响的假警。
function collectMissingAssets(rootDir, files) {
  const out = [];
  const localize = (raw) => {
    if (/^(data:|mailto:|tel:|javascript:|#)/i.test(raw) || /^\/\//.test(raw)) return null;
    if (/^https?:\/\//i.test(raw)) {
      const m = raw.match(/^https?:\/\/rocktier\.com(\/.*)?$/i);
      return m ? (m[1] || "/").split(/[?#]/)[0] : null;
    }
    return raw.split(/[?#]/)[0];
  };
  const ASSET_REL = /(icon|stylesheet|preload|manifest|prefetch)/i;
  for (const f of files) {
    const s = readFileSync(join(rootDir, f), "utf8");
    const refs = [];
    for (const m of s.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)) refs.push(["img", m[1]]);
    for (const m of s.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)) refs.push(["script", m[1]]);
    for (const m of s.matchAll(/<link\b([^>]*)>/gi)) {
      const attrs = m[1];
      const rel = (attrs.match(/\brel="([^"]*)"/i) || [])[1] || "";
      const href = (attrs.match(/\bhref="([^"]*)"/i) || [])[1];
      if (href && ASSET_REL.test(rel)) refs.push(["link", href]);
    }
    for (const m of s.matchAll(/(?:property="og:image"|name="twitter:image")[^>]*content="([^"]+)"/gi)) {
      refs.push(["og:image", m[1]]);
    }
    for (const [kind, raw] of refs) {
      const p = localize(raw);
      if (!p) continue;
      const rel = p.replace(/^\/+/, "");
      if (!rel) continue;
      if (!existsSync(join(rootDir, rel))) out.push(`${f}: <${kind}> ${raw}`);
    }
  }
  return out;
}

// ── 自测：`node tools/check-site.mjs --selftest` ────────────────────────
// 判据本身写错的话（比如把 canonical 也算进来）会天天报警，人被吵到就把整条
// 关掉。所以拿临时目录造一组「该报的」和「不该报的」样本，先证明判据成立。
if (process.argv.includes("--selftest")) {
  const dir = mkdtempSync(join(tmpdir(), "check-site-selftest-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  mkdirSync(join(dir, "js"), { recursive: true });
  writeFileSync(join(dir, "assets", "here.png"), "x");
  writeFileSync(join(dir, "assets", "og.png"), "x");
  writeFileSync(join(dir, "js", "app.js"), "//");
  writeFileSync(
    join(dir, "page.html"),
    `<link rel="icon" href="/assets/here.png">
<link rel="canonical" href="https://rocktier.com/about">
<link rel="alternate" hreflang="ja" href="https://rocktier.com/ja/about">
<script src="js/app.js"></script>
<script src="https://cdn.example.com/x.js"></script>
<img src="/assets/here.png">
<img src="/assets/gone.png?v=2">
<img src="https://example.com/remote.png">
<meta property="og:image" content="https://rocktier.com/assets/og.png">
<meta name="twitter:image" content="https://rocktier.com/assets/og-gone.png">
`
  );
  const got = collectMissingAssets(dir, ["page.html"]);
  const cases = [
    ["报出缺失的 hero 图", got.some((g) => g.includes("assets/gone.png")), true],
    ["报出缺失的 og:image", got.some((g) => g.includes("assets/og-gone.png")), true],
    ["不报 canonical 路由", got.some((g) => g.includes("/about")), false],
    ["不报站外资源", got.some((g) => /example\.com|cdn\.example/.test(g)), false],
    ["只报这两条", got.length, 2],
  ];
  let bad = 0;
  for (const [name, actual, expect] of cases) {
    const ok = JSON.stringify(actual) === JSON.stringify(expect);
    if (!ok) bad++;
    console.log(`  ${ok ? "✅" : "❌"} ${name}（得到 ${JSON.stringify(actual)}）`);
  }
  console.log(bad ? `\n  ❌ 自测失败 ${bad} 项\n` : "\n  ✅ 自测通过\n");
  process.exit(bad ? 1 : 0);
}

// ── 收集中文表的键 ─────────────────────────────────────────────────────
// 2026-10-11 修：这里原先从 js/main.js 里正则抓 `"key": "value"` 当中文表。
// 8 语言架构 2026-10-09 落地后，译文全部搬进了 i18n/zh.json（keys 对象），
// main.js 只剩同意门与主题逻辑、早已不是字典。
// 于是 403 个键全部报「没有中文译文」—— 一次 403 项的假警海。
// 现在直接读 i18n/zh.json 的 keys；读不到再退回 main.js 正则（兼容）。
let zhKeys = new Set();
const zhJson = join(root, "i18n", "zh.json");
if (existsSync(zhJson)) {
  try {
    const dict = JSON.parse(readFileSync(zhJson, "utf8"));
    for (const k of Object.keys(dict.keys || {})) zhKeys.add(k);
    // en_text 是「页面 → 键」的原文备份，同样计入可用键
    for (const page of Object.keys(dict.en_text || {})) {
      for (const k of Object.keys(dict.en_text[page] || {})) zhKeys.add(k);
    }
  } catch (e) {
    console.log(`  ⚠️  i18n/zh.json 解析失败（${e.message}），退回 main.js 正则`);
    zhKeys = new Set([...mainJs.matchAll(/"([a-zA-Z][A-Za-z0-9_.]*)"\s*:\s*"/g)].map((m) => m[1]));
  }
} else {
  zhKeys = new Set([...mainJs.matchAll(/"([a-zA-Z][A-Za-z0-9_.]*)"\s*:\s*"/g)].map((m) => m[1]));
}

/* 页面内同名文本会被抽取器加页面前缀（about::philosophy.p1 → about.philosophy.p1），
   运行时靠 lookup 表还原。自检若不查这张表，就会把这类键全部误报成「孤儿键」。 */
let pageLookup = {};
if (existsSync(join(root, "tools", "site-i18n.en.json"))) {
  try {
    pageLookup = JSON.parse(readFileSync(join(root, "tools", "site-i18n.en.json"), "utf8")).lookup || {};
  } catch {}
}

let problems = 0;
const warn = (msg) => {
  problems++;
  console.log(`  ❌ ${msg}`);
};

// ── 1) data-i18n 覆盖率 ────────────────────────────────────────────────
console.log("\n  1) data-i18n 覆盖率（中文表是否覆盖每个键）");
let keyCount = 0;
const used = new Set();
for (const f of htmlFiles) {
  const s = readFileSync(join(root, f), "utf8");
  /* 一起抓整段 innerHTML：判据同时要看「含 $金额」与「含 <a>」。
     $金额 —— gen-site-i18n.mjs：价格不翻译，调价要同步 8 门，
              漏一处就是「某语言显示旧价」；
     <a>  —— extract-site-i18n.mjs:142 `translatable: !hasLink`，
              译文表只收纯文本，富文本键运行时原样渲染 HTML 原文。
     两类键的展示都是正确的，不能算漏译。 */
  for (const m of s.matchAll(/data-i18n="([^"]+)"[^>]*>([\s\S]*?)<\/[a-zA-Z][^>]*>/g)) {
    keyCount++;
    const page = f.replace(/\.html$/, "");
    const resolved = pageLookup[`${page}::${m[1]}`] || m[1];
    used.add(resolved);
    used.add(m[1]);
    /* 两条按设计跳过：
       ① 含 $金额 —— gen-site-i18n.mjs：价格不翻译，调价要同步 8 门，
          漏一处就是「某语言显示旧价」；
       ② 含 <a> 链接 —— extract-site-i18n.mjs:142 `translatable: !hasLink`，
          译文表只收纯文本，富文本键运行时原样渲染 HTML 原文。
       两类键的展示都是正确的，不能算漏译。 */
    if (!zhKeys.has(resolved) && !/\$\d/.test(m[2]) && !/<a\s/i.test(m[2]))
      warn(`${f}: 键 "${m[1]}" 没有中文译文`);
  }
}
if (problems === 0) console.log(`  ✅ ${keyCount} 处引用、${used.size} 个键，全部有中文`);

/* 只被 js/i18n.js 的 labelControls() 使用的键：它们填的是 aria-label 属性，
   不是元素文本，因此不会出现在任何 HTML 的 data-i18n 里。
   不豁免的话每次运行都会多 6 条永远不该修的警告，而一条恒响的警告
   会训练人无视整行，真孤儿出现时就没人看了。
   行为本身由切语言后读 DOM 名称的断言覆盖，不靠本闸门。
   名单与 tools/gen-site-i18n.mjs 共用同一份（tools/i18n/js-only-keys.mjs）。 */
const orphans = [...zhKeys].filter((k) => !used.has(k) && !JS_ONLY_KEYS.includes(k) && k.includes("."));
console.log(
  `  ${orphans.length ? "⚠️ " : "✅"} 中文表里的孤儿键: ${orphans.length ? orphans.join(", ") : "无"}`
);

// ── 2) 内部链接 ────────────────────────────────────────────────────────
console.log("\n  2) 内部链接的目标是否存在");
let links = 0;
for (const f of htmlFiles) {
  const s = readFileSync(join(root, f), "utf8");
  for (const m of s.matchAll(/href="\/([^"#?]*)"/g)) {
    const target = m[1].replace(/\/$/, "");
    links++;
    // 页面链接按 .html / 目录首页解析；其余是真实存在的资产路径
    // （favicon、og 图等），原样存在即通过。此前只按页面规则解析，
    // 把每个页头的 favicon href 都误报成 404。
    const candidates = target === ""
      ? ["index.html"]
      : [`${target}.html`, `${target}/index.html`, target];
    if (!candidates.some((c) => existsSync(join(root, c)))) {
      warn(`${f}: href="/${target}" 找不到对应文件`);
    }
  }
}
console.log(`  ${problems === 0 ? "✅" : "⚠️ "} 检查了 ${links} 条内部链接`);

// ── 2b) 无扩展名路由是否被 vercel.json 覆盖 ────────────────────────────
// 这一项是 2026-11-07 的真实事故补上的：App Store 提审时填技术支持网址，
// 发现 https://rocktier.com/contact 线上 404，而 contact.html 明明是好的。
// 原因是本站「文件存在」不等于「路径能访问」—— 无扩展名路径全靠 vercel.json
// 的 rewrites 映射，漏一条就 404。上一节只查 contact.html 存不存在，所以
// 19 个页面全站导航里那个 /contact 挂了 40 天也没人发现。
//
// 判据：凡是指向 <name>.html 的无扩展名内部链接，必须在 vercel.json 的
// rewrites 或 redirects 里有同名 source。少一条就是 404。
console.log("\n  2b) 无扩展名路由是否被 vercel.json 覆盖（缺一条就 404）");
const vercelCfg = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"));
const normalize = (s) => s.replace(/\/+$/, "") || "/";
const routed = new Set([
  ...(vercelCfg.rewrites || []).map((r) => normalize(r.source)),
  ...(vercelCfg.redirects || []).map((r) => normalize(r.source)),
]);
const uncovered = new Set();
let routedChecked = 0;
for (const f of htmlFiles) {
  const s = readFileSync(join(root, f), "utf8");
  for (const m of s.matchAll(/href="\/([^"#?]*)"/g)) {
    const target = normalize("/" + m[1]);
    if (target === "/") continue;
    // 真实存在的静态文件/目录，Vercel 直接就给，不需要 rewrite
    if (existsSync(join(root, target)) || existsSync(join(root, target, "index.html"))) continue;
    if (!existsSync(join(root, `${target}.html`))) continue; // 本节不管坏链接，上一节已报
    routedChecked++;
    if (!routed.has(target)) uncovered.add(target);
  }
}
if (uncovered.size) {
  warn(`以下无扩展名路径没有 vercel.json 映射，线上会 404: ${[...uncovered].join(", ")}`);
} else {
  console.log(`  ✅ ${routedChecked} 处无扩展名引用全部有 rewrite/redirect 兜着`);
}

// ── 2c) 页面引用的资产是否存在 ─────────────────────────────────────────
// 图片/样式/脚本 404 时页面照样 200，只是悄悄变丑变空。这一项就是为此设的，
// 判据见上面的 collectMissingAssets。
console.log("\n  2c) 页面引用的资产是否存在（img / link / script / og:image）");
const missingAssets = collectMissingAssets(root, htmlFiles);
if (missingAssets.length) {
  for (const m of missingAssets) warn(m);
} else {
  console.log(`  ✅ ${htmlFiles.length} 个页面引用的站内资产全部存在`);
}

// ── 3) 标签配对 ────────────────────────────────────────────────────────
console.log("\n  3) 标签配对");
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr", "path", "circle", "line", "rect", "polygon", "use"]);
for (const f of htmlFiles) {
  let s = readFileSync(join(root, f), "utf8");
  s = s.replace(/<!--[\s\S]*?-->/g, "").replace(/<script[\s\S]*?<\/script>/gi, "")
       .replace(/<style[\s\S]*?<\/style>/gi, "");
  const stack = [];
  let bad = null;
  for (const m of s.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g)) {
    const [, close, rawName, selfClose] = m;
    const name = rawName.toLowerCase();
    if (VOID.has(name) || selfClose === "/") continue;
    if (close === "/") {
      const top = stack.pop();
      if (top !== name) { bad = `期望 </${top}>，遇到 </${name}>`; break; }
    } else stack.push(name);
  }
  if (bad) warn(`${f}: ${bad}`);
  else if (stack.length) warn(`${f}: 未闭合的标签 ${stack.join(", ")}`);
}
console.log(`  ${problems === 0 ? "✅" : "⚠️ "} ${htmlFiles.length} 个页面检查完毕`);

// ── 4) 破折号（skill 硬禁令，零容忍）────────────────────────────────────
// 现在是零，所以要守住：从 0 涨到 1 是回归，不是风格偏好。
// 扫描范围必须含 js/ —— 上一轮只扫 *.html，漏掉了 paddle.js 里的 8 处。
console.log("\n  4) 破折号 U+2014 / U+2013（taste skill 要求为零）");
const jsFiles = readdirSync(join(root, "js"))
  .filter((f) => f.endsWith(".js"))
  .map((f) => join("js", f));
let dashes = 0;
const perFile = [];
for (const f of [...htmlFiles, ...jsFiles]) {
  const s = readFileSync(join(root, f), "utf8");
  const n = (s.match(/[\u2014\u2013]/g) || []).length;
  if (n) { dashes += n; perFile.push(`${f}(${n})`); }
}
if (dashes) warn(`共 ${dashes} 处破折号: ${perFile.join(", ")}`);
else console.log(`  ✅ ${htmlFiles.length + jsFiles.length} 个文件（HTML + JS）零破折号`);

// ── 5) 首页 eyebrow 计数（skill：≤ ceil(sections / 3)）──────────────────
console.log("\n  5) 首页 eyebrow 与版式");
const index = readFileSync(join(root, "index.html"), "utf8");
const sections = (index.match(/<section[\s>]/g) || []).length;
const eyebrows = (index.match(/class="eyebrow"/g) || []).length;
const cap = Math.ceil(sections / 3);
console.log(
  `  ${eyebrows <= cap ? "✅" : "❌"} ${sections} 个 section、${eyebrows} 个 eyebrow（上限 ${cap}）`
);
if (eyebrows > cap) problems++;
const cols = (index.match(/class="cols"/g) || []).length;
console.log(`  ${cols === 0 ? "✅" : "⚠️ "} 首页三列等分网格数量: ${cols}（skill 禁止该版式）`);

// ── 6) main.js 能不能真的跑起来 ─────────────────────────────────────────
// 这一项是被一次真实事故补上的：往中文表里插新键时漏了一个逗号，`node --check`
// 能查出来，但当时它被上一条命令的失败退出码短路了（`&&` 链），而本脚本此前
// 只用正则抽键、并不解析 JS，于是**语法全坏的文件照样「自检通过」并推上线**。
// 正则数得清键，却数不出逗号。
console.log("\n  6) main.js 语法与可执行性");
let jsOk = true;
try {
  new Function(readFileSync(join(root, "js", "main.js"), "utf8"));
} catch (e) {
  jsOk = false;
  warn(`js/main.js 语法错误: ${e.message}`);
}

// 再用一个通用假 DOM 真跑一遍：能捕获"语法没问题但一加载就抛异常"的情况。
const stub = new Proxy(function () {}, {
  get(_t, k) {
    switch (k) {
      case "classList": return { add() {}, remove() {}, toggle() {}, contains: () => false };
      case "style": case "dataset": return {};
      case "textContent": case "innerHTML": case "title": return "";
      case "children": return [];
      case "hidden": case "checked": return false;
      case "lang": return "en";
      default: return (..._a) => stub;
    }
  },
  set: () => true,
  apply: () => stub,
});
if (jsOk) {
  try {
    const { runInNewContext } = await import("node:vm");
    runInNewContext(readFileSync(join(root, "js", "main.js"), "utf8"), {
      document: {
        querySelector: () => stub, querySelectorAll: () => [],
        getElementById: () => stub, createElement: () => stub,
        addEventListener() {}, documentElement: stub, body: stub,
        head: { appendChild() {} }, title: "",
      },
      window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      navigator: { language: "zh-CN" },
      matchMedia: () => ({ matches: false, addEventListener() {} }),
      fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
      location: { href: "", pathname: "/", search: "" },
      setTimeout, clearTimeout, console,
      // 浏览器里本来就有、Node 里没有的全局。补齐它们只是为了让 main.js 能跑完，
      // 不是为了模拟浏览器行为。
      requestAnimationFrame: () => 0, cancelAnimationFrame() {},
      IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
      ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
      CustomEvent: class { constructor(t, d) { this.type = t; Object.assign(this, d); } },
      getComputedStyle: () => ({ getPropertyValue: () => "" }),
    });
    console.log("  ✅ 语法正确，且能在假 DOM 中完整执行（中文表可被求值）");
  } catch (e) {
    jsOk = false;
    warn(`js/main.js 执行时抛错: ${e.message}`);
  }
}

// ── 7) 内联脚本：JSON-LD 能否解析、内联 JS 语法是否正确 ────────────────
// 又一个静默失败点：JSON-LD 写坏了，搜索引擎看到的就不是结构化数据，而页面上
// 看不出任何异常。（这个盲区是在清理破折号时发现的：结构化数据块被误当成 JS
// 检查，报了一堆假失败；反过来也一样，真的写坏了也没人知道。）
console.log("\n  7) 内联脚本（JSON-LD 与页面内联 JS）");
let inlineBad = 0;
for (const f of htmlFiles) {
  const s = readFileSync(join(root, f), "utf8");
  let i = 0;
  for (const m of s.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    const attrs = m[1];
    const code = m[2];
    if (/src=/.test(attrs) || !code.trim()) continue;
    i++;
    if (/ld\+json|application\/json/.test(attrs)) {
      try {
        JSON.parse(code);
      } catch (e) {
        warn(`${f} 的 JSON-LD #${i} 解析失败: ${e.message}`);
        inlineBad++;
      }
    } else {
      try {
        new Function(code);
      } catch (e) {
        warn(`${f} 的内联 JS #${i} 语法错误: ${e.message}`);
        inlineBad++;
      }
    }
  }
}
if (!inlineBad) console.log("  ✅ 所有结构化数据可解析、内联脚本语法正确");

// ── 8) class 引用 vs CSS 定义 ──────────────────────────────────────────
// 「引用了但 CSS 里没定义」也是静默失败：样式悄悄失效，控制台不报错，页面照常 200。
// 本轮就是靠这条才发现的 .be 与 .is-live —— 它们从第一次提交起就被引用，也从来
// 没有被定义过。JS 里动态加的 class 也要算进来。
console.log("\n  8) class 引用 vs CSS 定义");
const css = readFileSync(join(root, "css", "styles.css"), "utf8");
const definedClasses = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
const referenced = new Set();
for (const f of [...htmlFiles, ...jsFiles]) {
  const s = readFileSync(join(root, f), "utf8");
  for (const m of s.matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) referenced.add(c);
  }
  for (const m of s.matchAll(/classList\.(?:add|toggle|remove)\(["']([\w-]+)/g)) {
    referenced.add(m[1]);
  }
}
const undef = [...referenced].filter((c) => !definedClasses.has(c)).sort();
if (undef.length) {
  warn(`引用了但 CSS 未定义（样式会静默失效）: ${undef.map((c) => "." + c).join(", ")}`);
} else {
  console.log(`  ✅ ${referenced.size} 个被引用的 class 全部有定义`);
}

console.log(problems === 0 ? "\n  ✅ 自检通过\n" : `\n  ❌ ${problems} 项问题\n`);
process.exit(problems === 0 ? 0 : 1);
