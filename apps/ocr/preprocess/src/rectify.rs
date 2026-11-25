//! 拉直与去透视。
//!
//! 手机拍文档有两个独立的几何问题：整页转了一个角（拉直能救），以及页面被
//! 拍成了梯形（拉直救不了，必须做透视校正）。这里按「先找纸张四边」的顺序
//! 处理：找到可信的四边就直接透视展开，四边本来就是画幅本身（扫描件、截图）
//! 就什么都不做；两者都不成立才退回去只估计一个倾角。
//!
//! 三条保守原则，都是为了「宁可不做，不许做坏」：
//! - 四边必须**连续有强梯度支撑**（沿线采样，命中率不到 45% 直接弃用），
//!   否则一张桌面纹理丰富的照片会被切掉一块。
//! - 四角必须在画幅内、面积占 30%~99.5%、每个角接近直角（50°~130°）。
//! - 倾角必须**明显优于 0°**（提升不足 12% 视为没有倾斜），静止的扫描件
//!   不会被硬转 0.4° —— 那种重采样只会让字变糊。

use crate::geom::{dist, perspective_warp, rotate_expand};
use crate::Report;
use image::{GrayImage, Luma, RgbImage};

/// 拉直/找边的工作分辨率：720 长边足够看清纸张边缘，成本却是全图的零头。
const WORK_SIDE: u32 = 720;

pub fn to_gray(rgb: &RgbImage) -> GrayImage {
    let (w, h) = (rgb.width(), rgb.height());
    let mut out = GrayImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let p = rgb.get_pixel(x, y);
            let v = 0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32;
            out.put_pixel(x, y, Luma([v.round().clamp(0.0, 255.0) as u8]));
        }
    }
    out
}

fn downscale_gray(gray: &GrayImage, max_side: u32) -> GrayImage {
    let longest = gray.width().max(gray.height());
    if longest <= max_side || longest == 0 {
        return gray.clone();
    }
    let r = max_side as f64 / longest as f64;
    let w = ((gray.width() as f64 * r).round() as u32).max(1);
    let h = ((gray.height() as f64 * r).round() as u32).max(1);
    image::imageops::resize(gray, w, h, image::imageops::FilterType::Triangle)
}

fn otsu(gray: &GrayImage) -> u8 {
    let mut hist = [0u32; 256];
    for p in gray.pixels() {
        hist[p[0] as usize] += 1;
    }
    let total = (gray.width() as f64) * (gray.height() as f64);
    if total <= 0.0 {
        return 128;
    }
    let sum_all: f64 = (0..256).map(|i| i as f64 * hist[i] as f64).sum();
    let (mut sum_b, mut w_b) = (0f64, 0f64);
    let mut best = (-1f64, 128u8);
    for (t, count) in hist.iter().enumerate() {
        let count = *count as f64;
        w_b += count;
        if w_b <= 0.0 {
            continue;
        }
        let w_f = total - w_b;
        if w_f <= 0.0 {
            break;
        }
        sum_b += t as f64 * count;
        let m_b = sum_b / w_b;
        let m_f = (sum_all - sum_b) / w_f;
        let between = w_b * w_f * (m_b - m_f) * (m_b - m_f);
        if between > best.0 {
            best = (between, t as u8);
        }
    }
    best.1
}

/// 行投影的方差：文字行与投影轴垂直时，落进每一行的墨量最集中，方差最大。
fn profile_variance(pts: &[(f32, f32, f32)], w: f64, h: f64, theta_deg: f64) -> f64 {
    let th = theta_deg.to_radians();
    let (s, c) = (th.sin(), th.cos());
    let extent = w * s.abs() + h * c.abs();
    let bins = (extent.ceil() as usize).max(2) + 2;
    let mut acc = vec![0f32; bins];
    let off = w * s.abs() + 1.0;
    for &(x, y, wt) in pts {
        let t = -(x as f64) * s + (y as f64) * c + off;
        let b = (t as usize).min(bins - 1);
        acc[b] += wt;
    }
    let mean = acc.iter().sum::<f32>() / bins as f32;
    let var: f32 = acc.iter().map(|v| (v - mean) * (v - mean)).sum();
    var as f64 / bins as f64
}

/// 估计文字行的倾斜角（度）。`None` = 看不出倾斜，别动。
pub fn estimate_skew(gray: &GrayImage) -> Option<f64> {
    let (w, h) = (gray.width() as f64, gray.height() as f64);
    if gray.width() < 32 || gray.height() < 32 {
        return None;
    }
    let t = otsu(gray) as f32;
    let mut pts: Vec<(f32, f32, f32)> = Vec::new();
    for y in 0..gray.height() {
        for x in 0..gray.width() {
            let v = gray.get_pixel(x, y)[0] as f32;
            // 只留比 Otsu 阈值更暗的像素；-8 是留给纸面噪点的死区。
            let wt = (t - v) - 8.0;
            if wt > 0.0 {
                pts.push((x as f32, y as f32, wt));
            }
        }
    }
    // 墨点太少（空白页、纯色照片）就没有「行」可谈。
    if pts.len() < 256 {
        return None;
    }

    let mut best = (f64::NEG_INFINITY, 0.0f64);
    let mut at_zero = f64::NEG_INFINITY;
    let mut a = -10.0f64;
    while a <= 10.0 + 1e-9 {
        let s = profile_variance(&pts, w, h, a);
        if a.abs() < 1e-9 {
            at_zero = s;
        }
        if s > best.0 {
            best = (s, a);
        }
        a += 0.5;
    }
    if best.1.abs() < 0.3 {
        return None;
    }
    // 置信判据：比「不转」明显更好才算真倾斜。
    if at_zero.is_finite() && best.0 < at_zero * 1.12 {
        return None;
    }

    let mut fine = (best.0, best.1);
    let mut a = best.1 - 0.6;
    while a <= best.1 + 0.6 + 1e-9 {
        let s = profile_variance(&pts, w, h, a);
        if s > fine.0 {
            fine = (s, a);
        }
        a += 0.1;
    }
    Some(fine.1)
}

#[derive(Clone, Copy)]
struct Line {
    /// 法线方向（弧度），取值 [0, π)。
    theta: f64,
    rho: f64,
}

fn line_at(theta: f64, rho: f64) -> Line {
    Line { theta, rho }
}

fn intersect(a: Line, b: Line) -> Option<(f64, f64)> {
    let (c1, s1) = (a.theta.cos(), a.theta.sin());
    let (c2, s2) = (b.theta.cos(), b.theta.sin());
    let det = c1 * s2 - s1 * c2;
    if det.abs() < 1e-6 {
        return None;
    }
    Some(((a.rho * s2 - b.rho * s1) / det, (c1 * b.rho - c2 * a.rho) / det))
}

fn cross(o: (f64, f64), a: (f64, f64), b: (f64, f64)) -> f64 {
    (a.0 - o.0) * (b.1 - o.1) - (a.1 - o.1) * (b.0 - o.0)
}

/// Andrew monotone chain：给一组点求凸包。
fn convex_hull(mut pts: Vec<(f64, f64)>) -> Vec<(f64, f64)> {
    pts.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    pts.dedup();
    if pts.len() < 3 {
        return pts;
    }
    let mut lower: Vec<(f64, f64)> = Vec::new();
    for &p in &pts {
        while lower.len() >= 2 && cross(lower[lower.len() - 2], lower[lower.len() - 1], p) <= 0.0 {
            lower.pop();
        }
        lower.push(p);
    }
    let mut upper: Vec<(f64, f64)> = Vec::new();
    for &p in pts.iter().rev() {
        while upper.len() >= 2 && cross(upper[upper.len() - 2], upper[upper.len() - 1], p) <= 0.0 {
            upper.pop();
        }
        upper.push(p);
    }
    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower
}

/// 找出纸张四角（顺时针，左上起）。找不到可信四边形就返回 `None`。
pub fn find_doc_quad(gray: &GrayImage) -> Option<[(f64, f64); 4]> {
    let (iw, ih) = (gray.width() as usize, gray.height() as usize);
    if iw < 48 || ih < 48 {
        return None;
    }
    let (w, h) = (iw as f64, ih as f64);

    // Sobel 梯度。阈值取「均值 + 一个标准差」并设绝对下限：
    // 只是纸面纹理的弱梯度不该参与投票。
    let mut mag = vec![0f32; iw * ih];
    let mut sum = 0f64;
    let mut sum2 = 0f64;
    let mut cnt = 0f64;
    for y in 1..ih - 1 {
        for x in 1..iw - 1 {
            let at = |dx: i32, dy: i32| -> f32 {
                gray.get_pixel((x as i32 + dx) as u32, (y as i32 + dy) as u32)[0] as f32
            };
            let gx = -at(-1, -1) - 2.0 * at(-1, 0) - at(-1, 1) + at(1, -1) + 2.0 * at(1, 0) + at(1, 1);
            let gy = -at(-1, -1) - 2.0 * at(0, -1) - at(1, -1) + at(-1, 1) + 2.0 * at(0, 1) + at(1, 1);
            let m = (gx * gx + gy * gy).sqrt();
            mag[y * iw + x] = m;
            sum += m as f64;
            sum2 += (m * m) as f64;
            cnt += 1.0;
        }
    }
    if cnt <= 0.0 {
        return None;
    }
    let mean = sum / cnt;
    let std = (sum2 / cnt - mean * mean).max(0.0).sqrt();
    let thr = ((mean + std) as f32).max(24.0);

    // Hough：180 个角度 × 2px 一档的 ρ。
    let diag = (w * w + h * h).sqrt();
    let rho_step = 2.0f64;
    let nrho = ((2.0 * diag) / rho_step).ceil() as usize + 1;
    let mut cos_t = [0f64; 180];
    let mut sin_t = [0f64; 180];
    for ti in 0..180 {
        let th = (ti as f64).to_radians();
        cos_t[ti] = th.cos();
        sin_t[ti] = th.sin();
    }
    let mut acc = vec![0u32; 180 * nrho];
    let mut y = 0usize;
    while y < ih {
        let mut x = 0usize;
        while x < iw {
            if mag[y * iw + x] >= thr {
                let (xf, yf) = (x as f64, y as f64);
                for ti in 0..180 {
                    let r = xf * cos_t[ti] + yf * sin_t[ti];
                    let ri = (((r + diag) / rho_step).round() as isize)
                        .clamp(0, nrho as isize - 1) as usize;
                    acc[ti * nrho + ri] += 1;
                }
            }
            x += 2;
        }
        y += 2;
    }

    // 取峰：非极大抑制（角度 ±7°、ρ ±20px），最多留 10 条。
    let mut peaks: Vec<(u32, usize, usize)> = Vec::new();
    for _ in 0..10 {
        let mut best = (0u32, 0usize, 0usize);
        for ti in 0..180 {
            for ri in 0..nrho {
                let v = acc[ti * nrho + ri];
                if v > best.0 {
                    best = (v, ti, ri);
                }
            }
        }
        if best.0 < 6 {
            break;
        }
        peaks.push(best);
        for dti in -7i32..=7 {
            let ti = (best.1 as i32 + dti).rem_euclid(180) as usize;
            for dri in -10i32..=10 {
                let ri = best.2 as i32 + dri;
                if ri >= 0 && (ri as usize) < nrho {
                    acc[ti * nrho + ri as usize] = 0;
                }
            }
        }
    }
    if peaks.len() < 4 {
        return None;
    }
    let top_votes = peaks[0].0 as f64;
    let lines: Vec<Line> = peaks
        .iter()
        .filter(|p| p.0 as f64 >= top_votes * 0.40)
        .map(|p| line_at((p.1 as f64).to_radians(), p.2 as f64 * rho_step - diag))
        .collect();
    if lines.len() < 4 {
        return None;
    }

    // 四条线两两求交，取落在画幅内的交点做凸包 —— 凸包正好四个点才可能是纸张。
    let n = lines.len();
    let mut best: Option<(f64, [(f64, f64); 4])> = None;
    for a in 0..n {
        for b in a + 1..n {
            for c in b + 1..n {
                for d in c + 1..n {
                    let four = [lines[a], lines[b], lines[c], lines[d]];
                    let mut pts: Vec<(f64, f64)> = Vec::new();
                    for i in 0..4 {
                        for j in i + 1..4 {
                            if let Some(p) = intersect(four[i], four[j]) {
                                if p.0 > -0.03 * w && p.0 < 1.03 * w && p.1 > -0.03 * h && p.1 < 1.03 * h {
                                    pts.push(p);
                                }
                            }
                        }
                    }
                    if pts.len() < 4 {
                        continue;
                    }
                    let hull = convex_hull(pts);
                    if hull.len() != 4 {
                        continue;
                    }
                    let Some(q) = order_quad(&hull) else { continue };
                    let Some(area) = quad_area_ok(&q, w, h, &mag, iw, thr, gray) else { continue };
                    if best.as_ref().is_none_or(|(ba, _)| area > *ba) {
                        best = Some((area, q));
                    }
                }
            }
        }
    }
    best.map(|(_, q)| q)
}

/// 把凸包四点排成 左上、右上、右下、左下。
fn order_quad(hull: &[(f64, f64)]) -> Option<[(f64, f64); 4]> {
    if hull.len() != 4 {
        return None;
    }
    let cx = hull.iter().map(|p| p.0).sum::<f64>() / 4.0;
    let cy = hull.iter().map(|p| p.1).sum::<f64>() / 4.0;
    let mut v: Vec<(f64, f64)> = hull.to_vec();
    // y 轴向下时，atan2 升序即屏幕上的顺时针。
    v.sort_by(|a, b| {
        (a.1 - cy).atan2(a.0 - cx)
            .partial_cmp(&(b.1 - cy).atan2(b.0 - cx))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let start = (0..4)
        .min_by(|&i, &j| {
            (v[i].0 + v[i].1)
                .partial_cmp(&(v[j].0 + v[j].1))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .unwrap_or(0);
    v.rotate_left(start);
    Some([v[0], v[1], v[2], v[3]])
}

/// 面积、直角、边长、沿线梯度支撑、纸面比背景亮 —— 全过才返回面积。
fn quad_area_ok(
    q: &[(f64, f64); 4],
    w: f64,
    h: f64,
    mag: &[f32],
    iw: usize,
    thr: f32,
    gray: &GrayImage,
) -> Option<f64> {
    let mut area = 0f64;
    for i in 0..4 {
        let a = q[i];
        let b = q[(i + 1) % 4];
        area += a.0 * b.1 - b.0 * a.1;
    }
    let area = area.abs() / 2.0;
    let ratio = area / (w * h);
    if !(0.30..=0.995).contains(&ratio) {
        return None;
    }
    let min_side = w.min(h);
    for i in 0..4 {
        let a = q[i];
        let b = q[(i + 1) % 4];
        let c = q[(i + 2) % 4];
        if dist(a, b) < 0.18 * min_side {
            return None;
        }
        // 夹角：两个边向量之间的锐角
        let v1 = (a.0 - b.0, a.1 - b.1);
        let v2 = (c.0 - b.0, c.1 - b.1);
        let n1 = (v1.0 * v1.0 + v1.1 * v1.1).sqrt().max(1e-6);
        let n2 = (v2.0 * v2.0 + v2.1 * v2.1).sqrt().max(1e-6);
        let cosv = ((v1.0 * v2.0 + v1.1 * v2.1) / (n1 * n2)).clamp(-1.0, 1.0);
        let ang = cosv.acos().to_degrees();
        if !(50.0..=130.0).contains(&ang) {
            return None;
        }
        // 沿线采样：纸张边缘应该是连续强梯度，不是几段纹理凑出来的直线
        let mut hit = 0;
        let mut total = 0;
        for step in 0..=64 {
            let t = step as f64 / 64.0;
            let x = (a.0 + (b.0 - a.0) * t).round();
            let y = (a.1 + (b.1 - a.1) * t).round();
            if x < 0.0 || y < 0.0 || x >= w - 1.0 || y >= h - 1.0 {
                continue;
            }
            total += 1;
            if mag[y as usize * iw + x as usize] >= thr {
                hit += 1;
            }
        }
        if total < 8 || (hit as f64) < 0.45 * total as f64 {
            return None;
        }
    }
    if !interior_brighter(q, gray) {
        return None;
    }
    Some(area)
}

/// 纸面必须比纸张外侧更亮。
///
/// 没有这一条，页内的一圈表格边框（四条强边、四个直角、面积 80%）会被当成
/// 「纸的边缘」，于是一张本来端正的表格被裁到只剩表格 —— 这是最恶劣的一种
/// 自动校正：结果看起来像成功，实际丢掉了页边文字。
fn interior_brighter(q: &[(f64, f64); 4], gray: &GrayImage) -> bool {
    let cx = q.iter().map(|p| p.0).sum::<f64>() / 4.0;
    let cy = q.iter().map(|p| p.1).sum::<f64>() / 4.0;
    let (iw, ih) = (gray.width() as f64, gray.height() as f64);
    let mut inside = 0f64;
    let mut outside = 0f64;
    let mut n = 0f64;
    for i in 0..4 {
        let a = q[i];
        let b = q[(i + 1) % 4];
        for step in 1..9 {
            let t = step as f64 / 9.0;
            let (px, py) = (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t);
            let (vx, vy) = (cx - px, cy - py);
            let len = (vx * vx + vy * vy).sqrt().max(1e-6);
            let (ux, uy) = (vx / len, vy / len);
            let sample = |x: f64, y: f64| -> Option<f64> {
                if x < 0.0 || y < 0.0 || x >= iw - 1.0 || y >= ih - 1.0 {
                    return None;
                }
                Some(gray.get_pixel(x as u32, y as u32)[0] as f64)
            };
            if let (Some(vi), Some(vo)) = (
                sample(px + ux * 6.0, py + uy * 6.0),
                sample(px - ux * 6.0, py - uy * 6.0),
            ) {
                inside += vi;
                outside += vo;
                n += 1.0;
            }
        }
    }
    if n < 8.0 {
        return false;
    }
    inside / n - outside / n > 10.0
}

fn is_identity(q: &[(f64, f64)], w: f64, h: f64) -> bool {
    let corners = [(0.0, 0.0), (w, 0.0), (w, h), (0.0, h)];
    let tol = w.min(h) * 0.02;
    q.iter().zip(corners.iter()).all(|(a, b)| dist(*a, *b) < tol)
}

fn quad_size(q: &[(f64, f64); 4]) -> (u32, u32) {
    let top = dist(q[0], q[1]);
    let bottom = dist(q[3], q[2]);
    let left = dist(q[0], q[3]);
    let right = dist(q[1], q[2]);
    (((top + bottom) / 2.0).round().max(16.0) as u32, ((left + right) / 2.0).round().max(16.0) as u32)
}

/// 拉直 / 去透视。返回 `None` 表示「这页本来就是正的和方的」，不要重采样。
pub fn rectify(rgb: &RgbImage) -> Option<(RgbImage, Report)> {
    let (fw, fh) = (rgb.width() as f64, rgb.height() as f64);
    let gray = to_gray(rgb);
    let small = downscale_gray(&gray, WORK_SIDE);
    let sx = fw / small.width() as f64;
    let sy = fh / small.height() as f64;

    if let Some(q) = find_doc_quad(&small) {
        let qf: Vec<(f64, f64)> = q.iter().map(|p| (p.0 * sx, p.1 * sy)).collect();
        if !is_identity(&qf, fw, fh) {
            let quad: [(i32, i32); 4] = [
                (qf[0].0.round() as i32, qf[0].1.round() as i32),
                (qf[1].0.round() as i32, qf[1].1.round() as i32),
                (qf[2].0.round() as i32, qf[2].1.round() as i32),
                (qf[3].0.round() as i32, qf[3].1.round() as i32),
            ];
            let (ow, oh) = quad_size(&[qf[0], qf[1], qf[2], qf[3]]);
            let (ow, oh) = (ow.min(rgb.width().saturating_mul(2)), oh.min(rgb.height().saturating_mul(2)));
            if ow >= 32 && oh >= 32 {
                let warped = perspective_warp(rgb, &quad, ow, oh);
                return Some((warped, Report { angle_deg: 0.0, perspective: true }));
            }
        }
    }

    let angle = estimate_skew(&small)?;
    Some((
        rotate_expand(rgb, -angle, [255, 255, 255]),
        Report { angle_deg: angle as f32, perspective: false },
    ))
}
