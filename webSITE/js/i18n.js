/* 官网中英双语运行时（2026-10-13 起，全家收敛为 en/zh）。
 *
 * 与 9 个产品同一套家族模式：localStorage 存偏好、跟随系统语言、可手动覆盖。
 * 三处必须与家族对齐：
 *   · 存储键 `rocktier.lang`（family.json globalRules.langStorageKey）
 *   · 默认 `en`、followSystemLocale=true
 *   · 2 门：en / zh（2026-10-13 起；原 8 门的非中英为未审校机翻基线，已按裁定移除）
 *
 * ── 与产品端的一个实质差异：同意门 ──
 *
 * js/main.js 的 setStore() 对**非 CONSENT 键直接 return** -- 用户没点同意
 * 就不落盘任何偏好（GDPR 口径：偏好本身也是数据）。语言偏好必须走同一条路，
 * 否则「未同意却存了语言」就是个不一致点，会被审出。
 *
 * ── 为什么要单独的 lookup 表 ──
 *
 * 英文基线里 481 个 data-i18n 原值有 10 组同键不同文（philosophy.p1 在 about
 * 与 index 含义不同），抽取时已按页面前缀拆开，并把消歧结果落成
 * `"<页面>::<原始键>" → 字典键` 的查找表。运行时**只查表**，不做任何推断 --
 * 猜错就是显示另一个页面的文案。
 *
 * ── 价格回填 ──
 *
 * 已定策略「价格数字不翻译，只译周边说明文字」：译文里价格是 {p1} {p2}，
 * 运行时按序用 prices[字典键] 里的实际值回填。调价只需改 HTML 并重跑抽取器，
 * 7 门译文都不用动。
 *
 * 用法：在 </body> 前 <script src="js/i18n.js"></script>
 */
(function () {
  "use strict";

  var STORAGE_KEY = "rocktier.lang";
  var CONSENT_KEY = "rocktier-consent";
  var DEFAULT_LANG = "en";

  /* endonym = 语言自称。切换器上显示母语名，
     是让不懂该语言的人也能找到自己的语言，而不是让他们认英文缩写。 */
  var LOCALES = [
    { code: "en", endonym: "English" },
    { code: "zh", endonym: "中文" }
  ];

  var page = document.documentElement.getAttribute("data-page") || "";
  var dict = null;      // 当前语言的 keys
  var lookup = null;    // "<页面>::<原始键>" → 字典键
  var prices = null;    // 字典键 → 价格数组
  var EN_TEXT = {};     // 页面 → { 原始键: 英文纯文本 }

  /* 供非 data-i18n 的动态状态文案使用（如 /license 的取码状态）。
     这些元素不能挂 data-i18n：applyLang 会覆盖 textContent，状态会被
     语言层"打回"成加载中。改为页面脚本经 t() 取文案，并在本文件
     每次应用语言后回调 onChange()，由页面自己重绘。 */
  var currentCode = DEFAULT_LANG;
  var langListeners = [];
  var loadSeq = 0;        // 语言加载的序号，只有最后一次 load 能落地

  function setCurrent(code){ currentCode = code; labelControls(); }

  /* ── 控件名称 ──
   *
   * 导航 / 移动导航 / 主题 / 存储声明 / 语言 / 菜单按钮这 6 个名称属于
   * **属性**，不是元素文本，data-i18n 够不到（它写的是 textContent）。
   * 此前 #menuBtn 的名字由 main.js 三处各写一次硬编码英文，于是中文站里
   * 读屏器对着按钮念 "Open menu"，而且开合一次就被 JS 改回英文。
   * 现在名称只在这里写、只随语言变：开合状态交给 aria-expanded。
   *
   * 不引入 data-i18n-aria-label 这类新属性：check-site.mjs 的正则只认
   * data-i18n="…" 且其后跟着元素文本，换属性名闸门根本覆盖不到，
   * 漏译也不会报错。 */
  function uiText(key, fallback){
    /* en 的文案就是 HTML 里的英文原文，而 dict 此时可能是上一门语言的残留，
       所以 en 一律走 fallback，不读 dict。 */
    if (currentCode === "en") return fallback || "";
    return (dict && dict[key]) || fallback || "";
  }

  function labelControls(){
    var set = function (sel, key, fb){
      var el = document.querySelector(sel);
      if (el) el.setAttribute("aria-label", uiText(key, fb));
    };
    set("nav.links",  "ui.nav",       "Primary");
    set("#menuPanel", "ui.mobileNav", "Mobile");
    /* 名称固定："菜单" / "Menu"。不随开合改成"关闭菜单"：
       名称一变，读屏用户开合一次就发现按钮换了名字，而 aria-expanded 本来就会被播报。 */
    set("#menuBtn",   "nav.menu",     "Menu");
    set("#themeBtn",  "ui.theme",     "Toggle light or dark theme");
    set(".consent",   "ui.consent",   "Storage consent");
    set("#langSelect",       "ui.language", "Language");
    set("#langSelectMobile", "ui.language", "Language");
    labelDlGroups();
  }

  /* 价格表里的下载组：<span role="group" aria-label="Download Rocktier PDF">。
   *
   * 这 24 处的 aria-label 原本是硬编码英文，中文站里读屏器会念
   * "Download Rocktier PDF"。它不能直接删：组里有 Windows / macOS 两个按钮，
   * 正是这行告诉读屏器「这两个按钮属于哪个产品」，删了就是退化。
   *
   * 只翻动词，不翻产品名：Rocktier PDF / Rocktier OCR 是品牌名，
   * 全站中英一致，所以 24 处共用一个键 ui.dl，不做 8 个产品各一个键。
   *
   * 英文原文在第一次进来时存进 data-dl-en：之后切语言不再拿当前
   * aria-label 当兜底（切回英文时那已经是中文，会串成"下载 Rocktier PDF"）。 */
  function labelDlGroups(){
    /* 选中条件必须用稳定的 data-dl，不能用 aria-label 的内容：
       标签一旦本地化成「下载 Rocktier PDF」，按内容选的下一次就再也
       找不到它，于是切回英文切不回来（实测卡在中文）。
       这就是「自我失效的选择器」：用它选的东西，会被自己改掉。 */
    var els = document.querySelectorAll("[data-dl]");
    for (var i = 0; i < els.length; i++){
      var el = els[i];
      var en = el.getAttribute("data-dl-en");
      if (!en){
        en = el.getAttribute("aria-label");
        el.setAttribute("data-dl-en", en);
      }
      el.setAttribute("aria-label", uiText("ui.dl", "Download") + en.slice("Download".length));
    }
  }

  function notify(){
    for (var i = 0; i < langListeners.length; i++){
      try { langListeners[i](currentCode); } catch (e) {}
    }
  }

  /* 写文本，并在需要时让打字动画重跑。
   *
   * 16 个 .display 标题（hero.title / pr.title / …）带 data-i18n，
   * 而 js/main.js 的 runType() 把它们改造成 `<span class="tw">` + 光标，
   * 之后靠 h1.textContent 逐字显现。
   *
   * 若直接 innerHTML 赋值：动画结构被洗掉，光标消失 -- 那是可接受的。
   * 若把「备份的 innerHTML」写回去：动画结构回来了，但文本是动画跑完的
   * 空串，标题只剩一个 ▍ -- 实测正是这样。
   *
   * 所以对 .display 一律：清空 → 交回 runType() 重跑。
   * 它读 textContent，所以只要 textContent 是完整文案就行。
   */
  function setText(el, text) {
    var isDisplay = el.classList.contains("display");
    if (isDisplay) {
      /* runType() 把原文缓存在 dataset.twText，换语言必须清掉，
         否则重跑时读到的是上一次的语言（2026-10-11 实测 bug）。 */
      delete el.dataset.twText;
      el.textContent = text;
      if (window.RocktierRetype) window.RocktierRetype();
    } else {
      el.innerHTML = text;
    }
  }

  /* ── 存储：与 main.js 的同意门保持一致 ── */

  function getStore(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function readStore(key) {
    var v = getStore(key);
    if (v !== null) return v;
    try { var s = sessionStorage.getItem(key); return s === null ? null : s; } catch (e) { return null; }
  }
  function setStore(key, val) {
    /* 语言偏好与主题偏好同性质：未经同意不落**跨会话**存储。
       2026-10-11：未同意时改为落 sessionStorage 而非直接丢弃，
       与 main.js 的 setStore 行为对齐 -- 用户选了中文、拒绝同意，
       至少本次会话不要再跳回英文。sessionStorage 关标签即失效，
       与 privacy 页「偏好只在同意后持久化」的承诺不冲突。 */
    if (getStore(CONSENT_KEY) !== "accepted") {
      try { sessionStorage.setItem(key, val); } catch (e) {}
      return;
    }
    try { localStorage.setItem(key, val); } catch (e) {}
  }

  /* ── 语言判定：手动 > 系统 > 默认 ── */

  function pickLang() {
    var saved = readStore(STORAGE_KEY);
    if (saved && has(saved)) return saved;
    var list = navigator.languages || [navigator.language || ""];
    for (var i = 0; i < list.length; i++) {
      var base = String(list[i]).toLowerCase().split("-")[0];
      if (has(base)) return base;
    }
    return DEFAULT_LANG;
  }

  function has(code) {
    for (var i = 0; i < LOCALES.length; i++) {
      if (LOCALES[i].code === code) return true;
    }
    return false;
  }

  /* ── 应用 ── */

  /* 英文本身就在 HTML 元素内容里（站点本就是「HTML 即文案来源」），
     所以切回 en 只需把 DOM 还原 -- 这也是「en 无需生成物」的原因。
   *
     还原不能靠 innerHTML：16 个 .display 标题上，js/main.js 的打字动画
     已把内容换成 `<span class="tw">文本</span><i class="caret">▍</i>`。
     把那份 innerHTML 再写回去，只是把动画结构写回去，**文本仍是动画
     结束时的空/半截状态** -- 实测切回 en 后标题只剩一个 ▍ 光标。
   *
     所以切语言一律走 setText()，由它决定要不要触发打字动画重跑。
     en 的文案从哪儿来？每个元素首次被 i18n 碰到时，
     其**原始 textContent** 已被打字动画写进 el.dataset -- 不行，
     那也是动画后的。
     真正可靠的来源：生成器按页面导出一份 en 文本，i18n 一起带上。
     见下方 EN_TEXT。 */
  function applyEn(seq) {
    /* EN_TEXT 只在 applyLang 里赋值，而这里不 fetch 就直接读它 --
       首次就是 en、或上一次加载的是别的语言时它是空对象，
       于是 applyEn 什么都不做，页面停在上一种语言（实测切回 en 显示中文）。
       所以英文也走一次 fetch：en.json 本身就带 en_text。 */
    return fetch("i18n/en.json")
      .then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      })
      .then(function (payload) {
        /* 已经有更新的请求在飞：这一份是过期答案，丢掉。
           否则初始语言的请求后到会盖掉用户刚点的语言。 */
        if (seq !== undefined && seq !== loadSeq) return;
        EN_TEXT = payload.en_text || {};
        for (var raw in EN_TEXT[page] || {}) {
          /* 同键可能在页头、移动菜单、footer 各出现一次；只还原第一个
             会让其余元素停在上一语言（实测 zh→en 后导航残留中文）。 */
          document
            .querySelectorAll('[data-i18n="' + CSS.escape(raw) + '"]')
            .forEach(function (el) {
              setText(el, EN_TEXT[page][raw]);
            });
        }
        document.documentElement.lang = "en";
        document.documentElement.dir = "ltr";
        syncSwitcher(DEFAULT_LANG);
        setCurrent(DEFAULT_LANG);
        notify();
      })
      .catch(function () {
        if (seq !== undefined && seq !== loadSeq) return;
        /* 拉不到 en.json 时，HTML 元素里本来就是英文，
           只需把 lang/dir 归位，不必重写文本。 */
        document.documentElement.lang = "en";
        document.documentElement.dir = "ltr";
        syncSwitcher(DEFAULT_LANG);
        setCurrent(DEFAULT_LANG);
        notify();
      });
  }

  function applyLang(lang, payload) {
    dict = payload.keys;
    lookup = payload.lookup;
    prices = payload.prices || {};
    EN_TEXT = payload.en_text || {};

    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var raw = el.getAttribute("data-i18n");
      /* 记住英文原文，供切回 en 时还原 */
      if (el.dataset.i18nEn === undefined) {
        el.dataset.i18nEn = el.innerHTML;
      }
      var key = lookup[page + "::" + raw];
      if (!key) return;                 // 无译文：保留英文，不留空白
      var text = dict[key];
      if (typeof text !== "string" || !text) return;
      setText(el, fillPrices(text, key));
    });

    /* ar 是 RTL。这是内容属性而非样式偏好，必须每次切换都重设 --
       用户在英文与阿拉伯语之间来回切时最容易漏掉。 */
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    syncSwitcher(lang);
    setCurrent(lang);
    notify();
  }

  /* {p1} {p2} → 实际价格。缺价格时保留占位符会露出 {p1}，
     所以回落成空串而不是留着花括号。 */
  function fillPrices(text, key) {
    if (text.indexOf("{p") < 0) return text;
    var list = prices[key] || [];
    return text.replace(/\{p(\d+)\}/g, function (_, n) {
      return list[Number(n) - 1] || "";
    });
  }

  /* ── 切换器 ── */

  /* 两处挂载点：顶栏（桌面）与汉堡面板内（≤1080px）。
     两份都要有 -- 否则窄屏下顶栏那份被 .links 之外的规则挡住，
     用户在手机上根本找不到语言切换。 */
  function buildSwitcher() {
    ["langSwitch", "langSwitchMobile"].forEach(function (id, i) {
      var host = document.getElementById(id);
      if (!host) return;
      var sel = document.createElement("select");
      sel.id = i === 0 ? "langSelect" : "langSelectMobile";
      sel.setAttribute("aria-label", uiText("ui.language", "Language"));
      LOCALES.forEach(function (l) {
        var opt = document.createElement("option");
        opt.value = l.code;
        opt.textContent = l.endonym;
        sel.appendChild(opt);
      });
      sel.addEventListener("change", function () {
        setStore(STORAGE_KEY, sel.value);
        load(sel.value);
      });
      host.appendChild(sel);
    });
  }

  function syncSwitcher(code) {
    ["langSelect", "langSelectMobile"].forEach(function (id) {
      var sel = document.getElementById(id);
      if (sel) sel.value = code;
    });
  }

  /* ── 载入 ── */

  function load(code) {
    /* 每次 load 领一个号，只有最后领的那个能落地。
       没有这个守卫时，初始语言与用户手动的切换会互相覆盖：
       两个 fetch 同时在飞，谁后回谁说了算，于是用户刚点的语言被
       初始请求盖掉（实测 zh→en 切完还是中文）。 */
    var seq = ++loadSeq;
    if (code === DEFAULT_LANG) {
      applyEn(seq);
      return Promise.resolve();
    }
    return fetch("i18n/" + code + ".json")
      .then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      })
      .then(function (payload) {
        if (seq !== loadSeq) return;
        applyLang(code, payload);
      })
      .catch(function () {
        if (seq !== loadSeq) return;
        /* 拉不到译文就留在英文。半屏阿拉伯语 + 半屏英文比全英文更难用，
           而且这个分支不该被当成「正常情况」-- 控制台留痕便于发现。 */
        applyEn(seq);
        if (window.console) console.warn("[i18n] 载入失败，回退英文:", code);
      });
  }

  function init() {
    buildSwitcher();
    var lang = pickLang();
    syncSwitcher(lang);
    load(lang);
    /* 供其它脚本（如同意框重绘）查询当前语言 */
    window.RocktierLang = {
      get current() { return currentCode; },
      locales: LOCALES,
      set: function (code) {
        setStore(STORAGE_KEY, code);
        load(code);
      },
      /* 英文原文 + 中文译文，由页面决定用哪一条。
         不读 dict：动态状态文案不在字典里，也不需要为它们新增译文键。 */
      t: function (en, zh) {
        return currentCode === "zh" ? zh : en;
      },
      /* 控件名称的取值器：直读当前语言的 dict，不经过 lookup。
         lookup 是「页面上的 data-i18n 原值 → 字典键」的映射，
         而这 6 个键不出现在任何 HTML 元素上，lookup 里没有它们。 */
      get: function (key, fallback) { return uiText(key, fallback); },
      onChange: function (fn) {
        if (typeof fn === "function") langListeners.push(fn);
      },
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();