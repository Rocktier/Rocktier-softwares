/* 结账流程的共用行为：购买前的合规确认 + 收款通道降级。
   （原 js/paddle.js。Paddle 取消后，本文件只保留与收款通道无关的部分。）

   ── 为什么拆出这个文件 ──
   原来的 paddle.js 同时管三件事：① 加载 Paddle.js 并打开结账浮层、
   ②「即时交付 / 放弃撤回权」的勾选确认、③ Paddle CDN 不可达时降级到
   PayPal。取消 Paddle 后只有 ① 失效，而 ② ③ 仍然必需：

   - ② 是欧盟/英国 14 天撤回权的合规要件。refund-policy 第 3 节对外
     声明「下单即视为放弃撤回权」，那这句话要成立就必须有这一步 --
     **条款上写着、流程上没有，是虚假陈述**。Creem 同样要过这一道。
   - ③ 是单点故障兜底：收款 SDK 加载失败时，点购买静默无反应就是丢单，
     必须降级到另一条通道。

   ── 收款通道无关的部分 ──
   真正的通道接入（加载 SDK、打开结账、拿到交易号）由各通道自己的脚本负责，
   本文件只负责「能不能进入结账」和「通道失败时去哪」。 */

/* 购买区的「即时交付 / 放弃撤回权」确认。
   收款方（Creem / PayPal / …）的结账浮层里放不下我们自己的条款文本，
   所以这一步只能发生在**进入结账之前**；而欧盟/英国消费者只有在明示
   同意即时交付时才丧失 14 天撤回权。
   没有勾选框的页面（首页等）一律放行：这个检查只对购买区生效。 */
(function () {
  "use strict";

  function consentBox() {
    return document.querySelector ? document.querySelector(".buy-consent-box") : null;
  }

  function langText(en, zh) {
    if (window.RocktierLang && typeof window.RocktierLang.t === "function") {
      return window.RocktierLang.t(en, zh);
    }
    return document.documentElement && document.documentElement.lang === "zh" ? zh : en;
  }

  function nudge(el) {
    if (!el || !el.classList) return;
    el.classList.remove("nudge");
    /* 同一按钮连点两次时重启动画 */
    void el.offsetWidth;
    el.classList.add("nudge");
    setTimeout(function () { el.classList.remove("nudge"); }, 1200);
  }

  /* 提示落在被点的按钮旁，而不是页头那行全局提示：390px 下用户
     已经滚到卡片底部，回到页头看不见。aria-live 让读屏也能听到。 */
  function inlineHint(trigger) {
    if (!trigger || !trigger.closest || typeof document.createElement !== "function") return;
    var host = trigger.closest(".pt-row") || trigger.closest(".card-buy") ||
      trigger.closest(".cta-row") || trigger;
    if (!host || !host.parentNode) return;
    var next = host.nextElementSibling;
    var hint = next && next.classList && next.classList.contains("buy-consent-inline") ? next : null;
    if (!hint) {
      hint = document.createElement("span");
      hint.className = "buy-consent-inline";
      hint.setAttribute("role", "status");
      hint.setAttribute("aria-live", "polite");
      if (host.insertAdjacentElement) host.insertAdjacentElement("afterend", hint);
      else host.parentNode.insertBefore(hint, host.nextSibling);
    }
    hint.textContent = langText(
      "Please tick the box above before paying.",
      "请先勾选上面的同意框再付款。"
    );
  }

  function requireConsent(trigger) {
    var box = consentBox();
    if (!box || box.checked) return true;

    var wrap = box.closest ? box.closest(".buy-consent") : null;
    if (wrap) {
      wrap.classList.add("nudge");
      setTimeout(function () { wrap.classList.remove("nudge"); }, 1500);
    }
    nudge(trigger);
    inlineHint(trigger);
    /* 刻意不 focus 勾选框：移动端 focus 会把整页滚回页面顶部，
       买家刚点的按钮直接从视野里消失。焦点留在原按钮。 */
    return false;
  }

  /* 勾选之后立刻收掉所有内联提示。 */
  document.addEventListener("change", function (e) {
    if (!e.target || !e.target.classList ||
        !e.target.classList.contains("buy-consent-box") || !e.target.checked) return;
    if (!document.querySelectorAll) return;
    var hints = document.querySelectorAll(".buy-consent-inline");
    Array.prototype.slice.call(hints).forEach(function (el) {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
  });

  /* 本次点击能走通的备用通道（按优先级，第一个存在的即可）。
     收款 SDK 可能因 CDN 不可达、脚本被拦截、或初始化失败而打不开结账 --
     那时静默无反应就是丢单，所以必须有一处明确的去处。 */
  function fallbackHref() {
    var alt = document.querySelector
      ? document.querySelector("a.btn.ghost[href^='/api/paypal-checkout']")
      : null;
    return alt ? alt.getAttribute("href") : null;
  }

  function goToFallback() {
    var href = fallbackHref();
    /* 备用通道也没有时，宁可让这次点击什么都不做，也不要跳到 "#"
       -- 跳 "#" 只会让页面跳一下，用户以为买成了。 */
    if (href) window.location.href = href;
  }

  /* 各收款通道的脚本在初始化完成后调这个，告诉本文件「结账打不打得开」。
     channelOpen 返回 true 表示浮层已打开，返回 false 表示失败（应降级）。 */
  var channelOpen = null;
  window.RocktierCheckout = {
    /** 由收款通道脚本注册。fn(id) → true=已打开 / false=失败 */
    setChannel: function (fn) { channelOpen = fn; },
    /** 供通道脚本查询备用通道 */
    fallback: goToFallback
  };

  /* Event delegation：任何带data-buy 的按钮都能触发，包括 i18n 层后注入的。

     ⚠️ Creem 走的是**外部真实链接**（href 指向 creem.io），不拦它就等于
     这道合规确认形同虚设 -- 用户可以直接点「Buy - $14.99」跳走，
     而 refund-policy 第 3 节对外声明的 14 天撤回权正是靠这一步成立的。
     **条款上写着、流程上没有，是虚假陈述。**

     两条路径都必须过requireConsent：
     - [data-buy]        Creem 等外部托管结账
     - a[href^='/api/paypal-checkout']  PayPal 站内跳转 */
  document.addEventListener("click", function (e) {
    var closest = e.target && e.target.closest ? e.target.closest.bind(e.target) : null;

    var btn = closest ? closest("[data-buy]") : null;
    if (btn) {
      /* 无条件拦下：确认过了再放行跳转。这里不 preventDefault 的话，
         未勾选时点击已经离开站点了。 */
      if (!requireConsent(btn)) { e.preventDefault(); return; }
      /* 需要 JS 开浮层的通道（如未来的嵌入式 SDK）走这里；
         纯链接通道（Creem / PayPal）直接放行默认行为。 */
      if (channelOpen && channelOpen(btn.getAttribute("data-product")) === false) {
        e.preventDefault();
        goToFallback();
      }
      return;
    }

    var paypal = closest ? closest("a[href^='/api/paypal-checkout']") : null;
    if (paypal && !requireConsent(paypal)) e.preventDefault();
  });
})();