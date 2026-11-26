"""生成 Pic2WebP Windows 侧测试样张。

六类：
1. flat.png      基准色块（左红右蓝 + 顶部绿条），用来验证输出颜色/Gamma 没被搞乱
2. ori5.jpg / ori7.jpg   镜像类 EXIF 方向（5 = 镜像+90，7 = 镜像+270）
3. ori6.jpg / ori8.jpg   旋转类 EXIF 方向（对照组）
4. grad16.png    16-bit 灰度渐变，看是否被压成 8-bit 出现台阶
5. fake.heic     扩展名 .heic、内容是 JPEG，验证「不支持 HEIC」的提示路径
6. ori5.tif      TIFF 带 EXIF 方向 5 —— 后端白名单曾漏 .tif，且 TIFF 的 EXIF
                  方向是否被 image crate 处理要实测
7. 中文 名 空格.jpg  Windows 上最常见的两类路径麻烦
8. sub/           --recursive 目录扫描的输入
"""
import os
import shutil
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), "in")
os.makedirs(OUT, exist_ok=True)


def base(w=400, h=300):
    im = Image.new("RGB", (w, h), (255, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle([w // 2, 0, w, h], fill=(0, 0, 255))
    d.rectangle([0, 0, w, 30], fill=(0, 200, 0))
    return im


base().save(os.path.join(OUT, "flat.png"))

for o in (5, 6, 7, 8):
    im = base()
    exif = Image.Exif()
    exif[274] = o
    im.save(os.path.join(OUT, "ori%d.jpg" % o), quality=95, exif=exif)

im16 = Image.new("I;16", (600, 400))
px = im16.load()
for y in range(400):
    for x in range(600):
        px[x, y] = int((x / 599) * 65535)
im16.save(os.path.join(OUT, "grad16.png"))

jpg = os.path.join(OUT, "_tmp.jpg")
base().save(jpg, quality=90)
shutil.move(jpg, os.path.join(OUT, "fake.heic"))

# ── 2026-11-26 追加：TIFF + Windows 路径麻烦 ──────────────────────────
# TIFF **不写 EXIF orientation**。PIL 存 TIFF 时若带 orientation 会先把像素
# 转好再写（存出来已经是 300x400），那这份样张测的就不再是「orientation
# 有没有被应用」，而是「转了两次没有」。EXIF 方向一律用 ori*.jpg 测
# （JPEG 保存不自动转像素，存出来是原始 400x300 + orientation 标签）。
for name in ("ori5.tif", "ori6.tif", "ori7.tif", "ori8.tif"):
    p = os.path.join(OUT, name)
    if os.path.exists(p):
        os.remove(p)
base().save(os.path.join(OUT, "plain.tif"))

# 中文名 + 空格名（Windows 上最常见的两类路径麻烦）
base().save(os.path.join(OUT, "中文 空格 名.jpg"), quality=90)

# --recursive 的输入：一个带子目录的目录
sub = os.path.join(OUT, "sub")
os.makedirs(sub, exist_ok=True)
for i in (1, 2):
    base().save(os.path.join(sub, "nested%d.png" % i))

for f in sorted(os.listdir(OUT)):
    p = os.path.join(OUT, f)
    size = os.path.getsize(p)
    try:
        dim = Image.open(p).size
    except Exception:
        dim = "?"
    print(f, size, dim)
