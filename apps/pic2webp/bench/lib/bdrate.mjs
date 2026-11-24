/**
 * BD-rate（Bjøntegaard delta rate）—— 编码器对比的标准结论指标。
 *
 * 为什么不只报「达到 SSIM 0.98 需要多少字节」：截图、扁平插画这类图的
 * SSIM 在很宽的码率区间里都是 0.999x，曲线根本不穿过 0.98 —— 那个表会整列
 * 是空的（本地冒烟跑出来就是这样）。BD-rate 不要求曲线穿过某个固定值，
 * 它只在两条曲线的**重叠质量区间**上积分，比较同一画质下的码率差：
 *
 *   BD-rate = 10^( ∫ (log10 R_app(Q) − log10 R_ref(Q)) dQ / ΔQ ) − 1
 *
 * 负数表示本应用在同等画质下更省码率。拟合沿用 Bjøntegaard 原文的三次多项式
 * 最小二乘（工程上比逐点线性插值稳），积分用 100 点梯形。
 */

/** 解 n 元线性方程组（高斯消元，部分主元）。 */
function solve(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const f = a[row][col] / a[col][col];
      for (let k = col; k <= n; k += 1) a[row][k] -= f * a[col][k];
    }
  }
  return a.map((row, i) => row[n] / row[i]);
}

/** 三次多项式最小二乘：y ≈ c0 + c1 x + c2 x² + c3 x³。 */
export function cubicFit(xs, ys) {
  const size = 4;
  const sums = new Array(size * 2).fill(0);
  for (let k = 0; k < size * 2; k += 1) {
    sums[k] = xs.reduce((acc, x) => acc + x ** k, 0);
  }
  const matrix = [];
  const vector = [];
  for (let i = 0; i < size; i += 1) {
    matrix.push(sums.slice(i, i + size));
    vector.push(xs.reduce((acc, x, idx) => acc + ys[idx] * x ** i, 0));
  }
  return solve(matrix, vector);
}

function evalPoly(coef, x) {
  return coef.reduce((acc, c, i) => acc + c * x ** i, 0);
}

/**
 * @param {{quality:number, bytes:number, ssim:number}[]} ref 参考编码器的点
 * @param {{quality:number, bytes:number, ssim:number}[]} app 被测编码器的点
 * @returns {{percent:number|null, range:[number,number]|null, samples:number}}
 */
export function bdRate(ref, app, metric = "ssim") {
  const usable = (pts) => pts.filter((p) => p.bytes > 0 && Number.isFinite(p[metric]));
  const r = usable(ref);
  const a = usable(app);
  if (r.length < 4 || a.length < 4) return { percent: null, range: null, samples: 0 };

  const lo = Math.max(Math.min(...r.map((p) => p[metric])), Math.min(...a.map((p) => p[metric])));
  const hi = Math.min(Math.max(...r.map((p) => p[metric])), Math.max(...a.map((p) => p[metric])));
  if (!(hi > lo)) return { percent: null, range: null, samples: 0, saturated: true };

  // 拟合前把 x 平移到中心：SSIM 的四个有效位全在 0.99x 上，x/x²/x³ 几乎共线，
  // 不做平移时正规方程矩阵接近奇异，高斯消元直接判死（本地冒烟就是这么发现的）。
  const mid = (lo + hi) / 2;
  const refFit = cubicFit(r.map((p) => p[metric] - mid), r.map((p) => Math.log10(p.bytes)));
  const appFit = cubicFit(a.map((p) => p[metric] - mid), a.map((p) => Math.log10(p.bytes)));
  if (!refFit || !appFit) return { percent: null, range: null, samples: 0 };

  const samples = 100;
  const step = (hi - lo) / (samples - 1);
  let acc = 0;
  for (let i = 0; i < samples; i += 1) {
    const q = lo + step * i - mid;
    acc += evalPoly(appFit, q) - evalPoly(refFit, q);
  }
  const avg = acc / samples;
  // 重叠带窄于阈值时，多项式在端点上的斜率被放大，结论不可信 —— 宁可报 n/a。
  // SSIM 用 0.002（0..1 的尺度），PSNR 用 1.0 dB。
  const minSpan = metric === "psnr" ? 1.0 : 0.002;
  const saturated = hi - lo < minSpan;
  return {
    percent: saturated ? null : (10 ** avg - 1) * 100,
    range: [lo, hi],
    samples,
    saturated,
    metric,
  };
}
