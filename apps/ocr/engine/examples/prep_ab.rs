//! 前置处理 A/B：同一张图，识别前 / 识别后各认一遍，直接对比。
//!
//! 用法（在 engine/ 下）：
//!   cargo run --example prep_ab -- /tmp/ocr-photo.png
//!
//! 这不是断言式的测试（模型输出不是逐字稳定的），是用来**看数字**的：
//! 拉直之后认出多少行、平均分多少，和原图差在哪。回归时人工跑一次。

use ocr_preprocess::Opts;
use std::path::{Path, PathBuf};

fn models_dir() -> PathBuf {
    if let Ok(p) = std::env::var("OCR_MODELS_DIR") {
        return PathBuf::from(p);
    }
    Path::new("..").join("src-tauri/resources/models")
}

fn main() -> anyhow::Result<()> {
    let img_path = std::env::args().nth(1).unwrap_or_else(|| "/tmp/ocr-photo.png".into());
    let dir = models_dir();
    let m = |n: &str| dir.join(n);
    let mut pipe = ocr_engine::Pipeline::load(
        &m("ch_PP-OCRv4_det_infer.onnx"),
        &m("ch_ppocr_mobile_v2.0_cls_infer.onnx"),
        &m("ch_PP-OCRv4_rec_infer.onnx"),
    )?;

    let raw = image::open(&img_path)?;
    // PREP=rectify,demoire,enhance 可只开其中几项；默认只开拉直。
    let spec = std::env::var("PREP").unwrap_or_else(|_| "rectify".to_string());
    let opts = Opts {
        rectify: spec.contains("rectify"),
        demoire: spec.contains("demoire"),
        enhance: spec.contains("enhance"),
    };
    println!("开关：{}", spec);
    let t0 = std::time::Instant::now();
    let before = pipe.run(&raw)?;
    let t_before = t0.elapsed();

    let t1 = std::time::Instant::now();
    let (fixed, rep) = ocr_preprocess::apply(&raw, &opts);
    let t_fix = t1.elapsed();
    let t2 = std::time::Instant::now();
    let after = pipe.run(&fixed)?;
    let t_after = t2.elapsed();
    fixed.save("/tmp/ocr-photo-rectified.png")?;

    let chars = |v: &[ocr_engine::OcrLine]| v.iter().map(|l| l.text.chars().count()).sum::<usize>();
    let mean = |v: &[ocr_engine::OcrLine]| {
        if v.is_empty() {
            0.0
        } else {
            v.iter().map(|l| l.score as f64).sum::<f64>() / v.len() as f64
        }
    };
    println!(
        "原图 {}×{} → 校正后 {}×{}（角度 {:.1}°，透视 {}）",
        raw.width(),
        raw.height(),
        fixed.width(),
        fixed.height(),
        rep.angle_deg,
        rep.perspective
    );
    println!(
        "识别：原图 {} 行 / {} 字 / 均分 {:.3}；校正后 {} 行 / {} 字 / 均分 {:.3}",
        before.len(),
        chars(&before),
        mean(&before),
        after.len(),
        chars(&after),
        mean(&after)
    );
    println!(
        "耗时：识别原图 {:?}｜预处理 {:?}｜识别校正图 {:?}",
        t_before, t_fix, t_after
    );
    println!("--- 原图 ---");
    for l in &before {
        println!("  {:.2} {}", l.score, l.text);
    }
    println!("--- 校正后 ---");
    for l in &after {
        println!("  {:.2} {}", l.score, l.text);
    }
    Ok(())
}
