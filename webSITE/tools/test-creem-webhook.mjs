/* api/creem-webhook.js 的测试。

   重点不在「能不能跑通」，在**未验签的报文会不会被当成已授权处理**。
   这是一个公开可 POST 的端点，验签一旦漏掉，攻击者能凭空作废任意
   用户的授权（ Denial of service 到所有付费用户）。所以这里的断言
   全部围绕「拒绝优先」。

   与 test-revocation.mjs 的分工：那边测被调用的函数（isRevocationEvent /
   markRevoked），这边测**端点自己的逻辑**（验签、事件分发、取号）。
   两边都必要 —— 端点里若有逻辑没被任一边覆盖，就是裸奔。 */

import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const require = createRequire(import.meta.url);

const API_KEY = "test_creem_api_key";

/* ── 最小 req/res ── */
function mkReq(body, headers) {
  return {
    method: "POST",
    headers: headers || {},
    on(ev, cb) {
      if (ev === "data") cb(Buffer.from(body));
      if (ev === "end") cb();
      if (ev === "error") cb();
      return this;
    },
  };
}
function mkRes() {
  return {
    statusCode: 0, body: "",
    end(s) { this.body = s || ""; return this; },
  };
}
function sign(body) {
  return { "creem-signature": createHmac("sha256", API_KEY).update(body).digest("hex") };
}

/* KV 顶替：记录写了什么键，用来断言「撤权写到了正确的键」。
   顶在 fetch 上，因为 _shared.js 的 kvSet/kvGet 是直接调 Upstash REST。 */
const KV = new Map();
const apiRequire = createRequire(new URL("../api/_shared.js", import.meta.url));
/* 把 fetch 顶成内存 KV，这样 markRevoked → kvSet 这条真实路径会被走到，
   断言的是「真的写了 revoked 键」，不是「函数被调用了」。 */
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const set = u.match(/\/set\/(.+?)(\?|$)/);
  const get = u.match(/\/get\/(.+?)(\?|$)/);
  const key = decodeURIComponent((set || get || [])[1] || "");
  if (set) { KV.set(key, opts.body); return { status: 200, json: async () => ({ result: "OK" }) }; }
  if (get) return { json: async () => ({ result: KV.has(key) ? KV.get(key) : null }) };
  return { status: 404, json: async () => ({}) };
};
process.env.KV_REST_API_URL = "https://fake-kv.test";
process.env.KV_REST_API_TOKEN = "t";
process.env.LICENSE_ENV = "testenv";

const src = readFileSync(new URL("../api/creem-webhook.js", import.meta.url), "utf8");
const mod = { exports: {} };
vm.runInNewContext(src, {
  module: mod, exports: mod.exports, require: apiRequire, console,
  process: { env: { CREEM_API_KEY: API_KEY, LICENSE_ENV: "testenv" } },
  Buffer,
});
const handler = mod.exports;

async function call(body, headers) {
  const res = mkRes();
  await handler(mkReq(body, headers), res);
  return res;
}

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`    ✅ ${name}`); }
  else { fail++; console.log(`    ❌ ${name}\n         期望 ${JSON.stringify(expected)}\n         实际 ${JSON.stringify(actual)}`); }
}

console.log("\n  ── 拒绝优先：未验签的报文绝不能被处理 ──");

const refundBody = JSON.stringify({
  event_type: "refund.created",
  resource: { id: "ch_victim", checkout_id: "ch_victim" },
});
/* 这条最重要：签名错却返回 200，等于任何人退款都能作废全站授权。 */
check("无签名 → 401", (await call(refundBody, {})).statusCode, 401);
check("无签名 → 不写 KV", KV.size, 0);

const wrong = JSON.stringify({ event_type: "refund.created", resource: { id: "ch_x" } });
check("错签名 → 401", (await call(wrong, { "creem-signature": "deadbeef" })).statusCode, 401);
check("错签名 → 不写 KV", KV.size, 0);

check("篡改报文（签名对不上）→ 401",
  (await call(refundBody, sign(wrong))).statusCode, 401);

console.log("\n  ── 签名格式 ──");
check("合法签名 → 200", (await call(refundBody, sign(refundBody))).statusCode, 200);
check("带 sha256= 前缀也接受",
  (await call(refundBody, { "creem-signature": "sha256=" + createHmac("sha256", API_KEY).update(refundBody).digest("hex") })).statusCode, 200);
check("body 大小写不同 → 签名不同 → 401",
  (await call(refundBody.toUpperCase(), sign(refundBody))).statusCode, 401);
check("空签名 → 401", (await call(refundBody, { "creem-signature": "" })).statusCode, 401);

console.log("\n  ── 撤权：事件 → KV 键 ──");
KV.clear();
await call(refundBody, sign(refundBody));
check("refund.created 写到了 revoked 键",
  [...KV.keys()], ["testenv:revoked:ch_victim"]);
check("存的理由是事件类型", KV.get("testenv:revoked:ch_victim"), "refund.created");

for (const t of ["refund.created", "dispute.created", "chargeback.opened"]) {
  KV.clear();
  const b = JSON.stringify({ event_type: t, resource: { id: "ch_a", checkout_id: "ch_a" } });
  await call(b, sign(b));
  check(`${t} 也作废`, [...KV.keys()], ["testenv:revoked:ch_a"]);
}

console.log("\n  ── 不该撤权的事件 ──");
KV.clear();
const done = JSON.stringify({ event_type: "checkout.completed", resource: { id: "ch_ok", checkout_id: "ch_ok" } });
const r = await call(done, sign(done));
check("checkout.completed → 200", r.statusCode, 200);
check("但**不**写撤销键（铸码走回跳，不在这里重复铸）", KV.size, 0);

console.log("\n  ── 取不到 checkout id → 不静默放过 ──");
KV.clear();
const noId = JSON.stringify({ event_type: "refund.created", resource: { id: "refund_abc" } });
const r2 = await call(noId, sign(noId));
check("取不到号仍回 200（签名有效，不重试）", r2.statusCode, 200);
check("但也不能写一个空键（否则作废一切）", KV.size, 0);

console.log("\n  ── 畸形输入 ──");
const bad = "not json";
check("坏 JSON → 400", (await call(bad, sign(bad))).statusCode, 400);
check("JSON null → 400",
  (await call("null", sign("null"))).statusCode, 400);
check("JSON 数组 → 400",
  (await call("[]", sign("[]"))).statusCode, 400);

const getRes = mkRes();
await handler({ method: "GET", headers: {}, on() { return this; } }, getRes);
check("GET → 405", getRes.statusCode, 405);

console.log(`\n  ${fail === 0 ? "✅ 全部通过" : "❌ 有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);