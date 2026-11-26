"""Pic2WebP Windows 端行为验收（CLI 路径）。

跑法：
    python make_fixtures.py                       # 先生成样张（需要 Pillow）
    python check_cli.py <pic2webp.exe 路径>        # 再跑验收

输出：每项 PASS / FAIL / INFO，最后打印汇总。退出码：0 = 全绿，1 = 有 FAIL。

覆盖的行为（2026-11-26 Windows 本机首跑，15 PASS / 0 FAIL / 3 INFO）：
  · 基本转换 + 颜色保真（左红右蓝顶绿，逐像素核对）
  · EXIF 方向 6/8/5/7 转正 —— **命令行曾经完全不转**（D-196，界面转、脚本躺）
  · `.tif` 能被转换 —— **后端白名单曾经漏这个后缀**（D-196 同批，静默丢弃）
  · 中文名 + 空格名（Windows 上最常见的两类路径麻烦）
  · `--recursive` 扫子目录
  · 16-bit 灰度渐变未塌成 8-bit
  · 批量转换产物数与输入数对得上
  · 单张大图耗时（吞吐观察）

样张里的 `fake.heic` / `fake.heif` 内容其实是 JPEG —— 它们测的是「按内容嗅探」
的行为（CLI 不按后缀过滤），不是真的 HEIC。产品本身**不支持 HEIC**。
"""
import os
import shutil
import struct
import subprocess
import sys
import time

if len(sys.argv) < 2:
    print("用法: python check_cli.py <pic2webp.exe 路径>")
    print("（样张先跑 make_fixtures.py 生成）")
    sys.exit(2)

EXE = sys.argv[1]
HERE = os.path.dirname(os.path.abspath(__file__))
IN = os.path.join(HERE, "in")
OUT = os.path.join(HERE, "out")

results = []


def ok(name, cond, detail=""):
    results.append(("PASS" if cond else "FAIL", name, detail))


def info(name, detail):
    results.append(("INFO", name, detail))


def run(args, timeout=120):
    t0 = time.time()
    p = subprocess.run([EXE, "--cli"] + args, capture_output=True, text=True, timeout=timeout)
    return p, time.time() - t0


def webp_dims(path):
    """读 WebP 头拿宽高（VP8/VP8L/VP8X 三种）。"""
    with open(path, "rb") as f:
        data = f.read(40)
    assert data[:4] == b"RIFF" and data[8:12] == b"WEBP", "不是 WebP"
    fourcc = data[12:16]
    if fourcc == b"VP8 ":
        w, h = struct.unpack("<HH", data[26:30])
        return w & 0x3FFF, h & 0x3FFF
    if fourcc == b"VP8L":
        bits = struct.unpack("<I", data[21:25])[0]
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    if fourcc == b"VP8X":
        w = 1 + int.from_bytes(data[24:27], "little")
        h = 1 + int.from_bytes(data[27:30], "little")
        return w, h
    raise AssertionError("未知 WebP 分块 %r" % fourcc)


def px(path, x, y):
    from PIL import Image
    im = Image.open(path).convert("RGB")
    return im.getpixel((x, y))


def main():
    if not os.path.exists(EXE):
        print("找不到可执行文件:", EXE)
        return 1
    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(OUT, exist_ok=True)

    # 1) 基本转换 + 颜色保真
    p, dt = run([os.path.join(IN, "flat.png"), "-q", "90", "-o", OUT])
    flat_out = os.path.join(OUT, "flat-webp.webp")
    ok("基本转换出文件", os.path.exists(flat_out), os.path.basename(flat_out))
    if os.path.exists(flat_out):
        w, h = webp_dims(flat_out)
        ok("尺寸保持 400x300", (w, h) == (400, 300), f"{w}x{h}")
        left, right, top = px(flat_out, 40, 200), px(flat_out, 360, 200), px(flat_out, 200, 10)
        ok("左半仍是红", left[0] > 200 and left[1] < 60 and left[2] < 60, str(left))
        ok("右半仍是蓝", right[2] > 200 and right[0] < 60, str(right))
        ok("顶条仍是绿", top[1] > 150 and top[0] < 60, str(top))

    # 2) EXIF 方向：GUI 会转正，CLI 是否也转
    for o in (6, 8, 5, 7):
        src = os.path.join(IN, f"ori{o}.jpg")
        p, dt = run([src, "-q", "95", "-o", OUT])
        out = os.path.join(OUT, f"ori{o}-webp.webp")
        if not os.path.exists(out):
            ok(f"ori{o} 出文件", False, p.stderr.strip()[-120:])
            continue
        w, h = webp_dims(out)
        # 方向 5..8 都会把 4:3 转成 3:4
        ok(f"ori{o} 已转正（应为 300x400）", (w, h) == (300, 400), f"实际 {w}x{h}")

    # 2b) .tif：后端白名单曾漏这个后缀（静默丢弃，进得了列表出不了产物）
    tif = os.path.join(IN, "plain.tif")
    p, dt = run([tif, "-q", "90", "-o", OUT])
    tif_out = os.path.join(OUT, "plain-webp.webp")
    ok(".tif 能被转换出产物（后端白名单曾漏）", os.path.exists(tif_out),
       (tif_out if os.path.exists(tif_out) else p.stderr.strip()[-160:]))
    if os.path.exists(tif_out):
        w, h = webp_dims(tif_out)
        ok(".tif 尺寸不变（400x300）", (w, h) == (400, 300), f"{w}x{h}")

    # 2c) .heif 后缀单独一个（与 .heic 同类）
    heif_src = os.path.join(IN, "fake.heif")
    if not os.path.exists(heif_src):
        shutil.copy(os.path.join(IN, "fake.heic"), heif_src)
    p, dt = run([heif_src, "-q", "80", "-o", OUT])
    info("CLI 收到 .heif 时", f"exit={p.returncode} 出文件={os.path.exists(os.path.join(OUT, 'fake-webp.webp'))}")

    # 2d) 中文名 + 空格名（Windows 上最常见的两类路径麻烦）
    cn = os.path.join(IN, "中文 空格 名.jpg")
    p, dt = run([cn, "-q", "90", "-o", OUT])
    cn_out = os.path.join(OUT, "中文 空格 名-webp.webp")
    ok("中文名+空格名能转出产物", os.path.exists(cn_out),
       (cn_out if os.path.exists(cn_out) else p.stderr.strip()[-160:]))

    # 2e) --recursive 目录扫描（少一个后缀就是整批漏掉）
    p, dt = run([os.path.join(IN, "sub"), "--recursive", "-q", "80", "-o", os.path.join(OUT, "rec")])
    made = len(os.listdir(os.path.join(OUT, "rec"))) if os.path.isdir(os.path.join(OUT, "rec")) else 0
    ok("--recursive 扫到子目录里的 2 个文件", made == 2, f"实际 {made}")

    # 3) 16-bit 灰度渐变：被压成 8-bit 会出现台阶
    p, dt = run([os.path.join(IN, "grad16.png"), "-q", "100", "-o", OUT])
    g16 = os.path.join(OUT, "grad16-webp.webp")
    if os.path.exists(g16):
        from PIL import Image
        im = Image.open(g16).convert("L")
        row = [im.getpixel((x, 200)) for x in range(im.width)]
        steps = len({v for v in row})
        ok("16-bit 渐变未塌成 8-bit（>200 级）", steps > 200, f"实际 {steps} 级")

    # 4) 扩展名不受支持时的行为（.heic 内容是 JPEG）
    p, dt = run([os.path.join(IN, "fake.heic"), "-q", "80", "-o", OUT])
    heic_out = os.path.join(OUT, "fake-webp.webp")
    info("CLI 收到 .heic 时", f"exit={p.returncode} 出文件={os.path.exists(heic_out)}")

    # 5) 吞吐：1200 万像素单张耗时
    from PIL import Image
    big = os.path.join(IN, "big.jpg")
    if not os.path.exists(big):
        im = Image.new("RGB", (4000, 3000))
        px_ = im.load()
        for y in range(0, 3000, 2):
            for x in range(0, 4000, 2):
                c = (x * 255 // 4000, y * 255 // 3000, (x + y) * 255 // 7000)
                for dy in (0, 1):
                    for dx in (0, 1):
                        if x + dx < 4000 and y + dy < 3000:
                            px_[x + dx, y + dy] = c
        im.save(big, quality=92)
    p, dt = run([big, "-q", "80", "-o", OUT])
    info("4000x3000 → WebP q80", f"{dt:.2f}s")

    # 6) 批量：把 in 下的文件一次性丢进去（sub 是目录，不算文件）
    #    fake.heic / fake.heif **要排除**：两者 stem 都是 "fake"，输出文件名撞车
    #    （CLI 没有 GUI 那套撞名保护，后写的直接覆盖先写的）→ 只出 1 个文件。
    #    这个「同名静默覆盖」本身记一条，不用改产品（CLI 是内部接口）。
    batch = [os.path.join(IN, f) for f in sorted(os.listdir(IN))
             if f not in ("big.jpg", "fake.heic", "fake.heif")
             and os.path.isfile(os.path.join(IN, f))]
    p, dt = run(batch + ["-q", "80", "-o", os.path.join(OUT, "batch")])
    made = len(os.listdir(os.path.join(OUT, "batch"))) if os.path.isdir(os.path.join(OUT, "batch")) else 0
    ok(f"批量 {len(batch)} 个输入全部出文件", made == len(batch), f"{made}/{len(batch)}  {dt:.2f}s")

    width = max(len(r[1]) for r in results)
    for st, name, detail in results:
        print(f"{st:4s}  {name:<{width}}  {detail}")
    fails = [r for r in results if r[0] == "FAIL"]
    print(f"\n汇总：PASS {sum(1 for r in results if r[0]=='PASS')} / FAIL {len(fails)} / INFO {sum(1 for r in results if r[0]=='INFO')}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
