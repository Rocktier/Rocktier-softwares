/* 授权撤权链路的测试（markRevoked / isRevoked / PayPal 事件解析）。

   为什么重写这个文件：`8eea1cf` 删掉了旧的 test-revocation.mjs，
   理由（Paddle 专属、一跑就崩）成立 —— 但那个文件里**还有 4 条
   PayPal 作废判定的测试**，随Paddle 一起被误删了。

   后果：`isRevoked` / `markRevoked` / `isPayPalRefundEvent` /
   `paypalOrderIdFromEvent` 这几个函数**代码都在、但零测试覆盖**。
   撤权是「退款后收回使用权」这条安全链路最后一环 ——
   裸奔着接Creem webhook（阶段 30 的 P2）风险太大。

   本文件只测**还活着**的逻辑：
   - 纯函数：事件 → 是不是撤权事件 / 订单号能不能取到
   - KV 往返：markRevoked → isRevoked（用内存 KV 顶替 Upstash REST，
     走**真实的 fetch 调用路径**，所以键名也一并被测到）

   Paddle 专属的部分**不再测**：paddleTxnIdFromEvent / DEFAULT_PRICE_PRODUCT_MAP
   已随 Paddle 下线删除（0c9e11f），测不存在的东西没有意义。 */

import { createHash, createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import vm from "node:vm";

const require = createRequire(import.meta.url);

/* ── 内存 KV：顶替 Upstash REST，保留真实键名与 URL 形状 ── */
const STORE = new Map();
const KV_BASE = "https://fake-kv.test";
const SET_URLS = [];          /* 记录每次 set 的 {key, url} —— TTL 只体现在 ?ex= 上。
                                 注意必须存**解码后的 key**：URL 里 `:` 被编码成
                                 %3A，直接拿原始 URL 做 includes("lic:txn:")
                                 永远匹配不到 —— 那会让下面的 TTL 断言变成
                                 「对空串测试」的恒真断言，白写。 */

async function fakeFetch(url, opts) {
  const u = String(url);
  const setMatch = u.match(/\/set\/(.+?)(\?|$)/);
  const getMatch = u.match(/\/get\/(.+?)(\?|$)/);
  const key = decodeURIComponent((setMatch || getMatch || [])[1] || "");
  if (setMatch) {
    STORE.set(key, opts.body);
    SET_URLS.push({ key, url: u });
    return { status: 200, json: async () => ({ result: "OK" }) };
  }
  if (getMatch) {
    const v = STORE.get(key);
    return { json: async () => ({ result: v === undefined ? null : v }) };
  }
  return { status: 404, json: async () => ({}) };
}

process.env.KV_REST_API_URL = KV_BASE;
process.env.KV_REST_API_TOKEN = "test_token";
process.env.LICENSE_ENV = "testenv";

const src = readFileSync(new URL("../api/_shared.js", import.meta.url), "utf8");
const mod = { exports: {} };
vm.runInNewContext(src, {
  module: mod, exports: mod.exports, require, console, process,
  crypto: { createHash, createHmac },
  Buffer,
  fetch: fakeFetch,
});
const S = mod.exports;

/* ── 迷你断言 ── */
let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`    ✅ ${name}`); }
  else { fail++; console.log(`    ❌ ${name}\n         期望 ${JSON.stringify(expected)}\n         实际 ${JSON.stringify(actual)}`); }
}

console.log("\n  ── PayPal：订单号 → 交易号 ──");
/* PayPal 的 order_id 不是 txn_ 前缀，要包一层，否则 verifyCode 的
   /^(...):(txn_.+|ch_.+)$/ 匹配不上—— 与 ch_/che_ 那个 bug 同类：
   前缀错了，钱付了但码激活不了。 */
check("包成 txn_paypal_ 前缀（verifyCode 才认得）",
  S.paypalTxnId("5O190127TN364715T"), "txn_paypal_5O190127TN364715T");
check("包出来的号能过 verifyCode 的形状校验",
  /^[A-Z0-9]{2,4}:(txn_.+|ch_.+)$/.test("MD:" + S.paypalTxnId("5O190127TN364715T")), true);

console.log("\n  ── PayPal：退款事件取订单号 ──");
check("从 supplementary_data.related_ids.order_id 取",
  S.paypalOrderIdFromEvent({
    event_type: "PAYMENT.CAPTURE.REFUNDED",
    resource: { supplementary_data: { related_ids: { order_id: "5O190127TN364715T" } } },
  }), "5O190127TN364715T");
check("取不到时返回空串（由调用方走 REVOKE-NEEDED 人工）",
  S.paypalOrderIdFromEvent({ event_type: "PAYMENT.CAPTURE.REFUNDED", resource: {} }), "");
check("resource 整个缺失也不能炸",
  S.paypalOrderIdFromEvent({}), "");
check("null 传入不炸",
  S.paypalOrderIdFromEvent(null), "");

console.log("\n  ── PayPal：哪些事件算撤权 ──");
check("REFUNDED 算", S.isPayPalRefundEvent({ event_type: "PAYMENT.CAPTURE.REFUNDED" }), true);
check("REVERSED 算", S.isPayPalRefundEvent({ event_type: "PAYMENT.CAPTURE.REVERSED" }), true);
check("COMPLETED 不算（那是收款，不是退款）",
  S.isPayPalRefundEvent({ event_type: "PAYMENT.CAPTURE.COMPLETED" }), false);

console.log("\n  ── 通用：isRevocationEvent 的关键词判定 ──");
/* 用关键词而非枚举事件名：平台会加新事件，但「钱退回去」就那几种说法。 */
for (const t of ["refund.created", "chargeback.opened", "transaction.credited", "payment.reversed", "subscription.canceled", "dispute.created"]) {
  check(`${t} 判为撤权`, S.isRevocationEvent({ event_type: t }), true);
}
/* dispute 是 Creem 的拒付事件名（PayPal 叫 chargeback）。漏了它，
   Creem 争议单进来就不撤权 —— 买家拒付后码照样能用。 */
check("dispute 关键词在表里（否则 Creem 拒付不撤权）",
  /dispute/i.test(readFileSync(new URL("../api/_shared.js", import.meta.url), "utf8")), true);
check("checkout.completed 不判为撤权（刚付款）",
  S.isRevocationEvent({ event_type: "checkout.completed" }), false);
/* transaction.updated 是状态变化，只有落到「已退/已拒付」才算 —— */
check("transaction.updated + status=REFUNDED 算",
  S.isRevocationEvent({ event_type: "transaction.updated", data: { status: "REFUNDED" } }), true);
check("transaction.updated + status=ACTIVE 不算",
  S.isRevocationEvent({ event_type: "transaction.updated", data: { status: "ACTIVE" } }), false);
check("空事件不炸", S.isRevocationEvent(null), false);

console.log("\n  ── KV 往返：撤权标记 ──");
const TXN = "ch_myvFOeESRIaAiwTzY6EZb";

/* 付了钱的人绝不能被判作废 —— 这是最不能错的方向。 */
check("未撤权的交易 isRevoked=false", await S.isRevoked(TXN), false);

await S.markRevoked(TXN, "PAYMENT.CAPTURE.REFUNDED");
check("撤权后 isRevoked=true", await S.isRevoked(TXN), true);
check("键名带环境前缀与 revoked: 前缀",
  [...STORE.keys()].find(k => k.includes("revoked:")), `testenv:revoked:${TXN}`);
check("存的理由是事件类型（便于日后审计）",
  STORE.get(`testenv:revoked:${TXN}`), "PAYMENT.CAPTURE.REFUNDED");
/* 退款永久有效，不能带 TTL 过期 —— 否则过期后授权复活。
   注意：不能断言「markRevoked 返回 200」来测这条 —— kvSet 返回的是
   r.status，加不加 TTL 都是 200，那是个**恒真断言**（写了等于没写）。
   变异测试验证过：给 kvSet 加上 60s TTL 后旧断言照样全绿。
   TTL 只体现在请求 URL 的 ?ex= 上，所以这里直接看 URL。 */
const ttlUrl = (SET_URLS.filter(w => w.key.includes("revoked:")).pop() || {}).url || "";
check("撤权标记不设 TTL（退款永久有效）", /[?&]ex=/.test(ttlUrl), false);
/* 对照组：铸码那条**必须**带 TTL（一年）。没这条，上一条就成了
   「URL 里从来没有 ?ex=」的恒真断言，跟没测一样。
   storeLicenseCode 内部要用 LICENSE_SECRET 铸码，所以这里必须设。 */
process.env.LICENSE_SECRET = "test_license_secret";
await S.storeLicenseCode("MD", TXN);
check("对照组：铸码那条确实带 TTL（一年）",
  /[?&]ex=31536000/.test((SET_URLS.filter(w => w.key.includes("lic:txn:")).pop() || {}).url || ""), true);

check("空 txnId 不写库（防误撤权一切）", await S.markRevoked("", "x"), 0);
check("空 txnId 不读库", await S.isRevoked(""), false);
check("未撤权的另一笔不受影响", await S.isRevoked("ch_someone_else"), false);

console.log("\n  ── 端到端：铸码 → 撤权 ──");
const SECRET = "test_secret";
const code = S.makeCode("MD", TXN, SECRET);
check("撤权前 码能验过", !!S.verifyCode(code, SECRET), true);
await S.markRevoked(TXN, "refund.created");
check("撤权后 码本身仍能验（签名没坏，是 isRevoked 单独判）",
  !!S.verifyCode(code, SECRET), true);
check("但 isRevoked 拦住了", await S.isRevoked(TXN), true);
check("换个 secret 验不过", !!S.verifyCode(code, "wrong"), false);

console.log(`\n  ${fail === 0 ? "✅ 全部通过" : "❌ 有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);