/* api/devices.js 的测试。
 *
   重点在一件事：**一张码能不能被无限复制。**
   在 devices.js 之前，`/api/activate` 验完签名就签发回执、不写任何状态，
   所以一张码可以在任意多台机器上激活 —— 这比试用重置严重得多
   （试用重置是多白嫖 7 天，码共享是一份钱服务所有人）。
 *
   与 test-creem-webhook.mjs / test-revocation.mjs 的分工：那两个测「撤权」，
   这里测「设备上限」，两者是不同的失效方向。

   KV 顶在 fetch 上（而不是直接 mock 模块函数），这样
   `recordActivation → kvSet` 这条**真实路径**会被走到，
   断言的是「真的写进了 KV」，不是「函数被调用了」。
   这是本仓已有的测试手法，照抄。 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const apiRequire = createRequire(new URL("../api/_shared.js", import.meta.url));

/* ── 内存 KV ── */
const KV = new Map();
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

/* ── 加载 devices.js（它 require _shared.js，用真的那份，KV 顶替已生效）── */
const src = readFileSync(new URL("../api/devices.js", import.meta.url), "utf8");
const mod = { exports: {} };
vm.runInNewContext(src, {
  module: mod, exports: mod.exports, require: apiRequire, console,
  process: { env: process.env },
  JSON, Math, Date, Array, Object, String, Number,
});
const D = mod.exports;

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`    ✅ ${name}`); }
  else { fail++; console.log(`    ❌ ${name}\n         期望 ${JSON.stringify(expected)}\n         实际 ${JSON.stringify(actual)}`); }
}
const TXN = "ch_test_1";

console.log("\n  ── 上限：第 N+1 台必须被拒 ──");

/* 逐台激活，直到超过上限 */
for (let i = 1; i <= D.MAX_DEVICES; i++) {
  const r = await D.recordActivation(TXN, `fp-machine-${i}`, "Windows 11");
  check(`第 ${i} 台激活成功`, r.ok, true);
}
const over = await D.recordActivation(TXN, "fp-machine-4", "Windows 11");
check(`第 ${D.MAX_DEVICES + 1} 台被拒`, over.ok, false);
check("拒绝原因是 limit", over.reason, "limit");
check("拒绝时返回当前设备数供展示", over.current.length, D.MAX_DEVICES);

/* ── 关键：同一台机器重复激活不占新名额 ──
   否则用户重装一次就吃掉一个名额，重装两次就打不开了。 */
console.log("\n  ── 幂等：同一台机器重复激活不重复计数 ──");
const again = await D.recordActivation(TXN, "fp-machine-1", "Windows 11");
check("已激活的机器重输码仍成功", again.ok, true);
check("但不增加名额", again.counted, false);
const listAfterDup = await D.getActivations(TXN);
check("设备列表仍是 3 台", listAfterDup.length, D.MAX_DEVICES);

/* ── 解绑：这是"重装系统后还能用"的实现路径 ── */
console.log("\n  ── 解绑：腾出名额 ──");
const rel = await D.releaseDevice(TXN, "fp-machine-2");
check("解绑指定设备成功", rel.ok, true);
check("被解绑的是目标设备", rel.removed.fp, "fp-machine-2");
check("剩余 2 台", rel.remaining, D.MAX_DEVICES - 1);

const afterFree = await D.recordActivation(TXN, "fp-machine-4", "Windows 11");
check("腾出名额后新设备可激活", afterFree.ok, true);
check("并占用了一个名额", afterFree.counted, true);

/* ── 指纹对不上时解绑最早的一台 ──
   场景：用户换了机器 / 指纹变了，手上没有原机器的指纹，但仍要恢复可用。 */
console.log("\n  ── 指纹对不上 → 解绑最早的一台 ──");
const before = await D.getActivations(TXN);
const oldestFp = before.slice().sort((a, b) => (a.at || 0) - (b.at || 0))[0].fp;
const relNoFp = await D.releaseDevice(TXN, "fp-does-not-exist");
check("无匹配指纹也能解绑", relNoFp.ok, true);
check("解绑的是最早激活的那台", relNoFp.removed.fp, oldestFp);

/* ── 空指纹：取不到指纹时不计数、不拦激活 ──
   指纹取不到无法区分设备，计数只会误伤付费用户。 */
console.log("\n  ── 空指纹不计数也不拦 ──");
const TXN2 = "ch_test_2";
for (let i = 1; i <= 10; i++) {
  const r = await D.recordActivation(TXN2, "", "Linux");
  check(`第 ${i} 次空指纹激活放行`, r.ok, true);
}
check("空指纹从未占用名额", (await D.getActivations(TXN2)).length, 0);

/* ── 不同交易号互不影响 ── */
console.log("\n  ── 记账按交易号隔离 ──");
const TXN3 = "ch_test_3";
for (let i = 1; i <= D.MAX_DEVICES; i++) {
  await D.recordActivation(TXN3, `fp-other-${i}`, "macOS");
}
check("A 的满额不影响 B", (await D.recordActivation(TXN3, "fp-other-x", "macOS")).ok, false);
/* 注意这里断言的是「B 的操作没有写坏 A」，而不是某个绝对数字 ——
   上一节刚解绑过 A 的一台（那是被测行为），写死 3 会让本节依赖执行顺序。
   断言应只覆盖本节要证明的事：隔离。 */
const aAfter = await D.getActivations(TXN);
check("A 的记录仍可读且未被 B 覆盖", aAfter.length > 0, true);
check("A 里的指纹都不是 B 的机器", aAfter.every((d) => !String(d.fp).startsWith("fp-other")), true);
check("B 的记录只含 B 的机器",
  (await D.getActivations(TXN3)).every((d) => String(d.fp).startsWith("fp-other")), true);

/* ── KV 损坏：读不出来当空列表，不让所有激活失败 ── */
console.log("\n  ── KV 损坏时的方向 ──");
const TXN4 = "ch_test_4";
KV.set("testenv:lic:dev:" + TXN4, "{ this is not json");
const corrupt = await D.recordActivation(TXN4, "fp-after-corrupt", "Windows");
check("损坏记录不阻断激活（fail open）", corrupt.ok, true);
check("且重新写入了干净记录", (await D.getActivations(TXN4)).length, 1);

/* ── KV 写失败：放行而非拒绝 ──
   这是有意识的取舍，不是疏漏：KV 故障时若一律拒绝，所有已付款用户会在
   服务端抖动时被打不开。前者伤付费用户，后者只损失一点收入。
   代价是「KV 故障期间上限暂时失效」—— 已写进 devices.js 的模块说明。

   **这条必须有测试**：上一轮变异测试发现「改为拒绝」不会被任何断言抓到，
   说明当时根本没测这条路径 —— 而它恰恰是注释里解释得最多的取舍。 */
console.log("\n  ── KV 写失败时的方向 ──");
{
  const realFetchBackup = globalThis.fetch;
  /* 让 /set/ 一律失败，/get/ 仍正常 —— 模拟"读得到、写不进"。 */
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("/set/")) return { status: 500, json: async () => ({ result: null }) };
    return realFetchBackup(url, opts);
  };
  const r = await D.recordActivation("ch_kv_down", "fp-during-outage", "Windows");
  check("KV 写失败仍放行（不把付费用户锁在门外）", r.ok, true);
  check("并标记为未计数", r.counted, false);
  check("且标记出是存储故障", r.storageFailed, true);
  globalThis.fetch = realFetchBackup;
}

console.log("\n  ── 零设备时解绑 ──");
const relNone = await D.releaseDevice("ch_never_activated", "fp-x");
check("未激活过的码解绑返回 none", relNone.reason, "none");

console.log(`\n  ${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed\n`);
globalThis.fetch = realFetch;
process.exit(fail === 0 ? 0 : 1);