#!/usr/bin/env python3
"""重做两张 og 图（社交分享缩略图）：assets/og/index.png 与 assets/og/pdf-squeeze.png。

为什么重做：原图右侧嵌着一张**应用界面截图**，而那张截图是旧版「Rocktier PDF
Squeeze」压缩器的界面。产品在 2026-09-19 已与 PDF Editor 合并重做为
「Rocktier PDF」，界面与能力范围都完全不同了，于是任何人分享这两页，预览图里
都印着一个已经不存在的产品，还把它的能力说小了。

为什么不是「换一张新截图」：当前版本的真实截图需要在应用里现截，本机没有。
用生成式模型画界面会编出并不存在的按钮（taste skill 也明令禁止假界面预览）。
所以改成**纯排版卡**：品牌底 + 产品名 + 真实能力清单，每个字都可以对着 README 核。

    python3 tools/make_og.py
"""

import pathlib
import re
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "og"
W, H = 1200, 630

# 颜色从站点 CSS 取，避免 og 图与页面各用一套黑
css = (ROOT / "css" / "styles.css").read_text(encoding="utf-8")


def parse_color(value):
    """CSS 里的颜色可能是 rgba(...)，Pillow 不认，归一成 RGB 元组。"""
    value = value.strip()
    m = re.match(r"rgba?\(([^)]+)\)", value)
    if m:
        parts = [p.strip() for p in m.group(1).split(",")]
        return tuple(int(float(parts[i])) for i in range(3))
    return value


def token(name, fallback):
    m = re.search(r"--" + name + r"\s*:\s*([^;]+);", css)
    return parse_color(m.group(1)) if m else parse_color(fallback)


BG = token("bg", "#0a0a0b")
TEXT = token("text", "#f2f2f2")
MUTED = token("text3", "#8b8b90")
RED = token("red", "#e0513f")

SANS = [
    ("/System/Library/Fonts/SFNS.ttf", 0),
    ("/System/Library/Fonts/Helvetica.ttc", 0),
    ("/System/Library/Fonts/Supplemental/Arial.ttf", 0),
]
MONO_FONTS = [
    ("/System/Library/Fonts/SFNSMono.ttf", 0),
    ("/System/Library/Fonts/Menlo.ttc", 0),
    ("/System/Library/Fonts/Supplemental/Courier New.ttf", 0),
]


def load(candidates, size):
    for path, index in candidates:
        try:
            return ImageFont.truetype(path, size, index=index)
        except Exception:
            continue
    return ImageFont.load_default()


f_title = load(SANS, 84)
f_sub = load(SANS, 27)
f_label = load(MONO_FONTS, 19)
f_item = load(SANS, 25)
f_note = load(SANS, 21)
f_url = load(MONO_FONTS, 24)

LEFT = 82
CARDS = [
    {
        "file": "index.png",
        "title": "Rocktier",
        "sub": "Offline tools for macOS and Windows.",
        "label": "THE TOOLS",
        "items": [
            ("Rocktier PDF", "read, edit, compress"),
            ("Rocktier Pic2WebP", "images to WebP"),
            ("Rocktier Markdown", "write in plain text"),
            ("Rocktier CAD Viewer", "DWG and DXF"),
        ],
        "note": "One-time purchase. Nothing is uploaded.",
    },
    {
        "file": "markdown.png",
        "title": "Rocktier Markdown",
        "sub": "Write in plain text. Yours forever.",
        "label": "IN THE APP",
        "items": [
            ("Preview", "tables, code, maths"),
            ("Outline", "follows along"),
            ("Export", "HTML or print to PDF"),
            ("Files", "ordinary .md"),
        ],
        "note": "On the Microsoft Store.",
    },
    {
        "file": "pdf-squeeze.png",
        "title": "Rocktier PDF",
        "sub": "Read, edit and compress PDFs. Fully offline.",
        "label": "IN THE APP",
        "items": [
            ("Compress", "three strengths"),
            ("Pages", "reorder, split, merge"),
            ("Annotate", "highlight, sign, stamp"),
            ("Forms", "fill text and boxes"),
            ("Encrypt", "AES-128"),
            ("Export", "PNG out, images in"),
        ],
        "note": "7-day trial, then $4.99 once.",
    },
]

OUT.mkdir(parents=True, exist_ok=True)
for card in CARDS:
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    d.ellipse([LEFT, 84, LEFT + 22, 106], fill=RED)
    d.text((LEFT, 150), card["title"], font=f_title, fill=TEXT)
    d.text((LEFT, 268), card["sub"], font=f_sub, fill=MUTED)

    d.line([LEFT, 512, LEFT + 118, 512], fill=RED, width=4)
    d.text((LEFT, 540), "rocktier.com", font=f_url, fill=TEXT)

    # 右侧：真实能力清单（原图这里是那张过时的界面截图）
    RX = 660
    d.text((RX, 150), card["label"], font=f_label, fill=MUTED)
    y = 196
    for name, desc in card["items"]:
        d.ellipse([RX + 2, y + 11, RX + 8, y + 17], fill=RED)
        d.text((RX + 26, y), name, font=f_item, fill=TEXT)
        w = d.textlength(name, font=f_item)
        d.text((RX + 36 + w, y + 3), desc, font=f_note, fill=MUTED)
        y += 46

    d.text((RX, 540), card["note"], font=f_note, fill=MUTED)

    path = OUT / card["file"]
    img.save(path, "PNG", optimize=True)
    print(f"  ✅ {card['file']}  {img.size[0]}x{img.size[1]}  {path.stat().st_size // 1024} KB")
