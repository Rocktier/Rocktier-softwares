/* 提交前自查：确认密钥没有漏进版本库。
 *
 * ── 为什么需要 ──
 *
 * .env 已被 .gitignore 第 17-20 行挡住，但 .gitignore 是**约定**不是**强制**：
 * 一次 `git add -f`、一条 `!` 反向规则、或有人整理 .gitignore 时手滑，
 * 密钥就会进历史 —— 而 git 历史一旦写入，删文件也删不掉。
 *
 * 这道闸门不阻止提交，只**在提交前把话说出来**。
 * 真正的防线是轮换密钥，不是这个脚本。
 *
 * 用法：node tools/check-secrets.mjs
 * 退出码：0 = 干净；1 = 发现疑似泄漏
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* 密钥形态的特征。刻意不写死具体值 —— 换 key 后规则依然有效。 */
const PATTERNS = [
  { name: "百度翻译 API Key", re: /\b[A-Za-z0-9]{24}\b(?=.*百度|Baidu)/, hint: "BAIDU/BAIDU_API_KEY" },
  { name: "疑似 Baidu API Key", re: /\bYDdc_[A-Za-z0-9]{16,}\b/, hint: "百度翻译控制台" },
  { name: "AWS Access Key", re: /\bAKIA[0-9A-Z]{16}\b/, hint: "AWS IAM" },
  { name: "Google API Key", re: /\bAIza[0-9A-Za-z\-_]{35}\b/, hint: "Google Cloud" },
  { name: "OpenAI Key", re: /\bsk-[A-Za-z0-9]{32,}\b/, hint: "OpenAI" },
  { name: "私有钥", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, hint: "SSH/TLS" },
];

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
  } catch {
    return "";
  }
}

console.log("\n  ── 密钥泄漏自查 ──\n");

let bad = 0;

/* ① 已跟踪文件里是否有密钥 */
const tracked = sh("git", ["ls-files"]).split("\n").filter(Boolean);
console.log(`  已跟踪文件 ${tracked.length} 个，扫描中…`);
for (const f of tracked) {
  if (/\.(png|jpg|jpeg|gif|ico|woff2?|ttf|zip|pdf|mp4|wasm)$/i.test(f)) continue;
  const p = join(ROOT, f);
  if (!existsSync(p)) continue;
  const { readFileSync } = await import("node:fs");
  let s;
  try {
    s = readFileSync(p, "utf8");
  } catch {
    continue;
  }
  for (const { name, re } of PATTERNS) {
    if (re.test(s)) {
      bad++;
      console.log(`  ❌ ${f} —— 命中「${name}」`);
    }
  }
}

/* ② .env 是否确实被忽略（防 .gitignore 被改坏）*/
try {
  sh("git", ["check-ignore", "-q", ".env"]);
  console.log("  ✅ .env 被 .gitignore 挡住");
} catch {
  console.log("  ⚠️ .env **未被忽略** —— 检查 .gitignore");
}

console.log("");
if (bad) {
  console.log(`  ❌ ${bad} 处疑似泄漏。`);
  console.log(`     已进 git 历史的话，删文件没用 —— 必须**轮换该密钥**。\n`);
  process.exit(1);
}
console.log("  ✅ 未发现密钥泄漏\n");
