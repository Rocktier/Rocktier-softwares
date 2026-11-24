/* 发版命名与语言基线检测 —— 家族级（第 18 条闸门）。

   ── 为什么做这个 ──
   两条用户明确要求的东西，没有任何闸门在守：

   ① **发版名不许带 locale 后缀**。
      Tauri v2 会按 `bundle.windows.wix.language` 给 MSI 拼上 `_en-US`：
          Rocktier.PDF_1.0.23_x64_en-US.msi
      应用本身带语言切换器，文件名宣称单一语言等于暗示「存在英文版和
      其他本地化安装包」，而实际只有一个多语言安装包。
      修法是**构建后改名**，不是改配置 —— WiX 的 language 是 MSI 构建
      必需的工具链语言码，改它构建会失败。

   ② **每个产品至少 N 种语言，且默认语言是 en、中文不在首位**。
      全球发行的家族，语言数直接决定覆盖面；而「中文优先」是早期
      面向国内的产品定位留下的默认值，海外发行时是反的。
      2026-10-13 收敛裁定后 N = 2（en / zh），依据见 MIN_LOCALES 注释。

   ── 只检测，不改代码 ──
   本文件只报错并退出 1。

   命名项状态（2026-10-16 核账更正）：9 仓改名步骤 + 「找不到即报错」守卫
   已于 2026-10-06 全部落地（各仓 `chore(release): 去掉 MSI 文件名里的
   _en-US`），本项自那时起常绿。本文件头注释曾长期写着「命名项当前 9 仓
   全红、属独立工单」—— 那句话比落地提交晚写了 9 天，且写入后从未有人
   跑一遍本闸门核对，属台账失真（教训见 findings D-39）。
   **改本注释前先跑一遍本文件**，别让注释与 exit code 再次打架。 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/* 语言数下限。设为 0 表示该产品尚未纳入多语言目标（豁免）。
   2026-10-13 起为 2（en / zh）：全家收敛裁定，见 family.json
   globalRules.$locales_2026_10_13 —— 非中英语种均为未审校机翻基线。
   （原为 8，依据 findings F40；该裁定已被 2026-10-13 推翻，
    见 family.json 同条里的 2026-10-14 更正与 2026-10-15 收口记录。） */
const MIN_LOCALES = {
  pdf: 2, write: 2, ocr: 2, pic2webp: 2, "cad-viewer": 2,
  md: 2, sign: 2, journal: 2, compressor: 2,
};

/* 允许出现在发版文件名里的 locale 后缀 —— 一个都不允许。
   保留这个常量是提醒：曾经踩过，且很容易被改回来。 */
const FORBIDDEN_IN_RELEASE_NAME = [/_en-US\.msi/i, /_zh-CN\.msi/i, /\(en-US\)/i, /\(zh-CN\)/i];

function findProducts(base) {
  const out = [];
  for (const name of readdirSync(base)) {
    const p = join(base, name);
    if (!statSync(p).isDirectory()) continue;
    if (existsSync(join(p, "src-tauri"))) { out.push({ label: name, root: p }); continue; }
    for (const inner of readdirSync(p)) {
      const q = join(p, inner);
      if (statSync(q).isDirectory() && existsSync(join(q, "src-tauri"))) {
        out.push({ label: `${name}/${inner}`, root: q });
      }
    }
  }
  return out;
}

const SKIP = new Set(["node_modules", "dist", "target", "src-tauri", ".git", "public", "scripts"]);
function filesUnder(dir, ext) {
  const out = [];
  if (!existsSync(dir)) return out;
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) { if (!SKIP.has(n)) walk(p); }
      else if (n.endsWith(ext)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/* 语言集合的**权威来源是 TypeScript 的联合类型 / 字典表**，
   不是翻译文件的数量 —— 一个产品可能把 8 种语言塞在 1 个 .ts 里
   （Write），也可能每个语言一个文件（PDF）。
   踩过的坑：用「文件数」当语言数 → PDF 报 2、Write 报 1，全错。 */
const ISO_LOCALES = ["ar", "de", "en", "es", "fr", "it", "ja", "ko", "nl", "pl", "pt", "ru", "tr", "vi", "zh"];

function localesOf(root) {
  const src = [
    ...filesUnder(join(root, "src"), ".ts"),
    ...filesUnder(join(root, "src"), ".tsx"),
    ...filesUnder(join(root, "ui"), ".ts"),
    ...filesUnder(join(root, "ui"), ".js"),
    ...filesUnder(join(root, "src"), ".js"),
    ...filesUnder(join(root, "src"), ".svelte"),
  ];
  const locs = new Set();
  const tableLocs = new Set();   // 只来自 LOCALES 表
  const evidence = [];
  const isI18nPath = (f) => /i18n|lang|translat|locale/i.test(f);

  for (const f of src) {
    const s = readFileSync(f, "utf8");
    let found = 0;

    /* ⓿ LOCALES 表 —— 各产品现已统一的语言单一真源：
     *
     *     export const LOCALES = [
     *       { code: "en", endonym: "English" },
     *       { code: "ja", endonym: "日本語" },
     *       …
     *     ];
     *
     * 排在①之前是因为它**最可靠**：① 的联合类型在我把 Lang 改成
     * `export type Lang = (typeof LOCALES)[number]["code"]` 之后就消失了 ——
     * MD 因此被报成 7 门（漏了 en），而它实际是 8 门。
     * 靠「源码里出现过某个字面量」推断语言，本质上是在猜；读那张表才是读事实。 */
    for (const m of s.matchAll(/\bcode:\s*["']([a-z]{2}(?:-[A-Za-z]{2})?)["']/g)) {
      const c = m[1].split("-")[0].toLowerCase();
      locs.add(c); tableLocs.add(c); found++;
    }

    /* ① 联合类型：type Lang = "en" | "zh" / type Locale = "en-US" | "zh-CN" */
    for (const m of s.matchAll(/(?:type|const)\s+(?:Lang|Locale|LangCode)\s*(?::[^=]+)?=\s*([^;\n]+)/g)) {
      for (const x of m[1].matchAll(/["']([a-z]{2}(?:-[A-Za-z]{2})?)["']/g)) {
        locs.add(x[1].split("-")[0].toLowerCase()); found++;
      }
    }
    /* ②③ 只在 i18n 模块里认语言声明。
       踩过的坑：MD 的 Editor.tsx 里有 `const nl = value.lastIndexOf("\n")`
       —— 一个叫 nl（newline）的**局部变量**，被 `const\s+([a-z]{2})\s*=`
       命中，把 MD 的语言数从 2 报成 3。语言字典不会声明在组件里，
       所以把范围收窄到 i18n 模块是正解，不是打补丁。 */
    if (isI18nPath(f)) {
      for (const m of s.matchAll(/export\s+const\s+([a-z]{2})\s*(?::[^=]+)?=/g)) {
        if (ISO_LOCALES.includes(m[1])) { locs.add(m[1]); found++; }
      }
      for (const m of s.matchAll(/(?:^|\n)\s*const\s+([a-z]{2})\s*(?::\s*\w+\s*)?=/g)) {
        if (ISO_LOCALES.includes(m[1])) { locs.add(m[1]); found++; }
      }
      /* 顶层语言键：en: { / zh: { —— 整份字典塞在一个对象里
         （OCR 与 Pic2WebP 就是这种）。 */
      for (const m of s.matchAll(/(?:^|\n)\s{1,4}([a-z]{2})\s*:\s*\{/g)) {
        if (ISO_LOCALES.includes(m[1])) { locs.add(m[1]); found++; }
      }
    }
    if (found) evidence.push(f.split("/").slice(-1)[0]);
  }

  /* 有 LOCALES 表就**只认它**。
   *
   * 上面那些模式匹配（export const xx = / xx: { / 联合类型）都只是兜底：
   * 它们数的是「源码里出现过某个语言字面量」，所以一个**存在但没接线**的
   * 翻译文件也会把数字撑大 —— 删掉 LOCALES 里的 ar、却留着 i18n.ar.ts，
   * 闸门照样报 8 门。实测过：这样变异，闸门 exit=0（漏检）。
   *
   * tsc 能抓到那种情况（STRINGS 要求每个 key），但闸门不该依赖别的工具
   * 才正确 —— 所以给了权威来源时，旁证一律不作数。 */
  const finalLocs = tableLocs.size ? tableLocs : locs;
  return { locales: [...finalLocs].sort(), evidence: [...new Set(evidence)] };
}

/* 发布文件名检查：读 workflow 里的产物路径模板，
   再读当前已发布资产（若给了 --remote）。 */
function releaseNameIssues(root) {
  const issues = [];
  const wfDir = join(root, ".github", "workflows");
  if (!existsSync(wfDir)) return issues;
  for (const f of readdirSync(wfDir).filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"))) {
    /* Windows 工作树是 CRLF，而下面的剥离正则按 \n 写：不归一的话改名步骤
       剥不掉，守卫文案 "no *_en-US.msi found" 会自己命中禁用模式 ——
       8 仓齐红却什么都没坏（2026-11-08 实证，与 D-91 CRLF 正则同型）。
       判据只关心内容，统一归一为 LF 再判，跨平台结果一致。 */
    const s = readFileSync(join(wfDir, f), "utf8").replace(/\r\n/g, "\n");
    /* 已处理 = 插了改名步骤 **且** 带「找不到就报错」的守卫。
       两项缺一不可：只有改名没有守卫的话，Tauri 哪天改了命名，
       步骤会静默空转（`[ -e ] || continue`），locale 后缀悄悄回来，
       而且没有任何东西会报警 —— 这比没改更坏。 */
    /* 只看**真正处理 MSI 产物**的 workflow。
       踩过的坑：第一版对每个 yml 都要求有改名步骤，于是
       notify-family-gate.yml / ci.yml 这些压根不产 MSI 的文件全被判 ❌
       —— 9 个仓齐刷刷红，看起来像什么都没改。检查要落在它描述的对象上。 */
    if (!/\.msi\b/i.test(s)) continue;

    const hasStep = s.includes("Strip _en-US from MSI filename");
    const hasGuard = s.includes("no *_en-US.msi found");
    if (hasStep && hasGuard) {
      /* 禁用模式必须在**剥掉改名步骤之后**再查。
         否则守卫文案 `no *_en-US.msi found` 自己就命中了
         /_en-US\.msi/ —— 明明修好了却报 ❌，让人以为没改。 */
      const stripped = s.replace(
        /- name: Strip _en-US from MSI filename\n(?:.*\n)*?(?=      - name: |      # |  [a-z])/,
        "",
      );
      for (const re of FORBIDDEN_IN_RELEASE_NAME) {
        if (re.test(stripped)) issues.push(`${f}: 去掉改名步骤后仍有 ${re}`);
      }
      continue;
    }
    if (!hasStep) {
      issues.push(`${f}: 处理 MSI 产物但未插入去 _en-US 的改名步骤`);
    } else {
      issues.push(`${f}: 改名步骤缺「找不到即报错」守卫 —— Tauri 改命名时会静默空转`);
    }
  }
  return issues;
}

const products = findProducts(ROOT);
const rows = [];
let fails = 0;

console.log(`\n  ── 第 18 条闸门：发版命名 + 语言基线（${products.length} 仓）──\n`);

for (const { label, root } of products) {
  const id = (label.split("/").pop().replace("Rocktier ", "").replace("Rocktier-", "")
    .toLowerCase().replace(/\s+/g, "-")
    /* Pic2WebP 的源码曾在内层 `pic2webp-main/`，取目录名会得到 pic2webp-main；
       2026-11-04 已平铺，这一条保留为幂等兜底。 */
    .replace(/-main$/, "")
    /* CAD Viewer 的目录名带空格：cad-viewer */
    .replace(/^cad-viewer$/, "cad-viewer"));
  const { locales, evidence } = localesOf(root);
  const want = MIN_LOCALES[id] ?? 0;
  const localeOk = want === 0 ? true : locales.length >= want;
  const nmIssues = releaseNameIssues(root);
  const nameOk = nmIssues.length === 0;

  /* 默认语言必须是 en —— 中文优先是早期定位留下的，海外发行时是反的。
   *
   * 原来这三条的最后一个子句是 `|| locales.includes("en")`，
   * 而语言基线本身就要求 8 门且包含 en —— **整条判据永真，永远抓不到东西**。
   * 改读三个真实事实（都可能被真正改坏）：
   *   ① family.json 的 defaultLanguage 是家族策略
   *   ② LOCALES 表的首项 —— 切换器里的第一项，用户第一眼看到的
   *   ③ 无存档时 initialLang()/getLocale() 的返回值 —— 真正的生效默认值 */
  const defaultProblems = [];
  const famPath = join(ROOT, "docs", "rocktier", "family.json");
  if (existsSync(famPath)) {
    const fam = JSON.parse(readFileSync(famPath, "utf8"));
    const def = fam.globalRules?.defaultLanguage ?? fam.defaultLanguage;
    if (def !== "en") defaultProblems.push(`family.json defaultLanguage = ${JSON.stringify(def)}（应为 "en"）`);
  }
  const srcAll = filesUnder(join(root, "src"), ".ts").concat(filesUnder(join(root, "src"), ".tsx"))
    .map((f) => readFileSync(f, "utf8")).join("\n");
  const firstEntry = srcAll.match(/\bcode:\s*["']([a-z]{2})["']/);
  if (firstEntry && firstEntry[1] !== "en") {
    defaultProblems.push(`LOCALES 首项是 ${firstEntry[1]}，en 应排第一`);
  }
  /* initialLang / getLocale 的兜底返回值 */
  const fallback = srcAll.match(
    /(?:function\s+(?:initialLang|getLocale|detectLang|getUiLang|defaultLang|resolveLang)\b[\s\S]{0,800}?)return\s+["']([a-z]{2})/,
  );
  if (fallback && fallback[1] !== "en") {
    defaultProblems.push(`initialLang/getLocale 兜底返回 "${fallback[1]}"，应为 "en"`);
  }
  const defOk = defaultProblems.length === 0;

  if (!localeOk || !nameOk || !defOk) fails++;
  rows.push({ label, id, n: locales.length, want, localeOk, nameOk, defOk, defProblems: defaultProblems, locales, evidence, nmIssues });
}

console.log(`  ${"仓库".padEnd(30)} ${"语言".padEnd(10)} ${"目标".padEnd(6)} ${"命名".padEnd(6)} ${"默认en".padEnd(8)} locale`);
console.log(`  ${"-".repeat(100)}`);
for (const r of rows) {
  console.log(`  ${r.label.padEnd(30)} ${String(r.n).padEnd(10)} ${(r.want || "—").toString().padEnd(6)} `
    + `${r.nameOk ? "✅" : "❌   ".padEnd(6)} ${r.defOk ? "✅" : "❌".padEnd(8)} ${r.locales.join(",")}`);
}
console.log("");
if (fails === 0) {
  console.log("  ✅ 发版命名干净、语言数达标、默认语言为 en");
} else {
  console.log(`  ❌ ${fails} 个产品未达标`);
}
console.log("");
console.log("  说明：语言数取自 TS 联合类型/字典表（不是翻译文件数 —— 那会全错）。");
console.log("  命名检查读的是各仓 workflow：插了改名步骤且带「找不到即报错」守卫才算已处理。\n");
process.exit(fails === 0 ? 0 : 1);