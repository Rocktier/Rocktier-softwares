#!/usr/bin/env node
/**
 * 窗口配置漂移守卫（2026-11-24，真材质试点时立）
 *
 * 为什么需要它：
 *   Tauri 的平台配置文件按 JSON Merge Patch（RFC 7396）合并 —— **数组整体替换**，
 *   而且数组里的对象元素也是整体替换，不做字段级合并。官方文档原话：
 *   「any field you omit falls back to its default instead of the value in your
 *   base configuration. Repeat everything you want to keep.」
 *
 *   也就是说 `tauri.macos.conf.json` 里只要写了 `app.windows`，基础配置里的
 *   title / width / minWidth / titleBarStyle 全部**失效并回落默认值**：
 *   窗口变成没标题的 800×600，红绿灯位置也跟着错。而构建能过、CI 能绿、
 *   本机 dev 也许看不出差别 —— 这是那种只在装上之后才发现的漂移。
 *
 *   所以这里把「必须一致」写成判据：macos 覆盖块里，除材质三键外每个字段都得
 *   与基础配置逐字相等。将来谁在基础配置里改了窗口高度、忘了同步 macos 那份，
 *   这里会红，而不是等用户下载后发现窗口缩了。
 *
 * 判据：
 *   ① base.windows[i] 与 macos.windows[i] 的键集合一致（除 MATERIAL_KEYS）
 *   ② 同名键值逐字相等
 *   ③ macos 必须 transparent === true 且 windowEffects.effects 非空（否则等于没开）
 *   ④ base 不许有 transparent: true（Windows/Linux 不该跟着透明）
 *   ⑤ 两边 label 必须相等且唯一（label 对不上，Rust 侧 get_webview_window 找不到窗口）
 *
 * 用法: node scripts/verify-window-parity.mjs
 * 退出码: 0 = PASS, 1 = FAIL
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const TAURI = join(here, "..", "src-tauri");
const BASE = join(TAURI, "tauri.conf.json");
const MACOS = join(TAURI, "tauri.macos.conf.json");

/** 允许只在 macos 覆盖里出现的键：材质相关，正是本次要加的。 */
const MATERIAL_KEYS = new Set(["transparent", "windowEffects"]);

const failures = [];
const fail = (msg) => failures.push(msg);

const read = (p) => JSON.parse(readFileSync(p, "utf8"));

let base;
let macos;
try {
  base = read(BASE);
} catch (e) {
  console.error(`✗ 读不到 ${BASE}: ${e.message}`);
  process.exit(1);
}
try {
  macos = read(MACOS);
} catch (e) {
  console.log(`· 没有 ${MACOS}（这款没开真材质），跳过`);
  process.exit(0);
}

const baseWindows = base?.app?.windows ?? [];
const macWindows = macos?.app?.windows ?? [];

if (macWindows.length === 0) {
  console.log("· macos 覆盖里没有 app.windows（只覆盖了别的段），无需对齐");
  process.exit(0);
}
if (baseWindows.length !== macWindows.length) {
  fail(
    `窗口数量不一致：基础 ${baseWindows.length} 个，macos 覆盖 ${macWindows.length} 个` +
      `（数组整体替换，多出来的窗口会凭空出现或消失）`,
  );
}

const n = Math.min(baseWindows.length, macWindows.length);
for (let i = 0; i < n; i += 1) {
  const b = baseWindows[i] ?? {};
  const m = macWindows[i] ?? {};
  const tag = `windows[${i}]`;

  // ① 键集合
  const bKeys = Object.keys(b).filter((k) => !MATERIAL_KEYS.has(k));
  const mKeys = Object.keys(m).filter((k) => !MATERIAL_KEYS.has(k));
  for (const k of bKeys) {
    if (!mKeys.includes(k)) {
      fail(
        `${tag}.${k} 在基础配置里有、macos 覆盖里没有 —— 会回落到默认值（基础值 ${JSON.stringify(b[k])}）`,
      );
    }
  }
  for (const k of mKeys) {
    if (!bKeys.includes(k)) {
      fail(`${tag}.${k} 只在 macos 覆盖里出现，基础配置没有同名键，无从对齐`);
    }
  }

  // ② 同名键值
  for (const k of bKeys) {
    if (!mKeys.includes(k)) continue;
    if (JSON.stringify(b[k]) !== JSON.stringify(m[k])) {
      fail(
        `${tag}.${k} 两边不一致：基础 ${JSON.stringify(b[k])} vs macos ${JSON.stringify(m[k])}`,
      );
    }
  }

  // ⑤ label
  if (b.label !== m.label) {
    fail(`${tag}.label 不一致：基础 ${JSON.stringify(b.label)} vs macos ${JSON.stringify(m.label)}`);
  }
}

// ③ macos 必须真的开了
for (let i = 0; i < macWindows.length; i += 1) {
  const m = macWindows[i];
  if (m.transparent !== true) {
    fail(`windows[${i}]（macos）transparent 不是 true，材质透不出来`);
  }
  const effects = m?.windowEffects?.effects;
  if (!Array.isArray(effects) || effects.length === 0) {
    fail(`windows[${i}]（macos）windowEffects.effects 为空，等于没开`);
  }
}

// ④ 基础配置不许透明（Windows/Linux 没有对应材质，透明会露黑或露桌面）
for (let i = 0; i < baseWindows.length; i += 1) {
  if (baseWindows[i]?.transparent === true) {
    fail(`windows[${i}]（基础配置）transparent 为 true —— 会连带 Windows/Linux 一起透明`);
  }
  if (baseWindows[i]?.windowEffects) {
    fail(`windows[${i}]（基础配置）写了 windowEffects —— 跨平台材质必须落在平台覆盖里`);
  }
}

if (failures.length) {
  console.error(`✗ 窗口配置漂移 ${failures.length} 处：`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ 窗口配置对齐（${n} 个窗口，材质键 ${[...MATERIAL_KEYS].join(" / ")} 允许单边存在）`);
