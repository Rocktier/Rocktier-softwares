#!/usr/bin/env node
/**
 * Rocktier family gate —— monorepo 版执行器
 *
 * 背景（2026-11-24）：
 *   家族闸门原本只有一个执行点，在私有台账仓 rocktier-docs 的
 *   `.github/workflows/family-contract.yml`：先 clone 8 个产品仓到 `family/` 平铺，
 *   再跑 5 道闸门。monorepo 合并后那 8 个仓全部删除，于是这条链路有两处同时失效：
 *
 *     ① clone 的全是 404（布局假设没了）；
 *     ② 更早一步就挂了 —— 私有仓 Actions 额度耗尽，job 从未启动
 *        （annotation：「recent account payments have failed or your spending limit
 *        needs to be increased」）。也就是说中央闸门「全绿」的假象已经维持了很久，
 *        实际一次都没跑。
 *
 *   契约本身没有变，22 条判据也没有变。变的只有**布局**：产品从 8 个兄弟目录变成
 *   一个仓里的 `apps/<id>`。所以这里不去改那 20 条判据（1177 行，改判据风险远大于
 *   价值），而是造一个临时「农场」：把 `apps/<id>` 按旧目录名软链过去，布局对新
 *   判据透明。判据认的是 `Rocktier PDF` 这种名字，农场就给它这些名字。
 *
 *   为什么契约也跟着搬进了 monorepo：
 *   旧设计的理由是「私有台账仓是唯一副本，产品仓不许带副本，否则 9 份漂移」。
 *   8 仓合并成一个仓之后，「9 份」这个前提本身消失了 —— 一个仓只能有一份契约。
 *   而执行点必须落在**公开仓**：私有仓的 Actions 已经证明跑不起来（额度），
 *   公开仓的 ubuntu 分钟数不计量。
 *
 * 用法：
 *   node scripts/family-gate.mjs                  # 5 道闸门全跑（CI 用）
 *   node scripts/family-gate.mjs --only family    # 只跑指定闸门，可重复
 *   node scripts/family-gate.mjs --product pdf    # 单款：只跑 family-check
 *   node scripts/family-gate.mjs --keep-farm      # 保留 .family-root 便于排查
 *
 * 退出码：0 = 全绿；1 = 有闸门报红（第一道失败即停，与旧 workflow 一致）
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, ".."); // monorepo 根
const FARM = join(ROOT, ".family-root");
const TOOLS = join(ROOT, "docs", "rocktier", "tools");

const argv = process.argv.slice(2);
const optVal = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const onlyGates = argv.reduce((acc, a, i) => (a === "--only" ? [...acc, argv[i + 1]] : acc), []);
const product = optVal("--product");
const keepFarm = argv.includes("--keep-farm");

/* 产品 id → 旧家族目录名。与 docs/rocktier/tools 下各闸门内的 REPOS / PRODUCTS
   表必须完全一致 —— 名字对不上，闸门就会认为「这款产品不存在」并静默跳过，
   那比报红更坏（family-check 自己的注释里已经踩过一次）。 */
const LEGACY_DIRS = {
  pdf: "Rocktier PDF",
  markdown: "Rocktier MD",
  write: "Rocktier Write",
  pic2webp: "Rocktier Pic2Webp",
  "cad-viewer": "Rocktier CAD Viewer",
  ocr: "Rocktier OCR",
  journal: "Rocktier-Journal",
  compressor: "Rocktier-Compressor",
};

/* ---------- 建农场 ---------- */
function buildFarm() {
  if (existsSync(FARM)) rmSync(FARM, { recursive: true, force: true });
  mkdirSync(FARM, { recursive: true });

  // 闸门都以 <root>/docs/rocktier/tokens.css 为母版。农场里放软链，
  // 保持「母版只有一份」——复制过来就又生出一份会漂移的副本。
  symlinkSync(resolve(ROOT, "docs"), join(FARM, "docs"), "dir");

  const missing = [];
  for (const [id, dir] of Object.entries(LEGACY_DIRS)) {
    const src = join(ROOT, "apps", id);
    if (!existsSync(src)) {
      missing.push(`${id} (apps/${id})`);
      continue;
    }
    symlinkSync(src, join(FARM, dir), "dir");
  }
  if (missing.length) {
    console.error(`✗ 缺产品目录：${missing.join(", ")}`);
    process.exit(1);
  }
}

function cleanupFarm() {
  if (keepFarm) {
    console.log(`\n（农场保留在 ${FARM}，排查完记得删）`);
    return;
  }
  try {
    // 只删自己建的软链与空壳目录，不碰真实产品文件。
    if (existsSync(FARM)) rmSync(FARM, { recursive: true, force: true });
  } catch { /* 清不掉不影响结果 */ }
}

/* ---------- 闸门清单 ----------
 * 与旧 workflow 的 5 步逐一对应，参数形状各不相同，所以显式列出调用方式：
 *   contrast-gate / scan-token-revert 吃**位置参数**，
 *   family-check / macos-hig-check 吃 `--root`，
 *   scan-locale-parity 两者都收（这里用位置参数，与旧 workflow 一致）。
 * 想当然统一成 `--root` 已经踩过一次坑（scan-token-revert 会把字符串 `--root`
 * 当目录，ENOENT，而当时那步带 continue-on-error，静默绿）。 */
const GATES = [
  { id: "family", file: "family-check.mjs", args: ["--root", FARM], crossProduct: false },
  { id: "token-revert", file: "scan-token-revert.mjs", args: [FARM], crossProduct: true },
  { id: "contrast", file: "contrast-gate.mjs", args: [FARM], crossProduct: true },
  { id: "locale-parity", file: "scan-locale-parity.mjs", args: [FARM], crossProduct: true },
  { id: "macos-hig", file: "macos-hig-check.mjs", args: ["--root", FARM], crossProduct: true },
  /* ── 2026-11-24 补进来的三道：一直在仓里，但**没有任何工作流调用过** ──
   * 8 仓各自带 CI 的年代，它们由各仓自己的 workflow 跑；合并后没人接手，就此静默。
   * 三道现在都实测全绿，接进来是为了让它们继续绿着，而不是等哪天坏了才知道。
   *   dangling-import 12 条悬空 import（扫描 212 个文件）
   *   release-i18n    发版命名 + 语言数 + 默认 en（读各仓 workflow 的改名守卫）
   *   menu-click    菜单项逐项有响应路径（含 Rust 侧 as_str / as_ref 两种写法）
   * 它们自己按「哪里有 src-tauri」找产品，所以吃的是仓根而不是农场，cwd 由本脚本给 ROOT。 */
  { id: "dangling-import", file: "scan-dangling-import.mjs", args: [FARM], crossProduct: true },
  { id: "release-i18n", file: "release-i18n-check.mjs", args: [], crossProduct: true },
  { id: "menu-click", file: "menu-clickability.mjs", args: [], crossProduct: true },
];

const selected = onlyGates.length ? GATES.filter((g) => onlyGates.includes(g.id)) : GATES;
if (!selected.length) {
  console.error(`✗ --only 未命中任何闸门。可选：${GATES.map((g) => g.id).join(", ")}`);
  process.exit(1);
}

/* ---------- 跑 ---------- */
buildFarm();

const ran = [];
const skipped = [];
let failed = null;

for (const g of selected) {
  // 单款模式：跨产品的闸门天然要全家族（对比度要母版 × 8、locale 要对账集合），
  // 只跑一半等于给假信号，所以明确跳过并说明理由，不静默当成通过。
  if (product && g.crossProduct) {
    skipped.push(g.id);
    continue;
  }
  const args = [...g.args];
  if (product && g.id === "family") args.push("--product", product);

  console.log(`\n──── ${g.id} ────`);
  try {
    execFileSync(process.execPath, [join(TOOLS, g.file), ...args], { stdio: "inherit", cwd: ROOT });
    ran.push(g.id);
  } catch (e) {
    failed = g.id;
    break;
  }
}

cleanupFarm();

if (skipped.length) console.log(`\n跳过（跨产品闸门，单款模式下不跑）：${skipped.join(", ")}`);
if (failed) {
  console.log(`\n✗ 闸门 ${failed} 报红`);
  process.exit(1);
}
console.log(`\n✓ 全部通过：${ran.join(", ")}`);
