#!/usr/bin/env node
/* 官网 SHA-256 墙的对账闸门。

   要防的是什么：`checksums.json` 里的版本停在旧版，而下载按钮指向
   `releases/latest` —— 用户下到新版、照页面哈希校验，必然失败。
   2026-10-31 评审记录过一次（PDF 1.1.0 / OCR 0.2.11），2026-11-13 又发生一次
   （markdown 1.0.20 vs 1.0.23、pic2webp 1.9.20 vs 1.9.21、write 1.4.15 vs 1.4.16）。
   同一条缺陷复发两次，说明当时只修了数据、没修机制。

   判据纪律（准则 §二十三）：
   · 输入根不存在 → 判红，不返回空数组；
   · 产品清单来自 products.mjs 单一真源，并与文件内容双向对账；
   · `--selftest` 四条对照，其中三条必须红、一条必须绿；
   · 拿不到 latest（网络 / 限流 / 权限）→ 判红，不许静默当绿。

   用法：
     node tools/verify-checksums.mjs                 # 对账仓库里的 checksums.json
     node tools/verify-checksums.mjs --file <path>    # 对账指定文件（先红验证用）
     node tools/verify-checksums.mjs --selftest       # 判据自检，不发网络
*/

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { INTEL_ALLOWED_EMPTY, MONO_REPO, PRODUCTS } from "./products.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = join(HERE, "..", "checksums.json");
const SHA256_RE = /^[0-9a-f]{64}$/;

/* ---------- 纯函数：判据只认这两个入参，方便自检 ---------- */

export function audit(data, latest) {
  const problems = [];

  if (!data || typeof data !== "object" || !data.products || typeof data.products !== "object") {
    return ["checksums.json 没有 products 段"];
  }

  for (const [code, prefix] of PRODUCTS) {
    const p = data.products[code];
    if (!p) {
      problems.push(`${code}: 文件里没有这一款（前缀 ${prefix}/）—— 生成脚本漏了？`);
      continue;
    }

    const want = latest[code];
    if (!want) {
      /* 过渡期：monorepo 还没发过该应用、文件仍指旧仓 → 跳过（fetchLatest 已告警）。
         文件已指 monorepo 却拿不到 latest = 前缀错或 release 被删 → 必须红。 */
      if (String(p.repo || "") !== MONO_REPO) {
        console.warn(`  ~ ${code}: 无 monorepo latest，沿用旧仓条目 ${p.version}（过渡期）`);
      } else {
        problems.push(`${code}: 没拿到 latest 版本，无法对账（不许当成通过）`);
      }
    } else if (p.version !== want) {
      problems.push(`${code}: 墙上是 ${p.version}，latest 是 ${want}`);
    }

    const arm = p.macos?.aarch64;
    if (!arm?.sha256) {
      problems.push(`${code}: 缺 macOS aarch64 资产`);
    } else if (!SHA256_RE.test(arm.sha256)) {
      problems.push(`${code}: aarch64 sha256 不是 64 位十六进制（${arm.sha256}）`);
    }

    const win = p.windows;
    if (!win?.sha256) {
      problems.push(`${code}: 缺 Windows 资产`);
    } else if (!SHA256_RE.test(win.sha256)) {
      problems.push(`${code}: Windows sha256 不是 64 位十六进制（${win.sha256}）`);
    }

    const intel = p.macos?.x64;
    if (!intel?.sha256) {
      if (!INTEL_ALLOWED_EMPTY.has(code)) problems.push(`${code}: 缺 macOS x64 资产`);
    } else if (!SHA256_RE.test(intel.sha256)) {
      problems.push(`${code}: x64 sha256 不是 64 位十六进制（${intel.sha256}）`);
    }
  }

  /* 反向：文件里多出来的产品 = 清单与文件分叉（加过又删，或改名） */
  const known = new Set(PRODUCTS.map(([c]) => c));
  for (const code of Object.keys(data.products)) {
    if (!known.has(code)) problems.push(`${code}: 文件里有、产品清单里没有 —— 两处已分叉`);
  }

  return problems;
}

/* ---------- 自检：三条必须红、一条必须绿 ---------- */

function healthyFixture() {
  const sha = (c) => c.repeat(64);
  const products = {};
  for (const [code] of PRODUCTS) {
    products[code] = {
      repo: "Rocktier/Rocktier-softwares",
      version: "v9.9.9",
      published: "2026-01-01T00:00:00Z",
      windows: { name: `${code}.exe`, sha256: sha("a") },
      macos: {
        aarch64: { name: `${code}_aarch64.dmg`, sha256: sha("b") },
        x64: { name: `${code}_x64.dmg`, sha256: sha("c") },
      },
    };
  }
  const latest = Object.fromEntries(PRODUCTS.map(([code]) => [code, "v9.9.9"]));
  return { data: { generated: "2026-01-01T00:00:00Z", products }, latest };
}

function selftest() {
  let failures = 0;
  const check = (label, expectRed, problems) => {
    const isRed = problems.length > 0;
    const ok = isRed === expectRed;
    if (!ok) failures++;
    const first = problems[0] ? ` — ${problems[0]}` : "";
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}: ${isRed ? "红" : "绿"}${first}`);
  };

  const { data, latest } = healthyFixture();

  check("健康样本（应与 latest 一致 → 绿）", false, audit(data, latest));

  const stale = structuredClone(data);
  stale.products.markdown.version = "v1.0.20"; // 2026-11-13 真实发生过的值
  check("版本落后（墙 1.0.20 / latest 1.0.23 → 红）", true, audit(stale, latest));

  const badHash = structuredClone(data);
  badHash.products.write.macos.aarch64.sha256 = "abc123";
  check("sha256 形状不对（→ 红）", true, audit(badHash, latest));

  const missing = structuredClone(data);
  delete missing.products.journal;
  check("少一个产品（→ 红）", true, audit(missing, latest));

  const extra = structuredClone(data);
  extra.products.sign = { version: "v9.9.9", macos: {}, windows: {} };
  check("多一个清单外产品（→ 红）", true, audit(extra, latest));

  const noLatest = {};
  check("拿不到 latest（→ 红，不许当绿）", true, audit(data, noLatest));

  console.log(failures === 0 ? "\n自检通过 6/6" : `\n自检失败 ${failures} 项`);
  process.exit(failures === 0 ? 0 : 1);
}

/* ---------- 主流程 ---------- */

async function fetchLatest() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  const headers = {
    "User-Agent": "rocktier-site-tools",
    Accept: "application/vnd.github+json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const latest = {};
  const res = await fetch(`https://api.github.com/repos/${MONO_REPO}/releases?per_page=100`, { headers });
  if (!res.ok) {
    const hint = res.status === 403 || res.status === 429 ? "（限流？带 GH_TOKEN 跑可提额）" : "";
    throw new Error(`${MONO_REPO}: GitHub API ${res.status}${hint}`);
  }
  const releases = await res.json();
  if (!Array.isArray(releases)) throw new Error(`${MONO_REPO}: releases 响应不是列表`);
  for (const [code, prefix] of PRODUCTS) {
    let hit = null;
    for (const rel of releases) {
      const tag = String((rel && rel.tag_name) || "");
      if (!tag.startsWith(prefix + "/")) continue;
      if (!hit || String(rel.published_at || "") > String(hit.published_at || "")) hit = rel;
    }
    if (!hit) {
      /* 过渡期：monorepo 还没有该应用的 release，且文件条目仍指向旧仓 → 跳过并告警。
         文件条目已指向 monorepo 却没有 release，说明前缀写错或 release 被删 → 判红。 */
      const inFile = data?.products?.[code];
      if (inFile && String(inFile.repo || "") !== MONO_REPO) {
        console.warn(`  ~ ${code}: monorepo 尚无 ${prefix}/* release，沿用旧仓条目（过渡期）`);
        continue;
      }
      throw new Error(`${code}: monorepo 上没有 ${prefix}/* 的 release`);
    }
    latest[code] = hit.tag_name;
  }
  return latest;
}

if (process.argv.includes("--selftest")) selftest();

const fileArg = process.argv.indexOf("--file");
const target = fileArg >= 0 ? resolve(process.argv[fileArg + 1]) : DEFAULT_FILE;

let data;
try {
  data = JSON.parse(readFileSync(target, "utf8"));
} catch (err) {
  /* 输入根拿不到就是红，不是「跳过」 */
  console.error(`读不到 ${target}: ${err.message}`);
  process.exit(1);
}

const latest = await fetchLatest();
const problems = audit(data, latest);

console.log(`对账 ${target}`);
console.log(`  墙上生成时间 ${data.generated || "(缺失)"}`);
for (const [code] of PRODUCTS) {
  const p = data.products?.[code];
  console.log(`  ${code.padEnd(12)} ${String(p?.version || "-").padEnd(10)} latest ${latest[code]}`);
}

if (problems.length === 0) {
  console.log("\nPASS —— 八款墙上的版本与 latest 一致，资产哈希形状合法");
  process.exit(0);
}

console.error(`\nFAIL ${problems.length} 项：`);
for (const p of problems) console.error(`  - ${p}`);
console.error("\n修法：node tools/gen-checksums.mjs 重新生成后提交（不要手改哈希）");
process.exit(1);
