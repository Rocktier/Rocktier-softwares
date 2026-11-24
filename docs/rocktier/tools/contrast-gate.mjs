#!/usr/bin/env node
/**
 * 对比度与主题屏蔽闸门。
 *
 * 为什么需要它（2026-10-12/13 的教训）：
 *   家族原有两道闸门都看不见"文字实际不可见"这件事 ::
 *     · scan-token-revert.mjs 只做「产品 :root ↔ 母版 :root」同域比对，
 *       永不跟母版 [data-theme="light"] 比，于是产品用 :root 屏蔽浅色档
 *       在结构上就抓不到（OCR 的 bug 正是这样出厂的）；
 *       而且它第 97 行会**主动用 root 值填充 light 缺失**，把母版自己的
 *       light 漏令牌也一并抹平。
 *     · family-check.mjs 的 tokens-snapshot-diff 只读 tokens.css 镜像、
 *       只比令牌名不比值，且 stripComments 让注释层漂移完全隐形。
 *   结果就是"闸门全绿，同一时刻屏幕上量到 1.05:1"。
 *
 * 本闸门的三条判据：
 *   ① contrast                     文字令牌 × 背景表面，按 WCAG 2.1 算比值
 *   ② theme-blind-root             产品主题无关块不得重声明「母版两档值不同」的令牌
 *   ③ master-light-completeness    母版 light 必须含与 root 相同的令牌集
 *
 * 用法: node tools/contrast-gate.mjs [root]
 * 退出码: 0 = PASS, 1 = FAIL
 */

import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";

const root = process.argv[2] || ".";
const MASTER = join(root, "docs", "rocktier", "tokens.css");

const REPOS = {
  pdf: "Rocktier PDF",
  markdown: "Rocktier MD",
  write: "Rocktier Write",
  pic2webp: "Rocktier Pic2Webp",
  "cad-viewer": "Rocktier CAD Viewer",
  ocr: "Rocktier OCR",
  journal: "Rocktier-Journal",
  compressor: "Rocktier-Compressor",
  sign: "Rocktier Sign",
};

/* ---------- WCAG 2.1 ---------- */

function lin(v) {
  v /= 255;
  return v > 0.03928 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92;
}
function lum(c) {
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}
function contrast(fg, bg) {
  const a = lum(fg), b = lum(bg);
  const hi = Math.max(a, b), lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

/** 解析 #rgb/#rrggbb/rgba()，返回 {rgb:[r,g,b], a:number}；无法解析返回 null */
function parseColor(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) {
    return { rgb: [m[1][0], m[1][1], m[1][2]].map((h) => parseInt(h + h, 16)), a: 1 };
  }
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) {
    const h = m[1];
    return {
      rgb: [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)],
      a: 1,
    };
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m) {
    const p = m[1].split(",").map((x) => parseFloat(x.trim()));
    if (p.length < 3 || p.slice(0, 3).some(isNaN)) return null;
    return { rgb: p.slice(0, 3), a: p.length > 3 && !isNaN(p[3]) ? p[3] : 1 };
  }
  return null; // 渐变、var() 引用等 :: 不猜
}

/** 把半透明前景合成到不透明背景上 */
function composite(fg, bg) {
  const f = parseColor(fg), b = parseColor(bg);
  if (!f || !b) return null;
  if (f.a >= 1) return f.rgb;
  if (b.a < 1) return null; // 背景本身半透明时不做多级合成，跳过以免误判
  return [0, 1, 2].map((i) => f.rgb[i] * f.a + b.rgb[i] * (1 - f.a));
}

/* ---------- CSS 块解析 ---------- */

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * 提取主题块。scope:
 *   "root"  = 主题无关（:root / :root,[data-theme="dark"] / html / [data-theme="auto"]）
 *   "light" = [data-theme="light"]
 */
function blocks(css) {
  const re =
    /(:root\s*(?:,\s*\[data-theme="dark"\])?|html\b|\[data-theme="auto"\]|\[data-theme="light"\])\s*\{/g;
  const out = [];
  let m;
  while ((m = re.exec(css))) {
    const head = m[1];
    const scope = head.includes("light") ? "light" : "root";
    let i = m.index + m[0].length, depth = 1;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    const body = css.slice(m.index + m[0].length, i - 1);
    const tokens = new Map();
    const dre = /(^|[;{\s])(--[A-Za-z0-9-_]+)\s*:\s*([^;}]+)/g;
    let d;
    while ((d = dre.exec(body))) tokens.set(d[2], d[3].trim());
    out.push({ scope, tokens, start: m.index });
  }
  return out;
}

/* 去掉**所有**空格再比较：rgba(0,0,0,0.12) 与 rgba(0, 0, 0, 0.12) 是同一个颜色，
   只压缩连续空格会把它们判成不等，导致「light 已覆盖」被误报为未覆盖。 */
const norm = (v) => String(v).replace(/\s+/g, "").toLowerCase();

/* ---------- 令牌分类 ---------- */

const TEXT_TOKENS = [
  "--text-primary", "--text-secondary", "--text-tertiary", "--text-muted",
  "--dim-text", "--danger", "--warning", "--success", "--accent-warn",
];
const SURFACE_TOKENS = [
  "--bg-primary", "--bg-secondary", "--bg-elevated", "--bg-card",
  "--surface", "--surface-2",
];
/* 只列「识别控件所必需」的非文本令牌（WCAG 1.4.11 的 3:1）。
   --border / --border-hover 是装饰性分隔线、--scrollbar / --scrollbar-hover
   是滚动条轨道 :: 它们不承载「这是可交互元素」的识别任务，按 3:1 卡会
   与极简设计语言冲突并产生大量噪音，故不纳入。 */
const NONTEXT_TOKENS = ["--border-strong", "--scrollbar-thumb"];
const TEXT_MIN = 4.5;
const NONTEXT_MIN = 3.0;

/* ---------- 载入母版 ---------- */

const masterCss = stripComments(readFileSync(MASTER, "utf8"));
const MB = blocks(masterCss);
const masterRoot = new Map();
const masterLightRaw = new Map(); // 关键：原始值，不做 root 填充
for (const b of MB) {
  const target = b.scope === "light" ? masterLightRaw : masterRoot;
  for (const [k, v] of b.tokens) target.set(k, v);
}

let failures = 0;
const lines = [];
function fail(msg) { failures++; lines.push("  ❌ " + msg); }
function ok(msg) { lines.push("  ✅ " + msg); }

/* ---------- 判据 ③ 母版 light 完整性 ---------- */

lines.push("③ 母版 light 完整性");
const missingInLight = [...masterRoot.keys()].filter((k) => !masterLightRaw.has(k));
if (missingInLight.length) {
  fail(
    `母版 [data-theme="light"] 缺 ${missingInLight.length} 个令牌，它们会静默回落到 :root 深色值：` +
      missingInLight.slice(0, 8).join(", ") + (missingInLight.length > 8 ? " …" : "")
  );
} else {
  ok(`母版 light 含 root 全部令牌（${masterRoot.size}/${masterRoot.size}）`);
}

/* ---------- 判据 ① 对比度 ---------- */

/**
 * 把一个表面令牌解析成**不透明** rgb。
 *
 * 关键：半透明表面必须叠到「该档自己的 --bg-primary」上，不能一律叠黑 ::
 * 否则浅色档的 --bg-card: rgba(0,0,0,.03) 会被算成近黑，整档对比度全部失真。
 */
function surfaceRgb(tokenMap, k) {
  const c = parseColor(tokenMap.get(k));
  if (!c) return null;
  if (c.a >= 1) return c.rgb;
  const bv = tokenMap.get("--bg-primary");
  const b = parseColor(bv);
  const base = b && b.a >= 1 ? b.rgb : [0, 0, 0];
  return [0, 1, 2].map((i) => c.rgb[i] * c.a + base[i] * (1 - c.a));
}

/** 前景（可能半透明）叠到某个已解析好的不透明背景上 */
function fgOn(tokenMap, t, bgRgb) {
  const c = parseColor(tokenMap.get(t));
  if (!c) return null;
  if (c.a >= 1) return c.rgb;
  return [0, 1, 2].map((i) => c.rgb[i] * c.a + bgRgb[i] * (1 - c.a));
}

function worstOn(scopeName, tokenMap, t, min, kind) {
  let worst = null;
  for (const s of SURFACE_TOKENS) {
    if (!tokenMap.has(s)) continue;
    const bg = surfaceRgb(tokenMap, s);
    if (!bg) continue;
    const fg = fgOn(tokenMap, t, bg);
    if (!fg) continue;
    const r = contrast(fg, bg);
    if (!worst || r < worst.r) worst = { r, s };
  }
  if (worst && worst.r < min) {
    fail(`${scopeName} ${t} on ${worst.s} = ${worst.r.toFixed(2)}:1（${kind}需 ${min}）`);
  }
}

function checkContrast(scopeName, tokenMap) {
  for (const t of TEXT_TOKENS) if (tokenMap.has(t)) worstOn(scopeName, tokenMap, t, TEXT_MIN, "正文");
  for (const t of NONTEXT_TOKENS) if (tokenMap.has(t)) worstOn(scopeName, tokenMap, t, NONTEXT_MIN, "非文本");
}

lines.push("");
lines.push("① 对比度（母版两档 × 各表面）");
checkContrast("深色", masterRoot);
checkContrast("浅色", new Map([...masterRoot].map(([k, v]) => [k, masterLightRaw.has(k) ? masterLightRaw.get(k) : v])));

/* ---------- 判据 ② 产品主题无关块屏蔽浅色档 ---------- */

/** 已被 git 跟踪的样式文件（与 scan-token-revert 同口径，避免本地/CI 数字不一致） */
function trackedStyleFiles(dir) {
  let out;
  try {
    out = execFileSync("git", ["-C", dir, "ls-files", "-z"], {
      encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  return out
    .split("\0").filter(Boolean)
    .filter((p) => /\.(css|html|svelte)$/.test(p))
    .filter((p) => !/(node_modules|dist|target|design\/)/.test(p))
    .map((p) => join(dir, p));
}

lines.push("");
lines.push("② 产品主题无关块是否屏蔽浅色档");
for (const [id, rel] of Object.entries(REPOS)) {
  const dir = join(root, rel);
  let files;
  try { files = trackedStyleFiles(dir); } catch { continue; }
  for (const f of files) {
    // 跳过母版镜像：它是被允许逐字复制的分发物
    if (/(^|\/)tokens\.css$/.test(f)) continue;
    if (relative(dir, f).replace(/\\/g, "/").endsWith("styles/tokens.css")) continue;
    let css;
    try { css = stripComments(readFileSync(f, "utf8")); } catch { continue; }
    const all = blocks(css);
    for (const b of all) {
      if (b.scope !== "root") continue; // 只看主题无关块
      /* 同文件内、排在这个 :root **之后**的 light 块覆盖 → 屏蔽被抵消。
         同特异度下源序决定胜负：light 块在后就赢，浅色档能取到正确值。 */
      const covered = new Map();
      for (const lb of all) {
        if (lb.scope !== "light" || lb.start < b.start) continue;
        for (const [k, v] of lb.tokens) covered.set(k, v);
      }
      for (const [k, v] of b.tokens) {
        if (!masterRoot.has(k)) continue;      // 产品私有令牌，不管
        if (/^var\(/.test(v)) continue;        // 引用母版，非重声明
        const mRoot = masterRoot.get(k);
        const mLight = masterLightRaw.get(k);
        // 母版两档本就同值（如品牌色）→ 重声明无害
        if (mLight === undefined || norm(mLight) === norm(mRoot)) continue;
        // light 块已用母版浅色值覆盖 → 实际不会屏蔽
        if (covered.has(k) && norm(covered.get(k)) === norm(mLight)) continue;
        const line = css.slice(0, b.start).split("\n").length;
        fail(
          `${id} ${relative(dir, f).replace(/\\/g, "/")}:${line} 主题无关块重声明 ${k}，` +
            `母版两档值不同（深 ${mRoot} / 浅 ${mLight}），且本文件 light 块未覆盖 → 屏蔽浅色档`
        );
      }
    }
  }
}

/* ---------- 判据 ④ 关键裁定值锁定 ---------- */

/* --success 经历过四轮往复：10-02 保留绿 / 10-03 压暗 / 10-05 去绿 / 10-05 最终裁定回到绿。
   注释里已记明「最终裁定：回到绿 #1c7f46」。这段往复历史本身成了风险：后来者若只读到
   中间某一段旧注释（「去绿 = #000000」）就照着改代码，UI 上「成功」会失去语义色，
   且注释与代码再次背离 —— 这正是本次要防的「注释说修了、像素没修」的镜像情形。
   所以这里直接锁定终局裁定：要改，必须连同本文件注释与 docs/rocktier/DECISIONS.md 一起改。 */
const LOCKED_DECISIONS = [
  { scope: "root", token: "--success", expect: "rgba(48, 209, 88, 0.9)" },
  { scope: "light", token: "--success", expect: "#1c7f46" },
];
lines.push("");
lines.push("④ 关键裁定值锁定（--success 四轮往复后的终局裁定）");
for (const d of LOCKED_DECISIONS) {
  const map = d.scope === "light" ? masterLightRaw : masterRoot;
  const actual = map.get(d.token);
  if (actual === undefined) { fail(`母版 ${d.scope} 缺 ${d.token}`); continue; }
  if (norm(actual) !== norm(d.expect)) {
    fail(`${d.scope} ${d.token} = ${actual}，但终局裁定锁定为 ${d.expect}（要改请连同注释与 DECISIONS.md 一起改）`);
  } else {
    ok(`${d.scope} ${d.token} = ${actual}（与裁定一致）`);
  }
}

/* ---------- 判据 ⑤ 字面色值登记制（结果态对比度的闸门化） ---------- */

/* 评审（2026-10-22 世界百佳报告）罪状 #10：结果态（OCR 转换后、PDF 导出后、
   状态徽章）没有任何对比度数据。根因：结果态最爱用**字面色值**——toast、
   徽章、占位画布直接写 hex/rgba，绕开令牌体系，判据①的令牌×表面矩阵
   永远看不见它们。
   解法不是给每个瞬态装浏览器测量（重且脆），而是**登记制**：
   产品样式表（tokens.css 快照除外）里出现的一切字面颜色都必须落在
   下面三类之一，未知字面色直接 FAIL，逼它要么改走令牌、要么带着
   对比度论证进白名单：
     A. 黑色遮罩 rgba(0,0,0,α<0.9)——模态/拖放遮罩，恒压在最上层
     B. 纯白 #fff/#ffffff——白字压饱和令牌底（--danger/--red 等）或纸张画布
     C. 令牌色相染色——rgba/hex 的 RGB 三元组与母版某令牌同色相：
        母版改色后陈旧染色自动 FAIL（色相漂移检测）
     D. 显式登记的历史例外：
        - #ececec —— PDF 纸张加载占位（纸恒为白语义）
        - rgba(255,214,0)/rgba(255,235,59)/rgba(255,138,0)/rgba(255,120,0)/
          rgba(229,57,53)/rgba(255,177,0)/rgba(255,145,0)/rgba(255,214,10) ——
          搜索高亮与标注层（PDF 的 .hit/.annot-preview、Write 的
          .cm-searchMatch/<mark>；multiply 混合压在页面内容上，高亮的本质
          就是给内容变色，不是识别表面，对比度由内容自身承担）
        - 打包进应用的文书页（privacy/terms.html）：纸张隐喻的文档排版，
          深字白底印 Idiom，不属于应用 UI chrome

  var() 的回退值（var(--border, rgba(...)) 里的 rgba）不算字面色：
  令牌在位时永不渲染，令牌缺失由 tokens-snapshot-diff 闸门负责。 */

/* 高亮/标注层登记的 RGB 三元组（不含 alpha） */
const HIGHLIGHT_RGB = new Set([
  "255,214,0", "255,138,0", "255,120,0", "255,235,59",
  "229,57,53", "255,177,0", "255,145,0", "255,214,10",
]);
/* 平衡一层嵌套地剥 var()：var(--x) 与 var(--x, rgba(...)) 都剥干净 */
const stripVar = (v) => v.replace(/var\([^()]*(?:\([^()]*\)[^()]*)*\)/gi, " var() ");

const DOC_PAGE_RE = /(?:^|\/)(?:privacy|terms)(?:[-.][a-z-]+)?\.html?$/i;
const LITERAL_PROPS =
  /^(?:color|background|background-color|border|border-color|outline|outline-color|fill|stroke|text-decoration-color|caret-color)$/i;
const COLOR_RE = /(?:#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\))/gi;
const ALLOW_FIXED = (v) => {
  const s = v.trim().toLowerCase();
  if (/^#(?:fff|ffffff)$/.test(s)) return "纯白（饱和令牌底白字 / 纸张画布）";
  if (/^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*(0(?:\.\d+)?|1(?:\.0+)?)\s*\)$/.test(s)) {
    const a = parseFloat(s.match(/,\s*([\d.]+)\s*\)$/)[1]);
    if (a < 0.9) return "黑色遮罩";
  }
  if (s === "#ececec") return "登记例外：PDF 纸张加载占位（纸恒为白语义）";
  return null;
};

lines.push("");
lines.push("⑤ 字面色值登记制（tokens.css 快照以外的一切字面颜色）");
{
  /* 母版令牌的 RGB 三元组集合（不透明化：半透明母版值直接取 RGB）。
     产品里的字面染色若与母版令牌同色相 → 放行 + 自动跟随；
     母版日后改色，旧染色三元组失配 → FAIL 提示色相漂移。 */
  const masterRgbSet = new Set();
  for (const m of [masterRoot, masterLightRaw]) {
    for (const v of m.values()) {
      const c = parseColor(v);
      if (c) masterRgbSet.add(c.rgb.join(","));
    }
  }
  const literalFailures = [];
  for (const [id, rel] of Object.entries(REPOS)) {
    const dir = join(root, rel);
    let files;
    try { files = trackedStyleFiles(dir); } catch { continue; }
    for (const f of files) {
      if (/(^|\/)tokens\.css$/.test(f)) continue; // 母版镜像：字面色是分发物本体
      if (DOC_PAGE_RE.test(relative(dir, f).replace(/\\/g, "/"))) continue; // 文书页：文档排版非 UI chrome
      let css;
      try { css = stripComments(readFileSync(f, "utf8")); } catch { continue; }
      const dre = /([a-z-]+)\s*:\s*([^;{}]+)[;}]?/gi;
      let d;
      const relPath = relative(dir, f).replace(/\\/g, "/");
      while ((d = dre.exec(css))) {
        if (!LITERAL_PROPS.test(d[1])) continue;
        const line = css.slice(0, d.index).split("\n").length;
        const colors = stripVar(d[2]).match(COLOR_RE) || [];
        for (const raw of colors) {
          if (/^var\(/i.test(raw.trim())) continue;
          const why = ALLOW_FIXED(raw);
          if (why) continue;
          const c = parseColor(raw);
          if (c && masterRgbSet.has(c.rgb.join(","))) continue; // 令牌色相染色，自动跟随母版
          if (c && HIGHLIGHT_RGB.has(c.rgb.join(","))) continue; // 已登记的搜索高亮/标注层
          literalFailures.push(
            `${id} ${relPath}:${line}  ${d[1]}: ${raw.trim()}（未知字面色：走令牌，或带对比度论证登记进 contrast-gate 判据⑤白名单）`
          );
        }
      }
    }
  }
  if (literalFailures.length) {
    fail(`${literalFailures.length} 处未登记字面色：\n    ` + literalFailures.slice(0, 12).join("\n    "));
  } else {
    ok("全部字面色落在登记范围内（遮罩 / 纯白 / 令牌色相染色 / 显式例外）");
  }
}

/* ---------- 输出 ---------- */

console.log("\n=== 对比度与主题屏蔽闸门 ===");
console.log(lines.join("\n"));
console.log(`\n${failures === 0 ? "✅ PASS：0 项失败" : `❌ FAIL：${failures} 项失败`}\n`);
process.exit(failures === 0 ? 0 : 1);
