#!/usr/bin/env node
/* 补齐 Windows icon.ico 缺失的尺寸层级。
 *
 * ── 为什么需要 ──
 * Windows 任务栏图标槽随系统 DPI 缩放，所需像素是
 * 24（100%）、30（125%）、36（150%）、42（175%）、48（200%）。
 * `tauri icon` 生成的 ICO 固定是 16/24/32/48/64/128/256 ——
 * **30、36、42 一个都没有**。缺尺寸时 Windows 只能从邻近尺寸
 * 做位图插值放大/缩小，任务栏图标就糊。
 *
 * 而桌面图标请求的是 48（中等）或 32（小），ICO 里恰好有精确图层，
 * 所以「任务栏糊、桌面清晰」。这不是 DPI 感知问题（Tauri 2 默认
 * per-monitor-aware），也不是美术问题（24x24 图层内部细节清晰可读）。
 *
 * ── 做法 ──
 * **只增不改**：原有图层原样保留，从 1024x1024.png 精确降采样出缺的层
 * 追加进去。理由是 `tauri icon` 生成的既有图层有它自己的抗锯齿处理，
 * 全部重生成会让 8 个仓的图标产生大面积无意义 diff，也让 review 失焦。
 *
 * 降采样用 LANCZOS —— 对 1024 → 30 这种大比例缩小，它保留的细节最多。
 * 相比让 Windows 自己插值，拿到精确尺寸就是最优解。
 *
 * ── 用法 ──
 *   node docs/rocktier/tools/fix-ico-sizes.mjs              # 8 个仓全跑
 *   node docs/rocktier/tools/fix-ico-sizes.mjs "Rocktier MD" # 单仓
 *   node docs/rocktier/tools/fix-ico-sizes.mjs --check       # 只报告不改
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");

/* Windows 各处会请求的尺寸。已有层（16/24/32/48/64/128/256）由
 * `tauri icon` 提供，本脚本只补它没有的。 */
const WANT = [16, 20, 24, 30, 32, 36, 40, 42, 48, 64, 96, 128, 256];

/* 任务栏按 DPI 缩放的槽位，用来在报告里说清「补的是哪一档」。 */
const TASKBAR = { 100: 24, 125: 30, 150: 36, 175: 42, 200: 48 };

const CHECK_ONLY = process.argv.includes("--check");
const targets = process.argv.slice(2).filter((a) => !a.startsWith("--"));

const REPOS = targets.length
  ? targets
  : [
      "Rocktier PDF", "Rocktier MD", "Rocktier-Journal", "Rocktier-Compressor",
      "Rocktier Sign", "Rocktier CAD Viewer", "Rocktier Write", "Rocktier OCR",
      "Rocktier Pic2Webp",
    ];

/* ── ICO 读写（PNG 压缩条目，Vista+ 原生支持，现有 ICO 已是这个形态）── */

function parseIco(buf) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) {
    throw new Error("不是 ICO 文件（type != 1）");
  }
  const n = buf.readUInt16LE(4);
  const layers = [];
  for (let i = 0; i < n; i++) {
    const o = 6 + i * 16;
    const w = buf[o] || 256;             // 0 表示 256
    const h = buf[o + 1] || 256;
    const size = buf.readUInt32LE(o + 8);
    const off = buf.readUInt32LE(o + 12);
    layers.push({ w, h, size, data: buf.subarray(off, off + size) });
  }
  return layers;
}

function buildIco(layers) {
  const n = layers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(n, 4);
  const dir = Buffer.alloc(16 * n);
  let offset = 6 + 16 * n;
  layers.forEach((l, i) => {
    const o = i * 16;
    dir[o]     = l.w >= 256 ? 0 : l.w;      // 256 编码为 0
    dir[o + 1] = l.h >= 256 ? 0 : l.h;
    dir[o + 2] = 0;                          // 色彩数：0 = 真彩
    dir[o + 3] = 0;                          // 保留
    dir.writeUInt16LE(1, o + 4);             // planes
    dir.writeUInt16LE(32, o + 6);            // bpp
    dir.writeUInt32LE(l.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += l.data.length;
  });
  return Buffer.concat([header, dir, ...layers.map((l) => l.data)]);
}

/* ── 降采样 ── */
const PY = `
import sys
from PIL import Image
src, dst, size = sys.argv[1], sys.argv[2], int(sys.argv[3])
im = Image.open(src)
if im.mode != "RGBA":
    im = im.convert("RGBA")
im = im.resize((size, size), Image.LANCZOS)
im.save(dst, "PNG", optimize=True)
`;

function resizeTo(src, size) {
  const out = join("/tmp", `ico-${size}.png`);
  execFileSync("python3", ["-c", PY, src, out, String(size)], { stdio: "pipe" });
  return readFileSync(out);
}

/* ── 主流程 ── */
console.error("");
console.error("  仓库 / 现状 / 动作");
console.error("  " + "─".repeat(72));

const report = [];
let changed = 0;

for (const rel of REPOS) {
  const repo = join(ROOT, rel);
  const icoPath = join(repo, "src-tauri", "icons", "icon.ico");
  const srcPath = join(repo, "src-tauri", "icons", "1024x1024.png");

  if (!existsSync(icoPath)) {
    report.push([rel, "无 icon.ico", "跳过"]);
    continue;
  }
  if (!existsSync(srcPath)) {
    report.push([rel, "无 1024x1024.png（无法降采样）", "❌ 跳过"]);
    report.push([rel, "", "ERROR"]);
    continue;
  }

  const layers = parseIco(readFileSync(icoPath));
  const have = new Set(layers.map((l) => l.w));
  const missing = WANT.filter((s) => !have.has(s));

  // 哪些 DPI 档位因此受损
  const hurtDpi = Object.entries(TASKBAR)
    .filter(([, px]) => !have.has(px))
    .map(([dpi]) => `${dpi}%`);

  if (!missing.length) {
    report.push([rel, `${layers.length} 层，已齐全`, "✅ 无需改动"]);
    continue;
  }

  if (CHECK_ONLY) {
    report.push([rel, `${layers.length} 层，缺 ${missing.join("/")}（影响 DPI ${hurtDpi.join("/")}）`, "待补"]);
    continue;
  }

  for (const s of missing) layers.push({ w: s, h: s, data: resizeTo(srcPath, s) });
  layers.sort((a, b) => a.w - b.w);
  writeFileSync(icoPath, buildIco(layers));

  report.push([rel, `${layers.length - missing.length} → ${layers.length} 层，缺 ${missing.join("/")}`, `✅ 已补（修复 DPI ${hurtDpi.join("/")}）`]);
  changed++;
}

for (const [repo, before, after] of report) {
  console.error(`  ${after.padEnd(34)} ${repo.padEnd(30)} ${before}`);
}

console.error("");
if (changed) {
  console.error(`  ✅ ${changed} 个仓已更新（${CHECK_ONLY ? "check 模式未写盘" : "已写盘"}）`);
  console.error("");
  console.error("  补完仍必须走 CI 验打包产物 —— 本机不打包（铁律 #7）。");
  console.error("  装好后用 125% / 150% / 175% 三档缩放各看一次任务栏。");
  console.error("");
} else if (CHECK_ONLY) {
  console.error("  （check 模式：以上为待补清单，未写盘）\n");
} else {
  console.error("  ✅ 全部仓的 ICO 尺寸已齐全\n");
}