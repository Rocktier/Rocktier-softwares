/* 把 glossary.json 授权族的 ja/ko 用字对齐源码。
 *
 * ── 背景 ──
 * Write / OCR / Pic2WebP 三仓已把授权日韩用字从 認証/인증（认证）
 * 迁到 アクティベート/활성화（激活），但 glossary.json 仍记旧值。
 * glossary-check 报 PASS 正因为它锚在一个多数代码都违背的值上。
 *
 * ── 权威值从源码抽，不手打 ──
 * 下面从「Rocktier OCR/ui/lang.js」里正则取出已迁移仓的实际文案。
 * 手打过一次，打错了（证コード / アクティRipkey）——
 * 数据必须来自唯一真源，否则修术语表本身又成了新的漂移源。
 *
 * ── 判定按术语 id，不按尾段名 ──
 * 第一版按「id 的尾段」当键名，误判了 chapters.title（チャプター）、
 * dashboard.title（ワークスペース統計）、frontmatter.title、recent.title。
 * 现在只认 license.* 前缀，或无前缀且整串在白名单里。
 *
 * 用法：node tools/fix-license-glossary.mjs [--check]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const PATH = join(ROOT, "docs/rocktier/i18n/glossary.json");
const CHECK = process.argv.includes("--check");

/* ── 1. 从已迁移的 OCR 仓抽权威值 ── */
const SRC = join(ROOT, "Rocktier OCR/ui/lang.js");
if (!existsSync(SRC)) {
  console.error("  ❌ 找不到权威源 " + SRC);
  process.exit(2);
}
const src = readFileSync(SRC, "utf8");

function grabBlock(titleLiteral) {
  // 只按 title 字面量定位语言块，不拼正则转义
  const needle = 'title: "' + titleLiteral + '"';
  const at = src.indexOf(needle);
  const m = { index: at };
  if (!m) throw new Error("权威源里找不到 " + titleLiteral);
  const start = src.lastIndexOf("license: {", m.index);
  const end = src.indexOf("\n    },", start);
  return src.slice(start, end);
}

const KEYS = [
  "title", "expiredChip", "licensedNote", "notConfigured", "codeLabel",
  "activate", "activating", "invalid", "wrongProduct", "refunded",
  "offline", "privacyNote", "exportHintExpired",
];

function values(block) {
  const out = {};
  for (const k of KEYS) {
    const m = new RegExp(k + ':\\s*"((?:[^"\\\\]|\\\\.)*)"').exec(block);
    if (m) out[k] = m[1];
  }
  return out;
}

const AUTH = {
  ja: values(grabBlock("ライセンスアクティベート")),
  ko: values(grabBlock("라이선스 활성화")),
};

/* ── 2. 哪些术语 id 属于授权族 ── */
const BARE = new Set([
  "activate", "activating", "codeLabel", "expiredChip", "licensedNote",
  "notConfigured", "invalid", "wrongProduct", "refunded", "offline",
  "privacyNote", "exportHintExpired", "title",
]);

function keyOf(tid) {
  if (tid.startsWith("license.")) return tid.slice("license.".length);
  return BARE.has(tid) ? tid : null;
}

/* ── 3. 干跑 ── */
const raw = readFileSync(PATH, "utf8");
const glossary = JSON.parse(raw);
const changes = [];

for (const [tid, loc] of Object.entries(glossary.terms)) {
  const k = keyOf(tid);
  if (!k) continue;
  for (const lang of ["ja", "ko"]) {
    const cur = loc[lang];
    const want = AUTH[lang][k];
    if (!cur || !want || cur.value === want) continue;
    changes.push({ tid, lang, from: cur.value, to: want });
  }
}

console.error("");
if (!changes.length) {
  console.error("  ✅ 术语表授权族已与源码一致，无需改动");
  process.exit(0);
}
console.error(`  将改 ${changes.length} 条（ja ${changes.filter((c) => c.lang === "ja").length} · ko ${changes.filter((c) => c.lang === "ko").length}）`);
for (const c of changes.slice(0, 6)) {
  console.error(`    ${c.tid.padEnd(24)} ${c.lang}  ${JSON.stringify(c.from.slice(0, 22))} → ${JSON.stringify(c.to.slice(0, 22))}`);
}
if (changes.length > 6) console.error(`    … 另 ${changes.length - 6} 条`);

if (CHECK) {
  const stale = changes.filter((c) => glossary.terms[c.tid][c.lang].value !== c.to);
  console.error("");
  if (stale.length) {
    console.error(`  ⚠️ 仍有 ${stale.length} 条与源码不一致（--check 模式不写盘）`);
    process.exit(1);
  }
  console.error("  ✅ 与源码一致");
  process.exit(0);
}

/* ── 4. 写盘：只改 value，保留 sources 并补记迁移来源 ── */
for (const c of changes) {
  const entry = glossary.terms[c.tid][c.lang];
  entry.value = c.to;
  delete entry.conflict;
  const srcs = new Set(entry.sources || []);
  srcs.add("ocr");
  srcs.add("write");
  srcs.add("pic2webp");
  entry.sources = [...srcs];
  if (!entry.note) {
    entry.note = "2026-09 术语迁移：認証/인증（认证）→ アクティベート/활성화（激活）";
  }
}

writeFileSync(PATH, JSON.stringify(glossary, null, 2) + "\n");
console.error(`\n  ✅ 已写入 ${PATH}`);
console.error(`     ${changes.length} 条\n`);
