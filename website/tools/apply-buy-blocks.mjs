#!/usr/bin/env node
/* 给 9 个产品页装上**统一**的购买区。

   为什么用脚本而不是手改 9 遍：
   - 9 个页面的购买区必须逐字一致（合规勾选文案、价格、按钮措辞），
     手改必然漂移 —— 而这份文案是 EU/UK 撤回权的法律声明，漂移就是
     不同产品对买家说了不同的话
   - 每处改动都能追溯到这个脚本，比散落在 9 个文件里更容易复核

   用法：node tools/apply-buy-blocks.mjs [--dry]
   幂等：已装过且内容一致就跳过。 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DRY = process.argv.includes("--dry");

/* 与 api/_shared.js 的 CATALOG 同源。价格已逐项核对 family.json 的
   pricing.direct（家族价目真源），2026-10-06 全项一致。 */
const PRODUCTS = {
  "markdown.html":   { code: "MD", prod: "prod_25g9tjygShagA9Ou7NtQu1", price: "6.99",  ns: "md",  paypal: "pri_01m2x14gp1dzbjttsv6gqfw7m8", platform: true },
  "pic2webp.html":   { code: "WP", prod: "prod_3WGsJX0AuPkYBYCvoDD0wP", price: "4.99",  ns: "pic", paypal: "pri_01m2x14apb42kcscg18k5385jn", platform: true },
  "cad-viewer.html": { code: "CV", prod: "prod_2kPdg0bkPeven2QXzFG6bX", price: "14.99", ns: "cad", paypal: "pri_01m2x14jy1mmck626fb2v6k64w", platform: true },
  "ocr.html":        { code: "OC", prod: "prod_5p01aS1VOcdH9rqtozt9O5", price: "14.99", ns: "ocr", paypal: null, platform: true },
  "write.html":      { code: "WR", prod: "prod_GnHgkbJt8ahSjYcImdEBl",  price: "12.99", ns: "wr",  paypal: null, platform: true },
  "compressor.html": { code: "CO", prod: "prod_7LNvNTzDcfIAP2RyNjKOg7", price: "9.99",  ns: "co",  paypal: null, platform: true },
  "journal.html":    { code: "JO", prod: "prod_3a135PdLzq7CerGOSA6NSm", price: "9.99",  ns: "ji",  paypal: null, platform: true },
  /* Sign 2026-10-28 裁定并入 PDF 1.1.0（见 family.json $ruling_2026_10_28），官网
     卡片已撤、sign.html 只剩跳转页。条目**保留但不参与装块**：一旦有人重跑本脚本，
     没有这道守卫就会把 Creem 购买区块塞回一个已声明「moved into PDF」的页面，
     等于又开出一个可付费的 Sign 入口（Creem 后台的 SG 商品停用是用户本人的后台
     操作，本脚本管不到）。等 1.1.0 发布、退场动作真正执行完再删条目。 */
  "sign.html":       { code: "SG", prod: "prod_6GZMSHYC0paDLKguyWC1Et", price: "9.99",  ns: "sg",  paypal: null, platform: true, retired: true },
  "pdf.html":        { code: "PD", prod: "prod_29kyJdztcwhkCkI6eoXvCe", price: "9.99",  ns: "pd",  paypal: "pri_01m2x14d1qapnz8z45rx76fy4f", platform: true },
};

const PLATFORM_NOTE = "One-time purchase · Windows &amp; macOS";
const CONSENT =
  'I agree that Rocktier delivers the software immediately after payment, and that, where applicable, I lose the right of withdrawal once delivery has started.';

function block(p) {
  /* PayPal 入口只在**该产品在 PayPal 后台确实有商品**时渲染。
     给一个必定失败的链接比不给更糟：用户付了钱才发现。 */
  const paypal = p.paypal
    ? `\n          <a class="btn ghost" href="/api/paypal-checkout?price_id=${p.paypal}" data-i18n="p.paypal">Buy with PayPal</a>`
    : "";
  return `<section class="section alt" id="pricing">
    <div class="wrap">
      <div class="sec-head center">
        <p class="eyebrow" data-i18n="${p.ns}.p.eyebrow">Pricing</p>
        <h2 class="sec-title" data-i18n="${p.ns}.p.title">Pay once. Keep it forever.</h2>
        <p class="lead" data-i18n="${p.ns}.p.sub">No subscription, no account, nothing to renew.</p>
      </div>
      <div class="banner price-card">
        <p class="price-amount">$${p.price}</p>
        <p class="price-note" data-i18n="${p.ns}.p.note">${PLATFORM_NOTE}</p>
        <label class="buy-consent" for="buy-consent">
          <input class="buy-consent-box" id="buy-consent" type="checkbox" />
          <span data-i18n="p.consent">${CONSENT}</span>
        </label>
        <p class="buy-consent-hint" data-i18n="p.consentHint" hidden>Please tick the box above before paying.</p>
        <div class="cta-row">
          <a class="btn" href="https://www.creem.io/payment/${p.prod}" data-buy="creem" data-product="${p.code}" data-price="${p.price}" data-i18n="${p.ns}.p.buy">Buy - $${p.price}</a>${paypal}
        </div>
      </div>
    </div>
  </section>`;
}

let changed = 0, skipped = 0, missing = [], retired = [];
for (const [file, p] of Object.entries(PRODUCTS)) {
  /* 已退役产品不装块 —— 不删条目是为了留着 Creem 商品 id 备查，见 PRODUCTS 里的注释。 */
  if (p.retired) { retired.push(file); continue; }
  const path = join(ROOT, file);
  if (!existsSync(path)) { missing.push(file); continue; }
  const html = await readFile(path, "utf8");
  const want = block(p);

  if (html.includes(want)) { skipped++; continue; }

  /* 替换整个 <section id="pricing">…</section>；没有就插在 <section class="section" id="faq"> 之前。 */
  const secRe = /<section class="section alt" id="pricing">[\s\S]*?<\/section>/;
  let next;
  if (secRe.test(html)) next = html.replace(secRe, want);
  else if (html.includes('id="faq"')) next = html.replace(/(\s*<section class="section" id="faq">)/, `\n${want}\n$1`);
  else { console.warn(`  ⚠️  ${file}: 既无 pricing 段也无 faq 锚点，跳过`); continue; }

  /* 装购买区时**顺带补上 checkout.js**。
     踩过的坑：journal/sign/compressor 三页的购买区是后加的，加的时候
     没引checkout.js —— 于是 requireConsent 根本不存在，那道「即时交付」
     确认框成了摆设，买家可未勾选直接跳去付款，
     而refund-policy 第 3 节的撤回权声明正是靠它成立的。

     购买区与它的脚本是一体的，少一个就等于没有。 */
  if (!next.includes("js/checkout.js")) {
    const anchor2 = '<script src="js/main.js"></script>';
    if (next.includes(anchor2)) {
      next = next.replace(anchor2, anchor2 + '\n<script src="js/checkout.js"></script>');
    } else {
      console.warn(`  ⚠️  ${file}: 找不到 main.js 锚点，请手工加 checkout.js`);
    }
  }

  if (next === html) { skipped++; continue; }
  if (!DRY) await writeFile(path, next);
  changed++;
  console.log(`  ${DRY ? "[dry] " : ""}✅ ${file.padEnd(18)} ${p.code} $${p.price}`);
}
console.log(`\n  装上 ${changed} · 已就位 ${skipped} · 缺文件 ${missing.length}${missing.length ? " (" + missing.join(", ") + ")" : ""} · 退役跳过 ${retired.length}${retired.length ? " (" + retired.join(", ") + ")" : ""}`);
if (missing.length) process.exitCode = 1;