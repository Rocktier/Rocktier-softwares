#!/usr/bin/env node
/**
 * 把产品 CSS 里对 L0 令牌的回退**回退掉** —— 即删除产品侧的重复声明，
 * 让令牌重新由母版提供。
 *
 * ## 为什么不做「就地改成母版值」
 *
 * 就地改值会在产品里留下一份与母版同值的副本 —— 那正是漂移的来源：
 * 母版下次改值时，这份副本又变成新的回退。**删掉声明才是真的单一真源。**
 *
 * ## 为什么逐处编辑而不是一条 sed
 *
 * 1. 同一份文件里可能有多处声明，`sed` 容易误伤注释或示例代码里的同名串；
 * 2. 删除一行会改变块内结构，必须确认花括号/注释仍配平；
 * 3. 改完要**立刻**能验证，否则错误会累积到最后才发现
 *    （此前已有先例：脚本按字符串而非位置替换，把 `--bg-primary` 行搅成
 *      `--bg-primary: #0000--border: ...5, 0.06);`，postcss 直接报 Unknown word）。
 *
 * 所以本工具：**按行定位 → 删该行及其附属注释 → 立刻校验 → 汇总报告**。
 * 每一步都可回滚（只改工作树，不自动提交）。
 *
 * ## 用法
 *
 *   node revert-tokens.mjs            # 执行
 *   node revert-tokens.mjs --dry      # 只报告要删哪些行
 *   node revert-tokens.mjs --verify   # 只跑校验（改完后用）
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const verifyOnly = args.includes("--verify");

const ROOT = process.argv[2] && !args.includes("--dry") && !args.includes("--verify")
  ? process.argv[2]
  : ".";

/* 与 scan-token-revert.mjs 的 REPOS / LOCAL_DIRS 对齐 */
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

const MASTER = join(ROOT, "docs", "rocktier", "tokens.css");
const EXCLUDE = [/^design\//, /(^|\/)design\//, /\.mock\.html$/];

/**
 * 母版副本本身必须排除。
 *
 * 每个产品都有一份 `src/styles/tokens.css`，它是 L0 母版的**分发副本** ——
 * 内容就该等于母版。若不排除，本工具会把「副本 vs 母版」的每一处都当成回退
 * 去删，删完产品的令牌层就空了。（首次预演就踩到：9 仓各报 5 处，
 * 而那 5 处正是母版自己的值。）
 */
const isMasterCopy = (p) => /(^|\/)tokens\.css$/.test(p) || /(^|\/)rocktier\//.test(p);

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const norm = (v) => {
  let s = v.replace(/\s+/g, "").toLowerCase();
  s = s.replace(/#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3\b/g, "#$1$2$3");
  s = s.replace(/(^|[^0-9a-z.])(\d+)\.(\d+)(?![0-9a-z])/g, (_, pre, int, frac) => {
    const t = frac.replace(/0+$/, "");
    return t ? `${pre}${int}.${t}` : `${pre}${int}`;
  });
  return s;
};

function blocks(css) {
  const out = [];
  const re = /(:root\s*,?\s*\[data-theme="dark"\]|:root|\[data-theme="light"\])\s*\{/g;
  let m;
  while ((m = re.exec(css))) {
    let depth = 1, i = re.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    const body = css.slice(re.lastIndex, i - 1);
    const scope = /light/.test(m[1]) ? "light" : "root";
    const tokens = new Map();
    for (const t of body.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) {
      tokens.set(t[1], norm(t[2]));
    }
    out.push({ scope, tokens, start: m.index, end: i });
  }
  return out;
}

const MB = blocks(stripComments(readFileSync(MASTER, "utf8")));
const master = {
  root: new Map((MB.find((b) => b.scope === "root") || { tokens: new Map() }).tokens),
  light: new Map((MB.find((b) => b.scope === "light") || { tokens: new Map() }).tokens),
};
for (const [k, v] of master.root) if (!master.light.has(k)) master.light.set(k, v);

function trackedStyleFiles(dir) {
  try {
    const out = execFileSync("git", ["-C", dir, "ls-files", "-z"], {
      encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\0").filter(Boolean)
      .filter((p) => /\.(css|html|svelte)$/.test(p))
      .filter((p) => !EXCLUDE.some((re) => re.test(p)))
      .filter((p) => !isMasterCopy(p));
  } catch {
    return null;
  }
}

/* 找出文件里所有 `:root` / `[data-theme="light"]` 块覆盖到的行号区间 */
function scopeRanges(css) {
  const ranges = [];
  const re = /(:root\s*,?\s*\[data-theme="dark"\]|:root|\[data-theme="light"\])\s*\{/g;
  let m;
  while ((m = re.exec(css))) {
    let depth = 1, i = re.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    ranges.push({
      scope: /light/.test(m[1]) ? "light" : "root",
      startLine: css.slice(0, m.index).split("\n").length,
      endLine: css.slice(0, i).split("\n").length,
    });
  }
  return ranges;
}

function checkIntegrity(label, src) {
  const ob = (src.match(/\{/g) || []).length;
  const cb = (src.match(/\}/g) || []).length;
  const oc = (src.match(/\/\*/g) || []).length;
  const cc = (src.match(/\*\//g) || []).length;
  const ok = ob === cb && oc === cc;
  return { ok, msg: `花括号 ${ob}/${cb} 注释 ${oc}/${cc}` };
}

let totalRemoved = 0;
const problems = [];

for (const [id, rel] of Object.entries(REPOS)) {
  const dir = join(ROOT, rel);
  const tracked = trackedStyleFiles(dir);
  if (!tracked) continue;

  for (const p of tracked) {
    const full = join(dir, p);
    const src = readFileSync(full, "utf8");
    const ranges = scopeRanges(src);
    if (!ranges.length) continue;

    const lines = src.split("\n");
    /* 记录：行号(1-based) -> 该行所属 scope */
    const lineScope = new Map();
    for (const r of ranges) {
      for (let ln = r.startLine; ln <= r.endLine; ln++) lineScope.set(ln, r.scope);
    }

    const drop = new Set(); // 行号
    const detail = [];

    for (const r of ranges) {
      const ref = r.scope === "light" ? master.light : master.root;
      for (let ln = r.startLine; ln <= r.endLine; ln++) {
        const raw = lines[ln - 1];
        if (!raw) continue;
        const m = raw.match(/^\s*(--[\w-]+)\s*:\s*([^;]+);\s*$/);
        if (!m) continue;
        const [, tok, val] = m;
        if (!ref.has(tok)) continue;
        if (norm(val) === ref.get(tok)) continue; // 语义一致，不是回退
        drop.add(ln);
        detail.push({ ln, tok, prod: val.trim(), mast: ref.get(tok) });
      }
    }

    if (!detail.length) continue;

    if (verifyOnly) {
      problems.push(`${id} ${p}: 仍有 ${detail.length} 处`);
      continue;
    }

    // 连同紧邻上方的**单行**注释一起删。
// 刻意只认单行注释：多行注释若要连带删除，必须整块精确匹配，
// 而首次实现按「向上找注释开头」猜边界，结果把 CAD app.css 的注释拆成
// 30 个开头对 31 个结尾 —— 结构直接损坏。
// 多行注释留下无害（只是变成悬空注释），宁可留下也不冒险拆散。
// （教训：注释正文里绝不能出现注释定界符，本轮已因此犯错两次。）
    const dropSet = new Set(drop);
    for (const ln of drop) {
      const prev = (lines[ln - 2] || "").trim();
      if (/^\/\*[^*]*\*\/$/.test(prev)) dropSet.add(ln - 1);
    }

    const kept = lines.filter((_, i) => !dropSet.has(i + 1));
    const out = kept.join("\n");
    const integ = checkIntegrity(p, out);
    if (!integ.ok) {
      problems.push(`${id} ${p}: 删除后结构损坏（${integ.msg}），已跳过该文件`);
      continue;
    }
    if (dry) {
      console.log(`  [dry] ${id.padEnd(11)} ${p}  将删 ${dropSet.size} 行 / ${detail.length} 处`);
      for (const d of detail) console.log(`          ${d.ln}: ${d.tok}  ${d.prod} → 母版 ${d.mast}`);
      totalRemoved += detail.length;
      continue;
    }
    writeFileSync(full, out, "utf8");
    const after = checkIntegrity(p, readFileSync(full, "utf8"));
    console.log(`  ✓ ${id.padEnd(11)} ${p}  删 ${dropSet.size} 行 / ${detail.length} 处  ${integ.msg}${after.ok ? "" : " ⚠"}`);
    totalRemoved += detail.length;
  }
}

console.log(`\n${verifyOnly ? "校验" : dry ? "预演" : "执行"}完成：${totalRemoved} 处`);
if (problems.length) {
  console.log("\n未处理：");
  for (const p of problems) console.log(`  ✗ ${p}`);
  process.exit(1);
}