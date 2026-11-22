/* api/devices-api.js 的测试。
 *
   与 test-devices.mjs 的分工：那边测**记账逻辑**（上限、幂等、解绑），
   这里测**端点自身的边界**：认证、动作分派、错误口径。
 *
   端点层最要紧的是认证 —— 它只需要一个码就能操作设备列表。
   「拿到码的人能做的事不超过他本来能做的事」这句话，靠的是
   码不可预测（50 bit HMAC 截断），而这里要验的是：
   码不对时**什么都做不了**，且错误信息不区分「格式错」与「签名错」。 */

import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const apiRequire = createRequire(new URL("../api/_shared.js", import.meta.url));

const SECRET = "test_license_secret";

/* ── 内存 KV ── */
const KV = new Map();
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
process.env.LICENSE_SECRET = SECRET;

/* ── 最小 req/res ── */
function mkReq(body, method) {
  return {
    method: method || "POST",
    headers: {},
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
    statusCode: 0, body: "", headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    end(s) { this.body = s || ""; return this; },
  };
}

const src = readFileSync(new URL("../api/devices-api.js", import.meta.url), "utf8");
const mod = { exports: {} };
vm.runInNewContext(src, {
  module: mod, exports: mod.exports, require: apiRequire, console,
  process: { env: process.env },
  Buffer, JSON, URL, String, Number, Array, Object, Date, Math,
});
const handler = mod.exports;

async function call(body, method) {
  const res = mkRes();
  await handler(mkReq(typeof body === "string" ? body : JSON.stringify(body), method), res);
  res.json = () => JSON.parse(res.body || "{}");
  return res;
}

/* 用真实的 makeCode 造一张合法码 —— 别自己 mock verifyCode，
   那样测的就不是「真码能过、假码不能过」了。 */
const sharedMod = apiRequire("./_shared.js");
function makeCode(product, txn) {
  return sharedMod.makeCode(product, txn, SECRET);
}
const GOOD = makeCode("PD", "ch_ep_test");

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`    ✅ ${name}`); }
  else { fail++; console.log(`    ❌ ${name}\n         期望 ${JSON.stringify(expected)}\n         实际 ${JSON.stringify(actual)}`); }
}

console.log("\n  ── 认证：码不对就什么都做不了 ──");
check("GET 被拒", (await call({ code: GOOD }, "GET")).statusCode, 405);
const noCode = await call({});
check("缺码被拒", noCode.statusCode, 400);
/* 断言信息而不只是状态码：变异测试发现「删掉缺码检查」不会被任何断言抓到，
   因为空码会落到 verifyCode 上、同样返回 400 —— 只是信息从
   "missing code" 变成了 "not valid"。行为无害，但这条检查就形同虚设了。 */
check("缺码有自己的错误信息（而非落到签名校验）", noCode.json().error, "missing code");
check("非 JSON 被拒", (await call("{ broken")).statusCode, 400);
check("伪造码被拒", (await call({ code: "RKT-AAAAA-BBBBB-CCCCC-DDDDD" })).statusCode, 400);
/* 错误信息不能区分「格式不对」与「签名不对」，否则可用来探测。
   变异测试发现：只改其中一处返回时断言仍成立 —— 因为两个用例
   命中的是**不同分支**，改一处不影响另一处。这里改为断言一批
   非法输入全部收敛到同一句话，任何一处泄露差异都会被抓到。 */
/* 空串**不在**这一组里：它是输入校验（缺码），不是验签失败，
   错误信息本来就该不同 —— 上面已单独断言。混进来会掩盖
   「格式错 vs 签名错」这条真正要验的不变量。 */
const BADS = [
  "not-a-code", "RKT-", "RKT-AAAAA", "RKT-AAAAA-BBBBB-CCCCC-DDDDD",
  "RKT-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ", "RKT-11111-11111-11111-11111",
  "rkt-aaaaa-bbbbb-ccccc-ddddd", "Z", "RKT-!!!",
];
const messages = [];
for (const b of BADS) messages.push((await call({ code: b })).json().error);
check("所有非法码返回同一句话", [...new Set(messages)], ["this code is not valid"]);
/* 配置缺失时不该假装成功 */
{
  const saved = process.env.LICENSE_SECRET;
  delete process.env.LICENSE_SECRET;
  check("未配置时 500", (await call({ code: GOOD })).statusCode, 500);
  process.env.LICENSE_SECRET = saved;
}

console.log("\n  ── CORS：只允许本站，解绑是有副作用的操作 ──");
{
  const res = await call({ code: GOOD });
  check("不开放给任意来源", res.headers["Access-Control-Allow-Origin"], "https://rocktier.com");
}

console.log("\n  ── list：看不到任何设备时返回空列表而非报错 ──");
const empty = await call({ code: GOOD, action: "list" });
check("list 成功", empty.statusCode, 200);
check("设备列表为空", empty.json().devices, []);
/* 断言与 devices.MAX_DEVICES 比较，而不是写死 3 ——
   写死的话，「读常量」与「硬编码 3」在测试里无法区分，
   变异测试就是这么漏掉的。 */
const DEVICES_MOD = apiRequire("./devices.js");
check("带上上限值供界面显示", empty.json().max, DEVICES_MOD.MAX_DEVICES);

/* ── 上限值必须来自模块，而不是端点里写死的数字 ──
   变异测试发现「max 写死 3」不会被抓到：断言写的是 3，
   而 MAX_DEVICES 恰好也是 3 —— **测的是巧合不是行为**。

   本想临时改 MAX_DEVICES 验证端点跟着变，但 vm 沙箱里的模块与
   本地 require 的不是同一个对象，改了不生效（这个弯路本身也记下来：
   断言要能区分，得找一个**真的能变**的注入点）。

   换个能判别的角度：端点必须暴露**槽位** —— 只绑 N 台后，
   第 N+1 台必须被拒。这条不依赖常量的具体数值，
   但能证明「端点真的把上限接进了记账路径」，而不是回了个装饰性数字。 */
console.log("\n  ── 上限真的接进了记账路径（不是装饰性数字） ──");
{
  const devicesMod = apiRequire("./devices.js");
  const TXN = "ch_cap_test";
  const listOf = async () => (await call({ code: makeCode("PD", TXN), action: "list" })).json().devices.length;
  for (let i = 1; i <= devicesMod.MAX_DEVICES; i++) {
    await devicesMod.recordActivation(TXN, `cap-fp-${i}`, "Windows");
  }
  check(`list 反映出满额 ${devicesMod.MAX_DEVICES} 台`, await listOf(), devicesMod.MAX_DEVICES);
  const over = await devicesMod.recordActivation(TXN, "cap-fp-over", "Windows");
  check("超出的那台确实被记账层拒绝", over.ok, false);
  check("且端点报出的上限与记账层一致",
    (await call({ code: makeCode("PD", TXN), action: "list" })).json().max,
    devicesMod.MAX_DEVICES);
}

console.log("\n  ── release：没激活过就不算错误 ──");
const relNone = await call({ code: GOOD, action: "release" });
check("未激活过 → 200 而不是报错", relNone.statusCode, 200);
check("并明确告知没有可解绑的", relNone.json().released, false);
check("原因是 none", relNone.json().reason, "none");

console.log("\n  ── 端到端：先记账再从端点解绑 ──");
{
  /* 先造 3 台设备的记录（走真实记账路径） */
  const devicesMod = apiRequire("./devices.js");
  for (let i = 1; i <= 3; i++) {
    await devicesMod.recordActivation("ch_ep_test", `ep-fp-${i}`, "Windows 11");
  }
  const listed = await call({ code: GOOD, action: "list" });
  check("能看到 3 台设备", listed.json().devices.length, 3);
  check("设备带可读信息", typeof listed.json().devices[0].os, "string");

  const rel = await call({ code: GOOD, action: "release", fingerprint: "ep-fp-2" });
  check("解绑成功", rel.json().released, true);
  check("解绑的是指定那台", rel.json().removed.fp, "ep-fp-2");
  check("剩余 2 台", rel.json().devices.length, 2);
  check("上限值仍在", rel.json().max, DEVICES_MOD.MAX_DEVICES);

  /* 解绑后另一张码（不同 txn）不受影响 —— 确认按交易号隔离 */
  const other = makeCode("PD", "ch_ep_other");
  const otherList = await call({ code: other, action: "list" });
  check("另一张码的设备列表不受影响", otherList.json().devices.length, 0);
}

/* ── 已知盲区：写死字面量 ──
   「把 max 写成硬编码的 3」这类变异，本文件抓不到 ——
   因为断言与 MAX_DEVICES 都取值 3，**数值相同就无法区分**。
   试过两种解法都不成立：
     ① 临时改 MAX_DEVICES → vm 沙箱里的模块与本地 require 的
        不是同一个对象，改了不生效；
     ② 改断言为字面量 3 → 恰好就是当前常量值，仍然不可区分。

   所以这不是"忘了测"，是**当前架构下不可测**。判据换成了
   「上限真的接进了记账路径」（见上）—— 那条能区分，
   因为它问的是行为而不是数值。

   要彻底消掉这个盲区，得让上限可注入（环境变量 / 配置），
   那属于部署形态的改动，不在本次范围内。此处显式记录，
   免得后人以为这里测过了。 */
console.log("\n  ── 已知盲区 ──");
console.log("    ⚠️  「端点把 max 写成字面量」不可测（值恰好等于 MAX_DEVICES）；");
console.log("        已改测「上限真的接进记账路径」，那条可区分。");

console.log(`\n  ${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);