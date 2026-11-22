/* 用真实签名算法验 verifyCreemRedirect —— 这是安全核心，
   必须测「顺序敏感」与「空值排除」两个文档点名的坑。 */
import { createHash, createHmac } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import vm from "node:vm";

const API_KEY = "test_api_key_123";
const src = readFileSync(new URL("../api/_shared.js", import.meta.url), "utf8");
const mod = { exports: {} };
vm.runInNewContext(src, {
  module: mod, exports: mod.exports, require, console, process,
  crypto: { createHash, createHmac },
  Buffer,
  fetch: async () => ({ json: async () => ({}) }),
});
const S = mod.exports;

function sign(params, key) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) sp.append(k, v);
  const parts = [];
  sp.forEach((v, k) => { if (k !== "signature" && v !== "" && v != null) parts.push(`${k}=${v}`); });
  parts.push(`salt=${key}`);
  sp.set("signature", createHash("sha256").update(parts.join("|")).digest("hex"));
  return sp;
}

let fail = 0;
const check = (n, ok) => { if (!ok) fail++; console.log(`  ${ok ? "✅" : "❌"} ${n}`); };

console.log("\n  ── 正常路径 ──");
let sp = sign({ checkout_id: "ch_abc", order_id: "ord_xyz", customer_id: "cust_1",
                subscription_id: "", product_id: "prod_29kyJdztcwhkCkI6eoXvCe" }, API_KEY);
check("签名正确时通过", S.verifyCreemRedirect(sp, API_KEY) === true);

console.log("\n  ── 必须拒的 ──");
check("错 API key 被拒", S.verifyCreemRedirect(sp, "wrong_key") === false);
check("无签名参数被拒", S.verifyCreemRedirect(new URLSearchParams({ checkout_id: "ch_abc" }), API_KEY) === false);
check("空 API key 被拒", S.verifyCreemRedirect(sp, "") === false);

console.log("\n  ── 文档点名的两个坑 ──");
// 坑1：顺序敏感 —— 把 product_id 挪到 checkout_id 前面，签名应失效
/* 把 checkout_id 挪到最后 —— 真正的顺序改变。
   （上一版把 product_id「挪到末尾」，而它本来就在末尾，等于没改，
     测试通过了但什么都没验 —— 顺序敏感这条必须真的改到顺序。） */
const reordered = new URLSearchParams();
const sig = sp.get("signature");
const rest = [...sp.entries()].filter(([k]) => k !== "signature");
const ci = rest.findIndex(([k]) => k === "checkout_id");
const [checkoutPair] = rest.splice(ci, 1);
for (const [k, v] of [...rest, checkoutPair]) reordered.append(k, v);
reordered.append("signature", sig);
const joined = (u) => { const p = []; u.forEach((v, k) => { if (k !== "signature" && v) p.push(`${k}=${v}`); }); p.push(`salt=${API_KEY}`); return p.join("|"); };
if (joined(reordered) === joined(sp)) throw new Error("测试无效：顺序其实没变");
check("参数顺序被改 → 验签失败", S.verifyCreemRedirect(reordered, API_KEY) === false);

// 坑2：空值必须排除 —— 若把空 subscription_id 塞进签名串，应失败
const withEmpty = new URLSearchParams();
withEmpty.append("checkout_id", "ch_abc");
withEmpty.append("subscription_id", "null");   // 错误写法
withEmpty.append("product_id", "prod_29kyJdztcwhkCkI6eoXvCe");
withEmpty.append("signature", sp.get("signature"));
check("空值被写成 'null' → 验签失败", S.verifyCreemRedirect(withEmpty, API_KEY) === false);

console.log("\n  ── 取码辅助 ──");
check("creemTxnId 取 checkout_id", S.creemTxnId(sp) === "ch_abc");
check("目录反查 prod→PD", S.creemProductCode("prod_29kyJdztcwhkCkI6eoXvCe") === "PD");
check("目录反查未知 → null", S.creemProductCode("prod_XXXX") === null);
check("目录含 10 行", Object.keys(S.CATALOG).length === 10);
check("每个产品都有 creem id", Object.values(S.CATALOG).every(r => r.creem));

/* ── 铸码 → 验码 往返 ──
   /api/license 用 makeCode 出码，应用激活时 /api/activate 用 verifyCode 验码。
   两者必须对**每个渠道真实的交易号形状**都自洽。曾经 verifyCode 只认 che_，
   而 Creem 的 checkout_id 是 ch_ —— 结果付款后拿到的码一律被判无效。 */
console.log("\n  ── 铸码/验码往返（各渠道真实形状）──");
const SECRET = "test_secret_abc";
const roundtrip = (label, txn) => {
  const code = S.makeCode("MD", txn, SECRET);
  const v = S.verifyCode(code, SECRET);
  check(`${label} (${txn}) 能验过`, !!v && v.txnId === txn && v.productCode === "MD");
};
roundtrip("Creem checkout_id", "ch_myvFOeESRIaAiwTzY6EZb");
roundtrip("Paddle txn_id", "txn_01m2r4beys0tv7p1xa9t1zb5x1");
roundtrip("PayPal order_id", S.paypalTxnId("5O190127TN364715T"));
check("换一个 secret 就验不过", S.verifyCode(S.makeCode("MD", "ch_abc", SECRET), "other_secret") === null);

console.log(fail === 0 ? "\n  ✅ 全部通过\n" : `\n  ❌ ${fail} 条不符\n`);
process.exit(fail ? 1 : 0);
