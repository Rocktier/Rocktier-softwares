#!/usr/bin/env node
/* 家族 UX 审计器（零依赖）—— 文字溢出 / 控件重叠 / 命中区过小 / 视口溢出。

   ── 为什么做这个 ──
   用户 2026-10-16 反馈家族软件仍存在「按钮打架、文字溢出」。Token/对比度/
   焦点环已有闸门在守，但**布局类缺陷（溢出/重叠/截断/命中区）没有任何
   自动判据** —— 只能靠人开着软件看。本工具把这四类做成可复跑的判据。

   ── 口径（先声明量了什么、没量什么）──
   量：静态服务 dist/ 后 headless Chromium（Edge）实际渲染的 DOM 盒模型。
   没量：WKWebView（macOS 真机 webview）与 WebView2（Windows）的实际渲染；
   本机字体与目标平台不同，溢出风险以本机实测为下限信号，不是终审。
   Tauri 原生标题栏/拖拽区不在测量范围（CDP 量的是页面内容）。

   用法：
     node ux-audit.mjs --root <dist 或 ui 目录> [--port 8931] [--out x.json]
                       [--steps 18] [--width 1280] [--height 860]
                       [--browser <path>]   # 默认 macOS Edge；CI 传 chromium/chrome 绝对路径
   浏览器：--browser > 环境变量 CHROME_BIN > macOS Edge 默认路径。
   Chromium 与 Edge 同为 Chromium 内核、CDP 协议通用，故 ubuntu runner 可复跑；
   ci 结果只作「同环境纵向回归判据」，字体与真机 WKWebView/WebView2 不同，不是终审。
   退出码：0 = 无 fail 级问题；1 = 有。warn 级（截断/命中区）不影响退出码。
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { spawn } from "node:child_process";

/* ---------- 参数 ---------- */
function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
/* 浏览器可配置：CI（ubuntu）传 chromium/chrome，本机默认 Edge。
   2026-11-25 D-185：脚本原先写死 macOS Edge 路径，CI 必然 exit 2。 */
const EDGE = arg("browser", null)
  || process.env.CHROME_BIN
  || "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
const ROOT = arg("root", null);
const PORT = Number(arg("port", 8931));   // 静态服务端口
const DPORT = PORT + 1;                   // CDP 调试端口（必须错开）
const OUT = arg("out", null);
const STEPS = Number(arg("steps", 18));
const W = Number(arg("width", 1280));
const H = Number(arg("height", 860));
if (!ROOT) { console.error("missing --root"); process.exit(2); }
if (!existsSync(ROOT)) { console.error("root 不存在（假 PASS 防护，2026-10-18 自查发现）: " + ROOT); process.exit(2); }
if (!existsSync(EDGE)) { console.error("Edge not found: " + EDGE); process.exit(2); }

/* ---------- 静态服务器 ---------- */
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
  ".map": "application/json", ".wasm": "application/wasm" };
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    let fp = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ""));
    if (!existsSync(fp) || statSync(fp).isDirectory()) {
      fp = join(ROOT, "index.html");
      if (!existsSync(fp)) { res.writeHead(404); res.end("no"); return; }
    }
    const data = await readFile(fp);
    res.writeHead(200, { "content-type": MIME[extname(fp)] || "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(500); res.end("err"); }
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

/* ---------- 启动 Edge ---------- */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
const PROFILE = mkdtempSync(join(tmpdir(), "ux-audit-profile-"));
const edge = spawn(EDGE, [
  "--headless=new", "--remote-debugging-port=" + DPORT,
  "--remote-debugging-address=127.0.0.1",
  "--no-first-run", "--no-default-browser-check", "--disable-gpu",
  "--disable-extensions", "--force-device-scale-factor=1",
  "--no-sandbox", "--disable-dev-shm-usage", "--disable-sync",
  "--window-size=" + W + "," + H, "--user-data-dir=" + PROFILE,
  "about:blank",
], { stdio: "ignore" });

async function cdpUrl() {
  let lastErr = "";
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch("http://127.0.0.1:" + DPORT + "/json/list");
      const list = await r.json();
      const pages = list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
      const blank = pages.find((t) => t.url === "about:blank");
      if ((blank || pages[0])?.webSocketDebuggerUrl) return (blank || pages[0]).webSocketDebuggerUrl;
      lastErr = "list has no page target: " + JSON.stringify(list.map((t) => t.type + ":" + t.url));
    } catch (e) { lastErr = String(e); }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("edge CDP not up: " + lastErr);
}
const ws = new WebSocket(await cdpUrl());
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let mid = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++mid;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaljs(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
}
await send("Page.enable");
await send("Runtime.enable");

/* ---------- 注入的测量脚本 ---------- */
const MEASURE = `(() => {
  const out = { clipped: [], spill: [], overlap: [], small: [], trunc: [], embedded: [], scrollOverlap: [], contrastLow: [],
    vScroll: null, docScrollX: null, theme: document.documentElement.dataset.theme || null,
    lang: document.documentElement.lang || null, controls: 0 };
  const isText = (el) => /^(P|SPAN|H1|H2|H3|H4|H5|H6|LABEL|TD|TH|LI|A|BUTTON|DIV)$/.test(el.tagName);
  const txt = (el) => (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 40);
  const sel = (el) => {
    if (!(el instanceof Element)) return "?";
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    const cls = (el.getAttribute("class") || "").split(/\\s+/).filter(Boolean).slice(0, 2).join(".");
    if (cls) s += "." + cls;
    return s;
  };
  /* aria-hidden 层（如 KaTeX 的 .katex-mathml）是给屏幕阅读器的等价副本，
     视觉上被 clip 隐藏、与人眼所见重叠；把它当可见文字会假报溢出（基线 4 条全是它）。
     同理 clip-path: inset(全裁) 的元素也不参与视觉判据。 */
  const hiddenLayer = (el) => el.closest("[aria-hidden=\\"true\\"]")
    || getComputedStyle(el).clipPath === "inset(50%)";
  const vis = (el) => {
    if (hiddenLayer(el)) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none"
      && Number(st.opacity) > 0.05;
  };
  const parseColor = (c) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(c || "");
    if (!m) return null;
    const p = m[1].split(",").map((x) => parseFloat(x));
    if (p.length < 3) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lumOf = (c) => {
    const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratioOf = (fg, bg) => {
    const L1 = lumOf(fg), L2 = lumOf(bg);
    const hi = Math.max(L1, L2), lo = Math.min(L1, L2);
    return (hi + 0.05) / (lo + 0.05);
  };
  const mixc = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const effBg = (el) => {
    const layers = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const st = getComputedStyle(n);
      if (st.backgroundImage && st.backgroundImage !== "none") return { skip: true };
      const c = parseColor(st.backgroundColor);
      if (c) { layers.push(c); if (c.a >= 1) break; }
    }
    let bg = { r: 255, g: 255, b: 255, a: 1 }; /* 最底层未知按白底（偏宽松） */
    for (let i = layers.length - 1; i >= 0; i--) bg = mixc(layers[i], bg);
    return bg;
  };
  const bigText = (st) =>
    parseFloat(st.fontSize) >= 24 || (parseFloat(st.fontSize) >= 18.66 && Number(st.fontWeight) >= 700);
  const clippedOverflowX = (el) => {
    const st = getComputedStyle(el);
    return (st.overflowX === "hidden" || st.overflowX === "clip" || st.overflowX === "auto");
  };
  /* 1. 文字溢出（被裁） */
  const all = Array.from(document.querySelectorAll("*"));
  for (const el of all) {
    if (!vis(el)) continue;
    const st = getComputedStyle(el);
    const t = txt(el);
    /* 1a. 横向裁切：滚动宽度超出且容器横向裁剪。
       有 ellipsis 的属「有意截断」（下面第 4 类单独计数），不算缺陷。 */
    if (t && el.scrollWidth > el.clientWidth + 1 && clippedOverflowX(el) && st.overflowX !== "auto"
        && st.textOverflow !== "ellipsis") {
      out.clipped.push({ sel: sel(el), text: t, over: el.scrollWidth - el.clientWidth,
        w: Math.round(el.clientWidth) });
    }
    /* 1b. 纵向裁切：文本元素被 hidden 切掉 */
    if (t && isText(el) && el.scrollHeight > el.clientHeight + 1
        && (st.overflowY === "hidden" || st.overflowY === "clip")) {
      out.clipped.push({ sel: sel(el), text: t, over: el.scrollHeight - el.clientHeight, axis: "y" });
    }
    /* 2. 文字溅出父容器（父 overflow 可见时，子右/下缘超出父盒 >2px） */
    if (t && isText(el) && el.children.length === 0) {
      const p = el.parentElement;
      if (p && p !== document.body && p !== document.documentElement) {
        const ps = getComputedStyle(p);
        if (ps.overflow === "visible" && ps.overflowX === "visible") {
          const r = el.getBoundingClientRect(), pr = p.getBoundingClientRect();
          if (r.right > pr.right + 2 || r.bottom > pr.bottom + 2) {
            out.spill.push({ sel: sel(el), text: t,
              right: Math.round(r.right - pr.right), bottom: Math.round(r.bottom - pr.bottom),
              parent: sel(p) });
          }
        }
      }
    }
    /* 3. 控件命中区过小 */
    if (/^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)
        || el.getAttribute("role") === "button") {
      out.controls++;
      const r = el.getBoundingClientRect();
      /* label 包裹的输入框（复选框/单选框）：label 整体是点击区，
         按 label 尺寸判定，不按 12-16px 的输入框本体。 */
      const wrapped = el.closest("label");
      const wr = wrapped && wrapped !== el ? wrapped.getBoundingClientRect() : null;
      const effW = wr && wr.width >= r.width ? wr.width : r.width;
      const effH = wr && wr.height >= r.height ? wr.height : r.height;
      if (vis(el) && (effW < 24 || effH < 24)) {
        out.small.push({ sel: sel(el), text: t || String(el.type || ""),
          w: Math.round(r.width), h: Math.round(r.height) });
      }
    }
    /* 4. 省略号截断（提示级，非缺陷） */
    if (t && st.textOverflow === "ellipsis" && st.whiteSpace === "nowrap"
        && el.scrollWidth > el.clientWidth + 1) {
      out.trunc.push({ sel: sel(el), text: t });
    }
  }
  /* 5. 控件重叠（按钮打架）：可交互元素对，交叠 ≥30% 较小者面积，非祖先后代 */
  const inter = all.filter((el) => vis(el) && (/^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)
    || el.getAttribute("role") === "button"));
  for (let i = 0; i < inter.length; i++) {
    for (let j = i + 1; j < inter.length; j++) {
      const a = inter[i], b = inter[j];
      if (a.contains(b) || b.contains(a)) continue;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const ix = Math.max(0, Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left));
      const iy = Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top));
      const ia = ix * iy;
      const minA = Math.min(ra.width * ra.height, rb.width * rb.height);
      if (minA > 0 && ia / minA >= 0.3) {
        /* 内嵌控件豁免：输入框内的小按钮（密码眼睛/清除钮）是刻意图案，
           输入框留了 padding 给按钮。判据：小者完整落在大者内 + 大者是输入类。 */
        const [big, small] = (ra.width * ra.height >= rb.width * rb.height) ? [a, b] : [b, a];
        const Rb = big.getBoundingClientRect(), Rs = small.getBoundingClientRect();
        const embedded = /^(BUTTON|A)$/.test(small.tagName)
          && /^(INPUT|TEXTAREA)$/.test(big.tagName)
          && Rs.left >= Rb.left - 1 && Rs.right <= Rb.right + 1
          && Rs.top >= Rb.top - 1 && Rs.bottom <= Rb.bottom + 1;
        if (embedded) {
          out.embedded.push({ selBig: sel(big), selSmall: sel(small), text: txt(small) });
          continue;
        }
        const cx = Math.max(ra.left, rb.left) + ix / 2, cy = Math.max(ra.top, rb.top) + iy / 2;
        const top = document.elementFromPoint(cx, cy);
        const topIsA = top && (a === top || a.contains(top));
        const topIsB = top && (b === top || b.contains(top));
        /* 滚动豁免：一方在可滚动容器内 → 重叠由滚动位置造成（内容从固定
           工具栏下方经过），不是布局缺陷。仅记录为 scroll 级信息。 */
        const inScroller = (el) => {
          for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
            const st = getComputedStyle(n);
            if ((st.overflowY === "auto" || st.overflowY === "scroll" || st.overflowY === "overlay")
                && n.scrollHeight > n.clientHeight + 1) return true;
          }
          return false;
        };
        if (inScroller(a) || inScroller(b)) {
          out.scrollOverlap.push({ selA: sel(a), selB: sel(b), ratio: Math.round((ia / minA) * 100) / 100 });
          continue;
        }
        out.overlap.push({ selA: sel(a), selB: sel(b),
          textA: txt(a), textB: txt(b), ratio: Math.round((ia / minA) * 100) / 100,
          rectA: [Math.round(ra.x), Math.round(ra.y), Math.round(ra.width), Math.round(ra.height)],
          rectB: [Math.round(rb.x), Math.round(rb.y), Math.round(rb.width), Math.round(rb.height)],
          topIsA, topIsB, top: top ? sel(top) : null });
      }
    }
  }
  /* 5b. 渲染态对比度（fail 级）：可见控件的文字色对其有效背景色。
       背景沿祖先链向上收集并逐层混合到第一个不透明层；有背景图者跳过（无法计算）。
       大字（≥24px 或 ≥18.66px 加粗）按 3:1；禁用态控件豁免（WCAG 对 inactive 免责）。 */
    for (const el of inter) {
      const st = getComputedStyle(el);
      if (el.disabled === true) continue;
      const fgRaw = parseColor(st.color);
      if (!fgRaw) continue;
      const bg = effBg(el);
      if (!bg || bg.skip) continue;
      const fg = fgRaw.a < 1 ? mixc(fgRaw, bg) : fgRaw;
      const need = bigText(st) ? 3 : 4.5;
      const r = Math.round(ratioOf(fg, bg) * 100) / 100;
      if (r < need) out.contrastLow.push({ sel: sel(el), text: txt(el), ratio: r, need: need });
    }
  /* 6. 视口溢出 */
  out.vScroll = document.documentElement.scrollWidth > window.innerWidth + 1;
  out.docScrollX = document.documentElement.scrollWidth - window.innerWidth;
  return out;
})()`;

/* 点击候选：导航/功能按钮，跳过破坏性与外链 */
const CLICK_CANDIDATE = `(() => {
  const bad = /(delete|remove|uninstall|quit|exit|close app|reset|wipe|clear all|sign out|log out)/i;
  const els = Array.from(document.querySelectorAll('button, a, [role="button"]'));
  const out = [];
  for (const el of els) {
    const st = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (st.visibility === "hidden" || st.display === "none") continue;
    if (r.width < 8 || r.height < 8) continue;
    if (el.href && /^https?:/.test(el.href) && el.target === "_blank") continue;
    const t = (el.textContent || "").trim();
    if (bad.test(t)) continue;
    if (/^(#|\\/)/.test(el.getAttribute("href") || "") ) continue;
    out.push(t.slice(0, 24));
  }
  return out;
})()`;

const results = { root: ROOT, width: W, height: H, steps: [] };

await send("Page.navigate", { url: "http://127.0.0.1:" + PORT + "/index.html" });
await new Promise((r) => setTimeout(r, 900));
let first = await evaljs(MEASURE);
first.clicked = "(initial)";
results.steps.push(first);

/* 深度状态遍历：逐个点按钮（每个只点一次），每步重新测量 */
const clicked = new Set();
for (let step = 0; step < STEPS; step++) {
  const cands = await evaljs(CLICK_CANDIDATE);
  const next = (cands || []).find((t) => t && !clicked.has(t));
  if (!next) break;
  clicked.add(next);
  const res = await evaljs(`(() => {
    const bad = ${JSON.stringify(next)};
    const els = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    const el = els.find((e) => (e.textContent||"").trim().slice(0,24) === bad);
    if (!el) return "gone";
    try { el.click(); } catch (e) { return "err"; }
    return "ok";
  })()`);
  if (res !== "ok") continue;
  await new Promise((r) => setTimeout(r, 450));
  await evaljs("document.querySelectorAll('dialog[open], .modal, [role=dialog]').forEach(d=>{try{d.close?d.close():null}catch(e){}})");
  let m;
  try { m = await evaljs(MEASURE); } catch { continue; }
  m.clicked = next;
  results.steps.push(m);
}

/* ---------- 汇总 ---------- */
function tally() {
  const c = { clipped: 0, spill: 0, overlap: 0, small: 0, trunc: 0, embedded: 0, scrollOverlap: 0, contrastLow: 0 };
  const seen = { clipped: new Set(), spill: new Set(), overlap: new Set(), small: new Set(), contrastLow: new Set() };
  const examples = { clipped: [], spill: [], overlap: [], small: [], contrastLow: [] };
  for (const s of results.steps) {
    for (const k of ["clipped", "spill", "overlap", "small", "contrastLow"]) {
      for (const it of (s[k] || [])) {
        const key = JSON.stringify(it);
        if (seen[k].has(key)) continue;
        seen[k].add(key); c[k]++;
        if (examples[k].length < 12) examples[k].push({ ...it, step: s.clicked });
      }
    }
    c.trunc += (s.trunc || []).length;
    c.embedded += (s.embedded || []).length;
    c.scrollOverlap += (s.scrollOverlap || []).length;
  }
  return { counts: c, examples };
}
const { counts, examples } = tally();
results.counts = counts;
results.examples = examples;

const fail = counts.clipped + counts.spill + counts.overlap + counts.contrastLow > 0;
const pass = !fail;
console.log("");
console.log("  ── UX 审计：" + ROOT + "（" + results.steps.length + " 个状态）──");
  console.log("  文字溢出(clipped)   " + counts.clipped);
  console.log("  文字溅出(spill)    " + counts.spill);
  console.log("  控件重叠(overlap)  " + counts.overlap);
  console.log("  命中区过小(small)  " + counts.small + "  (warn)");
  console.log("  对比度不足(contrastLow) " + counts.contrastLow + "  (fail)");
  console.log("  内嵌控件(embedded) " + counts.embedded + "  (刻意图案，豁免)");
  console.log("  滚动瞬态(scroll)   " + counts.scrollOverlap + "  (内容滚过固定条，豁免)");
  console.log("  省略号截断(trunc) " + counts.trunc + "  (提示级)");
console.log("  裁断：" + (pass ? "**PASS**" : "**FAIL**"));
console.log("");
for (const k of ["overlap", "clipped", "spill", "contrastLow"]) {
  if (!examples[k].length) continue;
  console.log("  [" + k + "]");
  for (const e of examples[k]) {
    const where = e.step ? "@" + e.step : "";
    if (k === "overlap") console.log("   - " + e.selA + " ↔ " + e.selB + " （" + Math.round(e.ratio * 100) + "% " + JSON.stringify(e.textA) + " / " + JSON.stringify(e.textB) + "） A" + JSON.stringify(e.rectA) + " B" + JSON.stringify(e.rectB) + (e.topIsA ? " A在顶" : e.topIsB ? " B在顶" : " 第三方在顶") + where);
    if (k === "clipped") console.log("   - " + e.sel + " " + JSON.stringify(e.text) + " 超 " + e.over + "px" + where);
    if (k === "spill") console.log("   - " + e.sel + " " + JSON.stringify(e.text) + " 右溢 " + e.right + "px / 下溢 " + e.bottom + "px → " + e.parent + where);
    if (k === "contrastLow") console.log("   - " + e.sel + " " + JSON.stringify(e.text) + " 对比度 " + e.ratio + ":1（需 " + e.need + ":1）" + where);
  }
  console.log("");
}
if (OUT) await (await import("node:fs/promises")).writeFile(OUT, JSON.stringify(results, null, 1));

ws.close(); edge.kill();
try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
server.close();
process.exit(pass ? 0 : 1);
