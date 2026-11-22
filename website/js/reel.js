/* 细节卷轴：产品页截图区的交互。
 *
 * 三件事：切项、自动轮播、指针倾斜。没有依赖，也不碰别的组件。
 *
 * ── 为什么自动轮播要能停 ──
 * WCAG 2.2.2：超过 5 秒的自动运动内容必须能被用户暂停。这里的停留是 5.2 秒，
 * 恰好越线，所以给了三处出口：指针悬停、键盘聚焦、以及一个显式的 Pause 钮。
 * 另外 prefers-reduced-motion 下根本不启动。
 *
 * ── 为什么手动点一下会重置计时而不是停止 ──
 * 两种常见做法各有毛病：一点就停，等于让最想看的用户失去其余三个特性；
 * 一点不重置，又会在刚点完的两秒后自己跳走。重置计时两边都不吃亏，
 * 当前项底部的进度线会把「还剩多久」画给用户看。
 */
(function () {
  "use strict";

  var reels = document.querySelectorAll("[data-reel]");
  if (!reels.length) return;

  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var DWELL = 5200;

  [].forEach.call(reels, function (root) {
    var tabs = [].slice.call(root.querySelectorAll('[role="tab"]'));
    var panels = [].slice.call(root.querySelectorAll('[role="tabpanel"]'));
    var list = root.querySelector(".reel-tabs");
    var stage = root.querySelector(".reel-stage");
    var pauseBtn = root.querySelector(".reel-pause");
    if (!tabs.length || tabs.length !== panels.length) return;
    if (tabs.length < 2) root.classList.remove("is-running");

    var idx = 0;
    var timer = null;
    var paused = false;   // 用户按下 Pause
    var dwellable = false; // 用户在悬停或聚焦中
    var onScreen = false;

    function eligible() {
      return !reduce && !paused && !dwellable && onScreen && !document.hidden;
    }

    function sync() {
      root.classList.toggle("is-running", eligible());
      if (timer) { clearTimeout(timer); timer = null; }
      if (!eligible()) return;
      timer = setTimeout(function () { go(idx + 1); }, DWELL);
    }

    function go(i) {
      idx = (i % panels.length + panels.length) % panels.length;
      tabs.forEach(function (t, n) {
        var on = n === idx;
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.tabIndex = on ? 0 : -1;
      });
      panels.forEach(function (p, n) {
        var on = n === idx;
        p.classList.toggle("is-on", on);
        /* aria-hidden 而不是 hidden：hidden 会把元素从布局里摘掉，
           宽度只有 425 的那张一摘，整块舞台的高度就跟着跳。 */
        p.setAttribute("aria-hidden", on ? "false" : "true");
      });
      sync();
    }

    /* ── 目录 ────────────────────────────────────────────────────── */
    tabs.forEach(function (tab, n) {
      tab.addEventListener("click", function () { go(n); });
      tab.addEventListener("keydown", function (e) {
        var k = e.key, next = null;
        if (k === "ArrowDown" || k === "ArrowRight") next = n + 1;
        else if (k === "ArrowUp" || k === "ArrowLeft") next = n - 1;
        else if (k === "Home") next = 0;
        else if (k === "End") next = tabs.length - 1;
        if (next === null) return;
        e.preventDefault();
        go(next);
        tabs[idx].focus();
      });
    });
    /* 方向键在垂直 tablist 里走动，容器本身不是控件，别让它滚走焦点 */
    if (list) list.addEventListener("keydown", function (e) {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") e.preventDefault();
    });

    /* ── 悬停 / 聚焦 / 出屏 / 切标签页 ────────────────────────────── */
    function hold(on) { dwellable = on; sync(); }
    root.addEventListener("pointerenter", function (e) { if (e.pointerType === "mouse") hold(true); });
    root.addEventListener("pointerleave", function () { hold(false); });
    root.addEventListener("focusin", function () { hold(true); });
    root.addEventListener("focusout", function (e) {
      if (!root.contains(e.relatedTarget)) hold(false);
    });
    document.addEventListener("visibilitychange", sync);

    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        onScreen = entries[0].isIntersecting;
        sync();
      }, { threshold: 0.25 }).observe(root);
    } else {
      onScreen = true;
    }

    /* ── 暂停钮 ──────────────────────────────────────────────────── */
    if (pauseBtn) {
      if (reduce) {
        pauseBtn.hidden = true;
      } else {
        pauseBtn.hidden = false;
        pauseBtn.addEventListener("click", function () {
          paused = !paused;
          pauseBtn.setAttribute("aria-pressed", paused ? "true" : "false");
          sync();
        });
      }
    }

    /* ── 指针倾斜（只有鼠标才做，触屏没有悬停态） ─────────────────── */
    if (stage && !reduce) {
      var frame = 0;
      stage.addEventListener("pointermove", function (e) {
        if (e.pointerType !== "mouse" || frame) return;
        frame = requestAnimationFrame(function () {
          frame = 0;
          var r = stage.getBoundingClientRect();
          if (!r.width || !r.height) return;
          var px = (e.clientX - r.left) / r.width - 0.5;
          var py = (e.clientY - r.top) / r.height - 0.5;
          stage.style.setProperty("--ry", (px * 3.2).toFixed(2) + "deg");
          stage.style.setProperty("--rx", (-py * 2.4).toFixed(2) + "deg");
        });
      });
      stage.addEventListener("pointerleave", function () {
        stage.style.setProperty("--ry", "0deg");
        stage.style.setProperty("--rx", "0deg");
      });
    }

    /* ── 入场（只跑一次） ─────────────────────────────────────────── */
    if ("IntersectionObserver" in window) {
      root.classList.add("reel-ready");
      var once = new IntersectionObserver(function (entries) {
        if (!entries[0].isIntersecting) return;
        root.classList.add("in");
        once.disconnect();
      }, { threshold: 0.15 });
      once.observe(root);
    }

    go(0);
  });
})();
