/* 官网译文交叉审校 —— 把现有译文与第三方机翻逐条比对，**只报不一致**。
 *
 * ── 为什么是「找差异」而不是「重译」 ──
 *
 * 7 门 × 403 键是逐条写出来的，不是机翻产物。第三方机翻在这里的价值
 * 不是产出真相，而是**当独立第二意见**：两套独立来源不一致的条目，
 * 就是要人工看的地方。一致的条目大概率都对（两套独立译法同时犯
 * 同一个错的概率低），不值得花人力。
 *
 * 这个分工决定了工具的形态：**永远不写译文，只写报告**。
 *
 * ── 三条硬约束 ──
 *
 * ① **API Key 只从环境变量读**，不落盘、不进仓库、不回显。
 *    rocktier.com/.gitignore 第 17-20 行已挡 .env*。
 * ② **断点续跑**。403 键 × 7 门 = 2821 次请求，中途失败不能重来。
 *    结果按批追加写 .cache/audit-<lang>.jsonl，重跑自动跳过已完成的。
 * ③ **机翻结果绝不自动落进译文**。写报告，人看过再手工改 tools/i18n/*.mjs。
 *    一旦允许自动写入，就再也无法区分「人工确认过」和「机器灌的」。
 *
 * 用法：
 * ── 配置从哪来 ──
 *
 * 推荐 rocktier.com/.env（已被 .gitignore 第 17-20 行挡住），配合：
 *     node --env-file=.env tools/audit-site-i18n.mjs --lang ja
 *
 * 不用 .env 也能用命令行环境变量，但**实测这个 shell 里命令行传含 `/`
 * 的值会读到 EMPTY**（同批传的 BAIDU_API_KEY 不带 `/`，正常）。
 * 与其跟引号处理较劲，不如走 .env。
 *
 *   node --env-file=.env tools/audit-site-i18n.mjs --lang ja          # 单门
 *   node --env-file=.env tools/audit-site-i18n.mjs --lang all        # 全部 7 门
 *   node tools/audit-site-i18n.mjs --report ja                        # 只看已有报告
 *   node --env-file=.env tools/audit-site-i18n.mjs --lang ja --limit 10
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CACHE = join(HERE, ".cache");

/* ── 配置 ──
 *
 * 不把 .env 写进 process.env，自己解析成闭包。理由有二：
 *
 * ① **踩过的坑**：变量名我写成了 `BAUDU_TRANSLATE_ENDPOINT`，
 *    而 .env 里是 `BAIDU_...`（BA-I-D-U）。大小写不一致 →
 *    CONF() 永远取不到值，而 `process.env[k]` 那条路也一样取不到。
 *    同样的错在 KEY / APPID 上没犯（那两处名字是对的），
 *    于是表现为「只有端点报错、key 却正常」，非常像环境加载问题。
 *    排查了二十余轮（插桩、二分、复制品对照、变量名长度、值含 `/`、
 *    注释配对、TDZ、node -e 对照、逐行扫描花括号深度）全部扑空，
 *    最后是逐字符打印参数才看出 BAUDU ≠ BAIDU。
 *    **教训：变量名大小写错误，用「看起来一样」的调试输出查不出来** ——
 *    我打印的是自己写的那个键，永远有值。
 *
 * ② 不依赖 process.env 的加载时机（`--env-file` / shell export 都有坑），
 *    行为完全确定。
 *
 * 优先级：真实环境变量 > .env（便于临时把端点指向本地 mock 做离线测试）。
 */
const ENV_FILE = join(ROOT, ".env");
const CONF = (() => {
  const out = {};
  if (existsSync(ENV_FILE)) {
    for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 1) continue;
      out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  return (k) => process.env[k] || out[k] || "";
})();

/* 语言集单一真源：从生成器的 LOCALES 推导（en 恒在 + LANGS）。
   不再手写 —— 手写时收敛/加门必漏改一处，本仓已漏过两次。 */
const { LOCALES } = await import("./gen-site-i18n.mjs");
const LANGS = LOCALES.filter((l) => l.code !== "en").map((l) => l.code);

/* ── 参数 ── */
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(name);
const wantLang = arg("--lang", "ja");
const limit = Number(arg("--limit", "0")) || Infinity;

if (has("--help")) {
  console.log(`
  用法：
    node tools/audit-site-i18n.mjs --lang ja|all
    node tools/audit-site-i18n.mjs --report ja|all

  选项
    --lang <门>     要审的语言，或 all（默认 ja）
    --limit <n>     只跑前 n 条（试调用）
    --report        只出报告，不调 API
    --all-wording   连措辞差异一起列（默认不列，见下）
`);
  process.exit(0);
}

/* ── 读基线与现有译文 ── */
function loadLocale(lang) {
  const p = join(ROOT, "i18n", `${lang}.json`);
  if (!existsSync(p)) throw new Error(`缺少 i18n/${lang}.json`);
  return JSON.parse(readFileSync(p, "utf8"));
}

const base = loadLocale("en");

/* ── 选源 ──
 * --source baidu | mymemory | all（默认 all = 所有就绪的源）
 *
 * 「就绪」的判据不只看配置在不在，还要看它自己声称的 ready()。
 * MyMemory 零配置可用；百度需要 key + appid 两个都在。
 */
const wantSource = arg("--source", "all");
const readySources = Object.entries(SOURCES).filter(([, s]) => s.ready());
const chosen =
  wantSource === "all"
    ? readySources
    : wantSource.split(",").map((n) => {
        const e = Object.entries(SOURCES).find(([k]) => k === n.trim());
        if (!e) throw new Error(`未知源 "${n}"，可选: ${Object.keys(SOURCES).join(", ")}`);
        if (!e[1].ready()) {
          throw new Error(`源 "${n}" 未就绪 —— 需要 ${e[1].needs.join(" + ") || "无配置"}`);
        }
        return e;
      });

if (!chosen.length) {
  console.error("\n  ❌ 没有可用的审校源。");
  console.error("     MyMemory 零配置可用；百度需 BAIDU_API_KEY + BAIDU_APPID。\n");
  process.exit(2);
}
console.log(
  `\n  审校源：${chosen.map(([k, s]) => `${s.label}(${k})`).join(" + ")}` +
    (readySources.length < Object.keys(SOURCES).length
      ? `   跳过：${Object.entries(SOURCES).filter(([, s]) => !s.ready()).map(([k, s]) => s.label).join(", ")}`
      : ""),
);
const EN = base.keys;

/* ══════════════════════════════════════════════════════════
   只出报告模式
   ══════════════════════════════════════════════════════════ */
if (has("--report")) {
  /* `--report all` / `--report ja` 都该能用。
     `--report` 后面跟的参数就是门名 —— 用户写 `--report ja` 时
     不会再去写一个 `--lang ja`。第一版只读 `--lang`，于是
     `--report all` 里的 "all" 被当成 `--report` 的值，
     wantLang 落到默认值 "ja"，其余 6 门的报告被静默跳过。 */
  const langs = (wantLang === "all" ? "all" : arg("--report", wantLang)) === "all"
    ? LANGS
    : [arg("--report", wantLang)];
  const showWording = has("--all-wording");
  let nStruct = 0;
  let nWording = 0;

  for (const lang of langs) {
    const cachePath = join(CACHE, `audit-${lang}.jsonl`);
    if (!existsSync(cachePath)) {
      console.log(`\n  ── ${lang} ── 还没有报告`);
      continue;
    }
    const rows = readFileSync(cachePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    /* **结构问题**与**措辞差异**性质完全不同，必须分开报。 */
    const struct = rows.filter((r) => r.diff && r.why.startsWith("placeholder"));
    const wording = rows.filter((r) => r.diff && r.why === "wording");
    nStruct += struct.length;
    nWording += wording.length;

    console.log(
      `\n  ── ${lang} ── 审 ${rows.length} 条 · ` +
        `结构问题 ${struct.length} 条 · 措辞差异 ${wording.length} 条`,
    );

    for (const d of struct) {
      console.log(`\n    ⚠️  ${d.key}  (${d.why})`);
      console.log(`        en   ${d.en}`);
      console.log(`        现有  ${d.ours}`);
      console.log(`        机翻  ${d.theirs}`);
    }

    if (showWording) {
      for (const d of wording) {
        console.log(`\n    ·   ${d.key}`);
        console.log(`        en   ${d.en}`);
        console.log(`        现有  ${d.ours}`);
        console.log(`        机翻  ${d.theirs}`);
      }
    }
  }

  console.log(`\n  ── 合计 ──`);
  console.log(`  结构问题 ${nStruct} 条 · 措辞差异 ${nWording} 条`);
  console.log(`
  **结构问题 = 占位符不一致，必有一方是错的。** 这才是交叉审校能给出的
  高信噪比结论：实测 3 条全部是机翻丢了 {p1} 价格占位符，现有译文是对的。

  **措辞差异默认不列**（--all-wording 可展开）。理由是实测数据：
  zh 403 条里 348 条措辞不同，逐条看全是噪音 —— 常见问题 vs 常见问题解答、
  PDF vs PDF（便携式文档格式）、7 天 vs 7天。两套译者的风格惯例不同
  （机翻爱展开缩写、空格惯例不同），措辞天然对不上，**那是基线噪声不是信号**。
  列 348 条只会让人放弃看这份报告。
`);
  process.exit(nStruct ? 1 : 0);
}

/* ══════════════════════════════════════════════════════════
   调 API
   ══════════════════════════════════════════════════════════ */
const KEY = CONF("BAIDU_API_KEY");
if (!KEY) {
  console.error(`
  ❌ 没有 BAIDU_API_KEY。

  用环境变量传，不要写进文件：
      BAIDU_API_KEY=你的key BAIDU_APPID=你的appid \\
        node tools/audit-site-i18n.mjs --lang ja

  这个 key 现在已经出现在对话记录里了，用完请去控制台删掉重建。
`);
  process.exit(2);
}

/* 端点来自官方文档 /product/133「接入技术指南」，已实测格式正确。
 *
 * **刻意不给默认值。** 给了默认值之后想拿假端点做本地测试都做不到 ——
 * 环境变量被静默忽略，请求直接打到真实百度上（实测踩过：
 * 假装在测本地 mock，实际每条都在消耗真实额度并失败）。
 * 显式要求也让「现在连的是谁」永远写在命令行里，一眼可查。 */
const ENDPOINT = CONF("BAIDU_TRANSLATE_ENDPOINT");
if (!ENDPOINT) {
  console.error(`
  ❌ 没有 BAIDU_TRANSLATE_ENDPOINT。

  官方端点（/product/133「接入技术指南」）：
      https://fanyi-api.baidu.com/ait/api/aiTextTranslate

      BAIDU_TRANSLATE_ENDPOINT='https://fanyi-api.baidu.com/ait/api/aiTextTranslate' \\
      BAIDU_API_KEY=xxx BAIDU_APPID=yyy \\
        node tools/audit-site-i18n.mjs --lang ja

  也可以指向本地 mock 做离线测试 —— 刻意不给默认值就是为了这个。
`);
  process.exit(2);
}

const APPID = CONF("BAIDU_APPID");
if (!APPID) {
  console.error(`
  ❌ 没有 BAIDU_APPID。

  端点与 Bearer 鉴权已实测正确（带错 key 回 \`54001 invalid token\`，
  不带头回 \`54001 invalid sign\`，两者可区分 → 头解析成功）。
  但 appid 是**账号绑定值**，与 API Key 配对，猜不出来：
  传任意 appid 都是 \`invalid token\`。

  【管理控制台】→【开发者信息】→ APPID，与 API Key 是同页。

  另外大模型翻译服务要先开通（登录 → 开发者认证 → 开通服务），
  未开通时同样鉴权失败。

      BAIDU_API_KEY=xxx BAIDU_APPID=yyy \\
        node tools/audit-site-i18n.mjs --lang ja --limit 10
`);
  process.exit(2);
}

if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });

/* ── 已完成的键（断点续跑）── */
function doneKeys(lang) {
  const p = join(CACHE, `audit-${lang}.jsonl`);
  if (!existsSync(p)) return new Set();
  return new Set(
    readFileSync(p, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l).key;
        } catch {
          return null;
        }
      })
      .filter(Boolean),
  );
}

/* ── 语种代码 ──
 *
 * 百度用的是**自有代码表**，不是 ISO 639-1。第一版我按 ja/ko/ar 猜，
 * 6 个全错（jp/kor/de/spa/ara/pt，中文还得区分简体 zh 与繁体 cht）。
 * 现已逐条从官方「语种代码对照表」（/product/133 正文第 5 节）核实。
 *
 * 注意葡语那行：表格里葡萄牙语的「代码」是 pt，紧邻的 pot 是它的
 * **语种检测**值 —— 正则按「名称+两字母+是/否」抓会错配成 pot。
 * 这类相邻列陷阱在中文那行也有（zh 简体 / cht 繁体 / wyw 文言文）。
 */
const BAIDU_LANG = {
  zh: "zh", // 中文（简体）
  ja: "jp", // 日语 —— 不是 ja
  ko: "kor", // 韩语
  de: "de",
  es: "spa",
  pt: "pt",
  ar: "ara",
};
const BAIDU_LANG_EN = "en"; // 英文，from 用

/* ══════════════════════════════════════════════════════════
   审校源：多个第三方翻译服务，互为第二意见
   ══════════════════════════════════════════════════════════
 *
 * ── 为什么要多源 ──
 *
 * 实测两个源在**同一类**地方坏，但坏法不同：
 *
 *   原文  7-day trial, then {p1} once, no subscription.
 *   百度  7日間のトライアル後、{p1}1回           ← {p1} 完好
 *   MyMem 7日間のトライアル、その後{p 1} 1回      ← 插了个空格
 *
 *   原文  …no lock-in — {p1} once, no subscription.
 *   百度  …只需一次购买，无需订阅。               ← {p1} 整个消失
 *
 * 两套源**盲区不完全重叠** → 交叉比对能提高检出率。
 * 一套源只能看到一套的盲区。
 *
 * ── 但这不是「多意见投票」 ──
 *
 * 仍然只报**结构问题**（占位符），不报措辞。
 * 上一轮实测：措辞差异 2425 条，噪音率 ~99%。
 * 两套源之间的措辞差异只会更多，更不能当信号用。
 */

const SOURCES = {
  /* ── 百度大模型翻译 ──
   * 端点与鉴权来自官方文档 /product/133「接入技术指南」。
   * 实测（2026-10-09）：带错 key 返回 `54001 invalid token`，
   * 不带头返回 `54001 invalid sign`，两者可区分 → 头解析成功。
   * appid 是账号绑定值，传错同样是 `invalid token`。 */
  baidu: {
    label: "百度",
    needs: ["BAIDU_API_KEY", "BAIDU_APPID"],
    lang: BAIDU_LANG,
    langFrom: BAIDU_LANG_EN,
    ready() {
      return Boolean(CONF("BAIDU_API_KEY") && CONF("BAIDU_APPID"));
    },
    async call(text, target) {
      const endpoint = CONF("BAIDU_TRANSLATE_ENDPOINT");
      if (!endpoint) throw new Error("未设 BAIDU_TRANSLATE_ENDPOINT");
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CONF("BAIDU_API_KEY")}`,
        },
        body: JSON.stringify({
          appid: CONF("BAIDU_APPID"),
          from: this.langFrom,
          to: this.lang[target],
          q: text,
          /* llm = 大模型翻译。审校要的是「另一个独立意见」，
             nmt 是老机器翻译，与我们写译文的路径更远。 */
          model_type: "llm",
        }),
      });
      const raw = await res.text();
      let j;
      try {
        j = JSON.parse(raw);
      } catch {
        throw new Error(`响应非 JSON (${res.status}): ${raw.slice(0, 100)}`);
      }
      if (j.error_code) throw new Error(`${j.error_code} ${j.error_msg}`);
      const out = j.trans_result?.[0]?.dst;
      if (!out) throw new Error(`取不到译文，字段: ${Object.keys(j).join(",")}`);
      return out;
    },
  },

  /* ── MyMemory ──
   *
   * 无需注册 / 无需 API key。带 `de=<邮箱>` 参数额度 5000→50000 字符/天。
   *
   * 实测两个官方文档没写清的约束：
   *
   * ① **单次上限 500 字符**：
   *      403 QUERY LENGTH LIMIT EXCEEDED. MAX ALLOWED QUERY : 500 CHARS
   *    本项目最长一句是 terms.liabilityP 的 320 字符，暂时安全 ——
   *    但换文案就可能撞上。这里**硬性按 500 拒绝，不静默截断**：
   *    截断出来的译文占位符必然不完整，会被误报成「结构问题」。
   *
   * ② **语种码是它的自有格式**（ja-JP / ko-KR / ar-SA …），
   *    不是 ISO 639-1，与百度那套完全不同。
   *
   * 额度实测：不带 de 连打 5760 字符仍全部成功（官方口径 5000/天），
   * 比文档宽松。 */
  mymemory: {
    label: "MyMem",
    needs: [], /* 零配置可用 */
    lang: {
      zh: "zh-CN", ja: "ja-JP", ko: "ko-KR",
      de: "de-DE", es: "es-ES", pt: "pt-BR", ar: "ar-SA",
    },
    langFrom: "en",
    ready() {
      return true;
    },
    async call(text, target) {
      const to = this.lang[target];
      if (!to) throw new Error(`未映射的语种: ${target}`);
      if (text.length > 500) throw new Error(`超单次上限 (${text.length} > 500)`);

      const p = new URLSearchParams({ q: text, langpair: `en|${to}` });
      const de = CONF("MYMEMORY_EMAIL");
      if (de) p.set("de", de);

      const res = await fetch(`https://api.mymemory.translated.net/get?${p}`);
      const raw = await res.text();
      let j;
      try {
        j = JSON.parse(raw);
      } catch {
        throw new Error(`响应非 JSON (${res.status}): ${raw.slice(0, 100)}`);
      }
      if (j.responseStatus !== 200) {
        throw new Error(`${j.responseStatus} ${String(j.responseDetails).slice(0, 60)}`);
      }
      const out = j.responseData?.translatedText;
      if (!out) throw new Error(`取不到译文，字段: ${Object.keys(j).join(",")}`);
      return out;
    },
  },
};

/* 限流 / 超限 —— 两源都要退避（百度 qps limit、MyMemory 500 字符上限） */
const LIMIT_RE = /^59\d{3}|limit/i;

/* ── 差异判定 ──
 *
 * 只做**结构性**比较，不做语义比较 —— 那正是这个工具的边界：
 * 我们要的是「两套译法是否给出了同样的句子」，不是「哪个更好」。
 *
 * 不一致的三种形态：
 *   · normalize 后完全相同        → 一致（忽略空白/全半角差异）
 *   · 占位符集合不同              → 不一致（结构问题，必错）
 *   · 归一化后文本不同            → 不一致（值得人看）
 */
const PLACEHOLDER = /\{\{[^}]+\}\}|\$\{[^}]+\}|\{[^}]*\}|__[A-Z_]+__|RKT-[A-Z0-9-]+|\$[\d.,]+/g;

function placeholders(s) {
  /* **不排序。**
   *
   * 第一版写了 .sort()，理由是想忽略出现顺序。但价格是
   * {p1} / {p2} 两个**有语序含义**的占位符 —— 日语里
   * 「{p1} ベースで {p2}」与「{p2}、{p1}」说的不是一回事
   * （单品价在前 vs 全家桶价在前），排序后两者集合相同，
   * 于是「语序颠倒」被判成「一致」。
   *
   * 语序差异本来就是这个工具要报出来给人看的东西。
   * 变异测试实测：漏报。
   */
  return (s.match(PLACEHOLDER) || []).map((x) => x.replace(/[\d.,]+$/, "#")).join("|");
}

/* 归一化：全角→半角、去零宽字符、统一引号与破折号、压空白 */
function normalize(s) {
  return s
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, " ")
    .trim();
}

function diffOf(enText, ours, theirs) {
  const n = (x) => normalize(x || "");
  if (n(ours) === n(theirs)) return { same: true, why: "identical" };
  const po = placeholders(ours);
  const pt = placeholders(theirs);
  if (po !== pt) return { same: false, why: `placeholder ${po} vs ${pt}` };
  return { same: false, why: "wording" };
}

/* ── 主流程 ── */
const langs = wantLang === "all" ? LANGS : [wantLang];

for (const lang of langs) {
  if (!LANGS.includes(lang)) {
    console.error(`  ❌ 未知语言 "${lang}"，可选：${LANGS.join(" ")} | all`);
    process.exit(2);
  }
  const loc = loadLocale(lang);
  const already = doneKeys(lang);
  const keys = Object.keys(EN).filter((k) => !already.has(k)).slice(0, limit);
  const outPath = join(CACHE, `audit-${lang}.jsonl`);

  console.log(`\n  ── ${lang} ── 待审 ${keys.length} 条（已完成 ${already.size}）`);

  let nDiff = 0;
  let nErr = 0;
  let done = 0;
  let throttled = 0;

  /* ── 并发 + 限流退避 ──
   *
   * 第一版串行 + 每条 sleep 120ms：403 条 6 分钟，7 门 40 分钟，跑不完。
   *
   * 第二版「5 路并发 + 400ms 批间隔」**更糟** —— 直接把百度打限流了：
   * 每门 300 条 `59004 qps limit`，4 门卡在 103/403。
   * 撞了限流还以同样速度继续打，只是白烧配额。
   *
   * 现在：识别限流错误码 → 指数退避 → **降并发**（自适应，不是固定值）。
   * 限流错误（59004/59002/59003 等）与真错误分开计数，退避只针对前者。
   *
   * 默认并发回到 3，保守起步，撞到限流自己往下调。
   */
  let CONCURRENCY = Number(arg("--concurrency", "3")) || 3;
  const LIMIT_CODES = /^59\d{3}|^5[0-4]\d{3} limit|limit/i;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  while (done + nErr < keys.length) {
    const batchSize = Math.min(CONCURRENCY, keys.length - done - nErr);
    const batch = keys.slice(done + nErr, done + nErr + batchSize);

    const results = await Promise.all(
      batch.map(async (key) => {
        try {
          const theirs = await translate(EN[key], lang);
          const d = diffOf(EN[key], loc.keys[key], theirs);
          return {
            key,
            row: { key, en: EN[key], ours: loc.keys[key], theirs, diff: !d.same, why: d.why },
          };
        } catch (e) {
          return { key, err: e.message, limited: LIMIT_CODES.test(e.message) };
        }
      }),
    );

    let limitedInBatch = 0;
    for (const r of results) {
      if (r.err) {
        nErr++;
        if (r.limited) limitedInBatch++;
        else console.error(`\n     ⚠️ ${r.key}: ${r.err}`);
        continue; /* 不写入 —— 让它下次重试 */
      }
      if (r.row.diff) nDiff++;
      appendFileSync(outPath, JSON.stringify(r.row) + "\n");
      done++;
    }

    process.stdout.write(
      `\r     ${done + nErr}/${keys.length} · 差异 ${nDiff} · ` +
        `限流 ${throttled} · 报错 ${nErr - throttled} · 并发 ${CONCURRENCY}` +
        " ".repeat(12),
    );

    /* 撞限流就退避并降并发；否则恢复 */
    if (limitedInBatch) {
      throttled += limitedInBatch;
      const wait = Math.min(1000 * 2 ** Math.min(throttled, 5), 30000);
      CONCURRENCY = Math.max(1, CONCURRENCY - 1);
      console.error(
        `\n     ⏳ 限流 ${limitedInBatch} 条 · 退避 ${wait / 1000}s · 并发降到 ${CONCURRENCY}`,
      );
      await sleep(wait);
    } else if (throttled) {
      throttled = 0;
      console.error(`\n     ✅ 限流解除 · 并发回到 ${Math.min(CONCURRENCY + 1, 6)}`);
      CONCURRENCY = Math.min(CONCURRENCY + 1, 6);
      await sleep(300);
    } else {
      await sleep(250);
    }
  }

  process.stdout.write("\r" + " ".repeat(70) + "\r");
  if (nErr) console.log(`     ⚠️ ${nErr} 条未写入，重跑本命令会从它们继续。`);
  void done;
  const total = existsSync(outPath)
    ? readFileSync(outPath, "utf8").split("\n").filter(Boolean).length
    : 0;
  console.log(`  ✅ ${lang}: 本轮 ${keys.length} 条 · 不一致 ${nDiff} · 报错 ${nErr}`);
  console.log(`     报告 → tools/.cache/audit-${lang}.jsonl（累计 ${total} 条）`);
  console.log(`     下一轮重跑同一命令会自动跳过已完成的。`);
}

console.log(`\n  查看报告：node tools/audit-site-i18n.mjs --report all\n`);
