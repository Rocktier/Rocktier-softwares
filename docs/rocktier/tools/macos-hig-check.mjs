#!/usr/bin/env node
/**
 * Rocktier macOS HIG 闸门 —— 把《人机界面指南》里「能静态判定」的那几条钉死。
 *
 * 规范来源：
 *   - developer.apple.com/design/human-interface-guidelines/designing-for-macos
 *     （窗口可调整/最小尺寸、菜单栏承载全部命令、全屏、键盘快捷键）
 *   - App Store 提交要求（LSApplicationCategoryType 必填）
 *   - 2026-11-06/07 首次 MAS 提交的实际踩坑（ITSAppUsesNonExemptEncryption）
 *   对应清单与逐条理由见 docs/rocktier/macos-hig-checklist.md
 *
 * 为什么单独一个脚本而不塞进 family-check：
 *   family-check 只吃 UI 令牌与文案层（tokens/i18n），它的 20 条判据全部面向
 *   渲染结果；本脚本面向**打包产物配置**（Info.plist / tauri.conf / 原生菜单），
 *   两者失效方式不同（前者页面变丑，后者商店被拒），混在一起会让两边都难读。
 *
 * 用法：
 *   node docs/rocktier/tools/macos-hig-check.mjs                    # 家族根自动探测
 *   node docs/rocktier/tools/macos-hig-check.mjs --root family      # CI 里 8 仓平铺
 *   node docs/rocktier/tools/macos-hig-check.mjs --product pdf      # 只查一款
 *
 * 退出码：0 = 全过；1 = 有 FAIL
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);

/* 目录名与产品 id 不一一对应（markdown → "Rocktier MD"），与 sync-family-gates.mjs
   同一套显式列表：推导规则猜错会静默跳过一个产品，比列错更糟。 */
const PRODUCTS = [
  { dir: "Rocktier PDF", id: "pdf", category: "public.app-category.productivity", crypto: false },
  { dir: "Rocktier MD", id: "markdown", category: "public.app-category.productivity", crypto: false },
  { dir: "Rocktier Write", id: "write", category: "public.app-category.productivity", crypto: false },
  { dir: "Rocktier Pic2Webp", id: "pic2webp", category: "public.app-category.graphics-design", crypto: false },
  { dir: "Rocktier CAD Viewer", id: "cad", category: "public.app-category.graphics-design", crypto: false },
  { dir: "Rocktier OCR", id: "ocr", category: "public.app-category.productivity", crypto: false },
  { dir: "Rocktier-Compressor", id: "compressor", category: "public.app-category.utilities", crypto: false },
  /* Journal 例外：日记正文由 aes-gcm 在应用层自行加密，属「非豁免加密」，
     声明必须是 true。放进本表是为了让「有人把 false 复制到 Journal」当场报红。 */
  { dir: "Rocktier-Journal", id: "journal", category: "public.app-category.lifestyle", crypto: true },
];

const VALID_CATEGORIES = new Set([
  "public.app-category.business",
  "public.app-category.developer-tools",
  "public.app-category.education",
  "public.app-category.entertainment",
  "public.app-category.finance",
  "public.app-category.games",
  "public.app-category.graphics-design",
  "public.app-category.healthcare-fitness",
  "public.app-category.lifestyle",
  "public.app-category.medical",
  "public.app-category.music",
  "public.app-category.news",
  "public.app-category.photography",
  "public.app-category.productivity",
  "public.app-category.reference",
  "public.app-category.social-networking",
  "public.app-category.sports",
  "public.app-category.travel",
  "public.app-category.utilities",
  "public.app-category.video",
  "public.app-category.weather",
]);

/** 极简 plist 读取：只处理本家族用到的「扁平 dict + 标量值」。
    布尔统一成字符串 "true"/"false"，免得比较时在 boolean 与 string 之间来回翻。 */
function readPlist(text) {
  const out = {};
  const re = /<key>([^<]+)<\/key>\s*(?:<(true|false)\/>|<string>([\s\S]*?)<\/string>)/g;
  for (const m of text.matchAll(re)) {
    out[m[1]] = m[2] ? m[2] : m[3];
  }
  return out;
}

/** 递归收集 Rust 源码。
    不能只看 src/menu.rs —— 实测家族里菜单代码分三处落：Pic2Webp/OCR/CAD/Journal
    在 src/menu.rs，PDF 在 src/main.rs，MD/Write/Compressor 在 src/lib.rs。 */
function rustSources(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...rustSources(p));
    else if (e.name.endsWith(".rs")) out.push(p);
  }
  return out;
}

function detectRoot() {
  const explicit = opt("--root");
  if (explicit) return resolve(explicit);
  const probe = ["Rocktier PDF", "Rocktier MD", "Rocktier Pic2Webp"];
  let dir = HERE;
  for (let i = 0; i < 8; i++) {
    if (probe.filter((d) => existsSync(join(dir, d))).length >= 2) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return resolve(HERE, "..", "..", "..");
}

const root = detectRoot();
const only = opt("--product");
const targets = only ? PRODUCTS.filter((p) => p.id === only) : PRODUCTS;
if (!targets.length) {
  console.error(`  ❌ 未知产品 id: ${only}`);
  process.exit(1);
}

console.log(`\n  Rocktier macOS HIG 闸门（root: ${root}）\n`);

let fails = 0;
let passes = 0;
let skipped = 0;

for (const p of targets) {
  const base = join(root, p.dir);
  if (!existsSync(base)) {
    console.log(`  ·  ${p.dir.padEnd(22)} 目录不存在，跳过`);
    skipped++;
    continue;
  }
  const problems = [];
  const confPath = join(base, "src-tauri", "tauri.conf.json");
  const plistPath = join(base, "src-tauri", "Info.plist");
  const menuPath = join(base, "src-tauri", "src", "menu.rs");

  /* ── 1) tauri.conf.json：窗口与图标 ────────────────────────────────────
     HIG（designing-for-macos · Best practices）：可调整大小、可全屏、
     大屏上给足内容；App Store 要求 .icns 图标。 */
  if (!existsSync(confPath)) {
    problems.push("缺 src-tauri/tauri.conf.json");
  } else {
    let conf = null;
    try {
      conf = JSON.parse(readFileSync(confPath, "utf8"));
    } catch (e) {
      problems.push(`tauri.conf.json 解析失败: ${e.message}`);
    }
    if (conf) {
      const win = (conf.app && conf.app.windows && conf.app.windows[0]) || {};
      if (win.resizable === false) problems.push("主窗口 resizable:false —— HIG 要求窗口可调整大小");
      if (!win.minWidth || win.minWidth < 480) problems.push(`主窗口 minWidth=${win.minWidth ?? "未设"}，小于 480（拖到过小会挤坏布局）`);
      if (!win.minHeight || win.minHeight < 360) problems.push(`主窗口 minHeight=${win.minHeight ?? "未设"}，小于 360`);
      if (!win.title) problems.push("主窗口没有 title");
      const icons = (conf.bundle && conf.bundle.icon) || [];
      if (!icons.some((i) => i.endsWith(".icns"))) problems.push("bundle.icon 里没有 .icns（App Store 与 Dock 都要）");
      if (!existsSync(join(base, "src-tauri", "icons", "icon.icns"))) problems.push("icons/icon.icns 文件不存在");
    }
  }

  /* ── 2) Info.plist：出口合规 + 商店类别 ─────────────────────────────── */
  if (!existsSync(plistPath)) {
    problems.push("缺 src-tauri/Info.plist（出口合规与商店类别都在里面）");
  } else {
    const raw = readFileSync(plistPath, "utf8");
    const dict = readPlist(raw);
    if (!("ITSAppUsesNonExemptEncryption" in dict)) {
      problems.push("Info.plist 缺 ITSAppUsesNonExemptEncryption（ASC 会逐 build 弹加密问卷）");
    } else if (p.crypto && dict.ITSAppUsesNonExemptEncryption !== "true") {
      problems.push("本产品有自研加密，ITSAppUsesNonExemptEncryption 必须是 true（填 false 属虚假声明）");
    } else if (!p.crypto && dict.ITSAppUsesNonExemptEncryption !== "false") {
      problems.push("本产品无自研加密，ITSAppUsesNonExemptEncryption 应为 false");
    }
    if (!dict.LSApplicationCategoryType) {
      problems.push("Info.plist 缺 LSApplicationCategoryType（App Store 必填）");
    } else if (!VALID_CATEGORIES.has(dict.LSApplicationCategoryType)) {
      problems.push(`LSApplicationCategoryType 不是合法值: ${dict.LSApplicationCategoryType}`);
    } else if (dict.LSApplicationCategoryType !== p.category) {
      problems.push(`LSApplicationCategoryType=${dict.LSApplicationCategoryType}，契约期望 ${p.category}`);
    }
    /* HIG（暗色模式）：强制浅色外观等于剥夺系统级偏好。 */
    if ("NSRequiresAquaSystemAppearance" in dict) {
      problems.push("Info.plist 出现 NSRequiresAquaSystemAppearance —— 会强制浅色外观，HIG 要求跟随系统");
    }
  }

  /* ── 3) 原生菜单：HIG 的「菜单栏承载全部命令」 ───────────────────────── */
  const rsFiles = rustSources(join(base, "src-tauri", "src"));
  if (!rsFiles.length) {
    problems.push("src-tauri/src 下没有任何 .rs");
  } else {
    const menu = rsFiles.map((f) => readFileSync(f, "utf8")).join("\n");
    /* 判据分两类：
       ① 必须用系统预定义项 —— 撤回/拷贝/粘贴/全选/最小化这些是「与 webview 或
          NSWindow 打交道的系统能力」，自定义项做不到（尤其剪贴板）。
       ② 允许自定义项，只要绑了标准快捷键 —— 家族里两处是**有意为之**：
          PDF 的 undo/redo 走自己的文档撤销栈（getter 在 Rust 侧），
          OCR 的 quit 用自绘项（已绑 ⌘Q）。一刀切要求 Predefined 会逼人改掉
          正确设计，闸门就变成了噪音源。 */
    const need = [
      ["关于面板", (s) => s.includes("PredefinedMenuItem::about") && s.includes("AboutMetadata")],
      ["撤销（预定义或自绘 + ⌘Z）", (s) =>
        s.includes("PredefinedMenuItem::undo") ||
        (s.includes('"undo"') && s.includes("CmdOrCtrl+Z"))],
      ["退出（预定义或自绘 + ⌘Q）", (s) =>
        s.includes("PredefinedMenuItem::quit") ||
        (s.includes('"quit"') && s.includes("CmdOrCtrl+Q"))],
      ["拷贝", (s) => s.includes("PredefinedMenuItem::copy")],
      ["粘贴", (s) => s.includes("PredefinedMenuItem::paste")],
      ["全选", (s) => s.includes("PredefinedMenuItem::select_all")],
      ["最小化", (s) => s.includes("PredefinedMenuItem::minimize")],
    ];
    for (const [label, test] of need) {
      if (!test(menu)) problems.push(`原生菜单缺「${label}」`);
    }
    if (!menu.includes("PredefinedMenuItem::fullscreen") && !menu.includes("win-fullscreen")) {
      problems.push("menu.rs 没有全屏项 —— HIG 要求支持全屏");
    }
    /* AboutMetadata 必须是 Some(...)：Windows 后端只认带 metadata 的那种，
       传 None 会静默变成点了没反应（findings D-42 实测）。 */
    if (!menu.includes("AboutMetadata")) {
      problems.push("menu.rs 的 About 没带 AboutMetadata —— Windows 上点了没反应");
    }
    const submenus = (menu.match(/Submenu::with_items/g) || []).length;
    if (submenus < 5) {
      problems.push(`menu.rs 只有 ${submenus} 个子菜单，HIG 标准是 App/File/Edit/View/Window(+/Help) 至少 5 个`);
    }
  }

  if (problems.length) {
    fails++;
    console.log(`  ❌ ${p.dir.padEnd(22)} ${problems.length} 项不达标`);
    for (const x of problems) console.log(`       · ${x}`);
  } else {
    passes++;
    console.log(`  ✅ ${p.dir.padEnd(22)} 窗口 / 图标 / Info.plist / 原生菜单 全部达标`);
  }
}

console.log(
  `\n  通过 ${passes}，失败 ${fails}${skipped ? `，跳过 ${skipped}` : ""}\n`,
);
/* 一个产品目录都没找到时必须报错而不是静默通过：CI 里 --root 写错、
   或者家族根布局变了，都会让「全部跳过」看起来像「全部通过」。
   这是记忆里那条「判据失效比判据报红更坏」的直接应用。 */
if (skipped === targets.length) {
  console.error(`  ❌ ${root} 下没有找到任何产品目录 —— 路径错了，本次判据无效\n`);
  process.exit(1);
}
process.exit(fails ? 1 : 0);
