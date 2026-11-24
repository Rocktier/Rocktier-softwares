//! 提取 PDF 里**内嵌的原图**（不是把页面渲染成图片）。
//!
//! 「导出为图片」渲染页面，得到的是所见即所得但不含原始像素；这里取的是
//! 图像 XObject 的原始数据：扫描件里那张 3000px 的照片、报告里那张 PNG 图表。
//! 两者用途不同，入口也分开放（菜单里一个叫「导出图片」一个叫「提取内嵌图片」）。
//!
//! 解码路径只做三种，其余一律跳过并计数 —— 宁可少给几张，也不给错的文件：
//!
//! - `DCTDecode`：流里本来就是一份 JPEG，原样写出，一个字节都不重编码
//! - `JPXDecode`：JPEG 2000，原样写成 `.jp2`
//! - 无滤镜 / `FlateDecode`：8 位灰度或 RGB 的原始像素，重新封成 PNG
//!
//! 跳过的情形（CCITT 传真、JBIG2、LZW、RunLength、调色板、CMYK、
//! 带 Predictor 的编码）：这些要么得先做 TIFF 包装，要么色彩语义会翻车。
//! `skipped` 会把数量报给界面，避免"提取完了只出来两张"没有任何解释。

use std::collections::{BTreeSet, HashSet};
use std::io::Cursor;

use lopdf::{Dictionary, Document, Object, ObjectId};

/// 单张图像解压后的上限。21600×21600 的 8 位 RGB 已经是 1.4 GB，
/// 再往下走就是把内存当筹码，而这份文件本来也不该整张导出。
const MAX_RAW_BYTES: usize = 256 * 1024 * 1024;

/// 提取结果。`skipped` 与 `duplicates` 分开计：前者是"这张我处理不了"，
/// 后者是"同一张图在多页复用"，都是正常情况，不该混成一个数字。
#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractSummary {
    pub written: usize,
    pub skipped: usize,
    pub duplicates: usize,
    /// 实际写入的目录，供界面 toast / 打开文件夹使用。
    pub dir: String,
}

fn resolve<'a>(doc: &'a Document, obj: &'a Object) -> &'a Object {
    match obj {
        Object::Reference(id) => doc.get_object(*id).unwrap_or(obj),
        other => other,
    }
}

fn as_dict<'a>(doc: &'a Document, obj: &'a Object) -> Option<&'a Dictionary> {
    match resolve(doc, obj) {
        Object::Dictionary(d) => Some(d),
        _ => None,
    }
}

fn as_i64(doc: &Document, obj: &Object) -> Option<i64> {
    match resolve(doc, obj) {
        Object::Integer(i) => Some(*i),
        Object::Real(r) => Some(*r as i64),
        _ => None,
    }
}

/// 页字典上可能被继承的条目（`/Resources` 常常写在 `/Pages` 节点上）。
fn inherited(doc: &Document, id: ObjectId, key: &[u8]) -> Option<Object> {
    let mut cursor = id;
    for _ in 0..32 {
        let dict = doc.get_dictionary(cursor).ok()?;
        if let Ok(value) = dict.get(key) {
            return Some(value.clone());
        }
        match dict.get(b"Parent").ok() {
            Some(Object::Reference(parent)) => cursor = *parent,
            _ => return None,
        }
    }
    None
}

/// 把 `Filter` 展开成滤镜名列表。单个名字与数组两种写法都合法。
fn filters(doc: &Document, dict: &Dictionary) -> Vec<Vec<u8>> {
    match dict.get(b"Filter") {
        Ok(Object::Array(items)) => items
            .iter()
            .filter_map(|o| resolve(doc, o).as_name().ok().map(|n| n.to_vec()))
            .collect(),
        Ok(obj) => resolve(doc, obj)
            .as_name()
            .ok()
            .map(|n| vec![n.to_vec()])
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// PNG 预测器会把像素差值编码成流，先解压再读会得到错位的图。
/// 这种图直接跳过，别给用户一张花屏。
fn has_predictor(doc: &Document, dict: &Dictionary) -> bool {
    let Ok(parms) = dict.get(b"DecodeParms") else {
        return false;
    };
    let parms = match resolve(doc, parms) {
        Object::Array(items) => match items.first() {
            Some(first) => resolve(doc, first),
            None => return false,
        },
        other => other,
    };
    let Object::Dictionary(d) = parms else {
        return false;
    };
    d.get(b"Predictor")
        .ok()
        .and_then(|o| as_i64(doc, o))
        .map(|p| p > 1)
        .unwrap_or(false)
}

/// 通道数：只认 DeviceGray(1) / DeviceRGB(3) / ICCBased(按 ICC 流的 /N)。
fn components(doc: &Document, dict: &Dictionary) -> Option<usize> {
    let raw = dict.get(b"ColorSpace").ok()?;
    match resolve(doc, raw) {
        Object::Name(name) => match name.as_slice() {
            b"DeviceGray" | b"G" | b"CalGray" => Some(1),
            b"DeviceRGB" | b"RGB" | b"CalRGB" => Some(3),
            _ => None,
        },
        Object::Array(arr) => {
            let head = resolve(doc, arr.first()?).as_name().ok()?;
            if head != b"ICCBased" {
                // 调色板 / 分色 / 专色：色彩语义不是"每个通道一个字节"，
                // 封成 PNG 会得到一张颜色完全不对的图。
                return None;
            }
            let icc = as_dict(doc, arr.get(1)?)?;
            match icc.get(b"N").ok().and_then(|o| as_i64(doc, o)) {
                Some(1) => Some(1),
                Some(3) => Some(3),
                _ => None,
            }
        }
        _ => None,
    }
}

/// 解压一个流的像素内容。没有滤镜时直接拿原文。
fn pixel_bytes(doc: &Document, stream: &lopdf::Stream, filters: &[Vec<u8>]) -> Option<Vec<u8>> {
    if filters.is_empty() {
        return Some(stream.content.clone());
    }
    if filters.len() == 1 && filters[0].as_slice() == b"FlateDecode" {
        if has_predictor(doc, &stream.dict) {
            return None;
        }
        return stream.decompressed_content().ok();
    }
    None
}

/// 灰度蒙版（`/SMask`）的字节，用于合成 alpha。
fn mask_bytes(doc: &Document, id: ObjectId, width: usize, height: usize) -> Option<Vec<u8>> {
    let obj = doc.get_object(id).ok()?;
    let stream = obj.as_stream().ok()?;
    if stream
        .dict
        .get(b"BitsPerComponent")
        .ok()
        .and_then(|o| as_i64(doc, o))
        .unwrap_or(8)
        != 8
    {
        return None;
    }
    let raw = if stream.dict.get(b"Filter").is_err() {
        stream.content.clone()
    } else if filters(doc, &stream.dict)
        .iter()
        .all(|f| f.as_slice() == b"FlateDecode")
    {
        stream.decompressed_content().ok()?
    } else {
        return None;
    };
    if raw.len() < width * height {
        return None;
    }
    Some(raw[..width * height].to_vec())
}

/// 把一张图像 XObject 写成文件。返回 `false` 表示这张被跳过。
fn write_image(
    doc: &Document,
    id: ObjectId,
    page_no: u32,
    seq: usize,
    dir: &std::path::Path,
    stem: &str,
    smasks: &HashSet<ObjectId>,
) -> bool {
    let Ok(obj) = doc.get_object(id) else {
        return false;
    };
    let Ok(stream) = obj.as_stream() else {
        return false;
    };
    let dict = &stream.dict;

    // 1 位图像蒙版是形状不是图；解出来也是一张黑白剪影。
    if matches!(dict.get(b"ImageMask"), Ok(Object::Boolean(true))) {
        return false;
    }
    let (Some(w), Some(h)) = (
        dict.get(b"Width").ok().and_then(|o| as_i64(doc, o)),
        dict.get(b"Height").ok().and_then(|o| as_i64(doc, o)),
    ) else {
        return false;
    };
    if w <= 0 || h <= 0 {
        return false;
    }
    let (w, h) = (w as usize, h as usize);

    let fs = filters(doc, dict);

    // JPEG / JPEG 2000：流里就是成品文件，原样落盘。重编码只会掉画质。
    if fs.len() == 1 && (fs[0].as_slice() == b"DCTDecode" || fs[0].as_slice() == b"DCT") {
        let path = dir.join(format!("{stem}-p{page_no:03}-img{seq:02}.jpg"));
        return std::fs::write(&path, &stream.content).is_ok();
    }
    if fs.len() == 1 && (fs[0].as_slice() == b"JPXDecode" || fs[0].as_slice() == b"JPX") {
        let path = dir.join(format!("{stem}-p{page_no:03}-img{seq:02}.jp2"));
        return std::fs::write(&path, &stream.content).is_ok();
    }

    let Some(comps) = components(doc, dict) else {
        return false;
    };
    if dict
        .get(b"BitsPerComponent")
        .ok()
        .and_then(|o| as_i64(doc, o))
        .unwrap_or(8)
        != 8
    {
        return false;
    }
    let expected = w * h * comps;
    if expected > MAX_RAW_BYTES {
        return false;
    }
    let Some(raw) = pixel_bytes(doc, stream, &fs) else {
        return false;
    };
    if raw.len() < expected {
        return false;
    }
    let raw = &raw[..expected];

    // 有蒙版就补 alpha —— 否则透明底的 logo 会变成一块黑。
    let alpha = dict
        .get(b"SMask")
        .ok()
        .and_then(|o| match o {
            Object::Reference(m) if !smasks.contains(m) => mask_bytes(doc, *m, w, h),
            _ => None,
        });

    let path = dir.join(format!("{stem}-p{page_no:03}-img{seq:02}.png"));
    let color = match (comps, alpha) {
        (1, None) => image::ExtendedColorType::L8,
        (1, Some(mask)) => {
            let mut buf = Vec::with_capacity(w * h * 2);
            for i in 0..w * h {
                buf.push(raw[i]);
                buf.push(mask[i]);
            }
            return image::save_buffer_with_format(
                &path,
                &buf,
                w as u32,
                h as u32,
                image::ExtendedColorType::La8,
                image::ImageFormat::Png,
            )
            .is_ok();
        }
        (3, None) => image::ExtendedColorType::Rgb8,
        (3, Some(mask)) => {
            let mut buf = Vec::with_capacity(w * h * 4);
            for i in 0..w * h {
                buf.extend_from_slice(&raw[i * 3..i * 3 + 3]);
                buf.push(mask[i]);
            }
            return image::save_buffer_with_format(
                &path,
                &buf,
                w as u32,
                h as u32,
                image::ExtendedColorType::Rgba8,
                image::ImageFormat::Png,
            )
            .is_ok();
        }
        _ => return false,
    };

    image::save_buffer_with_format(&path, raw, w as u32, h as u32, color, image::ImageFormat::Png)
        .is_ok()
}

/// 一页上的图像 XObject，按出现顺序；`/Subtype /Form` 会往里钻一层（表单里
/// 常常包着真正的图像，只看页级 XObject 会漏掉整份扫描件）。
fn page_images(doc: &Document, page_id: ObjectId) -> Vec<ObjectId> {
    let mut out = Vec::new();
    let mut seen_forms: HashSet<ObjectId> = HashSet::new();
    if let Some(resources) = inherited(doc, page_id, b"Resources") {
        collect_images(doc, &resources, &mut out, &mut seen_forms, 0);
    }
    out
}

fn collect_images(
    doc: &Document,
    resources: &Object,
    out: &mut Vec<ObjectId>,
    seen_forms: &mut HashSet<ObjectId>,
    depth: usize,
) {
    if depth > 3 {
        return;
    }
    let Some(res) = as_dict(doc, resources) else {
        return;
    };
    let Ok(xobjects) = res.get(b"XObject") else {
        return;
    };
    let Some(xdict) = as_dict(doc, xobjects) else {
        return;
    };
    for (_, value) in xdict.iter() {
        let Object::Reference(id) = value else {
            continue;
        };
        let Ok(obj) = doc.get_object(*id) else {
            continue;
        };
        let Ok(stream) = obj.as_stream() else {
            continue;
        };
        // `as_name` 给的是 `&[u8]`，直接和字节字面量比 —— 比造一个
        // `Option<&[u8]>` 再 match 少一层类型体操。
        let subtype = stream
            .dict
            .get(b"Subtype")
            .ok()
            .and_then(|o| o.as_name().ok())
            .unwrap_or_default();
        if subtype == b"Image" {
            out.push(*id);
        } else if subtype == b"Form" {
            if !seen_forms.insert(*id) {
                continue;
            }
            if let Ok(sub) = stream.dict.get(b"Resources") {
                collect_images(doc, sub, out, seen_forms, depth + 1);
            }
        }
    }
}

/// 被别的图像当作 `/SMask` 引用的对象 —— 它们是透明通道，不是独立可用的图。
fn referenced_masks(doc: &Document, images: &[ObjectId]) -> HashSet<ObjectId> {
    let mut out = HashSet::new();
    for id in images {
        let Ok(obj) = doc.get_object(*id) else {
            continue;
        };
        let Ok(stream) = obj.as_stream() else {
            continue;
        };
        if let Some(Object::Reference(mask)) = stream.dict.get(b"SMask").ok() {
            out.insert(*mask);
        }
    }
    out
}

/// 从 `bytes` 里提取指定页（1 基，空 = 全部页）的内嵌图像，写进 `output_dir`。
///
/// `stem` 只做文件名前缀，实际文件名形如 `报告-p003-img01.png`：
/// 页码写进名字，用户才知道哪张来自哪页；序号避免同页多图互相覆盖。
pub fn extract_images(
    bytes: &[u8],
    pages: &[u32],
    output_dir: &str,
    stem: &str,
) -> Result<ExtractSummary, String> {
    let doc = Document::load_from(Cursor::new(bytes))
        .map_err(|e| format!("Cannot parse the PDF: {e}"))?;
    let page_ids = doc.get_pages();
    if page_ids.is_empty() {
        return Err("This PDF has no pages.".to_string());
    }
    std::fs::create_dir_all(output_dir)
        .map_err(|e| format!("Cannot create the folder: {e}"))?;

    let targets: Vec<u32> = if pages.is_empty() {
        page_ids.keys().copied().collect()
    } else {
        pages.to_vec()
    };
    for n in &targets {
        if !page_ids.contains_key(n) {
            return Err(format!("Page {n} is out of range"));
        }
    }

    // 先把所有候选图收齐，才知道哪些对象是被引用的蒙版。
    let mut per_page: Vec<(u32, Vec<ObjectId>)> = Vec::with_capacity(targets.len());
    for n in targets {
        let ids = page_images(&doc, page_ids[&n]);
        per_page.push((n, ids));
    }
    let all: Vec<ObjectId> = per_page.iter().flat_map(|(_, ids)| ids.iter().copied()).collect();
    let smasks = referenced_masks(&doc, &all);

    let dir = std::path::Path::new(output_dir);
    let mut summary = ExtractSummary {
        written: 0,
        skipped: 0,
        duplicates: 0,
        dir: output_dir.to_string(),
    };
    // 同一张图在多页复用（页眉 logo）只写一次：pdfium 保存过的文件里，
    // 复用的图共享同一个对象，按对象去重是准确的做法。
    let mut done: BTreeSet<ObjectId> = BTreeSet::new();

    for (page_no, ids) in per_page {
        let mut seq = 0usize;
        for id in ids {
            if smasks.contains(&id) {
                continue;
            }
            if !done.insert(id) {
                summary.duplicates += 1;
                continue;
            }
            seq += 1;
            if write_image(&doc, id, page_no, seq, dir, stem, &smasks) {
                summary.written += 1;
            } else {
                summary.skipped += 1;
            }
        }
    }

    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Stream};

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "rocktier-imgextract-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 造一份单页 PDF，页上挂一张图像 XObject。
    fn pdf_with_image(mut image_dict: Dictionary, content: Vec<u8>) -> Vec<u8> {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        // /Length 必须自己写：解析器按它切流，缺了会把后面的 xref 当成像素。
        image_dict.set("Length", Object::Integer(content.len() as i64));
        let image_id = doc.add_object(Stream::new(image_dict, content));
        let page_content = doc.add_object(Stream::new(dictionary! {}, Vec::new()));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => Object::Reference(pages_id),
            "MediaBox" => vec![0i64.into(), 0i64.into(), 200i64.into(), 300i64.into()],
            "Contents" => Object::Reference(page_content),
            "Resources" => dictionary! {
                "XObject" => dictionary! { "Im1" => Object::Reference(image_id) },
            },
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![Object::Reference(page_id)],
                "Count" => 1i64,
            }),
        );
        let catalog = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => Object::Reference(pages_id),
        });
        doc.trailer.set("Root", Object::Reference(catalog));
        doc.renumber_objects();
        let mut out = Vec::new();
        doc.save_to(&mut out).unwrap();
        out
    }

    fn rgb_dict(w: i64, h: i64) -> Dictionary {
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => w,
            "Height" => h,
            "ColorSpace" => "DeviceRGB",
            "BitsPerComponent" => 8,
        }
    }

    #[test]
    fn raw_rgb_pixels_become_a_png_of_the_same_size() {
        let dir = temp_dir("rgb");
        // 2×2 纯红
        let pixels: Vec<u8> = std::iter::repeat([255u8, 0, 0]).take(4).flatten().collect();
        let bytes = pdf_with_image(rgb_dict(2, 2), pixels);

        let summary = extract_images(&bytes, &[], dir.to_str().unwrap(), "doc").unwrap();
        assert_eq!(summary.written, 1);
        assert_eq!(summary.skipped, 0);

        let out = dir.join("doc-p001-img01.png");
        assert!(out.exists(), "expected {out:?}");
        let img = image::open(&out).unwrap();
        assert_eq!((img.width(), img.height()), (2, 2));
        assert_eq!(img.to_rgb8().get_pixel(0, 0).0, [255, 0, 0]);
    }

    #[test]
    fn flate_compressed_gray_pixels_are_decoded() {
        let dir = temp_dir("flate");
        let mut stream = Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 3,
                "Height" => 1,
                "ColorSpace" => "DeviceGray",
                "BitsPerComponent" => 8,
            },
            vec![10, 20, 30],
        );
        stream.compress().unwrap();
        // compress() 会把 /Filter 设成 FlateDecode。
        let bytes = pdf_with_image(stream.dict.clone(), stream.content.clone());

        let summary = extract_images(&bytes, &[], dir.to_str().unwrap(), "gray").unwrap();
        assert_eq!(summary.written, 1);
        let img = image::open(dir.join("gray-p001-img01.png")).unwrap();
        assert_eq!(img.to_luma8().get_pixel(0, 0).0, [10]);
        assert_eq!(img.to_luma8().get_pixel(2, 0).0, [30]);
    }

    #[test]
    fn a_jpeg_is_copied_byte_for_byte() {
        let dir = temp_dir("jpeg");
        // 先造一份真 JPEG，再把它当成流内容塞进去。
        let jpeg_path = dir.join("src.jpg");
        image::RgbImage::from_pixel(4, 4, image::Rgb([1, 2, 3]))
            .save(&jpeg_path)
            .unwrap();
        let jpeg = std::fs::read(&jpeg_path).unwrap();

        let bytes = pdf_with_image(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 4,
                "Height" => 4,
                "ColorSpace" => "DeviceRGB",
                "BitsPerComponent" => 8,
                "Filter" => "DCTDecode",
            },
            jpeg.clone(),
        );

        let summary = extract_images(&bytes, &[], dir.to_str().unwrap(), "photo").unwrap();
        assert_eq!(summary.written, 1);
        let out = dir.join("photo-p001-img01.jpg");
        assert_eq!(std::fs::read(&out).unwrap(), jpeg, "JPEG must not be re-encoded");
    }

    #[test]
    fn unsupported_encodings_are_counted_instead_of_written_wrong() {
        let dir = temp_dir("skip");
        let bytes = pdf_with_image(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 8,
                "Height" => 8,
                "ColorSpace" => "DeviceGray",
                "BitsPerComponent" => 1,
                "Filter" => "CCITTFaxDecode",
            },
            vec![0; 8],
        );
        let summary = extract_images(&bytes, &[], dir.to_str().unwrap(), "fax").unwrap();
        assert_eq!(summary.written, 0);
        assert_eq!(summary.skipped, 1);
    }

    #[test]
    fn an_image_reused_on_two_pages_is_written_once() {
        let dir = temp_dir("dup");
        // 两页共用同一个图像对象
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let image_id = doc.add_object(Stream::new(rgb_dict(1, 1), vec![0, 0, 0]));
        let mut kids = Vec::new();
        for _ in 0..2 {
            let content = doc.add_object(Stream::new(dictionary! {}, Vec::new()));
            let page = doc.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => Object::Reference(pages_id),
                "MediaBox" => vec![0i64.into(), 0i64.into(), 200i64.into(), 300i64.into()],
                "Contents" => Object::Reference(content),
                "Resources" => dictionary! {
                    "XObject" => dictionary! { "Im1" => Object::Reference(image_id) },
                },
            });
            kids.push(Object::Reference(page));
        }
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => Object::Array(kids),
                "Count" => 2i64,
            }),
        );
        let catalog = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => Object::Reference(pages_id),
        });
        doc.trailer.set("Root", Object::Reference(catalog));
        doc.renumber_objects();
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();

        let summary = extract_images(&bytes, &[], dir.to_str().unwrap(), "logo").unwrap();
        assert_eq!(summary.written, 1);
        assert_eq!(summary.duplicates, 1);
    }

    #[test]
    fn an_out_of_range_page_is_refused() {
        let dir = temp_dir("range");
        let bytes = pdf_with_image(rgb_dict(1, 1), vec![0, 0, 0]);
        let err = extract_images(&bytes, &[9], dir.to_str().unwrap(), "x").unwrap_err();
        assert!(err.contains("out of range"), "{err}");
    }
}
