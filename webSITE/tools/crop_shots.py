#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按「一格说一件事」裁出产品页的细节图。

为什么是 2x
-----------
抓屏用 `screencapture -l <窗口ID> -o`，Retina 上直接拿到 2 倍像素（1200x800 的
窗口是 2400x1600 像素）。裁切保留原始像素，页面上按 **1:1 CSS** 渲染 ——
CSS 宽 = 像素 / 2。于是 1 个 CSS 像素正好落在 2 个物理像素上，界面文字是
像素对齐的，不再像旧版那样把 1600px 的图压进 772px 的栏里发虚。

取景纪律（第一性）
------------------
1) **只留要说明的那个东西**。裁掉窗口外壳、标题栏、红绿灯、侧栏里与之无关的
   区块，也不要把「顺带能看到」的界面带进来。一格的答案只能是一个问题。
2) **上下边沿落在行间空白**。卡片边沿压着半行字时，那行会被横向切掉下半截，
   看着像渲染错位而不是取景。用 ink_edges() 量化校验，不靠肉眼。
3) **左边沿不切断正文**：只允许落在面板分界、页面边缘这类自然边界上。
   右边沿可以切（正文在右侧继续），左边不行。
4) 比例不强制统一。宽窄跟着内容走，页面侧用固定媒体行高对齐图注
   （见 css 的 --reel-h），所以 8:5 不再是纪律。

用法：
    python3 tools/crop_shots.py            # 全部
    python3 tools/crop_shots.py md-source  # 只重裁一张
产物：
    assets/showcase/<name>.webp   2x 像素
    assets/showcase/manifest.json 每张的 css/px 尺寸，供 apply-reel.mjs 取用
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageStat

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "screenshots"
OUT = ROOT / "assets" / "showcase"
PLAN = Path(__file__).resolve().parent / "shots.json"


def edge_spread(im: Image.Image) -> tuple[float, float]:
    """上/下边沿那一行像素的亮度标准差。

    这条判据只回答一个问题：**边沿上是不是压着一行字**。
    - 空白行 → 全白，std ≈ 0
    - 面板边框 → 一色细线，std ≈ 0
    - 被切掉半截的文字 → 墨色与底色相间，std 很大（实测浅色界面 >25、深色界面 >40）
    深色界面（OCR / CAD）里，面板顶边那道提亮的发丝线本身就有 15~20 的分散度，
    阈值因此定在 22：放得过边框线，挡得住半行字。

    早先试过「相邻行差」，它把边框线也判成内容（边框与白底差值很大），
    于是每张带标题栏的取景都误报。换成横向分散度后，边框和无字都判绿。
    """
    g = im.convert("L")
    w, h = g.size

    def band(y: int) -> float:
        return round(ImageStat.Stat(g.crop((0, max(0, min(h - 1, y)), w, max(0, min(h - 1, y)) + 1))).stddev[0], 1)

    return band(0), band(h - 1)


def main() -> None:
    plan = json.loads(PLAN.read_text(encoding="utf-8"))["crops"]
    only = set(sys.argv[1:])
    OUT.mkdir(parents=True, exist_ok=True)
    manifest_path = OUT / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}

    problems = []
    for name, (capture, x, y, w, h) in plan.items():
        if only and name not in only:
            continue
        path = SRC / f"{capture}.webp"
        if not path.exists():
            problems.append(f"{name}: 找不到源图 {path.name}")
            continue
        im = Image.open(path).convert("RGB")
        if (x, y, w, h) != (int(x), int(y), int(w), int(h)):
            problems.append(f"{name}: 坐标必须是整数")
            continue
        if x < 0 or y < 0 or x + w > im.width or y + h > im.height:
            problems.append(f"{name}: 越界 {x},{y},{w},{h} 源图 {im.width}x{im.height}")
            continue
        box = im.crop((x, y, x + w, y + h))
        top, bottom = edge_spread(box)
        if top > 22 or bottom > 22:
            problems.append(f"{name}: 边沿压着半行字（上 {top} / 下 {bottom}），挪几像素进空白行")
        out = OUT / f"{name}.webp"
        box.save(out, "WEBP", quality=90, method=6)
        manifest[name] = [w // 2, h // 2, w, h]
        print(f"  {name:<18} {w}x{h}px  css {w//2}x{h//2}  {out.stat().st_size // 1024} KB")

    # 清单只保留还在取景单里的项：删掉一项取景，记录也跟着走，
    # 免得积一堆没人引用的尺寸（旧版就是这样把 26 条留在 23 张的清单里）。
    stale = [k for k in manifest if k not in plan]
    for k in stale:
        del manifest[k]
    manifest_path.write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n")
    if stale:
        print(f"\n  ℹ️ 清掉 {len(stale)} 条已不在取景单里的记录: {', '.join(sorted(stale))}")

    if problems:
        print("\n  ❌ 有取景没通过：")
        for p in problems:
            print("     " + p)
        raise SystemExit(1)
    print(f"\n  ✅ {len(manifest)} 张细节图，清单已更新")


if __name__ == "__main__":
    main()
