/* 官网口径的产品清单（单一真源）。

   2026-11-21 起八款软件迁入 monorepo（Rocktier/Rocktier-softwares），
   Release 以 `<slug>/vX.Y.Z` 标签发布。PRODUCTS 的第二项从仓库名改为
   标签前缀；`gen-checksums.mjs` 与 `verify-checksums.mjs` 都从 monorepo
   的 releases 列表里按前缀取各应用最新版。两处各写一份清单的话，
   某天加了一个产品，生成脚本会带上它、对账脚本不认识它，
   于是「对账通过」而实际上少了一个产品（准则 §二十三 第 2 条）。 */

export const MONO_REPO = "Rocktier/Rocktier-softwares";

export const PRODUCTS = [
  ["pdf", "pdf"],
  ["pic2webp", "pic2webp"],
  ["markdown", "markdown"],
  ["cad-viewer", "cad-viewer"],
  ["ocr", "ocr"],
  ["write", "write"],
  ["journal", "journal"],
  ["compressor", "compressor"],
];

/* OCR 没有 Intel 腿（ort-sys 不支持 x86_64，见 task_plan 阶段 90 遗留登记）。
   官网按资产存在性显隐 Intel 子链接，所以这个洞是已知且被处理过的，
   对账时不能把它当缺陷 —— 但也不能静默：允许缺，缺了必须真的缺。 */
export const INTEL_ALLOWED_EMPTY = new Set(["ocr"]);
