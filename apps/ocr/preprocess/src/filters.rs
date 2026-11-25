//! 去摩尔纹与图像增强。
//!
//! 两条共同原则：
//! 1. **只改亮度，不改字形**。文字的高频本来就该保留，被压掉的只能是周期性
//!    的网点纹（摩尔纹）和低对比度，所以摩尔纹走「降采样再升采样」把周期结构
//!    拉掉，增强走「亮度局部均衡 + 轻微锐化」，都不做整体模糊。
//! 2. **白底不能变灰**。增强里的白平衡增益与 CLAHE 都限幅，均匀浅色页面进去
//!    出来还是均匀浅色，否则识别器会把灰底当成低对比度小字，反而更差。

use image::{Rgb, RgbImage};

/// 去摩尔纹：半分辨率往返（把周期性网点纹滤掉），再做一次色度平滑
/// （消掉屏幕翻拍常见的彩色条纹），亮度不动。
pub fn demoire(img: &RgbImage) -> RgbImage {
    let (w, h) = (img.width(), img.height());
    if w < 16 || h < 16 {
        return img.clone();
    }
    let half = image::imageops::resize(img, (w / 2).max(1), (h / 2).max(1), image::imageops::FilterType::Triangle);
    let smoothed = smooth_chroma(&half);
    image::imageops::resize(&smoothed, w, h, image::imageops::FilterType::Triangle)
}

/// 彩色条纹来自色度（Cb/Cr）的高频，亮度（Y）保持原样：3×3 均值只压色度。
fn smooth_chroma(img: &RgbImage) -> RgbImage {
    let (w, h) = (img.width() as usize, img.height() as usize);
    if w == 0 || h == 0 {
        return img.clone();
    }
    let mut yy = vec![0u8; w * h];
    let mut cb = vec![0f32; w * h];
    let mut cr = vec![0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let p = img.get_pixel(x as u32, y as u32);
            let (r, g, b) = (p[0] as f32, p[1] as f32, p[2] as f32);
            let yv = 0.299 * r + 0.587 * g + 0.114 * b;
            yy[y * w + x] = yv.round().clamp(0.0, 255.0) as u8;
            cb[y * w + x] = (b - yv) * 0.564;
            cr[y * w + x] = (r - yv) * 0.713;
        }
    }
    let cbs = box3(&cb, w, h);
    let crs = box3(&cr, w, h);
    let mut out = RgbImage::new(w as u32, h as u32);
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let yv = yy[i] as f32;
            let b = yv + 1.773 * cbs[i];
            let r = yv + 1.403 * crs[i];
            let g = yv - 0.714 * crs[i] - 0.344 * cbs[i];
            out.put_pixel(x as u32, y as u32, Rgb([clamp8(r), clamp8(g), clamp8(b)]));
        }
    }
    out
}

/// 3×3 均值，分离式两趟。
fn box3(src: &[f32], w: usize, h: usize) -> Vec<f32> {
    let mut tmp = vec![0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let x0 = x.saturating_sub(1);
            let x1 = (x + 1).min(w - 1);
            tmp[y * w + x] = (src[y * w + x0] + src[y * w + x] + src[y * w + x1]) / 3.0;
        }
    }
    let mut out = vec![0f32; w * h];
    for y in 0..h {
        let y0 = y.saturating_sub(1);
        let y1 = (y + 1).min(h - 1);
        for x in 0..w {
            out[y * w + x] = (tmp[y0 * w + x] + tmp[y * w + x] + tmp[y1 * w + x]) / 3.0;
        }
    }
    out
}

/// 增强：灰度世界白平衡 → 亮度 CLAHE → 轻微非锐化掩模，颜色按亮度比例还原。
pub fn enhance(img: &RgbImage) -> RgbImage {
    let (w, h) = (img.width() as usize, img.height() as usize);
    if w == 0 || h == 0 {
        return img.clone();
    }
    let mut out = img.clone();

    // 1) 白平衡：偏色的翻拍（暖光/阴天）会让灰度阈值全歪，先拉回中性。
    //    增益限在 ±20%，否则「白纸」会把整页推爆。
    let mut sums = [0f64; 3];
    let mut n = 0f64;
    let step = if w * h > 4_000_000 { 2 } else { 1 };
    let mut y = 0usize;
    while y < h {
        let mut x = 0usize;
        while x < w {
            let p = img.get_pixel(x as u32, y as u32);
            for c in 0..3 {
                sums[c] += p[c] as f64;
            }
            n += 1.0;
            x += step;
        }
        y += step;
    }
    let mean_all = (sums[0] + sums[1] + sums[2]) / (3.0 * n.max(1.0));
    let mut gain = [1f64; 3];
    for c in 0..3 {
        gain[c] = (mean_all / (sums[c] / n.max(1.0)).max(1.0)).clamp(0.85, 1.20);
    }
    let mut yplane = vec![0u8; w * h];
    for y in 0..h {
        for x in 0..w {
            let p = img.get_pixel(x as u32, y as u32);
            let r = (p[0] as f64 * gain[0]).clamp(0.0, 255.0);
            let g = (p[1] as f64 * gain[1]).clamp(0.0, 255.0);
            let b = (p[2] as f64 * gain[2]).clamp(0.0, 255.0);
            out.put_pixel(x as u32, y as u32, Rgb([r.round() as u8, g.round() as u8, b.round() as u8]));
            yplane[y * w + x] = (0.299 * r + 0.587 * g + 0.114 * b).round().clamp(0.0, 255.0) as u8;
        }
    }

    // 2) 亮度局部均衡：整页光照不均（手机拍照一侧偏暗）靠全局拉对比救不回来。
    let y1 = clahe(&yplane, w, h);
    // 3) 轻微锐化：上面两步都是平滑性质的，边缘会软一点，补回来但不放大噪点。
    let blur = blur5(&y1, w, h);
    let mut y2 = vec![0u8; w * h];
    for i in 0..w * h {
        let a = y1[i] as f64;
        y2[i] = (a + 0.5 * (a - blur[i] as f64)).round().clamp(0.0, 255.0) as u8;
    }

    // 4) 按亮度比例还原颜色：等比缩放保住色相，不会把红章变粉。
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let y0 = yplane[i] as f64;
            let scale = if y0 < 1.0 { 1.0 } else { (y2[i] as f64 / y0).clamp(0.60, 1.60) };
            let p = out.get_pixel(x as u32, y as u32);
            let mut q = [0u8; 3];
            for c in 0..3 {
                q[c] = (p[c] as f64 * scale).clamp(0.0, 255.0).round() as u8;
            }
            out.put_pixel(x as u32, y as u32, Rgb(q));
        }
    }
    out
}

/// CLAHE：分块直方图均衡 + 限幅 + 块间双线性插值。
/// 限幅是重点：不限幅的均衡会把纸纹和噪点一起放大成「假字」。
fn clahe(y: &[u8], w: usize, h: usize) -> Vec<u8> {
    let tx = (w / 64).clamp(1, 8);
    let ty = (h / 64).clamp(1, 8);
    let mut luts = vec![[0u8; 256]; tx * ty];
    for tyi in 0..ty {
        for txi in 0..tx {
            let x0 = txi * w / tx;
            let x1 = ((txi + 1) * w / tx).max(x0 + 1).min(w);
            let y0 = tyi * h / ty;
            let y1 = ((tyi + 1) * h / ty).max(y0 + 1).min(h);
            let area = ((x1 - x0) * (y1 - y0)).max(1);
            let mut hist = [0u32; 256];
            for yy in y0..y1 {
                for xx in x0..x1 {
                    hist[y[yy * w + xx] as usize] += 1;
                }
            }
            let limit = ((2.0 * area as f64) / 256.0).round().max(1.0) as u32;
            let mut excess = 0u32;
            for v in hist.iter_mut() {
                if *v > limit {
                    excess += *v - limit;
                    *v = limit;
                }
            }
            let inc = excess / 256;
            let rem = excess % 256;
            for (i, v) in hist.iter_mut().enumerate() {
                *v += inc + u32::from((i as u32) < rem);
            }
            let mut acc = 0u32;
            let mut lut = [0u8; 256];
            for i in 0..256 {
                acc += hist[i];
                let v = (acc as f64 * 255.0 / area as f64).round().clamp(0.0, 255.0) as u8;
                lut[i] = v;
            }
            luts[tyi * tx + txi] = lut;
        }
    }

    let mut out = vec![0u8; w * h];
    for yy in 0..h {
        // 像素落在哪两个块之间、权重多少
        let fy = ((yy as f64 + 0.5) * ty as f64 / h as f64 - 0.5).max(0.0);
        let ty0 = (fy.floor() as usize).min(ty - 1);
        let ty1 = (ty0 + 1).min(ty - 1);
        let ay = (fy - ty0 as f64).clamp(0.0, 1.0);
        for xx in 0..w {
            let fx = ((xx as f64 + 0.5) * tx as f64 / w as f64 - 0.5).max(0.0);
            let tx0 = (fx.floor() as usize).min(tx - 1);
            let tx1 = (tx0 + 1).min(tx - 1);
            let ax = (fx - tx0 as f64).clamp(0.0, 1.0);
            let v = y[yy * w + xx] as usize;
            let v00 = luts[ty0 * tx + tx0][v] as f64;
            let v10 = luts[ty0 * tx + tx1][v] as f64;
            let v01 = luts[ty1 * tx + tx0][v] as f64;
            let v11 = luts[ty1 * tx + tx1][v] as f64;
            let top = v00 * (1.0 - ax) + v10 * ax;
            let bot = v01 * (1.0 - ax) + v11 * ax;
            out[yy * w + xx] = (top * (1.0 - ay) + bot * ay).round().clamp(0.0, 255.0) as u8;
        }
    }
    out
}

/// 5 抽头高斯 [1,4,6,4,1]/16，分离式。
fn blur5(y: &[u8], w: usize, h: usize) -> Vec<u8> {
    let mut tmp = vec![0u16; w * h];
    for yy in 0..h {
        for xx in 0..w {
            let g = |dx: isize| -> u16 {
                let x = (xx as isize + dx).clamp(0, w as isize - 1) as usize;
                y[yy * w + x] as u16
            };
            let s = g(-2) + 4 * g(-1) + 6 * g(0) + 4 * g(1) + g(2);
            tmp[yy * w + xx] = (s + 8) / 16;
        }
    }
    let mut out = vec![0u8; w * h];
    for yy in 0..h {
        for xx in 0..w {
            let g = |dy: isize| -> u16 {
                let y = (yy as isize + dy).clamp(0, h as isize - 1) as usize;
                tmp[y * w + xx]
            };
            let s = g(-2) + 4 * g(-1) + 6 * g(0) + 4 * g(1) + g(2);
            out[yy * w + xx] = ((s + 8) / 16).min(255) as u8;
        }
    }
    out
}

fn clamp8(v: f32) -> u8 {
    v.round().clamp(0.0, 255.0) as u8
}
