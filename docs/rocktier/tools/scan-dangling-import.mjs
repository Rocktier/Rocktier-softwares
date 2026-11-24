// 悬空 import 扫描器 —— 删文件后确认没有 import 还指着它
//
// 为什么需要它：2026-10-13 语言收敛删掉了 24 个语言字典文件，
// 但留下了 18 个 import 指向已删文件，PDF / CAD / Journal 三个仓当场编译不过。
// 本脚本就是那次事故的产物 —— 当时是临时脚本，现收进 tools/ 做成闸门。
//
// 它抓的是「删除」这一类破坏，与其它闸门正交：
//   tsc --noEmit            也能抓，但要求每个仓都装齐 node_modules（本机有 3 个仓没装）
//   本脚本                  只读源码 + git ls-files，不需要依赖，删完立刻能跑
//
// 已知本脚本抓不到、必须靠编译器的形态（本轮实际踩过）：
//   const DICTS = { en, zh, ja, ko, de, es, pt, ar } as const;   简写属性
//   const dicts: Record<string, Dict> = { zh, en, ja, ... };      单行多键
//   const STRINGS = {\n  en, ja, ko, de, es, pt, ar,              换行多键
// 上面三种是「引用」而非「import」，只有 tsc 会报。
// 结论：删完跑本脚本能快速定位，跑 tsc 才能确认干净，两步都要做。
//
// 用法: node scan-dangling-import.mjs <familyRoot>
// 退出码 0 = 无悬空；1 = 有悬空

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";

const root = resolve(process.argv[2] || ".");

const REPOS = {
  pdf: "Rocktier PDF",
  cad: "Rocktier CAD Viewer",
  markdown: "Rocktier MD",
  write: "Rocktier Write",
  pic2webp: "Rocktier Pic2Webp",
  ocr: "Rocktier OCR",
  journal: "Rocktier-Journal",
  compressor: "Rocktier-Compressor",
  sign: "Rocktier Sign",
};

// 只扫这些扩展名；样式与 HTML 不做 import 图
const CODE = /\.(ts|tsx|js|mjs|cjs|svelte|jsx)$/;

// import X from "./y" / from './y' / require("./y")
const IMPORT_RE = /(?:from\s+|require\(\s*)["'](\.[^"']+)["']/g;

// 相对说明符可能带的扩展名（含空串，交给逐一探测）
const EXTS = ["", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".svelte", ".jsx", "/index.ts", "/index.js"];

// 构建器的资源查询不是路径：`../styles/tokens.css?raw` 指向的仍然是 tokens.css。
// 不剥掉就会把「样式以原文导入」（Vite 的 ?raw，MD 的 exportHtml 用它把家族 CSS
// 内联进导出的 HTML）判成 4 处悬空 —— 2026-11-12 实测假阳性。
// 剥的是查询串而不是文件名，所以「文件真被删了」照样报。
const stripQuery = (spec) => spec.replace(/\?.*$/, "");

const listTracked = (repoDir) => {
  try {
    return execFileSync("git", ["-C", repoDir, "ls-files", "src", "ui", "app", "lib"],
      { encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((f) => CODE.test(f));
  } catch {
    // 不是 git 仓就退回目录递归，数字可能与 CI 不一致
    return [];
  }
};

const hits = [];
let scannedFiles = 0;
let skippedRepos = [];

for (const [id, rel] of Object.entries(REPOS)) {
  const repoDir = join(root, rel);
  if (!existsSync(repoDir)) { skippedRepos.push(`${id}(目录不存在)`); continue; }
  const files = listTracked(repoDir);
  if (files.length === 0) { skippedRepos.push(`${id}(取不到文件列表)`); continue; }

  for (const f of files) {
    const abs = join(repoDir, f);
    if (!existsSync(abs)) continue;
    scannedFiles++;
    const src = readFileSync(abs, "utf8");

    IMPORT_RE.lastIndex = 0;
    let m;
    while ((m = IMPORT_RE.exec(src))) {
      const spec = m[1];
      const base = resolve(dirname(abs), stripQuery(spec));
      const ok = EXTS.some((ext) => existsSync(base + ext));
      if (!ok) {
        const line = src.slice(0, m.index).split(/\r?\n/).length;
        hits.push({ id, file: `${rel}/${f}`, line, spec });
      }
    }
  }
}

for (const s of skippedRepos) console.log(`  ⚠ 跳过 ${s}`);

if (hits.length === 0) {
  console.log(`\n合计 悬空 import 0 处（已扫 ${scannedFiles} 个文件）`);
  console.log("提醒：简写属性与多键登记形态本脚本抓不到，仍需 tsc --noEmit 兜底。");
  process.exit(0);
}

console.log("");
for (const h of hits) {
  console.log(`${h.id}  ${h.file}:${h.line}  ->  ${h.spec}`);
}
console.log(`\n合计 悬空 import ${hits.length} 处（已扫 ${scannedFiles} 个文件）`);
process.exit(1);