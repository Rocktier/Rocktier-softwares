// 接线判据：函数写对了，但没人调它 —— 这次两个 bug 都是这种形态。
//
// 1. `convert-done` 里 `isConverting = false` 之后没有任何刷新动作，
//    进度条停在最后一帧（`4/4 (100%)` 一直挂着）；
// 2. 清空列表写了两份实现（Clear 按钮 / ⌘⌫），两份都漏了进度条。
//
// 这两条测不了「用户看到什么」，只能测「代码有没有按约定接上」。
// 属于结构断言，故意写得窄：只盯调用点与重复实现，不猜实现细节。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, "..", "src", "app.js"), "utf8");

/** 粗粒度取一段代码块：从起始标记到下一次 `\n  }` 或 `\n});` 收尾。 */
function block(startMarker) {
  const i = SRC.indexOf(startMarker);
  assert.notEqual(i, -1, `app.js 里找不到 ${startMarker}`);
  const rest = SRC.slice(i);
  const end = rest.search(/\n\s*\}\);/);
  return end === -1 ? rest : rest.slice(0, end);
}

test("convert-done 落定后必须刷新进度条", () => {
  const b = block('listen("convert-done"');
  assert.match(
    b,
    /updateProgress\s*\(/,
    "convert-done 里没有 updateProgress() —— 进度条会停在转换中的最后一帧",
  );
});

test("清空列表只有一份实现，Clear 按钮与 ⌘⌫ 共用", () => {
  const defs = [...SRC.matchAll(/function clearAllFiles\s*\(/g)].length;
  const calls = [...SRC.matchAll(/(?<!function )clearAllFiles\s*\(/g)].length;
  assert.equal(defs, 1, "clearAllFiles 应当只定义一次");
  assert.ok(calls >= 2, `clearAllFiles 的调用点只有 ${calls} 个，两个入口没都接上`);
});

test("不允许再出现内联的清空实现（files = [] 紧跟 stats = null）", () => {
  // clearAllFiles 自己当然会写这两行 —— 把它整段剔掉，再看剩下还有没有第二份。
  const i = SRC.indexOf("function clearAllFiles");
  assert.notEqual(i, -1, "找不到 clearAllFiles 的定义");
  const end = SRC.indexOf("\n}", i);
  assert.notEqual(end, -1, "clearAllFiles 的函数体没有正常收尾");
  const rest = SRC.slice(0, i) + SRC.slice(end);
  assert.doesNotMatch(
    rest,
    /files\s*=\s*\[\];[^\n]*\n\s*stats\s*=\s*null;/,
    "还有一处内联清空：它会又一次漏掉进度条，请改调 clearAllFiles()",
  );
});

test("文件对话框的后缀白名单只从 formats.js 取", () => {
  assert.match(SRC, /import\s*\{[^}]*DIALOG_IMAGE_EXTENSIONS[^}]*\}\s*from\s*["']\.\/formats\.js["']/);
  assert.doesNotMatch(
    SRC,
    /extensions:\s*\[/,
    "app.js 里还有写死的后缀数组 —— 会与 formats.js 分叉（.tif 就是这么漏的）",
  );
});

test("导入校验与对话框共用同一份白名单（不要第二份 SUPPORTED_EXTS）", () => {
  // 事故形态：filters 与 addFiles 各有一份后缀数组，两份都漏 .tif。
  // 只修一处的话，另一处仍然会把文件挡在门外（拖放路径就走 addFiles）。
  assert.doesNotMatch(
    SRC,
    /(SUPPORTED_EXTS|const\s+\w*EXTS?\w*\s*=\s*\[)/,
    "app.js 里又出现了本地后缀数组，请改用 formats.js 的 DIALOG_IMAGE_EXTENSIONS",
  );
  assert.match(
    SRC,
    /DIALOG_IMAGE_EXTENSIONS\.includes\(\s*fileExt\(/,
    "addFiles 的导入校验没有用共享白名单",
  );
});

// ─── AVIF 输出（2026-11-25）────────────────────────────────────────
//
// 后端认 `output_format`，前端不发这个字段就等于「功能做了但用户点不到」。
// 两层各钉一条：请求体里必须有它、菜单里必须有切换项，且两个词条两种语言都在。

test("转换请求必须带上 output_format", () => {
  assert.match(SRC, /output_format:\s*outputFormat/, "buildRequest 没把格式传给后端");
  assert.ok(
    /localStorage\.getItem\(OUTPUT_FORMAT_KEY\)/.test(SRC),
    "格式没从 localStorage 读回来 —— 选了 AVIF 的用户每批都要重选",
  );
});

test("⋯ 菜单必须有 WebP / AVIF 两项，且互斥打勾", () => {
  assert.match(SRC, /item\(t\("mi-format-webp"\)/, "菜单缺 WebP 项");
  assert.match(SRC, /item\(t\("mi-format-avif"\)/, "菜单缺 AVIF 项");
  const b = block("function openMoreMenu");
  assert.match(b, /checked:\s*outputFormat === "webp"/, "WebP 项没按当前格式打勾");
  assert.match(b, /checked:\s*outputFormat === "avif"/, "AVIF 项没按当前格式打勾");
});

// ─── 失败清单导出（2026-11-25）──────────────────────────────────────
//
// 三处必须同时成立，缺一处就是「按钮点了没反应」：
// ① index.html 有按钮；② app.js 接了线而且会随失败数显隐；③ 后端命令在
// invoke_handler 里注册过、能力清单放行了 save 对话框。
// 第 ③ 条是最容易漏的：Tauri v2 里没写 `dialog:allow-save`，对话框在运行时
// 直接被拒，前端只会静默 catch 掉。

import { readFileSync as read2 } from "node:fs";
const HTML = read2(join(here, "..", "src", "index.html"), "utf8");
const RUST = read2(join(here, "..", "src-tauri", "src", "lib.rs"), "utf8");
const CAPS = read2(join(here, "..", "src-tauri", "capabilities", "default.json"), "utf8");

test("失败清单导出：按钮、接线、命令、能力四件齐", () => {
  assert.ok(HTML.includes('id="export-failed-btn"'), "index.html 缺导出按钮");
  assert.match(SRC, /getElementById\("export-failed-btn"\)\s*\n\s*\?\.addEventListener/, "按钮没有接线");
  assert.match(RUST, /fn export_failed_list\(/, "Rust 侧没有 export_failed_list");
  assert.match(RUST, /export_failed_list,\n/, "export_failed_list 没有注册进 invoke_handler");
  assert.match(CAPS, /"dialog:allow-save"/, "能力清单缺 dialog:allow-save —— 保存对话框会被拒");
});

test("失败清单必须带后端原始码（用户说的和日志里的要对得上）", () => {
  assert.match(
    SRC,
    /clean\(f\.path\),\s*clean\(translateBackendMessage\(f\.message\)\),\s*clean\(f\.message\),/s,
    "导出列应该是 路径 / 本地化原因 / 原始码",
  );
});

test("导出按钮与重试按钮同显同隐", () => {
  const hides = [...SRC.matchAll(/exportFailedBtn\.hidden\s*=/g)].length;
  assert.ok(hides >= 2, `export-failed-btn 只在 ${hides} 处显隐，重置与 convert-done 没都覆盖`);
});

// ─── 状态栏汇总只报非零段（2026-11-25 窄窗实测）────────────────────
//
// 实测 640 pt 宽：整串被省略号截掉，而「· 0 skipped · 0 failed」正好吃掉那段，
// 最该看见的失败数反而看不到。判据两条：非零过滤必须存在、失败必须排在跳过之前。

test("状态栏汇总必须只拼非零段，且失败排在跳过前", () => {
  const b = block("function updateStatus");
  assert.match(b, /if \(ok !== "0"\)/, "成功数没做非零过滤");
  assert.match(b, /if \(fail !== "0"\)/, "失败数没做非零过滤");
  const iFail = b.indexOf('t("statusbar-final-fail"');
  const iSkip = b.indexOf('t("statusbar-final-skip"');
  assert.ok(iFail > 0 && iSkip > 0, "缺 statusbar-final-fail / -skip");
  assert.ok(iFail < iSkip, "失败必须排在跳过之前 —— 窄窗截断时先保失败");
});

test("状态栏新键两种语言都在（旧 statusbar-done 已退役）", () => {
  const zh = read2(join(here, "..", "src", "i18n.js"), "utf8");
  for (const k of ["statusbar-final", "statusbar-final-ok", "statusbar-final-fail",
                   "statusbar-final-skip", "statusbar-final-saved"]) {
    const hits = zh.split(`"${k}"`).length - 1;
    assert.equal(hits, 2, `${k} 在两种语言里不是各一处（实际 ${hits}）`);
  }
  assert.ok(!zh.includes('"statusbar-done"'), "旧键 statusbar-done 还在，已无人引用");
});
