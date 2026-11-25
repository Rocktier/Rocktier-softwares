# Pic2WebP 编码 benchmark

回答一个具体问题：**同一张图、同一画质，本应用编出来的文件比 libwebp 的命令行基线大还是小？**

方案参考 libwebp 自己的对比口径（同 SSIM 比体积、同体积比 SSIM），全部本地跑，不联网、不上传图片。

## 一条命令

```bash
cd apps/pic2webp
node bench/run.mjs --bin src-tauri/target/release/pic2webp
```

需要 `cwebp` / `dwebp`（macOS `brew install webp`，Debian `apt install webp`）。
没编译过二进制时可以用 `--bin` 指任何遵守下面 CLI 契约的可执行文件。

报告写到 `bench/report/report.md`（给人看）与 `report.json`（给 CI 比对历史）。

## 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--bin` | 必填 | 被测二进制，走它自己的 `--cli` 入口 |
| `--qualities` | `50,60,70,80,90,95` | 质量扫描档，稀疏到插不出曲线会报 n/a |
| `--ref-method` | `6` | 参考编码器 `cwebp -m` 档位。**换档位必须显式传**，否则历史数字不可比 |
| `--only` | 全部 | 只跑某一张图（调参时用） |
| `--out` | `bench/report` | 报告目录 |
| `--keep` | 关 | 保留中间产物（解码后的 PAM / webp）便于复看 |
| `--cwebp` / `--dwebp` | `cwebp` / `dwebp` | 工具路径 |

被测二进制的契约（就是应用现有的 CLI）：

```
pic2webp --cli <input.png> -q <N> -o <outdir>
# 产物名固定为 <stem>-webp.webp
```

**为什么坚持走 `--cli`**：benchmark 要量的是产品实际使用的那段编码代码。另写一份
「跟产品差不多的编码函数」去跑分，数字好看也说明不了产品好用。

## 批量吞吐（另一件事）

```bash
node bench/batch.mjs --bin src-tauri/target/release/pic2webp --count 1000
```

`run.mjs` 量**画质**（同一张图 vs cwebp），`batch.mjs` 量**批量行为**：1000 张一次跑完的
总耗时、单张均值、吞吐、内存峰值、失败清单。两者都走被测二进制自己的 `--cli`。

- 语料 = 固定种子图集复制 N 份，分 10 个目录（把 `--recursive` 这条真实路径也走到）
- 内存峰值：Linux 读内核的 `VmHWM`（真峰值）；macOS 没有 `/proc`，按 100ms 采样
  `ps -o rss=`。**量不到就写「未量到」**，不写 0 —— 0 会被读成「测出来很省」
- 产物数 ≠ 请求数直接退出码 1：数字对不上时不给报告

## 指标

- **SSIM**：BT.601 亮度、11×11 高斯窗（σ=1.5）、可分离卷积。和 `cwebp -print_ssim` 同口径。
- **PSNR**：SSIM 在截图 / 扁平插画上会贴到 0.999x，两条曲线的重叠带窄到插值没有意义，
  这时报告自动改用 PSNR 口径，并在「口径」列标明。**换尺子这件事必须写在明面上**。
- **BD-rate**（Bjøntegaard delta rate）：把两条 (码率, 画质) 曲线各自拟合三次多项式，
  在重叠画质区间上积分码率比的 log，得到「同画质下的平均码率差」。负数 = 本应用更省。
  重叠带窄于阈值（SSIM 0.002 / PSNR 1 dB）时直接报 n/a，不给会被端点斜率带偏的数。

报表三段：结论（BD-rate）、同体积比画质（对齐参考 q80 的体积）、原始数据。

## 图集

`bench/gen-corpus.mjs` 按固定种子生成 6 张 PNG，逐字节可复现（`manifest.json` 里存像素哈希）：

| 文件 | 类别 | 为什么要它 |
|---|---|---|
| `photo-landscape.png` | photo-smooth | 平滑渐变 + 高光，有损编码最擅长的场景 |
| `photo-texture.png` | photo-detail | 多倍频噪声，细节密度高，最吃编码器 |
| `screenshot-ui.png` | screenshot | 平色块 + 1px 细线 + 文字条，色度二次采样最容易糊的 |
| `lineart-sketch.png` | lineart | 白底细笔画，一糊就废 |
| `flat-illustration.png` | flat-graphic | 大块平色，介于插画与 UI 之间 |
| `alpha-glow.png` | alpha | RGBA 软边，量 alpha 通道的独立编码 |

**没有 HEIC 与 Display-P3**：台账里点了这两类，但这两种要有真实相机样本和 16 bit + ICC
数据，合成出来的图既不像真照片也没法代表 P3 色域，宁缺勿假。要补就放真实样张进
`bench/corpus-real/`（不进版本库），用 `--only` 单独跑。

## 在 CI 上跑

`.github/workflows/pic2webp-bench.yml`（手动触发 / 每周一次）：编译 release 二进制 →
跑完整扫描 → 报告作为 artifact 上传。**不在 main push 触发**：这套要编 Tauri，占用
macOS 并发槽位，而且它是观测不是门禁。

要不要改成「BD-rate 超过阈值就红」，等积累十几轮数据、知道正常抖动范围再定 ——
现在定阈值只会得到一条天天误报的红线。

## 自检

```bash
node --test tests/bench.test.mjs
```

10 条判据：PNG 可复现、PPM/PAM 头解析、SSIM 自一致、亮度转换按通道数取值、
BD-rate 在「已知省 10%」的合成数据上回到 -10%、重叠带过窄时拒绝给结论、图集稳定。
