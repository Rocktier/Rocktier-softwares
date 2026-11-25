//! The whole pipeline: image in, text lines out, mirroring RapidOCR's
//! `RapidOCR.__call__` step for step - side-length normalisation, the wide
//! strip letterbox, detection, box sorting, perspective crops, the direction
//! classifier, recognition, the score filter, and the coordinate trip back
//! to the original image.

use anyhow::Result;
use image::{DynamicImage, RgbImage};

use crate::det::{self, DetParams};
use crate::words;
/// 单应矩阵与透视取样住在 `ocr-preprocess`：识别裁切与前置处理的去透视共用
/// 同一套取样器，两份实现各调一次插值核，同一张图会得到两个坐标基准。
/// 这里 re-export，`words.rs` 里的 `crate::pipeline::homography` 不用改。
pub use ocr_preprocess::homography;
use ocr_preprocess::{dist, perspective_warp};

pub struct OcrLine {
    pub box4: [(i32, i32); 4],
    pub text: String,
    pub score: f32,
    /// Per-word (or per-character, for CJK) quads in original-image coords.
    pub words: Vec<(String, [(i32, i32); 4])>,
}

pub struct Pipeline {
    pub det: ort::session::Session,
    pub cls: ort::session::Session,
    pub rec: crate::rec::RecModel,
    pub det_params: DetParams,
    /// Global config: wide strips wider than this ratio get letterboxed.
    pub width_height_ratio: f32,
    pub min_height: f32,
    pub max_side_len: usize,
    pub min_side_len: usize,
    pub text_score: f32,
}

struct Frame {
    img: RgbImage,
    /// ops in the order they were applied, so boxes can go back the way they
    /// came: ratios first, then the letterbox - the reverse pass subtracts and
    /// scales in the opposite order.
    ratio_h: f64,
    ratio_w: f64,
    pad_top: i64,
    pad_left: i64,
}

impl Pipeline {
    pub fn load(det_path: &std::path::Path, cls_path: &std::path::Path, rec_path: &std::path::Path) -> Result<Self> {
        let det = ort::session::Session::builder()?.commit_from_file(det_path)?;
        let cls = ort::session::Session::builder()?.commit_from_file(cls_path)?;
        let rec = crate::rec::RecModel::load(rec_path)?;
        Ok(Self {
            det,
            cls,
            rec,
            det_params: DetParams::default(),
            width_height_ratio: 8.0,
            min_height: 30.0,
            max_side_len: 2000,
            min_side_len: 30,
            text_score: 0.5,
        })
    }

    pub fn run(&mut self, raw: &DynamicImage) -> Result<Vec<OcrLine>> {
        let raw_w = raw.width() as usize;
        let raw_h = raw.height() as usize;
        let mut frame = self.normalise_sides(raw);
        self.maybe_letterbox(&mut frame);

        // Detection, in the transformed frame.
        let (input, nw, nh) = det::preprocess(&frame.img, &self.det_params);
        let x = ort::value::Tensor::from_array(([1i64, 3, nh as i64, nw as i64], input))?;
        let outs = self.det.run(ort::inputs![x])?;
        let (_shape, prob) = outs[0].try_extract_tensor::<f32>()?;
        let mut boxes = det::boxes_from_bitmap(prob, nw, nh, frame.img.width() as usize, frame.img.height() as usize, &self.det_params);
        sort_boxes(&mut boxes);

        // Perspective crops, upright, in recognition order.
        let mut crops: Vec<RgbImage> = Vec::with_capacity(boxes.len());
        let mut quads: Vec<[(f64, f64); 4]> = Vec::with_capacity(boxes.len());
        for b in &boxes {
            crops.push(rotate_crop(&frame.img, &b.box4));
            quads.push(b.box4.map(|(x, y)| (x as f64, y as f64)));
        }

        // Direction classifier, then recognition.
        for c in crops.iter_mut() {
            let owned = std::mem::take(c);
            *c = crate::cls::maybe_rotate(&mut self.cls, &owned)?;
        }
        let rec = self.rec.recognize(&crops)?;

        // Score filter, word boxes, then the coordinate trip back to the
        // original image - words ride the same transform as their line.
        let mut lines = Vec::new();
        for (((b, r), crop), quad) in boxes.iter().zip(rec).zip(crops.iter()).zip(quads.iter()) {
            if r.score < self.text_score {
                continue;
            }
            let words: Vec<(String, [(i64, i64); 4])> = words::word_boxes(
                &r.text, &r.selection, r.steps,
                (crop.width() as usize, crop.height() as usize),
                quad,
            )
            .into_iter()
            .map(|(t, q)| {
                let q = q.map(|(x, y)| {
                    let (mut x, mut y) = (x as f64, y as f64);
                    x -= frame.pad_left as f64;
                    y -= frame.pad_top as f64;
                    x *= frame.ratio_w;
                    y *= frame.ratio_h;
                    ((x.round() as i64).clamp(0, raw_w as i64), (y.round() as i64).clamp(0, raw_h as i64))
                });
                (t, q)
            })
            .collect();
            let mut box4 = b.box4;
            for c in box4.iter_mut() {
                let (mut x, mut y) = (c.0 as f64, c.1 as f64);
                x -= frame.pad_left as f64;
                y -= frame.pad_top as f64;
                x *= frame.ratio_w;
                y *= frame.ratio_h;
                *c = (
                    (x.round() as i64).clamp(0, raw_w as i64) as i32,
                    (y.round() as i64).clamp(0, raw_h as i64) as i32,
                );
            }
            let words = words
                .into_iter()
                .map(|(t, q)| (t, q.map(|(x, y)| (x as i32, y as i32))))
                .collect();
            lines.push(OcrLine { box4, text: r.text.clone(), score: r.score, words });
        }
        Ok(lines)
    }

    /// `preprocess`: shrink past the max side, grow past the min side. The
    /// ratios overwrite each other the way the Python reassigns them.
    fn normalise_sides(&self, raw: &DynamicImage) -> Frame {
        let (mut ratio_h, mut ratio_w) = (1.0f64, 1.0f64);
        let (mut w, mut h) = (raw.width() as f64, raw.height() as f64);
        if w.max(h) > self.max_side_len as f64 {
            let ratio = self.max_side_len as f64 / w.max(h);
            w = (w * ratio).floor();
            h = (h * ratio).floor();
            // The returned ratio is the trip BACK to the original size - the
            // origin mapping multiplies by it - so it is original over new.
            ratio_h = raw.height() as f64 / h;
            ratio_w = raw.width() as f64 / w;
        }
        if w.min(h) < self.min_side_len as f64 {
            let ratio = self.min_side_len as f64 / w.min(h);
            w = (w * ratio).floor();
            h = (h * ratio).floor();
            // Same convention, and the Python reassigns rather than
            // multiplies, so a double transform keeps only this ratio.
            ratio_h = raw.height() as f64 / h;
            ratio_w = raw.width() as f64 / w;
        }
        let rgb = raw.to_rgb8();
        let img = crate::det::bilinear_resize(&rgb, w as usize, h as usize);
        Frame { img, ratio_h, ratio_w, pad_top: 0, pad_left: 0 }
    }

    /// `maybe_add_letterbox`: very short or very wide strips get round-locked
    /// padding above and below so the detector has something to bite on.
    fn maybe_letterbox(&self, frame: &mut Frame) {
        let (w, h) = (frame.img.width() as f64, frame.img.height() as f64);
        let use_limit_ratio = w / h > self.width_height_ratio as f64;
        if h <= self.min_height as f64 || use_limit_ratio {
            let new_h = ((w / self.width_height_ratio as f64) as i64)
                .max(self.min_height as i64)
                * 2;
            let padding_h = ((new_h - h as i64).abs() / 2) as i64;
            if padding_h > 0 {
                let mut padded = RgbImage::new(frame.img.width(), (h as i64 + 2 * padding_h) as u32);
                image::imageops::overlay(&mut padded, &frame.img, padding_h as u32 as i64, 0);
                frame.img = padded;
                frame.pad_top = padding_h;
            }
        }
    }
}

/// `sorted_boxes`: top to bottom, then a bubble pass that keeps same-row
/// boxes (tops within ten pixels) left to right.
fn sort_boxes(boxes: &mut [det::TextBox]) {
    boxes.sort_by(|a, b| {
        let ka = (a.box4[0].1, a.box4[0].0);
        let kb = (b.box4[0].1, b.box4[0].0);
        ka.cmp(&kb)
    });
    let n = boxes.len();
    for i in 0..n.saturating_sub(1) {
        for j in (0..=i).rev() {
            let top_gap = (boxes[j + 1].box4[0].1 - boxes[j].box4[0].1).abs();
            if top_gap < 10 && boxes[j + 1].box4[0].0 < boxes[j].box4[0].0 {
                boxes.swap(j, j + 1);
            }
        }
    }
}

/// `get_rotate_crop_image`: perspective-warp the quad into an upright rect,
/// replicating edges, then turn tall crops the right way round.
fn rotate_crop(img: &RgbImage, quad: &[(i32, i32); 4]) -> RgbImage {
    let p = [quad[0], quad[1], quad[2], quad[3]];
    let pf = p.map(|(x, y)| (x as f64, y as f64));
    let crop_w = dist(pf[0], pf[1]).max(dist(pf[2], pf[3])) as u32;
    let crop_h = dist(pf[0], pf[3]).max(dist(pf[1], pf[2])) as u32;
    if crop_w == 0 || crop_h == 0 {
        return RgbImage::new(1, 1);
    }
    let warped = perspective_warp(img, &p, crop_w, crop_h);
    if crop_h as f32 / crop_w as f32 >= 1.5 {
        // np.rot90 turns counter-clockwise; the image crate's rotate90 runs
        // clockwise, so the counter-clockwise turn is rotate270 here.
        image::imageops::rotate270(&warped)
    } else {
        warped
    }
}

