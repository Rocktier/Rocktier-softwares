/* 设备激活记账 —— 让「一张码只服务有限台机器」真正成立。
 *
 * ── 为什么需要 ──
 *
 * 现状：`/api/activate` 验完 HMAC 就签发回执，**不写任何状态**
 * （`kvSet` 出现 0 次）。回执是 Ed25519 签名、客户端永久离线验签。
 *
 * 于是今天的实际状况：
 *   - 一张码在 10 台电脑上激活 → 全部成功，服务端毫无记录
 *   - 码发到论坛/群里转卖     → 无限次可用
 *   - 退款后对方已激活         → 撤不掉
 *
 * 第一条就是「一份钱无限用」。这是比试用重置严重一个量级的问题：
 * 试用重置是「多白嫖 7 天」，码共享是「一份钱服务所有人」。
 *
 * ── 模型：Adobe 的做法，不是 Office 的 ──
 *
 * 业界实测：
 *   Adobe CC        2 台，同时只能用 1 台，超限时在网页远程踢旧设备
 *   Microsoft 365    5 桌面 + 5 平板 + 5 手机，自动踢最少使用的设备
 *   LicenseSpring   Max Activations（同时上限）+ Transfer Count（转移次数）
 *
 * Office 365 的 5+5+5 依赖**账号体系**：Entra ID 登录、服务端知道每个账号
 * 名下有哪些设备。我们没有账号（无登录页、无 auth API），而 Creem 给的
 * email 是**付款邮箱**—— 可能是家庭共享、用户可能换邮箱，把它当身份会误伤。
 *
 * 所以采用 Adobe 模型：**同时有效设备数有上限 + 凭购买凭证自助解绑**。
 * 它约束的是「同时有效」而非「历史激活次数」—— 这正是「重装系统后还能用」
 * 能成立的原因：旧设备解绑后，新设备即可绑定。
 *
 * 将来真做移动端，是**加一个设备类型字段**（desktop/tablet/mobile），
 * 不是重写 —— 这就是为什么现在就把结构建成同构的。
 *
 * ── 数据结构 ──
 *
 *   <env>:lic:dev:<txnId>  →  JSON 数组，每项 { fp, at, os }
 *
 * 用 JSON 数组而不是 Redis Set：`kvGet`/`kvSet` 是仅有的两个原语，
 * Set 需要额外封装。数组的代价是并发下可能丢一次写入（两个请求同时
 * 读到旧值、各自写入，后者覆盖前者）—— 见下面的取舍说明。
 *
 * ── 并发取舍：为什么不用 SCARD/SADD ──
 *
 * Upstash 确实支持原子命令（`SADD`/`SCARD`/`LPUSH`），原子加更严谨。
 * 这次仍然用读-改-写，理由：
 *
 *   1. **并发激活同一张码是低频事件。** 正常用户装好就激活，不会并发。
 *      真正并发的场景是转卖者批量刷——而那正是我们要拦的，
 *      丢一次写入只让他多占一个名额，不影响「N 台」这个上限的有效性。
 *   2. `kvSet` 已封装、已在生产跑；引入 Set 需要新增原语 + 新测试面，
 *      收益（把「多占一个名额」的窗口关掉）不抵成本。
 *
 * 但这是**有意识的取舍，不是疏漏**：一旦将来出现并发滥用证据，
 * 换成 Set 是一次局部改动（只动 `recordActivation`）。
 *
 * ── 指纹取不到时怎么办 ──
 *
 * 客户端可能上报空指纹（取不到 MachineGuid / IOPlatformUUID）。
 * 此时**不占用名额、也不拦激活** —— 空指纹无法区分设备，
 * 计数只会把付费用户误伤。与"失败方向选放行"同一条准则。
 */

/* 设备数上限。
 *
 * 取 3 而非 Adobe 的 2：Rocktier 单品 $4.99–$6.99，个人用户，
 * "台式机 + 笔记本" 是常态，2 台会让买了的人被挡。
 * 3 台仍能把转卖的收益从「无限」压到「3 倍」。
 * 上限在服务端，客户端改不了。 */
/* KV 原语来自 _shared.js。这里单向依赖它，不反向 ——
   _shared.js 不得 require 本模块，否则构成循环。 */
var shared = require("./_shared.js");
var kvGet = shared.kvGet;
var kvSet = shared.kvSet;
var envPrefix = shared.envPrefix;

var MAX_DEVICES = 3;

/* 记账保留时长。回执本身不过期，但设备列表要能自然收敛 ——
   否则一年前的机器仍占着名额，正经用户换机就激活不了。
   10 年比回执的实际寿命长，实践中等于不淘汰，但给了运维手工清理的余地。 */
var DEVICE_TTL_SECONDS = 10 * 365 * 24 * 3600;

/* 读取某张码已激活的设备列表。损坏或读不到一律当空列表 ——
   读不到时放行（当没绑定过），而不是拒绝所有激活。 */
async function getActivations(txnId) {
  var raw = await kvGet(envPrefix() + "lic:dev:" + txnId);
  if (typeof raw !== "string" || !raw) return [];
  try {
    var arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

/* 判断这台设备（fp）是否已激活过。 */
function alreadyActivated(list, fp) {
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].fp === fp) return true;
  }
  return false;
}

/* 设备列表里可读的名字，给"自助解绑"页面用。 */
function describeDevice(entry) {
  var os = (entry && entry.os) || "";
  var at = (entry && entry.at) || 0;
  var when = at ? new Date(at * 1000).toISOString().slice(0, 10) : "";
  return { os: os || "unknown", activated: when, fp: (entry && entry.fp) || "" };
}

/* 记一次激活。
 *
 * 返回 { ok: true } 或 { ok: false, reason, current }：
 *   - "limit"  已达上限，需要用户先解绑一台
 *   - "storage" 记账写不进去 —— 放行（fail open）
 *
 * fail open 的方向要说明白：KV 故障时若一律拒绝，所有已付款用户会在
 * 最不该发生的时候（服务端抖动）被锁在门外。但 fail open 也意味着
 * KV 故障期间上限失效。这是"不锁人"与"防滥用"的取舍，前者优先级更高
 * —— 因为前者伤的是付费用户，后者只损失一点收入。 */
async function recordActivation(txnId, fp, os) {
  /* 空指纹无法区分设备：不计数、不拦激活。
     详见模块头「指纹取不到时怎么办」。 */
  if (!fp) return { ok: true, counted: false };

  var list = await getActivations(txnId);
  if (alreadyActivated(list, fp)) {
    /* 同一台机器重复激活（重装后重输码）—— 不重复计数，
       否则用户重装一次就吃掉一个名额。 */
    return { ok: true, counted: false };
  }
  if (list.length >= MAX_DEVICES) {
    return { ok: false, reason: "limit", current: list.map(describeDevice) };
  }

  list.push({ fp: fp, at: Math.floor(Date.now() / 1000), os: os || "" });
  var rc = await kvSet(
    envPrefix() + "lic:dev:" + txnId,
    JSON.stringify(list),
    DEVICE_TTL_SECONDS
  );
  /* 判 2xx 而不是「非 0」—— kvSet 的 catch 返回 0（网络异常），
     但服务端返回 5xx 时 `r.status` 是 500，也是真值。
     写 `if (!rc)` 会把 HTTP 500 当成写入成功，于是设备列表在
     服务端故障期间静默不落盘（而调用方以为记上了）。
     这个 bug 是变异测试逼出来的：把 fail-open 改成 fail-closed 时
     没有任何断言抓到，因为**写失败这条路径根本没被测过**。 */
  if (!(rc >= 200 && rc < 300)) {
    /* 写失败：放行。见上面的 fail open 说明。 */
    return { ok: true, counted: false, storageFailed: true };
  }
  return { ok: true, counted: true, devices: list.length, max: MAX_DEVICES };
}

/* 解绑一台设备。
 *
 * 用**购买凭证**（码本身）而不是账号来证明所有权 —— 这与当前
 * "无账号"的现实一致：持有码即可管理自己那一份的设备。
 *
 * `fp` 为空则解绑最早的一台：用户手上没有指纹（换了机器、指纹变了）
 * 却仍要恢复可用时的合理诉求。 */
async function releaseDevice(txnId, fp) {
  var list = await getActivations(txnId);
  if (!list.length) return { ok: false, reason: "none" };

  var idx = -1;
  if (fp) {
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].fp === fp) { idx = i; break; }
    }
  } else {
    /* 指纹对不上时解绑最早的一台 —— 那是"这台设备最可能已经不在用"的启发式。 */
    var oldest = -1;
    for (var j = 1; j < list.length; j++) {
      if ((list[j].at || 0) < (list[oldest].at || 0)) oldest = j;
    }
    idx = oldest;
  }
  /* 传了指纹但没匹配上 → 同样回落到"解绑最早的一台"。

     两种"对不上"的场景要合并处理，理由相同：用户手上**没有**原机器的指纹
     （换了机器、指纹取不到），但仍需要恢复可用。此时若返回 not_found
     就把人彻底锁住了 —— 而解绑最早那台正是"那台最可能已不在用"的启发式。

     区分"传了不存在的指纹"与"没传指纹"没有实际价值：
     两者都意味着调用者证明不了自己指定的是哪一台。 */
  if (idx < 0) {
    var oldestIdx = 0;
    for (var j = 1; j < list.length; j++) {
      if ((list[j].at || 0) < (list[oldestIdx].at || 0)) oldestIdx = j;
    }
    idx = oldestIdx;
  }

  var removed = describeDevice(list[idx]);
  list.splice(idx, 1);
  var rc = await kvSet(
    envPrefix() + "lic:dev:" + txnId,
    JSON.stringify(list),
    DEVICE_TTL_SECONDS
  );
  if (!(rc >= 200 && rc < 300)) return { ok: false, reason: "storage" };
  return { ok: true, removed: removed, remaining: list.length };
}

/* 列出某张码当前的设备（自助管理页用）。 */
async function listDevices(txnId) {
  var list = await getActivations(txnId);
  return { devices: list.map(describeDevice), max: MAX_DEVICES };
}

module.exports = {
  MAX_DEVICES: MAX_DEVICES,
  DEVICE_TTL_SECONDS: DEVICE_TTL_SECONDS,
  getActivations: getActivations,
  alreadyActivated: alreadyActivated,
  describeDevice: describeDevice,
  recordActivation: recordActivation,
  releaseDevice: releaseDevice,
  listDevices: listDevices,
};