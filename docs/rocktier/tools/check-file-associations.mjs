/* 文件关联配置检测 —— 家族级（file-associations 闸门）。

   ── 为什么做这个 ──
   2026-11-25 核实：pic2webp 1.9.21 的 MSIX 里**只有 .tiff 一条关联**，其余五种
   （jpg / png / webp / gif / bmp）全丢了。根因不是打包器坏了，是配置本身有问题：

     `bundle.fileAssociations[].name` 在 Windows 侧是 **ProgID / 清单里的唯一键**。
     AppxManifest 的 `<uap:FileTypeAssociation Name="…">` 要求 Name 在同一个
     Extension 内唯一，MSI 侧同样把 name 拼成 `<name>.<ext>` 的 ProgID。
     六组共用一个 name 时，六条里只有最后一条活下来 —— 而且**打包照样成功**，
     装完才发现双击 .jpg 没反应。

   这不是 pic2webp 一款的问题：横向一查 compressor（5 组重名）、ocr（2 组重名）
   都是同一个形状。家族级判据比逐款修更划算 —— 修完这三款，下次谁再加一组
   都会在 CI 上当场红。

   ── 判据 ──
   ① `name` 在同一款里唯一（上面那条的根因）
   ② 同一个 ext 不被两组抢（谁生效取决于顺序，等于掷骰子）
   ③ ext 必须小写、无前导点、非空（写错大小写在 Windows 上静默不生效）
   ④ 声明了 `tiff` 就必须同时声明 `tif`：老照片与扫描件几乎全是 `.tif`，
      面板白名单（formats.js FORMAT_ALIASES）也认两个 —— 只写 tiff 会让
      「能拖进来却不能双击打开」，与 D-170 那类「声明与能力不一致」同型

   只检测，不改代码。退出码 0 = 全绿，1 = 有违规。

   用法：
     node docs/rocktier/tools/check-file-associations.mjs
     node docs/rocktier/tools/check-file-associations.mjs --selftest   # 正反对照
*/

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const APPS = join(ROOT, "apps");

/** 纯函数：输入 `[{ app, associations }]`，输出违规清单。抽出来是为了 selftest 能喂合成数据。 */
export function audit(products) {
  const errors = [];

  for (const { app, associations } of products) {
    if (!associations || associations.length === 0) continue;

    // ① name 唯一 —— 按 name 归组后一次性报，不逐条滚雪球（同一处问题报六遍等于没报）
    const groupsByName = new Map();
    for (const g of associations) {
      const name = g.name ?? "";
      if (!name) {
        errors.push(`${app}: 有一组关联没有 name —— Windows 侧拿不到 ProgID`);
        continue;
      }
      const exts = (g.ext ?? []).join(",") || "（无扩展名）";
      groupsByName.set(name, [...(groupsByName.get(name) ?? []), exts]);
    }
    for (const [name, list] of groupsByName) {
      if (list.length > 1) {
        errors.push(
          `${app}: name "${name}" 被 ${list.length} 组共用（${list.join(" / ")}）` +
          `—— Windows 只留最后一条，其余扩展名静默消失`,
        );
      }
    }

    // ② 同一个 ext 不被两组抢
    const owner = new Map();
    for (const g of associations) {
      for (const raw of g.ext ?? []) {
        const ext = String(raw);
        const key = ext.toLowerCase();
        if (owner.has(key)) {
          errors.push(`${app}: 扩展名 .${ext} 同时出现在 "${owner.get(key)}" 与 "${g.name}" 两组`);
        } else {
          owner.set(key, g.name ?? "");
        }
      }
    }

    // ③ ext 形态
    for (const g of associations) {
      for (const raw of g.ext ?? []) {
        const ext = String(raw);
        if (ext !== ext.toLowerCase()) errors.push(`${app}: 扩展名 "${ext}" 有大写（Windows 上不生效）`);
        if (ext.startsWith(".")) errors.push(`${app}: 扩展名 "${ext}" 带了前导点（应为 "${ext.slice(1)}"）`);
        if (!ext.trim()) errors.push(`${app}: "${g.name}" 里有空扩展名`);
      }
    }

    // ④ tiff / tif 成对
    const exts = new Set((associations.flatMap((g) => g.ext ?? [])).map((e) => String(e).toLowerCase()));
    if (exts.has("tiff") && !exts.has("tif")) {
      errors.push(`${app}: 声明了 .tiff 却没有 .tif —— 老照片与扫描件大多只叫 .tif，双击打不开`);
    }
  }

  return errors;
}

function collect() {
  if (!existsSync(APPS)) {
    console.error(`找不到 ${APPS} —— 本闸门必须在 monorepo 根下跑`);
    process.exit(2);
  }
  const out = [];
  for (const app of readdirSync(APPS).sort()) {
    const conf = join(APPS, app, "src-tauri", "tauri.conf.json");
    if (!existsSync(conf)) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(conf, "utf8"));
    } catch (e) {
      console.error(`${app}: tauri.conf.json 解析失败 —— ${e.message}`);
      process.exit(2);
    }
    out.push({ app, associations: parsed.bundle?.fileAssociations ?? [] });
  }
  return out;
}

function selftest() {
  const failures = [];

  // 反面：六组共用一个 name（就是 pic2webp 1.9.21 的实际形状）
  const bad = audit([{
    app: "bad",
    associations: [
      { name: "Rocktier Image", ext: ["jpg", "jpeg"] },
      { name: "Rocktier Image", ext: ["png"] },
      { name: "Rocktier Image", ext: ["tiff"] },
    ],
  }]);
  if (!failures.length && bad.length === 0) failures.push("重名没有被抓到");
  if (!bad.some((e) => /被 3 组共用/.test(e))) failures.push(`重名的诊断不对：${JSON.stringify(bad)}`);
  if (!bad.some((e) => /没有 \.tif/.test(e))) failures.push("tiff/tif 缺对没被抓到");

  // 反面：大写与小前导点
  const bad2 = audit([{ app: "bad2", associations: [{ name: "X", ext: [".JPG"] }] }]);
  if (!bad2.some((e) => /有大写/.test(e))) failures.push("大写扩展名没被抓到");
  if (!bad2.some((e) => /前导点/.test(e))) failures.push("前导点没被抓到");

  // 反面：两组抢同一个 ext
  const bad3 = audit([{ app: "bad3", associations: [
    { name: "A", ext: ["png"] }, { name: "B", ext: ["png"] },
  ] }]);
  if (!bad3.some((e) => /同时出现在/.test(e))) failures.push("重复扩展名没被抓到");

  // 正面：修好之后的形状必须全绿
  const good = audit([{
    app: "good",
    associations: [
      { name: "Rocktier JPEG", ext: ["jpg", "jpeg"] },
      { name: "Rocktier PNG", ext: ["png"] },
      { name: "Rocktier TIFF", ext: ["tiff", "tif"] },
      { name: "Rocktier PDF", ext: ["pdf"] },
    ],
  }]);
  if (good.length) failures.push(`正确配置被误报：${JSON.stringify(good)}`);

  // 正面：没有关联的仓（journal）不该报
  if (audit([{ app: "none", associations: [] }]).length) failures.push("空关联被误报");

  if (failures.length) {
    console.error(`❌ selftest 失败：\n  - ${failures.join("\n  - ")}`);
    process.exit(1);
  }
  console.log("✅ selftest 通过：4 类违规各自报红，正确配置与空关联均绿");
}

if (process.argv.includes("--selftest")) {
  selftest();
} else {
  const products = collect();
  const errors = audit(products);
  const total = products.reduce((n, p) => n + (p.associations?.length ?? 0), 0);
  if (errors.length) {
    console.error(`❌ 文件关联配置有 ${errors.length} 处违规（共 ${total} 组）：`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`✅ 文件关联配置合规：${products.filter((p) => p.associations?.length).length} 款 / ${total} 组`);
}
