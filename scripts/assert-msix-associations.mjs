#!/usr/bin/env node
/**
 * MSIX 文件关联断言 —— 「配置里声明的扩展名，包里是不是真的有」。
 *
 * 背景（D-188，2026-11-25）：
 *   pic2webp 1.9.21 的六组 fileAssociations **共用同一个 name**（ProgID）。
 *   Windows 的 ProgID 撞车后，AppxManifest 里六条关联只活下来最后一条 ——
 *   装完双击 .jpg / .png 都没反应，而**打包全程是绿的**，没有任何报错。
 *   横向一查 compressor / ocr 同型，三款共 12 处。
 *
 * 为什么静态闸门不够：
 *   `check-file-associations.mjs` 能查「ProgID 有没有重名」，那是配置层。
 *   但「打包器有没有真的把这一组写进 AppxManifest」只有打完包才知道 ——
 *   中间隔着打包器、清单模板、ProgID 去重三道工序。所以必须**打包后**断言。
 *
 * 现状（2026-11-26 横向查）：只有 ocr 与 pic2webp 两个工作流带这条断言，
 *   cad-viewer / journal / markdown / pdf / write 五款都没有 ——
 *   也就是说「修完但没加断言」，下一次配置漂移照样没人拦。
 *   本脚本把那段逻辑抽出来，七个工作流统一调用。
 *
 * 用法：
 *   node scripts/assert-msix-associations.mjs --product markdown --manifest artifacts/AppxManifest.xml
 *   node scripts/assert-msix-associations.mjs --product pic2webp \
 *        --manifest a/AppxManifest.xml --manifest b/AppxManifest.xml
 *   node scripts/assert-msix-associations.mjs --selftest
 *
 * 退出码：0 = 全绿；1 = 断言失败；2 = 用法/环境错。
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

function parseArgs(argv) {
  const opts = { manifests: [], selftest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--product") opts.product = argv[++i];
    else if (a === "--manifest") opts.manifests.push(argv[++i]);
    else if (a === "--selftest") opts.selftest = true;
  }
  return opts;
}

/** 产品配置里声明的文件关联扩展名（小写、去重、排序）。 */
export function declaredExts(product) {
  const conf = join(ROOT, "apps", product, "src-tauri", "tauri.conf.json");
  if (!existsSync(conf)) throw new Error(`读不到 ${conf}`);
  const c = JSON.parse(readFileSync(conf, "utf8"));
  const list = c.bundle?.fileAssociations ?? [];
  return [...new Set(list.flatMap((a) => (a.ext ?? []).map((e) => String(e).toLowerCase())))].sort();
}

/**
 * 清单里实际声明的 FileType。
 * MSIX 的扩展名声明长这样：
 *   <uap:Extension Category="windows.fileTypeAssociation">
 *     <uap:FileTypeAssociations>
 *       <uap:FileType Extension="jpg" ... />      ← 另一种写法
 * 或  <FileType Name=".jpg" />
 * 两种都收（见 D-188 的实测清单里就是 FileType=".jpg" 这一种）。
 */
export function manifestExts(xml) {
  const out = new Set();
  // <FileType Name=".jpg" />
  for (const m of xml.matchAll(/FileType\s+Name\s*=\s*"\.([A-Za-z0-9]+)"/g)) {
    out.add(m[1].toLowerCase());
  }
  // <uap:FileType Extension="jpg" />
  for (const m of xml.matchAll(/FileType\s+Extension\s*=\s*"([A-Za-z0-9]+)"/g)) {
    out.add(m[1].toLowerCase());
  }
  return [...out].sort();
}

/** 对一份清单做断言，返回问题清单（空 = 绿）。 */
export function checkManifest(xml, expected) {
  const problems = [];
  const actual = new Set(manifestExts(xml));
  for (const ext of expected) {
    if (!actual.has(ext)) problems.push(`清单里没有 .${ext} 的关联`);
  }
  // 配置没声明、清单里却有的 —— 多半是有人手改过清单模板，顺手报出来
  for (const ext of actual) {
    if (!expected.includes(ext)) problems.push(`清单里多出配置未声明的 .${ext}`);
  }
  return problems;
}

/* ---------- 自检（正反对照）---------- */
function selftest() {
  const expected = ["jpg", "jpeg", "png"];
  const good = `<Extensions>
      <uap:FileTypeAssociations>
        <uap:FileType Name=".jpg" />
        <uap:FileType Name=".jpeg" />
        <uap:FileType Name=".png" />
      </uap:FileTypeAssociations>
    </Extensions>`;
  const missing = good.replace('<uap:FileType Name=".png" />', "");
  const extra = good.replace("</Extensions>", '<uap:FileType Name=".gif" /></Extensions>');

  const cases = [
    ["齐全 → 绿", checkManifest(good, expected).length === 0],
    ["缺一个 → 红", checkManifest(missing, expected).length > 0],
    ["多一个 → 红", checkManifest(extra, expected).length > 0],
    ["另一种写法（Extension=）也认", manifestExts('<uap:FileType Extension="jpg" />').includes("jpg")],
  ];
  let bad = 0;
  for (const [name, pass] of cases) {
    console.log(`${pass ? "✅" : "❌"} ${name}`);
    if (!pass) bad++;
  }
  console.log(bad ? `\n自检失败 ${bad} 条` : "\n自检通过");
  process.exit(bad ? 1 : 0);
}

/* ---------- 主流程 ---------- */
const opts = parseArgs(process.argv.slice(2));

if (opts.selftest) selftest();

if (!opts.product || !opts.manifests.length) {
  console.error("用法: node scripts/assert-msix-associations.mjs --product <id> --manifest <AppxManifest.xml>");
  process.exit(2);
}

let expected;
try {
  expected = declaredExts(opts.product);
} catch (e) {
  console.error(`::error::${e.message}`);
  process.exit(2);
}

if (!expected.length) {
  console.log(`  ${opts.product}: 配置里没有文件关联，跳过（这是合法的）`);
  process.exit(0);
}

let failed = 0;
for (const m of opts.manifests) {
  if (!existsSync(m)) {
    console.error(`::error::清单不存在: ${m}`);
    failed++;
    continue;
  }
  const xml = readFileSync(m, "utf8");
  const problems = checkManifest(xml, expected);
  if (problems.length) {
    failed++;
    console.error(`::error::${m}`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error(`  配置声明的是: ${expected.map((e) => "." + e).join(", ")}`);
  } else {
    console.log(`  ${m}: ${expected.length} 个扩展名全在（${expected.map((e) => "." + e).join(" ")}）`);
  }
}

if (failed) {
  console.error("::error::文件关联断言失败 —— 配置声明的扩展名没有全部进 AppxManifest");
  console.error("  （D-188 同型：ProgID 撞车会让后写的覆盖先写的，打包全程不报错）");
  process.exit(1);
}
console.log("::notice::文件关联断言通过");
