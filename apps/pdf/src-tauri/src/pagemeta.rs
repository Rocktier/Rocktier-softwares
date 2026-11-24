//! `/CropBox` 与 Info 字典的字节级改写（页面裁剪 + 文档属性）。
//!
//! 这两项都**不经过 pdfium**：pdfium 没有写裁剪框的公开入口
//! （`FPDFPage_GetCropBox` 只能读），也没有写元数据的入口
//! （`FPDFDoc_GetMetaText` 同样只读）。qpdf 那条压缩管线也不适合改结构。
//! 所以统一在 lopdf 上改字节，改完立刻用 pdfium 重新载入内存文档：
//!
//! ```text
//! 内存文档 --save_to_bytes--> 旧字节 --lopdf 改写--> 新字节 --load--> 内存文档
//! ```
//!
//! 这样做的好处是「改完就能看见」：pdfium 的页面尺寸取自 CropBox，
//! 重载之后缩略图与正文立刻是裁过的；撤销栈里那一步也天然是旧字节。
//!
//! 与 `formclear.rs` 的分工：那个模块在**保存时**改临时文件（单选清空
//! 是 pdfium 的能力缺口，属于保存流程的一部分）；这里的两项是用户可见的
//! 编辑动作，必须在内存里立刻生效，所以走「字节往返 + 重载」。

use std::io::Cursor;

use lopdf::{Dictionary, Document, Object, ObjectId};

/* ── 页面裁剪 ────────────────────────────────────────────────────── */

/// 四边要裁掉的留白，单位 PDF 点（1/72 英寸）。
///
/// 数字是**显示方向**上的：用户看到的左/上/右/下。旋转页（`/Rotate` 90/180/270）
/// 在内部换算回原始坐标系 —— 否则「裁掉左边 10pt」在一张横放的扫描件上会裁到
/// 顶边，而且用户完全看不出哪里错了。
#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CropMargins {
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
    pub left: f32,
}

/// 取数值对象。PDF 里同一个量的写法不统一（`200` 与 `200.0` 都合法），
/// 尺寸类条目尤其常见整数。
fn num(obj: &Object) -> Option<f32> {
    match obj {
        Object::Integer(i) => Some(*i as f32),
        Object::Real(r) => Some(*r),
        _ => None,
    }
}

/// 解析一个矩形数组，允许整体是间接引用。
fn rect_of(doc: &Document, obj: &Object) -> Option<[f32; 4]> {
    let arr = match obj {
        Object::Array(arr) => arr,
        Object::Reference(id) => doc.get_object(*id).ok()?.as_array().ok()?,
        _ => return None,
    };
    if arr.len() < 4 {
        return None;
    }
    Some([num(&arr[0])?, num(&arr[1])?, num(&arr[2])?, num(&arr[3])?])
}

/// 沿 `/Parent` 链找一条可能被继承的条目。
///
/// `/MediaBox`、`/CropBox`、`/Rotate` 都允许写在页树的中间节点上 ——
/// 扫描件里很常见（整本一个 MediaBox，页对象里什么都不写）。
/// 只看页对象自己的字典会把这些页判成「没有 MediaBox」。
fn inherited(doc: &Document, id: ObjectId, key: &[u8]) -> Option<Object> {
    let mut cursor = id;
    // 上限 32 层：页树再深也不该超过这个数，环状引用更不能死循环。
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

/// 把留白从显示方向换算到原始坐标系的矩形。
///
/// `/Rotate` 90 表示"显示时把页面顺时针转 90°"，于是四条边的对应关系变成：
/// 显示左 ← 原始下、显示右 ← 原始上、显示上 ← 原始左、显示下 ← 原始右。
/// 180 与 270 同理。这一层换算写错的症状是「裁剪生效了但裁错边」，而几何上
/// 一切自洽，光看图很难定位，所以每种角度都在测试里钉了一条。
fn crop_box(base: [f32; 4], rot: i32, m: CropMargins) -> [f32; 4] {
    let [x0, y0, x1, y1] = base;
    match rot {
        90 => [x0 + m.top, y0 + m.left, x1 - m.bottom, y1 - m.right],
        180 => [x0 + m.right, y0 + m.top, x1 - m.left, y1 - m.bottom],
        270 => [x0 + m.bottom, y0 + m.right, x1 - m.top, y1 - m.left],
        _ => [x0 + m.left, y0 + m.bottom, x1 - m.right, y1 - m.top],
    }
}

/// 把 `pages`（1 基页码，空 = 全部页）按留白裁掉一圈，返回新的 PDF 字节。
///
/// **先全部算完再落笔**：裁到第 7 页才发现越界时，前 6 页必须原封不动。
pub fn apply_crop(bytes: &[u8], pages: &[u32], m: CropMargins) -> Result<Vec<u8>, String> {
    if m.top < 0.0 || m.right < 0.0 || m.bottom < 0.0 || m.left < 0.0 {
        return Err("Crop margins cannot be negative".to_string());
    }
    if m.top == 0.0 && m.right == 0.0 && m.bottom == 0.0 && m.left == 0.0 {
        return Ok(bytes.to_vec());
    }

    let mut doc = Document::load_from(Cursor::new(bytes))
        .map_err(|e| format!("Cannot parse the PDF: {e}"))?;
    let page_ids = doc.get_pages();
    if page_ids.is_empty() {
        return Err("This PDF has no pages.".to_string());
    }

    let targets: Vec<u32> = if pages.is_empty() {
        page_ids.keys().copied().collect()
    } else {
        pages.to_vec()
    };

    let mut boxes: Vec<(ObjectId, [f32; 4])> = Vec::with_capacity(targets.len());
    for n in &targets {
        let Some(&id) = page_ids.get(n) else {
            return Err(format!("Page {n} is out of range"));
        };
        let base = inherited(&doc, id, b"CropBox")
            .and_then(|o| rect_of(&doc, &o))
            .or_else(|| inherited(&doc, id, b"MediaBox").and_then(|o| rect_of(&doc, &o)))
            .ok_or_else(|| format!("Page {n} has no usable page box"))?;

        let rot = inherited(&doc, id, b"Rotate")
            .and_then(|o| num(&o))
            .map(|d| (d as i32).rem_euclid(360))
            .unwrap_or(0);
        let rot = rot - rot % 90;

        // 显示方向下的尺寸：90/270 是一次宽高互换。
        let (w, h) = (base[2] - base[0], base[3] - base[1]);
        let (dw, dh) = if rot == 90 || rot == 270 { (h, w) } else { (w, h) };
        if m.left + m.right >= dw || m.top + m.bottom >= dh {
            return Err(format!(
                "Crop leaves nothing of page {n}: the margins are wider than the page"
            ));
        }
        boxes.push((id, crop_box(base, rot, m)));
    }

    for (id, b) in boxes {
        let dict = doc
            .get_dictionary_mut(id)
            .map_err(|e| format!("Cannot update page box: {e}"))?;
        dict.set(
            "CropBox",
            Object::Array(b.iter().map(|v| Object::Real(*v)).collect()),
        );
    }

    let mut out = Vec::new();
    doc.save_to(&mut out)
        .map_err(|e| format!("Cannot write the cropped PDF: {e}"))?;
    Ok(out)
}

/* ── 文档属性（Info 字典）────────────────────────────────────────── */

/// 可编辑的四个标准字段。`Creator` / `Producer` 不在这里：前者是生成
/// 原稿的软件（不是我们的），后者是我们自己，改了等于伪造来源。
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfMetadata {
    pub title: String,
    pub author: String,
    pub subject: String,
    pub keywords: String,
}

/// 解码一个 PDF 文本串。
///
/// 规范允许两种编码：PDFDocEncoding（基本等同 Latin-1）或带 BOM 的 UTF-16BE。
/// 现实里还有第三种：不少工具直接写 UTF-8（不合规，但读的时候不该显示乱码）。
/// 三路依次尝试，BOM 优先。
fn decode_text(raw: &[u8]) -> String {
    if raw.starts_with(&[0xFE, 0xFF]) {
        let units: Vec<u16> = raw[2..]
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    match std::str::from_utf8(raw) {
        Ok(s) => s.to_string(),
        Err(_) => raw.iter().map(|&b| b as char).collect(),
    }
}

/// 编码一个 PDF 文本串：始终 UTF-16BE + BOM。
///
/// 不"能 ASCII 就用 Literal"：一旦标题里有一个汉字，PDFDocEncoding 就表达不了，
/// 而中文标题是常态。统一 UTF-16 只有体积代价（每字符 2 字节），
/// 换来的是任何阅读器都不会把标题读成乱码。
fn encode_text(s: &str) -> Object {
    let mut out = Vec::with_capacity(2 + s.len() * 2);
    out.extend_from_slice(&[0xFE, 0xFF]);
    for unit in s.encode_utf16() {
        out.extend_from_slice(&unit.to_be_bytes());
    }
    Object::String(out, lopdf::StringFormat::Hex)
}

fn text_of(dict: &Dictionary, key: &[u8]) -> String {
    match dict.get(key) {
        Ok(Object::String(raw, _)) => decode_text(raw),
        Ok(Object::Name(name)) => String::from_utf8_lossy(name).to_string(),
        _ => String::new(),
    }
}

/// 读 Info 字典。没有 Info 字典、或某个键不存在，都返回空串 ——
/// 界面上是空输入框，不是错误。
pub fn read_metadata(bytes: &[u8]) -> Result<PdfMetadata, String> {
    let doc = Document::load_from(Cursor::new(bytes))
        .map_err(|e| format!("Cannot parse the PDF: {e}"))?;
    let info = match doc.trailer.get(b"Info") {
        Ok(Object::Reference(id)) => doc.get_dictionary(*id).ok(),
        Ok(Object::Dictionary(d)) => Some(d),
        _ => None,
    };
    let Some(info) = info else {
        return Ok(PdfMetadata::default());
    };
    Ok(PdfMetadata {
        title: text_of(info, b"Title"),
        author: text_of(info, b"Author"),
        subject: text_of(info, b"Subject"),
        keywords: text_of(info, b"Keywords"),
    })
}

/// 写 Info 字典。空字符串 = 删除该键（不是写一个空串）——
/// 否则阅读器的属性面板里会显示一个空条目，看起来像没保存成功。
pub fn write_metadata(bytes: &[u8], meta: &PdfMetadata) -> Result<Vec<u8>, String> {
    let mut doc = Document::load_from(Cursor::new(bytes))
        .map_err(|e| format!("Cannot parse the PDF: {e}"))?;

    let existing = match doc.trailer.get(b"Info") {
        Ok(Object::Reference(id)) if doc.get_dictionary(*id).is_ok() => Some(*id),
        _ => None,
    };
    let id = match existing {
        Some(id) => id,
        None => {
            let id = doc.add_object(Object::Dictionary(Dictionary::new()));
            doc.trailer.set("Info", Object::Reference(id));
            id
        }
    };

    {
        let dict = doc
            .get_dictionary_mut(id)
            .map_err(|e| format!("Cannot update document info: {e}"))?;
        let fields: [(Vec<u8>, &str); 4] = [
            (b"Title".to_vec(), &meta.title),
            (b"Author".to_vec(), &meta.author),
            (b"Subject".to_vec(), &meta.subject),
            (b"Keywords".to_vec(), &meta.keywords),
        ];
        for (key, value) in fields {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                dict.remove(&key);
            } else {
                dict.set(key, encode_text(trimmed));
            }
        }
    }

    let mut out = Vec::new();
    doc.save_to(&mut out)
        .map_err(|e| format!("Cannot write the document info: {e}"))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Stream};

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("rocktier-pagemeta-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    /// 一份 200×300pt 的单页 PDF，`rotate` 直接写进页字典。
    fn page_pdf(path: &std::path::Path, rotate: i64) {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let content_id = doc.add_object(Stream::new(dictionary! {}, Vec::new()));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => Object::Reference(pages_id),
            "MediaBox" => vec![0i64.into(), 0i64.into(), 200i64.into(), 300i64.into()],
            "Rotate" => rotate,
            "Contents" => Object::Reference(content_id),
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![Object::Reference(page_id)],
                "Count" => 1i64,
                "MediaBox" => vec![0i64.into(), 0i64.into(), 200i64.into(), 300i64.into()],
            }),
        );
        let catalog = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => Object::Reference(pages_id),
        });
        doc.trailer.set("Root", Object::Reference(catalog));
        doc.renumber_objects();
        let mut out = std::fs::File::create(path).unwrap();
        doc.save_to(&mut out).unwrap();
    }

    fn crop_box_of(path: &std::path::Path) -> Vec<f64> {
        let doc = Document::load(path).unwrap();
        let pages = doc.get_pages();
        let id = *pages.values().next().unwrap();
        let dict = doc.get_dictionary(id).unwrap();
        let Object::Array(arr) = dict.get(b"CropBox").unwrap() else {
            panic!("no CropBox");
        };
        arr.iter()
            .map(|o| match o {
                Object::Integer(i) => *i as f64,
                Object::Real(r) => *r as f64,
                other => panic!("unexpected {other:?}"),
            })
            .collect()
    }

    const M: CropMargins = CropMargins {
        top: 20.0,
        right: 30.0,
        bottom: 40.0,
        left: 10.0,
    };

    #[test]
    fn crop_writes_the_box_in_page_coordinates() {
        let path = temp("plain.pdf");
        page_pdf(&path, 0);
        let bytes = std::fs::read(&path).unwrap();
        let out = apply_crop(&bytes, &[], M).unwrap();
        std::fs::write(&path, &out).unwrap();
        // 左 10 / 下 40 / 右 30 / 上 20 → [10, 40, 170, 280]
        assert_eq!(crop_box_of(&path), vec![10.0, 40.0, 170.0, 280.0]);
    }

    #[test]
    fn every_rotation_maps_margins_from_the_displayed_orientation() {
        // 200×300 的页，转 90° 后显示成 300×200：
        // 显示左 = 原始下 → y0 = 10；显示下 = 原始右 → x1 = 200-40 = 160；
        // 显示右 = 原始上 → y1 = 300-30 = 270；显示上 = 原始左 → x0 = 20。
        for (rotate, expected) in [
            (0i64, vec![10.0, 40.0, 170.0, 280.0]),
            (90, vec![20.0, 10.0, 160.0, 270.0]),
            (180, vec![30.0, 20.0, 190.0, 260.0]),
            (270, vec![40.0, 30.0, 180.0, 290.0]),
            // 负角度与超过 360 的角度按同一套算：rem_euclid 之后是 270。
            (-90, vec![40.0, 30.0, 180.0, 290.0]),
            (450, vec![20.0, 10.0, 160.0, 270.0]),
        ] {
            let path = temp(&format!("rot{rotate}.pdf"));
            page_pdf(&path, rotate);
            let bytes = std::fs::read(&path).unwrap();
            let out = apply_crop(&bytes, &[], M).unwrap();
            std::fs::write(&path, &out).unwrap();
            assert_eq!(crop_box_of(&path), expected, "rot {rotate}");
        }
    }

    #[test]
    fn a_second_crop_composes_on_the_first_one() {
        let path = temp("twice.pdf");
        page_pdf(&path, 0);
        let mut bytes = std::fs::read(&path).unwrap();
        bytes = apply_crop(&bytes, &[], M).unwrap();
        bytes = apply_crop(
            &bytes,
            &[],
            CropMargins {
                top: 0.0,
                right: 0.0,
                bottom: 0.0,
                left: 5.0,
            },
        )
        .unwrap();
        std::fs::write(&path, &bytes).unwrap();
        // 左 10+5、其余不变 —— 第二次裁剪以第一次的 CropBox 为基准。
        assert_eq!(crop_box_of(&path), vec![15.0, 40.0, 170.0, 280.0]);
    }

    #[test]
    fn margins_wider_than_the_page_are_rejected_before_anything_is_written() {
        let path = temp("too-wide.pdf");
        page_pdf(&path, 0);
        let bytes = std::fs::read(&path).unwrap();
        let err = apply_crop(
            &bytes,
            &[],
            CropMargins {
                top: 0.0,
                right: 100.0,
                bottom: 0.0,
                left: 100.0,
            },
        )
        .unwrap_err();
        assert!(err.contains("leaves nothing"), "{err}");

        let err = apply_crop(
            &bytes,
            &[],
            CropMargins {
                top: -1.0,
                right: 0.0,
                bottom: 0.0,
                left: 0.0,
            },
        )
        .unwrap_err();
        assert!(err.contains("negative"), "{err}");
    }

    #[test]
    fn only_the_requested_pages_are_touched() {
        let path = temp("two-pages.pdf");
        // 两页：第二页用同一个 generator 再拼一次
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let mut kids = Vec::new();
        for _ in 0..2 {
            let content_id = doc.add_object(Stream::new(dictionary! {}, Vec::new()));
            let page_id = doc.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => Object::Reference(pages_id),
                "MediaBox" => vec![0i64.into(), 0i64.into(), 200i64.into(), 300i64.into()],
                "Contents" => Object::Reference(content_id),
            });
            kids.push(Object::Reference(page_id));
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
        let mut out = std::fs::File::create(&path).unwrap();
        doc.save_to(&mut out).unwrap();

        let bytes = std::fs::read(&path).unwrap();
        let cropped = apply_crop(&bytes, &[2], M).unwrap();
        std::fs::write(&path, &cropped).unwrap();

        let doc = Document::load(&path).unwrap();
        let pages = doc.get_pages();
        let first = doc.get_dictionary(*pages.get(&1).unwrap()).unwrap();
        let second = doc.get_dictionary(*pages.get(&2).unwrap()).unwrap();
        assert!(first.get(b"CropBox").is_err(), "page 1 must stay untouched");
        assert!(second.get(b"CropBox").is_ok(), "page 2 must be cropped");
    }

    /// 裁完的文件必须还能被真正的阅读器（pdfium）打开，且页面尺寸跟着变。
    /// 这条断言的是「裁剪对这个应用可见」—— 只写字节不改渲染的话，
    /// 用户点完裁剪看到的还是原页面。
    #[test]
    fn pdfium_agrees_the_cropped_page_is_smaller() {
        let path = temp("pdfium-crop.pdf");
        page_pdf(&path, 0);
        let bytes = std::fs::read(&path).unwrap();
        let out = apply_crop(&bytes, &[], M).unwrap();
        std::fs::write(&path, &out).unwrap();

        let pdfium = crate::pdf::test_pdfium();
        let doc = pdfium
            .load_pdf_from_file(&path, None)
            .expect("pdfium must open the cropped file");
        let page = doc.pages().get(0).unwrap();
        // 200-10-30 = 160 宽，300-20-40 = 240 高。
        assert!(
            (page.width().value - 160.0).abs() < 0.5,
            "width {} != 160",
            page.width().value
        );
        assert!(
            (page.height().value - 240.0).abs() < 0.5,
            "height {} != 240",
            page.height().value
        );
    }

    /// 更隐蔽的一条：pdfium 的 `save` 若丢掉 CropBox，裁剪会「看着生效、
    /// 存完就没了」。用户下一次打开才发现，且没有任何报错。
    #[test]
    fn crop_survives_a_pdfium_rewrite() {
        let path = temp("rewrite.pdf");
        page_pdf(&path, 0);
        let bytes = std::fs::read(&path).unwrap();
        let out = apply_crop(&bytes, &[], M).unwrap();
        std::fs::write(&path, &out).unwrap();

        let pdfium = crate::pdf::test_pdfium();
        let doc = pdfium.load_pdf_from_file(&path, None).unwrap();
        let again = doc.save_to_bytes().expect("pdfium must serialise");
        let reparsed = Document::load_from(Cursor::new(again)).unwrap();
        let pages = reparsed.get_pages();
        let dict = reparsed
            .get_dictionary(*pages.values().next().unwrap())
            .unwrap();
        assert!(
            dict.get(b"CropBox").is_ok(),
            "pdfium dropped /CropBox on save — the crop would vanish after one save"
        );
    }

    #[test]
    fn metadata_round_trips_including_chinese() {
        let path = temp("meta.pdf");
        page_pdf(&path, 0);
        let bytes = std::fs::read(&path).unwrap();

        let meta = PdfMetadata {
            title: "季度报告 2026".to_string(),
            author: "老党".to_string(),
            subject: "内部".to_string(),
            keywords: "report, 财务, q3".to_string(),
        };
        let out = write_metadata(&bytes, &meta).unwrap();
        let back = read_metadata(&out).unwrap();
        assert_eq!(back, meta);
    }

    #[test]
    fn clearing_a_field_removes_the_key_instead_of_writing_an_empty_string() {
        let path = temp("meta-clear.pdf");
        page_pdf(&path, 0);
        let bytes = std::fs::read(&path).unwrap();
        let full = PdfMetadata {
            title: "T".to_string(),
            author: "A".to_string(),
            subject: "S".to_string(),
            keywords: "K".to_string(),
        };
        let with_info = write_metadata(&bytes, &full).unwrap();
        let cleared = write_metadata(
            &with_info,
            &PdfMetadata {
                title: "T".to_string(),
                ..Default::default()
            },
        )
        .unwrap();

        let doc = Document::load_from(Cursor::new(&cleared)).unwrap();
        let Object::Reference(info_id) = doc.trailer.get(b"Info").unwrap() else {
            panic!("Info must stay a reference");
        };
        let info = doc.get_dictionary(*info_id).unwrap();
        assert!(info.get(b"Title").is_ok());
        assert!(info.get(b"Author").is_err(), "empty field must be removed");
        assert!(info.get(b"Subject").is_err());
        assert!(info.get(b"Keywords").is_err());
        assert_eq!(read_metadata(&cleared).unwrap().title, "T");
    }

    #[test]
    fn text_is_written_as_utf16_with_a_bom() {
        let path = temp("meta-bom.pdf");
        page_pdf(&path, 0);
        let bytes = std::fs::read(&path).unwrap();
        let out = write_metadata(
            &bytes,
            &PdfMetadata {
                title: "A季度".to_string(),
                ..Default::default()
            },
        )
        .unwrap();
        let doc = Document::load_from(Cursor::new(&out)).unwrap();
        let Object::Reference(info_id) = doc.trailer.get(b"Info").unwrap() else {
            panic!()
        };
        let info = doc.get_dictionary(*info_id).unwrap();
        let Object::String(raw, lopdf::StringFormat::Hex) = info.get(b"Title").unwrap() else {
            panic!("title must be a hex string");
        };
        assert_eq!(&raw[..2], &[0xFE, 0xFF]);
        assert_eq!(decode_text(raw), "A季度");
    }

    #[test]
    fn a_document_without_an_info_dictionary_gets_one() {
        let path = temp("meta-none.pdf");
        page_pdf(&path, 0);
        let bytes = std::fs::read(&path).unwrap();
        assert!(Document::load_from(Cursor::new(&bytes))
            .unwrap()
            .trailer
            .get(b"Info")
            .is_err());

        let out = write_metadata(
            &bytes,
            &PdfMetadata {
                title: "新增".to_string(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(read_metadata(&out).unwrap().title, "新增");

        // 加过 Info 的文件仍要被 pdfium 正常打开。
        std::fs::write(&path, &out).unwrap();
        let pdfium = crate::pdf::test_pdfium();
        let doc = pdfium
            .load_pdf_from_file(&path, None)
            .expect("pdfium must open a file with a fresh Info dict");
        assert_eq!(doc.pages().len(), 1);
    }
}
