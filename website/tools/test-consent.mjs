#!/usr/bin/env node
/**
 * 购买区「未勾选则不许付款」的自检（最小 DOM 打桩，不需要浏览器）。
 *
 * 用法: node tools/test-consent.mjs
 *
 * 为什么要测它：这一步是法律与收入的交汇点 —— 欧盟/英国消费者只有**明示同意
 * 即时交付**才丧失 14 天撤回权。而它失效的方式是**静默**的：用户照常点了、照常
 * 付了钱，只是那个同意从未发生，于是法定退款期排不掉。界面上看不出任何异常。
 *
 * 所以两个方向都要测：
 *   - 未勾选 ⇒ 两个入口（Paddle 浮层、PayPal 跳转）都必须被拦下；
 *   - 已勾选 ⇒ 两个入口都必须正常放行（拦过头等于把付钱的人挡在门外）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "js", "checkout.js"), "utf8");

/** 在一个全新的假 DOM 里加载一次 checkout.js（每次都是干净的实例）。 */
function load({ checked, hasBox = true, hasFallback = true, channelFails = false }) {
  let opened = null;
  let handler = null;

  const wrap = {
    classes: new Set(),
    classList: {
      add(c) { wrap.classes.add(c); },
      remove(c) { wrap.classes.delete(c); },
    },
  };
  const box = {
    checked,
    focused: false,
    focus() { this.focused = true; },
    closest(sel) { return sel === ".buy-consent" ? wrap : null; },
  };
  const hint = { hidden: true };

  /* 内联提示：插在被点按钮所在行的后面，带 aria-live，不抢焦点。 */
  const inline = {
    className: "",
    textContent: "",
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
  };
  const host = {
    nextElementSibling: null,
    parentNode: { insertBefore() {} },
    inserted: null,
    insertAdjacentElement(_pos, el) { this.inserted = el; },
  };

  const fallbackLink = { getAttribute: () => "/api/paypal-checkout?price_id=fb" };
  const document = {
    querySelector(sel) {
      if (sel === ".buy-consent-box") return hasBox ? box : null;
      if (sel === ".buy-consent-hint") return hint;
      /* PayPal 备用通道。只给「有备用」的页面 —— OCR/Write/Journal/Sign/
         Compressor 的 PayPal 侧没有商品，页面上确实没有这个链接，
         那种情况下点击应当保持无操作，而不是跳到 "#"。 */
      if (sel === "a.btn.ghost[href^='/api/paypal-checkout']") {
        return hasFallback ? fallbackLink : null;
      }
      return null;
    },
    addEventListener(type, fn) { if (type === "click") handler = fn; },
    createElement() { return inline; },
    querySelectorAll() { return []; },
    head: { appendChild() {} },
  };
  /* Creem 走外部真实链接，没有浮层。setChannel 是给「需要 JS 开结账的
     通道」留的口子：注册一个返回 false 的通道，用来验证降级仍会触发。 */
  const fakeWindow = { location: { href: "" } };

  vm.runInNewContext(source, {
    document,
    window: fakeWindow,
    location: fakeWindow.location,
    setTimeout: () => {},
    console,
  });

  /* 需要时注册一个「打不开结账」的通道 —— 不注册的话 channelOpen 是
     null，checkout.js 根本不会走降级分支，测试就成了摆设。 */
  if (channelFails) {
    fakeWindow.RocktierCheckout.setChannel(() => false);
  }

  return { handler, box, wrap, hint, inline, host, opened: () => opened, win: fakeWindow };
}

/** 模拟一次点击：元素按选择器自报身份。 */
function click(sim, el) {
  let prevented = false;
  const trigger = {
    /* 真实 DOM 里触发元素本身也能被子孙选择器命中；这里模拟
       `[data-buy]` 命中触发元素、布局容器命中所在行。 */
    closest(sel) {
      if (el.matches.includes(sel)) return trigger;
      if (sel === ".pt-row" || sel === ".card-buy" || sel === ".cta-row") return sim.host;
      return null;
    },
    classList: { add() {}, remove() {} },
    getAttribute: el.getAttribute,
  };
  sim.handler({
    target: trigger,
    preventDefault: () => { prevented = true; },
  });
  return prevented;
}

/* Creem 购买按钮。走**外部真实链接**（href 指向 creem.io），所以这道
   合规确认是它唯一的拦截点 —— 若test 里换成别的选择器而这里没跟着改，
   测试会静默失去覆盖（还照样绿）。改按钮属性时**必须**同步改这里。 */
const CREEM_BTN = { matches: ["[data-buy]"], getAttribute: () => "PD" };
const PAYPAL_LINK = {
  matches: ["a[href^='/api/paypal-checkout']"],
  getAttribute: () => "/api/paypal-checkout?price_id=x",
};

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? `\n       ${detail}` : ""}`);
}

console.log("\n  ── 未勾选：两个入口都必须拦下 ──");
{
  const sim = load({ checked: false });
  const prevented = click(sim, CREEM_BTN);
  check("Creem 按钮：不触发结账", sim.opened() === null);
  check("Creem 按钮：阻止默认跳转（否则直接跳走）", prevented === true);
  check("提示插在被点按钮旁（aria-live）", sim.host.inserted === sim.inline && sim.inline.attrs["aria-live"] === "polite" && sim.inline.textContent.length > 0);
  check("确认框被高亮，焦点没有被抢走", sim.wrap.classes.has("nudge") && sim.box.focused === false);
}
{
  const sim = load({ checked: false });
  const prevented = click(sim, PAYPAL_LINK);
  check("PayPal 链接：阻止跳转", prevented === true);
}

console.log("\n  ── 已勾选：两个入口都必须放行 ──");
{
  const sim = load({ checked: true });
  const prevented = click(sim, CREEM_BTN);
  /* Creem 走外部真实链接，**不该**被拦 ——拦了买家就付不了款。
     这是与Paddle 最大的行为差异：Paddle 需要 JS 开浮层所以要拦 '#'，
     Creem 不需要，所以拦它反而是 bug。 */
  check("Creem 按钮：不拦（正常跳去Creem）", prevented === false);
  check("不误伤（未勾选提示保持隐藏）", sim.hint.hidden === true);
}
{
  const sim = load({ checked: true });
  const prevented = click(sim, PAYPAL_LINK);
  check("PayPal 链接：正常跳转（不拦）", prevented === false);
}

console.log("\n  ── 没有确认框的页面（首页等）：一律放行 ──");
{
  const sim = load({ checked: false, hasBox: false });
  const prevented = click(sim, CREEM_BTN);
  check("无确认框 → 不拦", prevented === false);
}

console.log("\n  ── 已勾选时通道注册表返回 false → 降级到备用通道 ──");
{
  /* 这条守住 setChannel 那个口子：将来若有嵌入式通道打不开，
     仍要降级而不是静默丢单。Creem 本身是纯链接、不走这里。 */
  const sim = load({ checked: true, channelFails: true });
  click(sim, CREEM_BTN);
  check("通道失败时导航到备用通道", sim.win.location.href.includes("paypal-checkout"));
}

console.log("\n  ── 无备用通道时：点击保持无操作，不跳 '#' ──");
{
  /* OCR/Write/Journal/Sign/Compressor 的页面就是这种形态 ——
     跳到 "#" 会让买家以为买成了，实际什么都没发生。 */
  const sim = load({ checked: true, hasFallback: false, channelFails: true });
  const prevented = click(sim, CREEM_BTN);
  check("无备用 → 不导航", sim.win.location.href === "");
  check("无备用 → 阻止默认行为（不跳 '#'）", prevented === true);
}

console.log(
  failed === 0 ? "\n  ✅ 全部通过\n" : `\n  ❌ ${failed} 条不符\n`
);
process.exit(failed === 0 ? 0 : 1);
