#!/usr/bin/env node
/* 把产品页的截图区换成「细节卷轴」。
 *
 * 一次性改写脚本（跑完就把结果当源文件维护），与 apply-buy-blocks.mjs 同一路数：
 * 站点没有构建步骤，所以结构只能由脚本落进 HTML，而不是在构建时拼出来。
 *
 * 底图来源：assets/screenshots/<capture>.webp（macOS 2 倍抓屏）
 * 裁切来源：tools/shots.json → tools/crop_shots.py → assets/showcase/*.webp + manifest.json
 * 这里只负责「把已经裁好的图排进页面」，不碰裁切。
 *
 * 幂等：第二次运行会命中 id="app" 的 section，整体覆盖，不会套娃。
 * journal.html 原本没有截图区，第一次运行插在下载区之前；插进去的那段本身带
 * id="app"，所以之后再跑就走同一条覆盖路径。
 *
 * 用法：node tools/apply-reel.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..");
const START = "<!-- reel:start -->";
const END = "<!-- reel:end -->";

/* 每个面板：裁图名、alt、标签、说明。
   标签与说明各带一个 data-i18n 键，中文译文在 tools/i18n/zh.mjs 里。
   图片的 CSS 宽高从 assets/showcase/manifest.json 读（crop_shots.py 生成），
   页面上按 1:1 CSS 渲染 —— Retina 上像素对齐，不再发虚。 */
const PRODUCTS = {
  pdf: {
    stops: [
      ["pdf-page",
        "Page one of a report open in Rocktier PDF: a title block, a summary section set in body text and a shaded outcome box",
        "A page, not a canvas",
        "Real text: click anywhere and drag to select it. Nothing is wrapped in an image, so nothing re-flows when you copy it out."],
      ["pdf-tools",
        "The tools list in the right panel: compress, password protection, fill form, to Markdown, page numbers",
        "Five operations, one column",
        "Compress, password, forms, page numbers, Markdown. One list on the right, always in the same order, never a menu tree."],
      ["pdf-sign",
        "The digital signature block, marked unsigned, with sign and verify buttons below it",
        "Signed on this machine",
        "Sign and verify inside the document. Both routines run on your device, so the file never leaves it."],
      ["pdf-compress",
        "The Compress PDF dialog with three quality options, balanced selected, a choose output button and cancel and compress buttons",
        "Compress to a size you choose",
        "Smallest, balanced or archive quality, and a destination you pick. The original file is never modified."]
    ]
  },
  markdown: {
    stops: [
      ["md-source",
        "The source pane of Rocktier Markdown: the file itself, with a hash heading, a subheading and a quote marker",
        "Source, exactly as typed",
        "The left pane is the file itself: hashes, quote markers, the line breaks you typed. No hidden database, no format of our own."],
      ["md-preview",
        "The typeset preview of the same document: the title in large type, a rule, body text and a subheading",
        "The same bytes, set",
        "Heading weights, paragraph rhythm, the quote set off with a rule. This render is what Export PDF and the HTML export start from."],
      ["md-outline",
        "The outline panel listing every heading in the document, with a filter field above it",
        "Every heading, one list",
        "The outline is read from the hashes, not from a separate index. Click a line and the cursor goes there. Nothing to maintain."]
    ]
  },
  pic2webp: {
    stops: [
      ["webp-saving",
        "Five converted photos in a grid, each carrying a minus 66 or minus 67 percent badge and a line reading old size to new size",
        "The saving, per file",
        "Five photos, five answers: minus 66 to 67 percent, with the old and new weight on every card."],
      ["webp-detail",
        "Two converted cards close up: dunes.jpg went from 1.9 MB to 613.6 KB, a 67 percent saving",
        "One card, measured",
        "1.9 MB down to 613 KB. The badge and the line under the file name carry the same number."]
    ]
  },
  ocr: {
    stops: [
      ["ocr-drop",
        "The OCR drop zone with the accepted formats listed and a chosen file, scan.jpg, with its full path underneath",
        "One file, three formats",
        "A scan or a single image, PDF, PNG or JPG. Pages that already carry text are skipped and never overwritten."],
      ["ocr-result",
        "The OCR result panel with four counters: pages 1, recognised 1, skipped 0, lines 5",
        "The result, counted",
        "Pages, recognised, skipped, lines. Nothing is written to disk until you export."]
    ]
  },
  "cad-viewer": {
    stops: [
      ["cad-plan",
        "A floor plan in Rocktier CAD Viewer with room names, floor areas and door swings drawn to scale",
        "Drawn to scale, still readable",
        "Room names, floor areas and dimensions come through the DXF intact. No AutoCAD, no conversion step."],
      ["cad-layers",
        "The layers panel: named drawing layers, each with the colour chip it was drawn in and a visibility toggle",
        "Layers, named and coloured",
        "Every layer in the file, with the colour it was drawn in and its own visibility toggle."]
    ]
  },
  write: {
    stops: [
      ["wr-page",
        "A manuscript page in Rocktier Write: a title, a chapter heading and body text set in Times New Roman",
        "The page is the interface",
        "Times New Roman, double spaced, one-inch margins. No panels competing with the text, and what you see is what prints."],
      ["wr-modes",
        "The rich, edit and preview tabs with a compare button, above a formatting toolbar of bold, italic, heading and list controls",
        "Rich, edit, preview",
        "Format in rich mode, fix the source in edit mode, read the typeset page in preview. Compare puts two of them side by side."],
      ["wr-chapters",
        "The chapters panel listing five headings with their word counts, ending with an end of sample entry",
        "Headings become chapters",
        "Headings become chapters with a word count. Click a line and the cursor goes there: nothing to maintain."]
    ]
  },
  compressor: {
    stops: [
      ["cmp-results",
        "Seven files in Rocktier Compressor after a run: each row shows the original size, a progress bar, the new size, the percentage saved and a status, with one row marked already optimized",
        "Seven files, seven verdicts",
        "1.2 MB to 333 KB, 484 KB to 103 KB, a PDF that lost a quarter of its weight, and one file honestly reported as already optimized."],
      ["cmp-profiles",
        "The profile panel: Default, Web, Print, Screen and Maximum, a three-step quality control set to Balanced, and target size buttons from 1 to 25 MB",
        "A profile, not a set of sliders",
        "Pick what the file is for and the settings follow. Screen came out at 68 percent off across the seven files."]
    ]
  },
  journal: {
    /* journal.html 本来没有截图区，这里给它插一个。
       锚点用 id，不整段匹配 section 的属性（那一节是 "section alt"，属性会变）； 
       代码会从这个 id 往前退到它所属的 <section 开头。 */
    before: 'id="download"',
    stops: [
      ["jr-lock",
        "The Rocktier Journal lock screen: a single password field and an unlock button, with the line offline is the best safety above it",
        "One password, and that is all",
        "Nothing opens without it. What sits on the disk is ciphertext, and this window is the only door."],
      ["jr-page",
        "Today's journal page with the date, a row of mood faces, a title, a formatting toolbar and three paragraphs of text",
        "The day is already dated",
        "Open it and today is there, with the mood row if you want it. One toolbar, one page, nothing else in the way."],
      ["jr-timeline",
        "The timeline view listing four entries by date with their titles and word counts",
        "Every day you wrote",
        "Newest first, each with its word count. Click a line and you are back in that evening."],
      ["jr-search",
        "The search view with the word minutes typed in, two matching entries listed, and a note that title and content search is local only",
        "Search inside the ciphertext",
        "Titles and bodies both, matched on your machine. Small vaults answer instantly; larger ones decrypt in memory as they go."]
    ]
  }
};

const MANIFEST_PATH = join(SITE, "assets", "showcase", "manifest.json");
if (!existsSync(MANIFEST_PATH)) {
  console.error("  ❌ 没有 assets/showcase/manifest.json，先跑 python3 tools/crop_shots.py");
  process.exit(1);
}
const MANIFEST = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));

const sizeOf = (img) => {
  const m = MANIFEST[img];
  if (!m) throw new Error(`没有尺寸记录: ${img}（先跑 tools/crop_shots.py）`);
  return [m[0], m[1]];                    // [cssW, cssH]
};

const pad2 = (n) => String(n).padStart(2, "0");

function render(page, { stops }) {
  const total = pad2(stops.length);
  const sized = stops.map((s) => [...s, ...sizeOf(s[0])]);   // 尺寸跟在原参数后面
  /* 媒体行高度取本页最高的一张：图注因此共用同一条基线，
     切换细节时文字不会上下跳。这是「宽窄跟着内容走」的前提。 */
  const rowH = Math.max(...sized.map((s) => s[5]));
  const colW = Math.max(...sized.map((s) => s[4]));
  const panels = sized.map(([img, alt, label, body, w, h], i) => {
    const n = i + 1;
    return `              <figure class="reel-panel${i === 0 ? " is-on" : ""}" role="tabpanel" id="${page}-p${n}" aria-labelledby="${page}-t${n}" aria-hidden="${i === 0 ? "false" : "true"}" style="--pw:${w};--ph:${h}">
                <div class="reel-frame">
                  <img src="assets/showcase/${img}.webp" width="${w}" height="${h}" alt="${alt}" loading="lazy" decoding="async">
                </div>
                <figcaption class="reel-cap">
                  <span class="reel-cap-no">${pad2(n)} / ${total}</span>
                  <b data-i18n="reel.${page}.${n}">${label}</b>
                  <p data-i18n="reel.${page}.${n}b">${body}</p>
                </figcaption>
              </figure>`;
  }).join("\n");

  const tabs = stops.map(([, , label], i) => {
    const n = i + 1;
    return `          <button class="reel-tab" type="button" role="tab" id="${page}-t${n}" aria-controls="${page}-p${n}" aria-selected="${i === 0 ? "true" : "false"}" tabindex="${i === 0 ? "0" : "-1"}">
            <span class="reel-no">${pad2(n)}</span>
            <span class="reel-label" data-i18n="reel.${page}.${n}">${label}</span>
            <span class="reel-fill" aria-hidden="true"></span>
          </button>`;
  }).join("\n");

  return `  <section class="section" id="app">
    <div class="wrap">
      ${START}
      <div class="sec-head">
        <h2 class="sec-title" data-i18n="reel.title">Details, not mockups.</h2>
        <p data-i18n="reel.sub">Every image here is a crop of the shipping build, shown close to the size it renders on your screen.</p>
      </div>
      <div class="reel" data-reel style="--reel-h:${rowH}px;--reel-w:${colW}">
        <div class="reel-main">
          <div class="reel-stage">
            <div class="reel-stack">
${panels}
            </div>
          </div>
        </div>
        <div class="reel-tabs" role="tablist" aria-orientation="vertical" aria-label="Screenshot details">
${tabs}
        </div>
        <!-- 暂停钮挂在目录列的底部，而不是面板下方：
             面板下方它孤零零悬在背景上，右侧目录列又空着一大截。
             放在这里两件事一起解决，读起来也像目录的页脚。 -->
        <div class="reel-foot">
          <button class="reel-pause" type="button" aria-pressed="false" hidden>
            <svg class="ic-pause" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><rect x="2" y="1.5" width="3" height="9" rx="1"/><rect x="7" y="1.5" width="3" height="9" rx="1"/></svg>
            <svg class="ic-play" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M3 1.6v8.8l7-4.4z"/></svg>
            <span data-i18n="reel.pause">Pause</span>
          </button>
        </div>
      </div>
      ${END}
    </div>
  </section>`;
}

let changed = 0;
for (const [page, data] of Object.entries(PRODUCTS)) {
  const file = join(SITE, `${page}.html`);
  if (!existsSync(file)) {
    console.error(`  ❌ 找不到 ${page}.html`);
    process.exitCode = 1;
    continue;
  }
  let html = readFileSync(file, "utf8");
  const block = render(page, data);

  /* 幂等的关键：无论第几次运行，都从 section 起点改到它自己的 </section>。
     这个 section 里没有嵌套 section，所以「第一个 </section>」就是它的终点，
     第二次运行不会套娃，只会整体覆盖。START/END 标记留在产物里，是为了让人
     一眼看出这段是脚本生成的。 */
  const marker = '<section class="section" id="app">';
  const a = html.indexOf(marker);
  if (a >= 0) {
    const lineStart = html.lastIndexOf("\n", a) + 1;
    const b = html.indexOf("</section>", a) + "</section>".length;
    html = html.slice(0, lineStart) + block + html.slice(b);
  } else if (data.before && html.includes(data.before)) {
    /* 页面从来没有截图区：插在锚点所属的 section 之前。
       插进去的这段自带 id="app"，所以下一次运行会走上面的覆盖路径。 */
    const hit = html.indexOf(data.before);
    const at = html.lastIndexOf("<section", hit);
    const lineStart = html.lastIndexOf("\n", at) + 1;
    html = html.slice(0, lineStart) + block + "\n\n" + html.slice(lineStart);
  } else {
    console.error(`  ❌ ${page}.html 里既没有 id="app" 的 section，也没有插入锚点`);
    process.exitCode = 1;
    continue;
  }

  if (!html.includes('src="js/reel.js"')) {
    /* 缩进不统一（pdf 是两格，其余是零格），所以匹配时把行首空白一起吃进来，
       再用回调还回去，避免把 <script> 顶到行首。 */
    html = html.replace(/(\n\s*)<script src="js\/main\.js"><\/script>/, (m, ws) =>
      `${ws}<script src="js/main.js"></script>${ws}<script src="js/reel.js"></script>`);
  }
  writeFileSync(file, html);
  changed++;
  console.log(`  ✅ ${page}.html  ${data.stops.length} 个细节`);
}
console.log(`\n  ${changed} 个页面已改写`);
