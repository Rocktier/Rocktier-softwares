#!/usr/bin/env node
/**
 * 批量生成内测激活码（明天发 100 码这种场景）。
 *
 * 为什么单独写：官网只有 makeCode() 这个纯函数，发码入口全是支付回跳触发的，
 * 没有管理员批量发码接口。内测码不是买出来的，得离线签一批。
 *
 * 用法（在 website/ 下）：
 *   LICENSE_SECRET="<Vercel 上的 LICENSE_SECRET>" node tools/beta-codegen.mjs \
 *     --product FL --count 100 --prefix beta --out /tmp/beta-codes.csv
 *
 *   node tools/beta-codegen.mjs --selftest
 *     用临时密钥自测，不要求真实凭据，也不会落盘。
 *
 * 码格式沿用服务端同一套 makeCode：RKT-<base32(PRODUCT:txn)>-<HMAC 前 10 位>。
 * 交易号必须是 txn_ 前缀，否则 /api/activate 的 verifyCode 直接拒绝；
 * 本脚本统一生成 txn_<prefix>_<YYMMDD>_<序号>，逐码回验 product 与 txn 一致。
 *
 * 输出：默认 CSV（code,product,txn）；--out 以 .json 结尾则输出 JSON 数组。
 * 默认拒绝把码写进仓库目录（避免误提交），确有必要才加 --force。
 *
 * 注意：码本身不含设备数与有效期语义。现有机制每码最多 3 台设备（api/devices.js），
 * 回执不设过期。发码前请确认这两条对内测是可接受的。
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, "..");
const require = createRequire(import.meta.url);
const { makeCode, verifyCode, CATALOG } = require(join(SITE, "api/_shared.js"));

function fail(message) {
  console.error("beta-codegen FAIL: " + message);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    product: "FL",
    count: 100,
    prefix: "beta",
    out: null,
    selftest: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--selftest") opts.selftest = true;
    else if (a === "--force") opts.force = true;
    else if (["--product", "--count", "--prefix", "--out"].includes(a)) {
      const v = argv[++i];
      if (!v) fail(`${a} 缺参数`);
      opts[a.slice(2)] = v;
    } else fail(`未知参数: ${a}`);
  }
  opts.count = Number(opts.count);
  if (!Number.isInteger(opts.count) || opts.count < 1 || opts.count > 10000) {
    fail("--count 必须是 1..10000 的整数");
  }
  if (!/^[a-z0-9_-]{1,20}$/.test(opts.prefix)) {
    fail("--prefix 只能用小写字母、数字、下划线、连字符，且不超过 20 字符");
  }
  return opts;
}

function generate(product, count, prefix, secret, date) {
  if (!Object.hasOwn(CATALOG, product)) fail(`产品码 ${product} 不在 CATALOG`);
  const seen = new Set();
  const rows = [];
  for (let i = 1; i <= count; i++) {
    const txn = `txn_${prefix}_${date}_${String(i).padStart(3, "0")}`;
    const code = makeCode(product, txn, secret);
    /* 逐码回验：生成器和校验器若有一处漂移，这里必须当场红，不能等到用户激活失败 */
    const parsed = verifyCode(code, secret);
    if (!parsed || parsed.productCode !== product || parsed.txnId !== txn) {
      fail(`第 ${i} 码自检不通过: ${code}`);
    }
    if (seen.has(code)) fail(`第 ${i} 码重复: ${code}`);
    seen.add(code);
    rows.push({ code, product, txn });
  }
  return rows;
}

function serialize(rows, out) {
  if (out && out.toLowerCase().endsWith(".json")) {
    return JSON.stringify(rows, null, 2) + "\n";
  }
  return ["code,product,txn", ...rows.map((r) => `${r.code},${r.product},${r.txn}`)].join("\n") + "\n";
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const selftest = opts.selftest;
  const secret = selftest ? "selftest-secret-not-for-production" : process.env.LICENSE_SECRET;

  if (!secret) {
    fail("LICENSE_SECRET 未设置。从 Vercel 环境变量取；或先跑 --selftest 验证工具本身。");
  }
  if (!selftest && secret === "test-secret-not-used-in-production") {
    fail("拒绝使用夹具里的测试密钥签真实内测码");
  }

  const date = new Date().toISOString().slice(2, 10).replace(/-/g, "");
  const rows = generate(
    selftest ? "FL" : opts.product,
    selftest ? 3 : opts.count,
    selftest ? "selftest" : opts.prefix,
    secret,
    date
  );

  if (selftest) {
    console.log("beta-codegen selftest OK: 3 码生成 + 回验通过（临时密钥，未落盘）");
    return;
  }

  const text = serialize(rows, opts.out);
  if (!opts.out) {
    process.stdout.write(text);
  } else {
    const target = resolve(opts.out);
    const rel = relative(resolve(SITE), target);
    const insideRepo = !rel.startsWith("..") && !isAbsolute(rel);
    if (insideRepo && !opts.force) {
      fail(`拒绝把码写进仓库内：${target}（确要写则加 --force，但别提交）`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, "utf8");
  }

  console.error(`beta-codegen OK: ${rows.length} 码 | product=${opts.product} | prefix=${opts.prefix} | date=${date}`);
  console.error(`  首码 ${rows[0].code}`);
  console.error(`  末码 ${rows[rows.length - 1].code}`);
  if (opts.out) console.error(`  已写 ${resolve(opts.out)}（不要把此文件提交或贴进公开仓库）`);
  else console.error("  未指定 --out，清单写到 stdout");
}

main();
