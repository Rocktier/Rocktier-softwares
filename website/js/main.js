(function(){
  "use strict";

  /* Language is owned by js/i18n.js (8 locales: en/zh/ja/ko/de/es/pt/ar).
     The 2026-09-13 English-only decision and its removed zh dictionary were
     reversed on 2026-10-09 when all 8 locales shipped. This file owns only
     theme and consent; HTML remains the source of copy. */
  /* 2026-11-19 起与家族其余产品同键：rocktier.theme（旧键 rocktier-theme 仅读取回落）。 */
  var THEME = "rocktier.theme";
  var THEME_LEGACY = "rocktier-theme";
  var CONSENT = "rocktier-consent";

  /* Consent: store the decision itself (strictly necessary to avoid re-prompting). */
  function consentGiven(){ return getStore(CONSENT) === "accepted"; }

  function getStore(key){ try{ return localStorage.getItem(key); }catch(e){ return null; } }
  function setStore(key, val){
    /* Only persist preferences across sessions when consent was accepted.
       The consent flag itself is always stored (strictly necessary).

       2026-10-11: when consent is absent the preference now falls back to
       sessionStorage instead of being dropped. The old "return" meant a user
       who picked dark / Chinese and declined consent was silently reset on the
       next visit. /privacy promises preferences are only persisted with
       consent, so localStorage must stay gated -- but throwing away the current
       session too trades a compliance posture for user frustration.
       sessionStorage dies with the tab, so it does not cross sessions. */
    if(key !== CONSENT && !consentGiven()){
      try{ sessionStorage.setItem(key, val); }catch(e){}
      return;
    }
    try{ localStorage.setItem(key, val); }catch(e){}
  }
  /* Read order matters: a consented preference must always beat an
     un-consented session preference. */
  function readStore(key){
    var v = getStore(key);
    if (v !== null) return v;
    try{ var s = sessionStorage.getItem(key); return s === null ? null : s; }catch(e){ return null; }
  }

  /* Resolve the newest release asset per platform and deep-link the download
     buttons past the releases page (non-technical users cannot pick between
     .dmg / .exe / source archives). Falls back to the releases page.

     2026-10-11 rewritten. The old implementation fetched once per button: 18
     buttons on the home page meant 18 requests against an unauthenticated cap
     of 60/hour/IP. A corporate NAT, campus network, or a single traffic spike
     exhausts it, after which every button silently degrades to the Releases
     page -- the exact experience the feature exists to avoid -- with no signal
     to the user that anything went wrong.

     Now: one request for the monorepo's release list (all eight apps publish
     into Rocktier/Rocktier-softwares as `<slug>/vX.Y.Z` tags since 2026-11-21),
     shared by every button, and an explicit degraded marker instead of a
     silent fallback. */
  (function(){
    var buttons = Array.prototype.slice.call(document.querySelectorAll("a.btn.dl[data-gh]"));
    var intelLinks = Array.prototype.slice.call(document.querySelectorAll("a.dl-intel[data-gh]"));
    if (buttons.length === 0 && intelLinks.length === 0) return;

    var MONO_REPO = "Rocktier/Rocktier-softwares";
    var releasesPromise = null;   // shared: one list fetch for all apps

    function allReleases(){
      if (!releasesPromise){
        releasesPromise = fetch("https://api.github.com/repos/"+MONO_REPO+"/releases?per_page=100")
          .then(function(r){
            if (!r.ok) throw new Error("github api " + r.status);
            return r.json();
          })
          .then(function(list){
            if (!Array.isArray(list)) throw new Error("no releases");
            return list;
          });
      }
      return releasesPromise;
    }

    /* checksums.json 是构建期生成、随站点一起发布的本地文件。
       它既决定 Intel 子链接是否露出（资产名与 hash 存在才算有货），
       也在 GitHub API 不可用时给主按钮兜底：用已验证的版本和
       文件名拼出直链，而不是退回 /releases/latest。 */
    var checksumsReady = fetch("checksums.json")
      .then(function(r){
        if (!r.ok) throw new Error("checksums " + r.status);
        return r.json();
      })
      .then(function(data){
        var bySlug = {};
        Object.keys(data.products || {}).forEach(function(code){
          var p = data.products[code];
          if (p) bySlug[code] = p;
        });
        return { bySlug: bySlug };
      })
      .catch(function(){ return { bySlug: {} }; });

    /* 同一前缀可能挂多个 tag（回滚重发），按发布时间取最新。 */
    function releaseFor(slug){
      return allReleases().then(function(list){
        var hit = null, i, tag;
        for (i = 0; i < list.length; i++){
          tag = String((list[i] && list[i].tag_name) || "");
          if (tag.indexOf(slug + "/") !== 0) continue;
          if (!hit || String(list[i].published_at || "") > String(hit.published_at || "")) hit = list[i];
        }
        if (!hit || !hit.assets) throw new Error("no release for " + slug);
        return hit;
      });
    }

    /* Preference order matters: the NSIS installer is the friendliest for a
       non-technical user, then the MSI. CAD Viewer ships MSI + MSIX only
       (the MSIX pair belongs to the Store), so a setup.exe-only rule left
       its Windows button stranded on the releases page. */
    var winPrefs=[/x64-setup\.exe$/i, /x64.*\.msi$/i, /\.msi$/i];

    /* Since 2026-10-23 every macOS release carries two DMGs. Tauri names the
       Intel one `_x64.dmg` (not `_x86_64`). The primary button must resolve
       the Apple Silicon build explicitly: the GitHub API order is not a
       contract, so "first .dmg" would hand arm64 to Intel users at random.
       The Intel build is opt-in through a sub-link that only appears when
       the release actually ships it (OCR never will until ort-sys does). */
    var ARM_DMG=/_aarch64\.dmg$/i;

    function pickHref(rel, mac){
      var assets=rel.assets||[];
      var hit=null, i;
      if (mac){
        for(i=0;i<assets.length && !hit;i++) if(ARM_DMG.test(assets[i].name)) hit=assets[i].browser_download_url;
        for(i=0;i<assets.length && !hit;i++) if(/\.dmg$/i.test(assets[i].name)) hit=assets[i].browser_download_url;
        return hit;
      }
      for(var p=0;p<winPrefs.length && !hit;p++)
        for(i=0;i<assets.length && !hit;i++)
          if(winPrefs[p].test(assets[i].name)) hit=assets[i].browser_download_url;
      return hit;
    }

    /* 本地 checksums 兜底：返回 {url, version}；资产不存在则 null。 */
    function localRelease(slug, mac){
      return checksumsReady.then(function(ck){
        var p = ck.bySlug[slug];
        if (!p) return null;
        var asset = mac
          ? ((p.macos && p.macos.aarch64) || (p.macos && p.macos.x64))
          : p.windows;
        if (!asset || !asset.url) return null;
        return { url: asset.url, version: p.version || "" };
      });
    }

    function useLocal(a, local){
      a.href = local.url;
      a.dataset.dlState = "checksums";
      a.dataset.dlNote = local.version ? " · " + local.version : "";
      a.title = "Pinned to the last verified build" +
        (local.version ? " (" + local.version + ")" : "");
    }

    /* Intel 子链接只看本地 checksums：资产名与 hash 都在才算有货。
       GitHub API 的 assets 不再参与这个判断：匿名限额一到，
       它会把本来存在的 Intel 包一起隐藏。 */
    checksumsReady.then(function(ck){
      intelLinks.forEach(function(link){
        var p = ck.bySlug[link.getAttribute("data-slug") || link.getAttribute("data-gh")];
        var x64 = p && p.macos && p.macos.x64;
        if (!x64 || !x64.url || !x64.sha256){ link.hidden = true; return; }
        if (pinOutranks(link, { tag_name: p.version })){ link.hidden = true; return; }
        link.href = x64.url;
        link.hidden = false;
        link.dataset.dlState = "checksums";
      });
    });

    function markDegraded(btn){
      /* The href still points at the Releases page, so say so rather than
         letting the button pose as a direct installer. The suffix is
         rendered by CSS from data-dl-note; title alone was invisible. */
      btn.dataset.dlState = "degraded";
      btn.dataset.dlNote = " ↗ Releases";
      btn.title = "Download from the release page";
    }

    /* 静态钉版兜底：`/releases/latest` 正常返回时仍优先用最新资产，但若接口
       返回的 tag 低于该链接上写死的版本（回滚、误发旧 tag），不要静默降级，
       保留 HTML 里的钉版 href。只在带 data-min-version 的链接上生效。 */
    function tagVersion(tag){
      /* monorepo 标签形如 `pdf/v1.2.2`；旧仓裸 `v1.2.2` 也兼容。 */
      var m = String(tag || "").match(/^(?:[a-z0-9-]+\/)?v?(\d+)\.(\d+)\.(\d+)/i);
      return m ? [+m[1], +m[2], +m[3]] : null;
    }
    function olderThan(a, b){
      for (var i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
      return false;
    }
    function pinOutranks(link, rel){
      var min = tagVersion(link.getAttribute("data-min-version"));
      var got = tagVersion(rel && rel.tag_name);
      return !!(min && got && olderThan(got, min));
    }

    buttons.forEach(function(a){
      var slug=a.getAttribute("data-slug") || a.getAttribute("data-gh");
      var mac=a.getAttribute("data-platform")==="mac";
      releaseFor(slug).then(function(rel){
        var href=pickHref(rel, mac);
        if (href){ a.href=href; a.dataset.dlState="direct"; delete a.dataset.dlNote; return; }
        return localRelease(slug, mac).then(function(local){
          if (local) useLocal(a, local); else markDegraded(a);
        });
      }).catch(function(){
        return localRelease(slug, mac).then(function(local){
          if (local) useLocal(a, local); else markDegraded(a);
        });
      });
    });
  })();

  /* Day / night theme */
  function applyTheme(t){
    document.documentElement.setAttribute("data-theme", t);
    /* 产品 logo 只加载当前主题那一张：dark/light 曾各放一个 <img>，
       浏览器会把两套都下载（首页约 2.8MB）。现在单 <img> + data-dark/data-light 换 src。 */
    var marks = document.querySelectorAll("img.mark-img[data-dark]");
    for (var i = 0; i < marks.length; i++){
      var want = t === "light" ? marks[i].getAttribute("data-light") : marks[i].getAttribute("data-dark");
      if (want && marks[i].getAttribute("src") !== want) marks[i].setAttribute("src", want);
    }
  }
  /* 2026-11-19 起与家族应用同规：两态手动切换，默认深色（不再跟随系统）。
     无同意时偏好只存 sessionStorage，本会话内仍然生效。 */
  var theme = readStore(THEME) || readStore(THEME_LEGACY) || "dark";
  applyTheme(theme);
  var themeBtn = document.getElementById("themeBtn");
  if(themeBtn) themeBtn.addEventListener("click", function(){
    var next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    applyTheme(next);
    setStore(THEME, next);
  });

  /* Mobile hamburger menu */
  var menuBtn = document.getElementById("menuBtn");
  var menuPanel = document.getElementById("menuPanel");
  if(menuBtn && menuPanel){
    menuBtn.addEventListener("click", function(){
      var open = menuPanel.classList.toggle("open");
      menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
      /* 名称不在这里改：按钮名必须稳定（"菜单" / "Menu"），开合状态由
         aria-expanded 表达，这也是 WAI-ARIA disclosure 模式本身的做法。
         名称由 js/i18n.js 的 labelControls() 随语言统一写入。此前这里
         硬编码英文，中文站的读屏器听到的就是 "Open menu"。 */
    });
    /* close when a menu link is chosen */
    menuPanel.addEventListener("click", function(e){
      if(e.target.tagName === "A"){
        menuPanel.classList.remove("open");
        menuBtn.setAttribute("aria-expanded","false");
      }
    });
    /* 面板原先只有 click 监听，键盘用户打开后只能再摸回汉堡按钮才关得掉。
       Esc 是「关闭浮层」的通用约定，补在这里；只在面板真打开时响应，
       免得抢走输入框与 details 自己的 Esc。 */
    document.addEventListener("keydown", function(e){
      if(e.key !== "Escape" && e.key !== "Esc") return;
      if(!menuPanel.classList.contains("open")) return;
      menuPanel.classList.remove("open");
      menuBtn.setAttribute("aria-expanded","false");
      menuBtn.focus();
    });
  }

  /* Consent banner */
  var banner = document.getElementById("consent");
  if(banner){
    if(getStore(CONSENT)) banner.classList.add("hidden");
    var acceptBtn = document.getElementById("consentAccept");
    var declineBtn = document.getElementById("consentDecline");
    function hideBanner(){ banner.classList.add("hidden"); }
    if(acceptBtn) acceptBtn.addEventListener("click", function(){
      setStore(CONSENT, "accepted");
      /* persist current preferences now that consent is given */
      setStore(THEME, document.documentElement.getAttribute("data-theme"));
      hideBanner();
    });
    if(declineBtn) declineBtn.addEventListener("click", function(){
      /* store the decline decision (strictly necessary); do NOT persist preferences */
      try{ localStorage.setItem(CONSENT, "declined"); }catch(e){}
      hideBanner();
    });
  }

  /* ── Checksums (2026-10-11) ─────────────────────────────────────────────
     The entire differentiation of this site is "offline = trustworthy", but
     until now that was an assertion with no evidence. GitHub publishes a
     SHA-256 digest for every release asset, so /checksums.json is generated
     at build time (zero runtime requests) and injected here.

     Only the assets the download buttons actually point to are listed; the
     MSIX / MSI / app.zip files have their own pages. If the file is missing
     the container keeps its static fallback text. */
  (function(){
    var host = document.getElementById("checksums");
    if (!host) return;
    fetch("checksums.json").then(function(r){
      if (!r.ok) throw new Error("checksums.json " + r.status);
      return r.json();
    }).then(function(data){
      var rows = [];
      function list(v){
        if (!v) return [];
        if (v.sha256) return [v];
        return Object.keys(v).map(function(k){ return v[k]; })
          .filter(function(a){ return a && a.sha256; });
      }
      Object.keys(data.products || {}).forEach(function(code){
        var p = data.products[code];
        ["windows", "macos"].forEach(function(kind){
          list(p[kind]).forEach(function(a){
            rows.push(
              '<div class="ck-row">' +
                '<p class="ck-name">' + code + ' · ' + a.name + '</p>' +
                '<p class="ck-hash"><code>' + a.sha256 + '</code></p>' +
              '</div>'
            );
          });
        });
      });
      if (rows.length) host.insertAdjacentHTML("beforeend", rows.join(""));
      host.insertAdjacentHTML("beforeend",
        '<p class="ck-gen">Generated ' + (data.generated || "") + ' from GitHub release metadata.</p>');
    }).catch(function(){
      /* leave the static "checksums are on the release page" copy in place */
    });
  })();

  /* Lightweight scroll reveal + stagger (no library; moment ON only via JS) */
  document.body.classList.add("js-anim");
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if ("IntersectionObserver" in window && !reduceMotion){
    var rvEls = document.querySelectorAll(".sec-head,.card,.col,.name-card,.banner,.lead,.prose h2,.prose p");
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(en){
        if(en.isIntersecting){ en.target.classList.add("in"); io.unobserve(en.target); }
      });
    },{threshold:.15, rootMargin:"0px 0px 40px 0px"});
    rvEls.forEach(function(el){
      var r = el.getBoundingClientRect();
      var vh = window.innerHeight || document.documentElement.clientHeight;
      if(r.top < vh && r.bottom > 0){ el.classList.add("in"); }
      else { el.classList.add("rv"); io.observe(el); }
    });
    [".grid",".cols",".name-row"].forEach(function(sel){
      var group = document.querySelector(sel);
      if(!group) return;
      [].forEach.call(group.children,function(ch,i){ ch.style.transitionDelay = (i*90)+"ms"; });
    });
  }

  /* ===== Antigravity-inspired motion (monochrome) ===== */

  /* --- 3) Dot-matrix typewriter for .display titles (respects i18n + reduced motion) --- */
  function runType(){
    if (reduceMotion) return;
    document.querySelectorAll(".display").forEach(function(h1){
      if (h1.__tw) clearTimeout(h1.__tw);
      /* 2026-10-11：动画会把 textContent 清空再逐字填回。切语言时
         i18n.js 会先把 innerHTML 换成译文，此时 h1.textContent 是完整译文；
         但若上一次动画还在跑（或已被自己清空），textContent 就只剩零头，
         之前正是靠一个 40 KB 的 en_text JSON 备份层来兜这个底。
         现在动画开始前先把原文写进 dataset，从头跑也读得回来。 */
      var txt = (h1.dataset.twText || h1.textContent || "").replace(/\s+/g," ").trim();
      if (!txt) return;
      h1.dataset.twText = txt;
      h1.textContent = "";
      var tw = document.createElement("span"); tw.className = "tw";
      var caret = document.createElement("i"); caret.className = "caret"; caret.setAttribute("aria-hidden","true"); caret.textContent = "▍";
      h1.appendChild(tw); h1.appendChild(caret);
      var n = 0;
      (function tick(){
        tw.textContent = txt.slice(0, n++);
        if (n <= txt.length){ h1.__tw = setTimeout(tick, 34); }
        else { if (caret.parentNode) caret.parentNode.removeChild(caret); }
      })();
    });
  }
  runType();

  /* 让 i18n.js 能在换语言后重跑打字动画。
     16 个 .display 标题带 data-i18n，而 runType() 会把它们的文本换成
     <span class="tw"> + <i class="caret">。i18n.js 若直接 innerHTML 赋值，
     动画结构会消失；若把备份的 innerHTML 写回去，文本又是动画跑完的空串
     （标题只剩一个 ▍ 光标）。两种都不对，所以由 i18n.js 调这里重跑。 */
  window.RocktierRetype = runType;

})();