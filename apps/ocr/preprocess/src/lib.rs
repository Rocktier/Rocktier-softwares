//! 识别前置处理三件套：拉直（含去透视）、去摩尔纹、图像增强。
//!
//! 为什么单独成一个 crate：这三件事都是**纯位图运算**，不碰 ONNX、不碰模型，
//! 也不该为了跑一个单元测试去下载 200MB 的推理运行时。识别管线（`ocr-engine`）
//! 依赖它，`pipeline` 里原来的单应矩阵与透视取样也搬到了这里共用。
//!
//! 设计上的硬约束只有一条：**可以不做，不许做坏**。每一项默认关闭；几何校正
//! 拿不准就原样返回（见 `rectify` 里的置信判据），因为错误地转 3° 或裁掉页边，
//! 比不转更难被用户发现。识别率提升是收益，把好图做坏是事故。

mod filters;
mod geom;
mod rectify;

pub use geom::{dist, homography, perspective_warp, rotate_expand};
pub use rectify::{estimate_skew, find_doc_quad, to_gray};

use image::{DynamicImage, RgbImage};

/// 预处理工作分辨率上限。
///
/// 识别管线自己会把长边压到 2000 再检测，再大的图喂进去也是白算；而几何校正
/// 的透视取样是逐像素的，2600 已经把一张 A4 拍到 220dpi 以上。放开到原图尺寸
/// 只会让 8GB 内存的机器在 40MP 照片上抖。
pub const MAX_SIDE: u32 = 2600;

/// 三件套开关。默认全关 —— 好扫描件不需要任何处理。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Opts {
    /// 拉直 + 去透视。会改变画幅尺寸。
    pub rectify: bool,
    /// 去摩尔纹（屏幕翻拍、投影幕布）。
    pub demoire: bool,
    /// 增强：白平衡 + 局部对比度 + 轻微锐化。
    pub enhance: bool,
}

impl Opts {
    pub fn any(&self) -> bool {
        self.rectify || self.demoire || self.enhance
    }
}

/// 实际做了什么，回给界面用。
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Report {
    /// 拉直用掉的倾角（度），正数表示原图内容顺时针偏了这个角度。
    pub angle_deg: f32,
    /// 是否做了四角透视校正。
    pub perspective: bool,
}

impl Report {
    pub fn describe(&self) -> String {
        if self.perspective {
            "perspective".to_string()
        } else if self.angle_deg.abs() >= 0.3 {
            format!("{:.1}", self.angle_deg)
        } else {
            String::new()
        }
    }
}

/// 跑一遍预处理。`rectify` 由调用方决定是否允许（PDF 页不允许：文字层的坐标
/// 是跟原页面对齐的，画幅一变全歪）。
pub fn apply(img: &DynamicImage, o: &Opts) -> (DynamicImage, Report) {
    if !o.any() {
        return (img.clone(), Report::default());
    }
    let mut rgb: RgbImage = img.to_rgb8();
    let (w, h) = (rgb.width(), rgb.height());
    let longest = w.max(h);
    if longest > MAX_SIDE {
        let r = MAX_SIDE as f64 / longest as f64;
        rgb = image::imageops::resize(
            &rgb,
            ((w as f64 * r).round() as u32).max(1),
            ((h as f64 * r).round() as u32).max(1),
            image::imageops::FilterType::Triangle,
        );
    }
    let mut report = Report::default();
    if o.rectify {
        if let Some((out, rep)) = rectify::rectify(&rgb) {
            rgb = out;
            report = rep;
        }
    }
    if o.demoire {
        rgb = filters::demoire(&rgb);
    }
    if o.enhance {
        rgb = filters::enhance(&rgb);
    }
    (DynamicImage::ImageRgb8(rgb), report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;

    /// 白纸 + 横向墨条，模拟正文页。
    fn page(w: u32, h: u32) -> RgbImage {
        let mut img = RgbImage::from_pixel(w, h, Rgb([245, 243, 238]));
        let margin = (w / 8).max(8);
        let mut y = 40u32;
        while y + 10 < h.saturating_sub(40) {
            for x in margin..w - margin {
                for dy in 0..8 {
                    img.put_pixel(x, y + dy, Rgb([28, 28, 30]));
                }
            }
            y += 26;
        }
        img
    }

    /// 把 `src` 按 `quad` 四点贴进一块纯色画布 —— 只为造测试图，用最近邻。
    fn warp_into(src: &RgbImage, quad: &[(f64, f64); 4], cw: u32, ch: u32, bg: [u8; 3]) -> RgbImage {
        let mut out = RgbImage::from_pixel(cw, ch, Rgb(bg));
        let sw = src.width() as f64 - 1.0;
        let sh = src.height() as f64 - 1.0;
        let src_rect = [(0.0, 0.0), (sw, 0.0), (sw, sh), (0.0, sh)];
        let h = homography(quad, &src_rect);
        for y in 0..ch {
            for x in 0..cw {
                let (dx, dy) = (x as f64 + 0.5, y as f64 + 0.5);
                let den = h[6] * dx + h[7] * dy + 1.0;
                if den.abs() < 1e-9 {
                    continue;
                }
                let sx = (h[0] * dx + h[1] * dy + h[2]) / den;
                let sy = (h[3] * dx + h[4] * dy + h[5]) / den;
                if !(0.0..=sw).contains(&sx) || !(0.0..=sh).contains(&sy) {
                    continue;
                }
                let px = src.get_pixel(sx.round() as u32, sy.round() as u32);
                out.put_pixel(x, y, *px);
            }
        }
        out
    }

    #[test]
    fn skew_is_recovered() {
        let p = page(400, 520);
        let tilted = rotate_expand(&p, 4.0, [255, 255, 255]);
        let a = estimate_skew(&to_gray(&tilted)).expect("应能看出倾斜");
        assert!((a - 4.0).abs() < 0.6, "估计 {a}，实际 4.0");
    }

    #[test]
    fn rectify_straightens_image() {
        let p = page(400, 520);
        let tilted = DynamicImage::ImageRgb8(rotate_expand(&p, 3.5, [255, 255, 255]));
        let (out, rep) = apply(&tilted, &Opts { rectify: true, ..Default::default() });
        assert!(!rep.perspective, "不该误判成透视");
        assert!((rep.angle_deg - 3.5).abs() < 0.8, "报告角 {}", rep.angle_deg);
        let residual = estimate_skew(&to_gray(&out.to_rgb8())).unwrap_or(0.0);
        assert!(residual.abs() < 0.6, "校正后仍有 {residual}°");
    }

    #[test]
    fn flat_scan_is_not_resampled() {
        let p = page(400, 520);
        let (out, rep) = apply(
            &DynamicImage::ImageRgb8(p.clone()),
            &Opts { rectify: true, ..Default::default() },
        );
        assert_eq!((out.width(), out.height()), (p.width(), p.height()));
        assert!(!rep.perspective, "端正页面不该被判成梯形");
        assert_eq!(rep.angle_deg, 0.0);
    }

    #[test]
    fn perspective_quad_is_found() {
        // 深色桌面上的纸：四边必须连续有强梯度，纸面比桌面亮。
        let p = page(300, 400);
        let quad = [(120.0, 80.0), (400.0, 100.0), (430.0, 500.0), (100.0, 470.0)];
        let canvas = warp_into(&p, &quad, 520, 560, [48, 46, 44]);
        let q = find_doc_quad(&to_gray(&canvas)).expect("应能找到纸张四角");
        for i in 0..4 {
            let d = dist(q[i], quad[i]);
            assert!(d < 16.0, "第 {i} 角偏差 {d:.1}px：找到 {:?}，期望 {:?}", q[i], quad[i]);
        }
    }

    #[test]
    fn table_border_is_not_mistaken_for_the_page() {
        // 页内一圈边框，四角与面积都像纸张 —— 但边框内外亮度一样，必须拒绝。
        let p = page(400, 520);
        let g = to_gray(&p);
        assert!(find_doc_quad(&g).is_none(), "页内表格边框被当成了纸张");
    }

    #[test]
    fn textured_photo_is_not_a_document() {
        // 纯噪声没有任何「纸张边缘」，也必须拒绝 —— 这是最容易误伤的输入。
        let (w, h) = (300u32, 300u32);
        let mut img = RgbImage::new(w, h);
        let mut seed = 12345u32;
        for y in 0..h {
            for x in 0..w {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                let v = (seed >> 24) as u8;
                img.put_pixel(x, y, Rgb([v, v, v]));
            }
        }
        assert!(find_doc_quad(&to_gray(&img)).is_none(), "噪声图被当成了文档");
    }

    #[test]
    fn perspective_rectify_end_to_end() {
        let p = page(300, 400);
        let quad = [(120.0, 80.0), (400.0, 100.0), (430.0, 500.0), (100.0, 470.0)];
        let canvas = DynamicImage::ImageRgb8(warp_into(&p, &quad, 520, 560, [48, 46, 44]));
        let (out, rep) = apply(&canvas, &Opts { rectify: true, ..Default::default() });
        assert!(rep.perspective, "梯形拍摄没有走透视校正");
        let ratio = out.width() as f64 / out.height() as f64;
        assert!((ratio - 0.75).abs() < 0.10, "校正后纵横比 {ratio:.2}，应接近 0.75");
        // 校正后文字行应当接近水平
        let residual = estimate_skew(&to_gray(&out.to_rgb8())).unwrap_or(0.0);
        assert!(residual.abs() < 1.2, "校正后仍有 {residual:.1}°");
    }

    #[test]
    fn demoire_kills_periodic_pattern() {
        let (w, h) = (240u32, 240u32);
        let mut img = RgbImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = if (x / 2 + y / 2) % 2 == 0 { 40 } else { 220 };
                img.put_pixel(x, y, Rgb([v, v, v]));
            }
        }
        let energy = |im: &RgbImage| -> f64 {
            let mut s = 0f64;
            for y in 0..im.height() {
                for x in 0..im.width() - 1 {
                    let a = im.get_pixel(x, y)[0] as f64;
                    let b = im.get_pixel(x + 1, y)[0] as f64;
                    s += (a - b).abs();
                }
            }
            s
        };
        let before = energy(&img);
        let after = energy(&filters::demoire(&img));
        assert!(after < before * 0.6, "高频只降到 {:.0}/{:.0}", after, before);
        assert_eq!((240, 240), (filters::demoire(&img).width(), filters::demoire(&img).height()));
    }

    #[test]
    fn enhance_keeps_flat_paper_flat() {
        let img = RgbImage::from_pixel(160, 160, Rgb([250, 250, 250]));
        let out = filters::enhance(&img);
        for p in out.pixels() {
            assert!(p[0] >= 246, "白纸被压到 {}", p[0]);
        }
    }

    #[test]
    fn disabled_opts_change_nothing() {
        let p = page(200, 260);
        let d = DynamicImage::ImageRgb8(p.clone());
        let (out, rep) = apply(&d, &Opts::default());
        assert_eq!(rep, Report::default());
        assert_eq!(out.to_rgb8().as_raw(), p.as_raw());
    }
}
