//! 几何原语：单应矩阵、透视取样、旋转补边。
//!
//! 这几个函数原来住在 `ocr-engine` 的 `pipeline.rs` 里，只有透视裁切一个调用
//! 点。现在前置处理的「去透视」也要用同一套取样器，搬到这里共用 —— 两份
//! 实现各自微调插值核，会让同一张图在识别与预处理里得到不一致的坐标基准，
//! 那种偏差没人查得出来。

use image::{Rgb, RgbImage};

/// 两点距离。
pub fn dist(a: (f64, f64), b: (f64, f64)) -> f64 {
    ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt()
}

/// 解出把 `dst` 四点映到 `src` 四点的单应矩阵（8 参数，h8 固定为 1）。
///
/// 取样方向是「反查」的：目标像素 (u, v) 去源图哪个位置取色，所以这里解的是
/// dst → src，不是正向的那个。
pub fn homography(dst: &[(f64, f64); 4], src: &[(f64, f64); 4]) -> [f64; 8] {
    let mut a = [[0f64; 8]; 8];
    let mut bvec = [0f64; 8];
    for i in 0..4 {
        let (x, y) = (src[i].0, src[i].1);
        let (u, v) = dst[i];
        a[i * 2] = [u, v, 1.0, 0.0, 0.0, 0.0, -x * u, -x * v];
        bvec[i * 2] = x;
        a[i * 2 + 1] = [0.0, 0.0, 0.0, u, v, 1.0, -y * u, -y * v];
        bvec[i * 2 + 1] = y;
    }
    for col in 0..8 {
        let mut piv = col;
        for r in col + 1..8 {
            if a[r][col].abs() > a[piv][col].abs() {
                piv = r;
            }
        }
        a.swap(col, piv);
        bvec.swap(col, piv);
        let d = a[col][col];
        if d.abs() < 1e-12 {
            continue;
        }
        for r in 0..8 {
            if r == col {
                continue;
            }
            let f = a[r][col] / d;
            // 先把主元行拷出来：a[r] 与 a[col] 同时可变借用会被借用检查器拒绝。
            let pivot_row = a[col];
            for c in col..8 {
                a[r][c] -= f * pivot_row[c];
            }
            bvec[r] -= f * bvec[col];
        }
    }
    let mut h = [0f64; 8];
    for i in 0..8 {
        h[i] = bvec[i] / a[i][i];
    }
    h
}

/// 把 `src` 四点围出的四边形透视展开成 `out_w × out_h` 的直立矩形。
/// `src` 顺序必须是 左上、右上、右下、左下。
pub fn perspective_warp(img: &RgbImage, src: &[(i32, i32); 4], out_w: u32, out_h: u32) -> RgbImage {
    let (iw, ih) = (img.width() as i64, img.height() as i64);
    let src_f: [(f64, f64); 4] = src.map(|p| (p.0 as f64, p.1 as f64));
    let dst = [
        (0f64, 0f64),
        (out_w as f64, 0.0),
        (out_w as f64, out_h as f64),
        (0.0, out_h as f64),
    ];
    let h_ = homography(&dst, &src_f);
    let map = |dx: f64, dy: f64| -> (f64, f64) {
        let den = h_[6] * dx + h_[7] * dy + 1.0;
        (
            (h_[0] * dx + h_[1] * dy + h_[2]) / den,
            (h_[3] * dx + h_[4] * dy + h_[5]) / den,
        )
    };

    let cubic = |t: f64| -> f64 {
        // cv2 的 cubic 卷积核，A = -0.75。
        let a = -0.75;
        let t = t.abs();
        if t < 1.0 {
            (a + 2.0) * t * t * t - (a + 3.0) * t * t + 1.0
        } else if t < 2.0 {
            a * t * t * t - 5.0 * a * t * t + 8.0 * a * t - 4.0 * a
        } else {
            0.0
        }
    };
    let sample = |sx: f64, sy: f64| -> [f64; 3] {
        let sx = sx.clamp(0.0, (iw - 1) as f64);
        let sy = sy.clamp(0.0, (ih - 1) as f64);
        let x0 = sx.floor() as i64;
        let y0 = sy.floor() as i64;
        let fx = sx - x0 as f64;
        let fy = sy - y0 as f64;
        let mut acc = [0f64; 3];
        for m in -1..=2 {
            for n in -1..=2 {
                let xx = (x0 + n).clamp(0, iw - 1) as u32;
                let yy = (y0 + m).clamp(0, ih - 1) as u32;
                let px = img.get_pixel(xx, yy);
                let wgt = cubic(n as f64 - fx) * cubic(m as f64 - fy);
                for ch in 0..3 {
                    acc[ch] += px[ch] as f64 * wgt;
                }
            }
        }
        acc
    };

    let mut out = RgbImage::new(out_w, out_h);
    for dy in 0..out_h {
        for dx in 0..out_w {
            let (sx, sy) = map(dx as f64, dy as f64);
            let v = sample(sx, sy);
            out.put_pixel(
                dx,
                dy,
                Rgb([
                    v[0].clamp(0.0, 255.0) as u8,
                    v[1].clamp(0.0, 255.0) as u8,
                    v[2].clamp(0.0, 255.0) as u8,
                ]),
            );
        }
    }
    out
}

/// 双线性取样，越界按边缘钳制。
fn bilinear(img: &RgbImage, sx: f64, sy: f64) -> Rgb<u8> {
    let (w, h) = (img.width() as i64, img.height() as i64);
    let sx = sx.clamp(0.0, (w - 1) as f64);
    let sy = sy.clamp(0.0, (h - 1) as f64);
    let x0 = sx.floor() as i64;
    let y0 = sy.floor() as i64;
    let x1 = (x0 + 1).min(w - 1);
    let y1 = (y0 + 1).min(h - 1);
    let fx = sx - x0 as f64;
    let fy = sy - y0 as f64;
    let p00 = img.get_pixel(x0 as u32, y0 as u32);
    let p10 = img.get_pixel(x1 as u32, y0 as u32);
    let p01 = img.get_pixel(x0 as u32, y1 as u32);
    let p11 = img.get_pixel(x1 as u32, y1 as u32);
    let mut out = [0u8; 3];
    for c in 0..3 {
        let top = p00[c] as f64 * (1.0 - fx) + p10[c] as f64 * fx;
        let bot = p01[c] as f64 * (1.0 - fx) + p11[c] as f64 * fx;
        out[c] = (top * (1.0 - fy) + bot * fy).round().clamp(0.0, 255.0) as u8;
    }
    Rgb(out)
}

/// 把整幅图绕中心旋转 `deg` 度（正数 = 屏幕上顺时针），画布扩大到装得下，
/// 空出来的角用 `fill` 填。文档拉直只能填白：填黑会在页边造出一圈假边界，
/// 检测器会把它们当成文字框。
pub fn rotate_expand(img: &RgbImage, deg: f64, fill: [u8; 3]) -> RgbImage {
    let (w, h) = (img.width() as f64, img.height() as f64);
    let th = deg.to_radians();
    let (s, c) = (th.sin(), th.cos());
    let nw = (w * c.abs() + h * s.abs()).ceil().max(1.0) as u32;
    let nh = (w * s.abs() + h * c.abs()).ceil().max(1.0) as u32;
    let (cx, cy) = (w / 2.0, h / 2.0);
    let (ncx, ncy) = (nw as f64 / 2.0, nh as f64 / 2.0);
    let mut out = RgbImage::from_pixel(nw, nh, Rgb(fill));
    for y in 0..nh {
        for x in 0..nw {
            let dx = x as f64 + 0.5 - ncx;
            let dy = y as f64 + 0.5 - ncy;
            // 内容转 +deg，目标像素就按 -deg 回源图取色。
            let sx = c * dx + s * dy + cx;
            let sy = -s * dx + c * dy + cy;
            if sx < -0.5 || sy < -0.5 || sx > w - 0.5 || sy > h - 0.5 {
                continue;
            }
            out.put_pixel(x, y, bilinear(img, sx, sy));
        }
    }
    out
}
