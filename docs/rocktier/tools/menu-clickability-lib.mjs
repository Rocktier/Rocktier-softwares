/* 家族菜单栏可点性检测 —— 核心逻辑（CLI 与中央闸门共用）。

   ── 检测原理 ──
   菜单项从 Rust 的 MenuItem::with_id 定义，到真正有响应，中间隔着**两跳**：
       Rust 定义 → 事件分发 → 前端 case 分支
   9 个应用里有 8 个**不做逐 id match**，而是兜底转发：

       if event.id().0.as_str() == "quit" { …; return; }
       let _ = app.emit("menu-action", event.id().0.as_str());

   任一跳漏掉，菜单项照样显示、编译照样通过、应用照样启动 ——
   只是**点了没反应**。这类缺陷没有任何既有闸门能抓到。

   ── 前端消费的三种写法都要认 ──
       switch   case "x":
       if/else  else if (id === "x")        ← Compressor
       映射表    open: () => …               ← Pic2WebP 的 menuActions

   ── 我在这件事上错过的三次（留着当反面教材）──
   ① 只认 `"id" => {}` 的 match 分支 → 误报 **68 项**死项，
      因为 8/9 应用根本是兜底转发。
   ② 前端只扫 .tsx/.ts/.jsx/.js → 漏了 **.svelte**，
      CAD Viewer 整个被误报成「8 项全死」（它是 Svelte）。
   ③ 假定前端在 `src/` → OCR 的前端实际在 `ui/`，
      7 项全被误报，而它的 app.js 里 switch 七项齐全。

   修法：前端扫**全仓**（排除 node_modules/dist/target/src-tauri），
   只按扩展名认，不假定目录名，也不假定框架。

   ── 另一处把我坑了的写法 ──
   `MenuItem::with_id(app, "new", …)` 的**第一个参数是 &AppHandle，
   不是 id**。写成 /with_id\(\s*"([^"]+)"/ 会匹配到 0 项，
   然后脚本报「✅ 无死项」—— **一个永远说通过的检测器比没有更危险**。

   ── 已用变异测试验证判别力 ──
   删掉任一分支（case / 映射表 / else-if 三种形态）均被抓出，还原后归零。 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

/* .family-root 是 scripts/family-gate.mjs 跑闸门时造的软链农场（apps/<id> 的别名）。
   不排除它会把同一款产品数两遍：「apps/compressor」与「.family-root/Rocktier-Compressor」
   指向同一份代码，于是 1 个死项被报成 2 个（2026-11-24 实测）。 */
const SKIP_DIRS = new Set(["node_modules", "dist", "target", "src-tauri", "scripts", ".git", "public", ".family-root"]);

/* 按「哪里有 src-tauri」定位产品仓，不按目录名猜 ——
   2026-11-04 起 8 款产品仓均为平铺；下面第二层探测保留为历史嵌套布局的兜底。 */
function findProducts(base) {
  const out = [];
  for (const name of readdirSync(base)) {
    /* 点开头的一律跳过：.git / .family-root（闸门自己的软链农场）。
       农场里的 `Rocktier PDF` 与 `apps/pdf` 是同一份代码，不跳过就会把同一款
       产品数两遍，死项也跟着翻倍。 */
    if (name.startsWith(".")) continue;
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
      if (statSync(p).isDirectory()) {
        if (SKIP_DIRS.has(n)) continue;
        walk(p);
      } else if (n.endsWith(ext)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

const readAll = (files) => files.map((f) => ({ f, s: readFileSync(f, "utf8") }));

/* 菜单项 id。**第一个参数是 &AppHandle，必须跳过。** */
function menuItemIds(rust) {
  const ids = new Map();
  const patterns = [
    /MenuItem::with_id\(\s*[^,]+,\s*"([^"]+)"/g,
    /CheckMenuItemBuilder::new\(\s*"([^"]+)"/g,
    /MenuItemBuilder::with_id\(\s*[^,]+,\s*"([^"]+)"/g,
  ];
  for (const { f, s } of rust) {
    for (const re of patterns) {
      for (const m of s.matchAll(re)) {
        if (!ids.has(m[1])) {
          ids.set(m[1], `${f.split("/src-tauri/")[1] || f}:${s.slice(0, m.index).split("\n").length}`);
        }
      }
    }
  }
  return ids;
}

/* Rust 侧：分发方式 + 逐 id match 的分支 + PredefinedMenuItem。
   match 分支**只取 on_menu_event 之后的段落**，否则会把菜单定义区
   里的字符串误当分支。 */
function rustDispatch(rust) {
  const matched = new Set();
  const predefined = new Set();
  let passthroughTo = null;

  for (const { s } of rust) {
    for (const mm of s.matchAll(/on_menu_event/g)) {
      const seg = s.slice(mm.index, mm.index + 5000);
      for (const h of seg.matchAll(/"([a-z][a-z0-9_-]*)"\s*=>/g)) matched.add(h[1]);
      /* 逐 id 处理的两种写法都要认：
         `event.id().as_str() == "x"`（多数款）与 `event.id().as_ref() == "x"`
         （Compressor 的 win-fullscreen，2026-11-24 补）。
         只认 as_str 时，as_ref 那处被判成死项 —— 而它就在 on_menu_event 里
         调 set_fullscreen，代码注释还写着为什么不用 PredefinedMenuItem。
         闸门报假红比漏报更伤：没人会去认真实存在的死项。 */
      for (const h of seg.matchAll(/event\.id\(\)(?:\.\d)?(?:\.0)?\.\s*(?:as_str|as_ref)\(\)\s*==\s*"([^"]+)"/g)) matched.add(h[1]);
      for (const h of seg.matchAll(/event\.id\(\)\s*==\s*"([^"]+)"/g)) matched.add(h[1]);
      const pt = seg.match(/emit\(\s*"(menu-action|menu:[a-z0-9-]+)"[^)]*event\.id\(\)/);
      if (pt) passthroughTo = pt[1];
    }
    for (const h of s.matchAll(/PredefinedMenuItem::(\w+)/g)) predefined.add(h[1]);
  }
  return { matched, predefined, passthroughTo };
}

/* 前端：某事件被哪些分支消费。扫全仓，不假定目录/框架。 */
function frontendCases(root, eventName) {
  const exts = [".tsx", ".ts", ".jsx", ".js", ".svelte", ".vue"];
  const files = readAll(exts.flatMap((e) => filesUnder(root, e)));
  const cases = new Set();
  let listened = false;
  const evRe = new RegExp(`listen[^\\n]*["'\`]${eventName.replace(/-/g, "\\-")}["'\`]`);

  for (const { s } of files) {
    if (evRe.test(s)) listened = true;
    for (const c of s.matchAll(/case\s+["']([a-z][a-z0-9_-]*)["']/gi)) cases.add(c[1]);
    for (const c of s.matchAll(/(?:else\s+)?if\s*\(\s*\w+\s*===\s*["']([a-z][a-z0-9_-]*)["']/g)) cases.add(c[1]);
    for (const c of s.matchAll(/["']([a-z][a-z0-9_-]*)["']\s*:/g)) cases.add(c[1]);
    for (const c of s.matchAll(/^\s{2,}([a-z][a-z0-9_-]*)\s*:\s*(?:\(\)|async|function|\()/gm)) cases.add(c[1]);
  }
  return { cases, listened };
}

export function runMenuCheck(familyRoot) {
  const products = findProducts(familyRoot);
  const rows = [];

  for (const { label, root: prodRoot } of products) {
    const rust = readAll(filesUnder(join(prodRoot, "src-tauri"), ".rs"));
    const ids = menuItemIds(rust);
    const { matched, predefined, passthroughTo } = rustDispatch(rust);
    const mode = passthroughTo ? `透传 ${passthroughTo}` : "Rust match";

    const fe = passthroughTo ? frontendCases(prodRoot, passthroughTo) : null;
    const dead = [];
    for (const id of ids.keys()) {
      if (predefined.has(id)) continue;   /* quit/minimize/copy… 系统自己处理 */
      if (matched.has(id)) continue;      /* Rust 侧逐 id match */
      if (fe && fe.cases.has(id)) continue; /* 前端 case / else-if / 映射表 */
      dead.push(id);
    }
    rows.push({ label, n: ids.size, mode, dead, where: ids, feListened: fe ? fe.listened : null });
  }
  return { rows, deadAll: rows.reduce((n, r) => n + r.dead.length, 0), products: products.length };
}

export { findProducts, filesUnder, menuItemIds, rustDispatch, frontendCases };