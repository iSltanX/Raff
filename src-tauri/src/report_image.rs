//! The one optional image in a problem report.
//!
//! It comes from a file the user picks or a paste they make in the report
//! window — never a screen capture, so no Screen Recording permission. It is
//! decoded and written again from pixels, which drops EXIF, GPS, text chunks,
//! colour-profile names and the file name; then shrunk until it fits the
//! channel's limit. The bytes stay in Rust: the webview receives a small
//! `data:` thumbnail and the facts it shows in the preview.

use std::io::Cursor;

use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::{DynamicImage, ImageEncoder, ImageFormat};
use serde::Serialize;

/// Read no further than this — checked before decoding.
pub const MAX_INPUT_BYTES: usize = 20 * 1024 * 1024;
/// The channel's ceiling per attachment (contract v1).
pub const MAX_OUTPUT_BYTES: usize = 3 * 1024 * 1024;
/// Decoding a hostile header must not allocate gigabytes.
const MAX_PIXELS: u64 = 40_000_000;
const THUMB_EDGE: u32 = 160;
const JPEG_QUALITY: u8 = 85;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageError {
    /// Not PNG or JPEG (or TIFF from the pasteboard).
    Unsupported,
    /// Larger than the input ceiling, or too many pixels.
    TooLarge,
    /// Could not be decoded or re-encoded.
    Unreadable,
}

impl ImageError {
    /// Stable code the window turns into Arabic.
    pub fn code(self) -> &'static str {
        match self {
            ImageError::Unsupported => "raff/image-unsupported",
            ImageError::TooLarge => "raff/image-too-large",
            ImageError::Unreadable => "raff/image-unreadable",
        }
    }
}

/// A prepared attachment: re-encoded bytes plus what the preview shows.
#[derive(Clone)]
pub struct Prepared {
    pub mime: &'static str,
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub thumb: String,
}

/// What crosses IPC: facts and a thumbnail, never the image.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImageMeta {
    pub mime: &'static str,
    pub bytes: usize,
    pub width: u32,
    pub height: u32,
    pub thumb: String,
}

impl Prepared {
    pub fn meta(&self) -> ImageMeta {
        ImageMeta {
            mime: self.mime,
            bytes: self.bytes.len(),
            width: self.width,
            height: self.height,
            thumb: self.thumb.clone(),
        }
    }
}

/// The format by signature — the file name and extension are never trusted.
pub fn sniff(bytes: &[u8], allow_tiff: bool) -> Option<ImageFormat> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(ImageFormat::Png)
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(ImageFormat::Jpeg)
    } else if allow_tiff && (bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*")) {
        Some(ImageFormat::Tiff)
    } else {
        None
    }
}

fn encode_png(img: &DynamicImage) -> Option<Vec<u8>> {
    let rgba = img.to_rgba8();
    let mut out = Vec::new();
    PngEncoder::new(Cursor::new(&mut out))
        .write_image(rgba.as_raw(), rgba.width(), rgba.height(), image::ExtendedColorType::Rgba8)
        .ok()?;
    Some(out)
}

fn encode_jpeg(img: &DynamicImage) -> Option<Vec<u8>> {
    let rgb = img.to_rgb8();
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(Cursor::new(&mut out), JPEG_QUALITY)
        .write_image(rgb.as_raw(), rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)
        .ok()?;
    Some(out)
}

/// Decodes, re-encodes from pixels and shrinks until it fits. PNG first (it
/// keeps screenshots crisp); JPEG when PNG is too large; then 80% steps.
/// CPU-bound — call it off the main thread.
pub fn prepare(bytes: &[u8], from_pasteboard: bool) -> Result<Prepared, ImageError> {
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(ImageError::TooLarge);
    }
    let format = sniff(bytes, from_pasteboard).ok_or(ImageError::Unsupported)?;
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_PIXELS * 4);
    reader.limits(limits);
    let (w, h) = image::ImageReader::with_format(Cursor::new(bytes), format)
        .into_dimensions()
        .map_err(|_| ImageError::Unreadable)?;
    if u64::from(w) * u64::from(h) > MAX_PIXELS {
        return Err(ImageError::TooLarge);
    }
    let mut img = reader.decode().map_err(|_| ImageError::Unreadable)?;

    for _ in 0..12 {
        if let Some(png) = encode_png(&img).filter(|b| b.len() <= MAX_OUTPUT_BYTES) {
            return Ok(finish("image/png", png, &img));
        }
        if let Some(jpeg) = encode_jpeg(&img).filter(|b| b.len() <= MAX_OUTPUT_BYTES) {
            return Ok(finish("image/jpeg", jpeg, &img));
        }
        let (nw, nh) = ((img.width() as f32 * 0.8) as u32, (img.height() as f32 * 0.8) as u32);
        if nw < 64 || nh < 64 {
            break;
        }
        img = img.resize(nw, nh, image::imageops::FilterType::Triangle);
    }
    Err(ImageError::TooLarge)
}

fn finish(mime: &'static str, bytes: Vec<u8>, img: &DynamicImage) -> Prepared {
    let thumb = encode_png(&img.thumbnail(THUMB_EDGE, THUMB_EDGE))
        .map(|png| {
            format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(png)
            )
        })
        .unwrap_or_default();
    Prepared {
        mime,
        bytes,
        width: img.width(),
        height: img.height(),
        thumb,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_with_text_chunk(w: u32, h: u32) -> Vec<u8> {
        let img = DynamicImage::new_rgba8(w, h);
        let mut png = encode_png(&img).unwrap();
        // Insert a tEXt chunk after IHDR: a stand-in for metadata a source
        // file could carry (a name, a location, a camera).
        let mut chunk = Vec::new();
        let data = b"Comment\0GPS 24.7136 46.6753 /Users/someone/Desktop/private.png";
        chunk.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let mut body = b"tEXt".to_vec();
        body.extend_from_slice(data);
        chunk.extend_from_slice(&body);
        chunk.extend_from_slice(&crc32(&body).to_be_bytes());
        png.splice(33..33, chunk);
        png
    }

    /// PNG's CRC-32 (IEEE), so the fixture is a valid file.
    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xFFFF_FFFFu32;
        for &b in bytes {
            crc ^= u32::from(b);
            for _ in 0..8 {
                crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
            }
        }
        !crc
    }

    #[test]
    fn the_format_is_read_from_the_signature_only() {
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\nrest", false), Some(ImageFormat::Png));
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0], false), Some(ImageFormat::Jpeg));
        assert_eq!(sniff(b"GIF89a", false), None);
        assert_eq!(sniff(b"II*\0", false), None, "TIFF only from the pasteboard");
        assert_eq!(sniff(b"II*\0", true), Some(ImageFormat::Tiff));
        assert_eq!(prepare(b"<svg/>", false).err(), Some(ImageError::Unsupported));
    }

    #[test]
    fn re_encoding_drops_metadata_and_the_name() {
        let input = png_with_text_chunk(32, 24);
        let window = |b: &[u8]| b.windows(4).any(|w| w == b"tEXt");
        assert!(window(&input), "the fixture carries a text chunk");
        let out = prepare(&input, false).expect("prepares");
        assert!(!window(&out.bytes), "no text chunk survives");
        assert!(!out.bytes.windows(7).any(|w| w == b"private"), "nor the file name it held");
        assert_eq!((out.mime, out.width, out.height), ("image/png", 32, 24));
        assert!(out.thumb.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn jpeg_input_is_accepted_and_re_encoded() {
        let img = DynamicImage::new_rgb8(40, 30);
        let jpeg = encode_jpeg(&img).unwrap();
        let out = prepare(&jpeg, false).expect("jpeg decodes");
        assert_eq!((out.width, out.height), (40, 30));
        assert!(out.bytes.len() <= MAX_OUTPUT_BYTES);
    }

    #[test]
    fn an_oversized_input_is_refused_before_decoding() {
        let big = vec![0u8; MAX_INPUT_BYTES + 1];
        assert_eq!(prepare(&big, false).err(), Some(ImageError::TooLarge));
    }

    #[test]
    fn a_large_noisy_image_is_shrunk_under_the_limit() {
        // Noise does not compress: PNG and JPEG at full size both exceed 3 MB.
        let mut img = image::RgbImage::new(2600, 2000);
        let mut seed = 0x2545F4914F6CDD1Du64;
        for p in img.pixels_mut() {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            *p = image::Rgb([seed as u8, (seed >> 8) as u8, (seed >> 16) as u8]);
        }
        let png = encode_png(&DynamicImage::ImageRgb8(img)).unwrap();
        assert!(png.len() > MAX_OUTPUT_BYTES);
        let out = prepare(&png, false).expect("fits after shrinking");
        assert!(out.bytes.len() <= MAX_OUTPUT_BYTES);
        assert!(out.width < 2600);
    }

    #[test]
    fn only_facts_and_a_thumbnail_cross_ipc() {
        let out = prepare(&png_with_text_chunk(8, 8), false).unwrap();
        let meta = serde_json::to_value(out.meta()).unwrap();
        let mut keys: Vec<_> = meta.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["bytes", "height", "mime", "thumb", "width"]);
    }
}
