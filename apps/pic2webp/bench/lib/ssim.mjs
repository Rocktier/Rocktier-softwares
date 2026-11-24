/**
 * SSIM（Wang et al. 2004）—— 编码对比的客观尺子。
 *
 * 为什么不是 PSNR：PSNR 对「同样的均方差、不同的观感」没有区分力，
 * 而图片压缩的取舍恰恰全在观感上（截图里的细字 vs 照片里的噪声）。
 * SSIM 是 libwebp 自己 `-print_ssim` 用的指标，数值可以直接和 cwebp 的结果对表。
 *
 * 实现在亮度通道上做，11×11 高斯窗（σ=1.5），可分离卷积拆成横竖两遍 ——
 * 直接 121 点全窗在 1600×1200 上要 2 亿次乘加，JS 里跑一次十几秒，
 * 拆开是 22 点两遍，单张降到亚秒级。
 */

const WINDOW = 11;
const SIGMA = 1.5;

function gaussianKernel(size = WINDOW, sigma = SIGMA) {
  const half = (size - 1) / 2;
  const k = new Float64Array(size);
  let sum = 0;
  for (let i = 0; i < size; i += 1) {
    const x = i - half;
    k[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
    sum += k[i];
  }
  for (let i = 0; i < size; i += 1) k[i] /= sum;
  return k;
}

const KERNEL = gaussianKernel();
const HALF = (WINDOW - 1) / 2;

/** BT.601 亮度，与 libwebp 的 SSIM 口径一致（都是先转灰度再加权）。 */
export function toLuma(width, height, data, channels) {
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; i < out.length; i += 1, p += channels) {
    out[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  return out;
}

function blur(src, width, height) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      let acc = 0;
      for (let t = -HALF; t <= HALF; t += 1) {
        const xx = Math.min(width - 1, Math.max(0, x + t));
        acc += src[row + xx] * KERNEL[t + HALF];
      }
      tmp[row + x] = acc;
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let acc = 0;
      for (let t = -HALF; t <= HALF; t += 1) {
        const yy = Math.min(height - 1, Math.max(0, y + t));
        acc += tmp[yy * width + x] * KERNEL[t + HALF];
      }
      out[y * width + x] = acc;
    }
  }
  return out;
}

/**
 * @param {Float32Array} a 亮度，长度 width*height
 * @param {Float32Array} b 同上
 * @returns {number} 0..1，1 表示完全一致
 */
export function ssimFromLuma(a, b, width, height) {
  if (a.length !== b.length || a.length !== width * height) {
    throw new Error("ssim: luma buffers do not match the given dimensions");
  }
  const a2 = new Float32Array(a.length);
  const b2 = new Float32Array(a.length);
  const ab = new Float32Array(a.length);
  for (let i = 0; i < a.length; i += 1) {
    a2[i] = a[i] * a[i];
    b2[i] = b[i] * b[i];
    ab[i] = a[i] * b[i];
  }
  const muA = blur(a, width, height);
  const muB = blur(b, width, height);
  const sAA = blur(a2, width, height);
  const sBB = blur(b2, width, height);
  const sAB = blur(ab, width, height);

  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  let total = 0;
  for (let i = 0; i < muA.length; i += 1) {
    const ma = muA[i];
    const mb = muB[i];
    const varA = sAA[i] - ma * ma;
    const varB = sBB[i] - mb * mb;
    const cov = sAB[i] - ma * mb;
    const num = (2 * ma * mb + c1) * (2 * cov + c2);
    const den = (ma * ma + mb * mb + c1) * (varA + varB + c2);
    total += num / den;
  }
  return total / muA.length;
}

/** 两张同尺寸图（原始字节 + 通道数）的 SSIM。 */
export function ssim(width, height, ref, refChannels, dec, decChannels) {
  return ssimFromLuma(
    toLuma(width, height, ref, refChannels),
    toLuma(width, height, dec, decChannels),
    width,
    height,
  );
}

/**
 * PSNR（亮度通道）。
 *
 * 为什么 SSIM 之外还要它：截图 / 扁平插画这类图的 SSIM 在很宽的码率区间里都贴着
 * 0.999，两条曲线的重叠带窄到无法比较（BD-rate 会判成不可信）。PSNR 对「细字被
 * 抹平」这类误差敏感得多，正好补上这个盲区 —— 所以一旦 SSIM 饱和，benchmark 就
 * 退回 PSNR 口径出结论，并在报告里标明换了尺子。
 */
export function psnrFromLuma(a, b) {
  if (a.length !== b.length) throw new Error("psnr: luma buffers differ in length");
  let mse = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = a[i] - b[i];
    mse += d * d;
  }
  mse /= a.length;
  if (mse === 0) return Infinity;
  return 10 * Math.log10((255 * 255) / mse);
}

/** 两张同尺寸图（原始字节 + 通道数）的 PSNR。 */
export function psnr(width, height, ref, refChannels, dec, decChannels) {
  return psnrFromLuma(
    toLuma(width, height, ref, refChannels),
    toLuma(width, height, dec, decChannels),
  );
}
