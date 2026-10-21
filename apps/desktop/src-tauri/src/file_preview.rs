// Author: Jeff.Liu. Explicit, bounded reads anchored to a native authority.
use std::{
    collections::{HashMap, VecDeque},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::Manager;
const TEXT_LIMIT: usize = 1024 * 1024;
const IMAGE_LIMIT: usize = 5 * 1024 * 1024;

#[derive(Debug, PartialEq)]
struct ImageInfo {
    mime: &'static str,
    width: u32,
    height: u32,
}
fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}
fn image_info(bytes: &[u8]) -> Result<ImageInfo, &'static str> {
    if bytes.len() > IMAGE_LIMIT {
        return Err("file_too_large");
    }
    let mime = image_mime(bytes).ok_or("file_invalid_image")?;
    if mime == "image/png" {
        static CRC: std::sync::LazyLock<[u32; 256]> = std::sync::LazyLock::new(|| {
            std::array::from_fn(|i| {
                let mut c = i as u32;
                for _ in 0..8 {
                    c = if c & 1 != 0 {
                        0xedb88320 ^ (c >> 1)
                    } else {
                        c >> 1
                    };
                }
                c
            })
        });
        let mut at = 8;
        let mut data = false;
        let mut compressed = Vec::new();
        let mut data_ended = false;
        let mut end = false;
        while at < bytes.len() {
            let header = bytes.get(at..at + 8).ok_or("file_invalid_image")?;
            let len = u32::from_be_bytes(header[..4].try_into().unwrap()) as usize;
            let next = at
                .checked_add(len)
                .and_then(|v| v.checked_add(12))
                .filter(|n| *n <= bytes.len())
                .ok_or("file_invalid_image")?;
            let tag = &header[4..8];
            if at == 8 && (tag != b"IHDR" || len != 13) {
                return Err("file_invalid_image");
            }
            if at != 8 && tag == b"IHDR" {
                return Err("file_invalid_image");
            }
            if matches!(tag, b"acTL" | b"fcTL" | b"fdAT") {
                return Err("file_animated_image");
            }
            let mut crc = u32::MAX;
            for byte in &bytes[at + 4..next - 4] {
                crc = CRC[((crc ^ u32::from(*byte)) & 255) as usize] ^ (crc >> 8);
            }
            if !crc != u32::from_be_bytes(bytes[next - 4..next].try_into().unwrap()) {
                return Err("file_invalid_image");
            }
            if tag == b"IDAT" {
                if data_ended {
                    return Err("file_invalid_image");
                }
                data = true;
                compressed.extend_from_slice(&bytes[at + 8..next - 4]);
            } else if data {
                data_ended = true;
            }
            if tag == b"IEND" {
                if len != 0 || next != bytes.len() || !data {
                    return Err("file_invalid_image");
                }
                end = true;
            }
            at = next;
        }
        if !end {
            return Err("file_invalid_image");
        }
        strict_png_data(&bytes[16..29], &compressed)?;
    } else if mime == "image/webp" {
        if (u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize).checked_add(8)
            != Some(bytes.len())
        {
            return Err("file_invalid_image");
        }
        let mut at = 12;
        let mut images = 0;
        while at < bytes.len() {
            let header = bytes.get(at..at + 8).ok_or("file_invalid_image")?;
            let len = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
            let next = at
                .checked_add(len)
                .and_then(|v| v.checked_add(8 + (len & 1)))
                .filter(|n| *n <= bytes.len())
                .ok_or("file_invalid_image")?;
            if matches!(&header[..4], b"ANIM" | b"ANMF")
                || &header[..4] == b"VP8X" && bytes.get(at + 8).is_some_and(|b| b & 2 != 0)
            {
                return Err("file_animated_image");
            }
            if matches!(&header[..4], b"VP8 " | b"VP8L") {
                images += 1;
            }
            at = next;
        }
        if images != 1 {
            return Err("file_invalid_image");
        }
    } else {
        jpeg_scans(bytes)?;
    }
    imageio::validate(bytes, mime)
}

fn jpeg_scans(bytes: &[u8]) -> Result<(), &'static str> {
    let mut at = 2;
    let mut scans = 0;
    while at < bytes.len() {
        if bytes[at] != 0xff {
            return Err("file_invalid_image");
        }
        while bytes.get(at) == Some(&0xff) {
            at += 1;
        }
        let tag = *bytes.get(at).ok_or("file_invalid_image")?;
        at += 1;
        if tag == 0xd9 {
            return if at == bytes.len() && scans > 0 {
                Ok(())
            } else {
                Err("file_invalid_image")
            };
        }
        if matches!(tag, 0x00 | 0x01 | 0xd0..=0xd8) {
            return Err("file_invalid_image");
        }
        let length = bytes.get(at..at + 2).ok_or("file_invalid_image")?;
        let length = u16::from_be_bytes(length.try_into().unwrap()) as usize;
        if length < 2 {
            return Err("file_invalid_image");
        }
        at = at
            .checked_add(length)
            .filter(|n| *n <= bytes.len())
            .ok_or("file_invalid_image")?;
        if tag != 0xda {
            continue;
        }
        scans += 1;
        let mut data = false;
        // ImageIO can recover an empty JPEG scan; require actual entropy bytes before its next marker.
        while at < bytes.len() {
            if bytes[at] != 0xff {
                data = true;
                at += 1;
                continue;
            }
            let mut next = at + 1;
            while bytes.get(next) == Some(&0xff) {
                next += 1;
            }
            match bytes.get(next) {
                Some(0x00) => {
                    data = true;
                    at = next + 1;
                }
                Some(0xd0..=0xd7) => {
                    if !data {
                        return Err("file_invalid_image");
                    }
                    at = next + 1;
                }
                _ => break,
            }
        }
        if !data {
            return Err("file_invalid_image");
        }
    }
    Err("file_invalid_image")
}

#[cfg(target_os = "macos")]
fn strict_png_data(header: &[u8], compressed: &[u8]) -> Result<(), &'static str> {
    use std::os::raw::{c_int, c_ulong};
    #[link(name = "z")]
    unsafe extern "C" {
        fn uncompress2(
            dest: *mut u8,
            dest_len: *mut c_ulong,
            source: *const u8,
            source_len: *mut c_ulong,
        ) -> c_int;
    }
    let width = u32::from_be_bytes(header[..4].try_into().unwrap()) as usize;
    let height = u32::from_be_bytes(header[4..8].try_into().unwrap()) as usize;
    if width == 0 || height == 0 || width.checked_mul(height).is_none_or(|n| n > 16_000_000) {
        return Err("file_image_pixel_limit");
    }
    let depth = header[8] as usize;
    let channels = match (header[9], depth) {
        (0, 1 | 2 | 4 | 8 | 16) | (3, 1 | 2 | 4 | 8) => 1,
        (2, 8 | 16) => 3,
        (4, 8 | 16) => 2,
        (6, 8 | 16) => 4,
        _ => return Err("file_invalid_image"),
    };
    if header[10] != 0 || header[11] != 0 || header[12] > 1 {
        return Err("file_invalid_image");
    }
    let passes = if header[12] == 0 {
        vec![(0, 0, 1, 1)]
    } else {
        vec![
            (0, 0, 8, 8),
            (4, 0, 8, 8),
            (0, 4, 4, 8),
            (2, 0, 4, 4),
            (0, 2, 2, 4),
            (1, 0, 2, 2),
            (0, 1, 1, 2),
        ]
    };
    let mut rows = Vec::new();
    let mut expected = 0usize;
    for (x, y, dx, dy) in passes {
        if width <= x || height <= y {
            continue;
        }
        let w = (width - x).div_ceil(dx);
        let h = (height - y).div_ceil(dy);
        let stride = (w * channels * depth).div_ceil(8) + 1;
        expected = expected
            .checked_add(stride.checked_mul(h).ok_or("file_invalid_image")?)
            .ok_or("file_invalid_image")?;
        rows.push((stride, h));
    }
    // ImageIO recovers damaged PNGs; zlib must verify the full stream and Adler checksum first.
    let mut raw = vec![0u8; expected + 1];
    let mut out_len = raw.len() as c_ulong;
    let mut in_len = compressed.len() as c_ulong;
    if unsafe {
        uncompress2(
            raw.as_mut_ptr(),
            &mut out_len,
            compressed.as_ptr(),
            &mut in_len,
        )
    } != 0
        || out_len as usize != expected
        || in_len as usize != compressed.len()
    {
        return Err("file_invalid_image");
    }
    let mut at = 0;
    for (stride, count) in rows {
        for _ in 0..count {
            if raw[at] > 4 {
                return Err("file_invalid_image");
            }
            at += stride;
        }
    }
    Ok(())
}
#[cfg(not(target_os = "macos"))]
fn strict_png_data(_header: &[u8], _compressed: &[u8]) -> Result<(), &'static str> {
    Err("file_platform_unavailable")
}

#[cfg(target_os = "macos")]
mod imageio {
    use super::ImageInfo;
    use std::{ffi::c_void, ptr};
    type Ref = *const c_void;
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFDataCreate(allocator: Ref, bytes: *const u8, len: isize) -> Ref;
        fn CFRelease(value: Ref);
        fn CFDictionaryGetValue(dict: Ref, key: Ref) -> Ref;
        fn CFNumberGetValue(number: Ref, kind: isize, out: *mut c_void) -> u8;
        fn CFGetTypeID(value: Ref) -> usize;
        fn CFNumberGetTypeID() -> usize;
        fn CFDictionaryCreate(
            allocator: Ref,
            keys: *const Ref,
            values: *const Ref,
            count: isize,
            key_callbacks: Ref,
            value_callbacks: Ref,
        ) -> Ref;
        static kCFBooleanTrue: Ref;
    }
    #[link(name = "ImageIO", kind = "framework")]
    unsafe extern "C" {
        fn CGImageSourceCreateWithData(data: Ref, options: Ref) -> Ref;
        fn CGImageSourceGetCount(source: Ref) -> usize;
        fn CGImageSourceGetStatus(source: Ref) -> i32;
        fn CGImageSourceGetStatusAtIndex(source: Ref, index: usize) -> i32;
        fn CGImageSourceCopyPropertiesAtIndex(source: Ref, index: usize, options: Ref) -> Ref;
        fn CGImageSourceCreateImageAtIndex(source: Ref, index: usize, options: Ref) -> Ref;
        static kCGImagePropertyPixelWidth: Ref;
        static kCGImagePropertyPixelHeight: Ref;
        static kCGImageSourceShouldCacheImmediately: Ref;
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGImageGetWidth(image: Ref) -> usize;
        fn CGImageGetHeight(image: Ref) -> usize;
        fn CGImageRelease(image: Ref);
    }
    struct Owned(Ref);
    impl Drop for Owned {
        fn drop(&mut self) {
            unsafe { CFRelease(self.0) }
        }
    }
    fn owned(value: Ref) -> Result<Owned, &'static str> {
        if value.is_null() {
            Err("file_invalid_image")
        } else {
            Ok(Owned(value))
        }
    }
    pub(super) fn validate(bytes: &[u8], mime: &'static str) -> Result<ImageInfo, &'static str> {
        unsafe {
            let data = owned(CFDataCreate(
                ptr::null(),
                bytes.as_ptr(),
                bytes.len() as isize,
            ))?;
            let source = owned(CGImageSourceCreateWithData(data.0, ptr::null()))?;
            if CGImageSourceGetCount(source.0) != 1 {
                return Err("file_animated_image");
            }
            if CGImageSourceGetStatus(source.0) != 0 {
                return Err("file_invalid_image");
            }
            let props = owned(CGImageSourceCopyPropertiesAtIndex(source.0, 0, ptr::null()))?;
            let mut dims = [0i64; 2];
            for (i, key) in [kCGImagePropertyPixelWidth, kCGImagePropertyPixelHeight]
                .into_iter()
                .enumerate()
            {
                let number = CFDictionaryGetValue(props.0, key);
                if number.is_null()
                    || CFGetTypeID(number) != CFNumberGetTypeID()
                    || CFNumberGetValue(number, 4, (&mut dims[i] as *mut i64).cast()) == 0
                {
                    return Err("file_invalid_image");
                }
            }
            if dims[0] < 1
                || dims[1] < 1
                || dims[0].checked_mul(dims[1]).is_none_or(|n| n > 16_000_000)
            {
                return Err("file_image_pixel_limit");
            }
            let options = owned(CFDictionaryCreate(
                ptr::null(),
                [kCGImageSourceShouldCacheImmediately].as_ptr(),
                [kCFBooleanTrue].as_ptr(),
                1,
                ptr::null(),
                ptr::null(),
            ))?;
            let image = CGImageSourceCreateImageAtIndex(source.0, 0, options.0);
            if image.is_null() {
                return Err("file_invalid_image");
            }
            let same = CGImageGetWidth(image) == dims[0] as usize
                && CGImageGetHeight(image) == dims[1] as usize;
            CGImageRelease(image);
            if !same || CGImageSourceGetStatusAtIndex(source.0, 0) != 0 {
                return Err("file_invalid_image");
            }
            Ok(ImageInfo {
                mime,
                width: dims[0] as u32,
                height: dims[1] as u32,
            })
        }
    }
}
#[cfg(not(target_os = "macos"))]
mod imageio {
    pub(super) fn validate(
        _bytes: &[u8],
        _mime: &'static str,
    ) -> Result<super::ImageInfo, &'static str> {
        Err("file_platform_unavailable")
    }
}

fn safe_path(path: &Path) -> bool {
    path.is_absolute()
        && path.to_str().is_some_and(|s| {
            s.len() <= 4096
                && !s.chars().any(|c| {
                    c.is_control() || matches!(c,'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}')
                })
        })
        && path
            .components()
            .all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
        && !path.components().any(|c| {
            c.as_os_str()
                .to_str()
                .is_some_and(|s| s.eq_ignore_ascii_case(".git"))
        })
}

#[cfg(unix)]
pub(crate) fn open_beneath(
    root: &std::fs::File,
    relative: &Path,
) -> Result<std::fs::File, &'static str> {
    use std::os::{
        fd::{AsRawFd, FromRawFd},
        unix::ffi::OsStrExt,
    };
    let parts = relative.components().collect::<Vec<_>>();
    if parts.is_empty()
        || parts.iter().any(|c| {
            !matches!(c, Component::Normal(_))
                || c.as_os_str()
                    .to_str()
                    .is_some_and(|s| s.eq_ignore_ascii_case(".git"))
        })
    {
        return Err("file_outside_root");
    }
    let mut directory = root.try_clone().map_err(|_| "file_unavailable")?;
    for (i, part) in parts.iter().enumerate() {
        let name =
            std::ffi::CString::new(part.as_os_str().as_bytes()).map_err(|_| "file_invalid_path")?;
        let flags = libc::O_RDONLY
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | libc::O_NONBLOCK
            | if i + 1 < parts.len() {
                libc::O_DIRECTORY
            } else {
                0
            };
        let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err("file_unavailable");
        }
        directory = unsafe { std::fs::File::from_raw_fd(fd) };
    }
    Ok(directory)
}

#[cfg(unix)]
fn open_root(root: &Path) -> Result<std::fs::File, &'static str> {
    if !safe_path(root) {
        return Err("file_invalid_path");
    }
    let slash = std::fs::File::open("/").map_err(|_| "file_unavailable")?;
    if root == Path::new("/") {
        return Ok(slash);
    }
    let file = open_beneath(
        &slash,
        root.strip_prefix("/").map_err(|_| "file_invalid_path")?,
    )?;
    if !file.metadata().map_err(|_| "file_unavailable")?.is_dir() {
        return Err("file_unavailable");
    }
    Ok(file)
}

#[cfg(unix)]
fn identity(m: &std::fs::Metadata) -> (u64, u64, u64, i64, i64, i64, i64) {
    use std::os::unix::fs::MetadataExt;
    (
        m.dev(),
        m.ino(),
        m.len(),
        m.mtime(),
        m.mtime_nsec(),
        m.ctime(),
        m.ctime_nsec(),
    )
}

#[cfg(unix)]
fn read_bytes(
    root: &Path,
    path: &Path,
    cancel: &AtomicBool,
    after_open: impl FnOnce(),
    limit: usize,
) -> Result<Vec<u8>, &'static str> {
    use std::{io::Read, os::unix::fs::MetadataExt};
    if cancel.load(Ordering::Acquire) {
        return Err("file_cancelled");
    }
    if !safe_path(path) || !safe_path(root) {
        return Err("file_invalid_path");
    }
    let relative = path.strip_prefix(root).map_err(|_| "file_outside_root")?;
    let directory = open_root(root)?;
    let root_before = directory.metadata().map_err(|_| "file_unavailable")?;
    let mut file = open_beneath(&directory, relative)?;
    let before = file.metadata().map_err(|_| "file_unavailable")?;
    if !before.is_file() || before.nlink() != 1 || before.mode() & 0o444 == 0 {
        return Err("file_not_regular");
    }
    if before.len() > limit as u64 {
        return Err("file_too_large");
    }
    after_open();
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 16384];
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err("file_cancelled");
        }
        let n = file.read(&mut chunk).map_err(|_| "file_unavailable")?;
        if n == 0 {
            break;
        }
        if bytes.len() + n > limit {
            return Err("file_too_large");
        }
        bytes.extend_from_slice(&chunk[..n]);
    }
    let after = file.metadata().map_err(|_| "file_unavailable")?;
    let current = open_beneath(&directory, relative)?
        .metadata()
        .map_err(|_| "file_unavailable")?;
    let current_root = open_root(root)?
        .metadata()
        .map_err(|_| "file_unavailable")?;
    if identity(&before) != identity(&after)
        || identity(&after) != identity(&current)
        || root_before.dev() != current_root.dev()
        || root_before.ino() != current_root.ino()
    {
        return Err("file_changed");
    }
    if cancel.load(Ordering::Acquire) {
        return Err("file_cancelled");
    }
    Ok(bytes)
}
#[cfg(not(unix))]
fn read_bytes(
    _root: &Path,
    _path: &Path,
    _cancel: &AtomicBool,
    _after_open: impl FnOnce(),
    _limit: usize,
) -> Result<Vec<u8>, &'static str> {
    Err("file_platform_unavailable")
}

#[cfg(test)]
fn read_text(
    root: &Path,
    path: &Path,
    cancel: &AtomicBool,
    hook: impl FnOnce(),
) -> Result<String, &'static str> {
    String::from_utf8(read_bytes(root, path, cancel, hook, TEXT_LIMIT)?)
        .map_err(|_| "file_invalid_utf8")
}

#[derive(Debug, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Content {
    Text {
        text: String,
    },
    Image {
        mime: &'static str,
        width: u32,
        height: u32,
        data_base64: String,
    },
}

#[derive(Debug, serde::Serialize)]
pub(crate) struct Preview {
    query_token: String,
    session_id: Option<String>,
    path: String,
    root: String,
    read_at: u64,
    bytes: usize,
    #[serde(flatten)]
    content: Content,
}
#[derive(Default)]
struct WindowQuery {
    active: Option<(String, Arc<AtomicBool>)>,
    cancelled: VecDeque<String>,
}
#[derive(Clone, Default)]
pub(crate) struct Requests(Arc<Mutex<HashMap<String, WindowQuery>>>);
impl Requests {
    fn begin(&self, window: &str, token: &str) -> Result<Arc<AtomicBool>, String> {
        if !valid_token(token) {
            return Err("file_invalid_request".into());
        }
        let mut all = self.0.lock().map_err(|_| "file_unavailable")?;
        let q = all.entry(window.into()).or_default();
        if q.cancelled.iter().any(|x| x == token) {
            return Err("file_cancelled".into());
        }
        if q.active.is_some() {
            return Err("file_busy".into());
        }
        let flag = Arc::new(AtomicBool::new(false));
        q.active = Some((token.into(), flag.clone()));
        Ok(flag)
    }
    fn cancel(&self, window: &str, token: &str) {
        if let Ok(mut all) = self.0.lock() {
            let q = all.entry(window.into()).or_default();
            if let Some((id, f)) = &q.active {
                if id == token {
                    f.store(true, Ordering::Release);
                }
            }
            if !q.cancelled.iter().any(|x| x == token) {
                q.cancelled.push_back(token.into());
                if q.cancelled.len() > 16 {
                    q.cancelled.pop_front();
                }
            }
        }
    }
    fn finish(&self, window: &str, token: &str) -> bool {
        if let Ok(mut all) = self.0.lock() {
            if let Some(q) = all.get_mut(window) {
                if q.active.as_ref().is_some_and(|(id, _)| id == token) {
                    let cancelled = q.active.as_ref().unwrap().1.load(Ordering::Acquire);
                    q.active = None;
                    return cancelled;
                }
            }
        }
        false
    }
}
fn valid_token(token: &str) -> bool {
    token.len() == 36
        && token.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

fn preview(
    root: &Path,
    path: &Path,
    token: String,
    session_id: Option<String>,
    cancel: &AtomicBool,
) -> Result<Preview, String> {
    let bytes = read_bytes(root, path, cancel, || {}, IMAGE_LIMIT)?;
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let expected = match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        _ => None,
    };
    let literal = matches!(ext.as_str(), "html" | "htm" | "md" | "markdown" | "svg");
    let content = if !literal && (expected.is_some() || image_mime(&bytes).is_some()) {
        let info = image_info(&bytes)?;
        if expected.is_some_and(|mime| mime != info.mime) {
            return Err("file_invalid_image".into());
        }
        Content::Image {
            mime: info.mime,
            width: info.width,
            height: info.height,
            data_base64: crate::terminal_runtime::base64(&bytes),
        }
    } else {
        if bytes.len() > TEXT_LIMIT {
            return Err("file_too_large".into());
        }
        Content::Text {
            text: String::from_utf8(bytes.clone()).map_err(|_| "file_invalid_utf8")?,
        }
    };
    if cancel.load(Ordering::Acquire) {
        return Err("file_cancelled".into());
    }
    Ok(Preview {
        query_token: token,
        session_id,
        path: path.to_str().ok_or("file_invalid_path")?.into(),
        root: root.to_str().ok_or("file_invalid_path")?.into(),
        read_at: crate::unix_timestamp_millis()
            .try_into()
            .map_err(|_| "file_unavailable")?,
        bytes: bytes.len(),
        content,
    })
}

fn session_file_preview(
    native_root: &Path,
    session_id: &str,
    path: &str,
    token: String,
    cancel: &AtomicBool,
) -> Result<Preview, String> {
    let root = std::fs::canonicalize(native_root).map_err(|_| "file_session_unavailable")?;
    let input = Path::new(&path);
    if !safe_path(input) {
        return Err("file_invalid_path".into());
    }
    let relative = input
        .strip_prefix(native_root)
        .or_else(|_| input.strip_prefix(&root))
        .map_err(|_| "file_outside_root")?;
    let mut result = preview(
        &root,
        &root.join(relative),
        token,
        Some(session_id.to_string()),
        cancel,
    )?;
    // Correlate the exact requested spelling after reading beneath the canonical native root.
    result.path = path.into();
    result.root = input
        .ancestors()
        .nth(relative.components().count())
        .and_then(Path::to_str)
        .ok_or("file_invalid_path")?
        .into();
    Ok(result)
}

fn session_preview<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    session_id: String,
    path: String,
    token: String,
    cancel: &AtomicBool,
) -> Result<Preview, String> {
    let before = crate::get_session(app.clone(), app.state(), session_id.clone())
        .map_err(|_| "file_session_unavailable")?;
    if before.summary.ssh.is_some() {
        return Err("file_session_unavailable".into());
    }
    let result = session_file_preview(
        Path::new(&before.summary.cwd),
        &session_id,
        &path,
        token,
        cancel,
    )?;
    #[cfg(all(test, unix))]
    tests::AFTER_SESSION_READ.with(|hook| {
        let callback = hook.borrow_mut().take();
        if let Some(callback) = callback {
            callback();
        }
    });
    let after = crate::get_session(app.clone(), app.state(), session_id)
        .map_err(|_| "file_session_unavailable")?;
    if before.summary.cwd != after.summary.cwd
        || before.summary.launch != after.summary.launch
        || before.started_at != after.started_at
        || before.conversation_id != after.conversation_id
        || before.summary.ssh != after.summary.ssh
    {
        return Err("file_session_changed".into());
    }
    if cancel.load(Ordering::Acquire) {
        return Err("file_cancelled".into());
    }
    Ok(result)
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn read_project_file_preview(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    requests: tauri::State<'_, Requests>,
    session_id: String,
    path: String,
    query_token: String,
) -> Result<Preview, String> {
    preview_request_with(
        window.label().to_string(),
        requests.inner().clone(),
        query_token,
        move |token, flag| session_preview(&app, session_id, path, token, flag),
    )
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn choose_project_file_preview(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    requests: tauri::State<'_, Requests>,
    query_token: String,
) -> Result<Preview, String> {
    use tauri_plugin_dialog::DialogExt;
    preview_request_with(
        window.label().to_string(),
        requests.inner().clone(),
        query_token,
        move |token, flag| {
            choose_preview(token, flag, || {
                let selected = app
                    .dialog()
                    .file()
                    .set_title("Choose a file for read-only preview")
                    .blocking_pick_file()
                    .ok_or("file_cancelled")?;
                selected.into_path().map_err(|_| "file_invalid_path")
            })
        },
    )
    .await
}

async fn preview_request_with(
    scope: String,
    requests: Requests,
    query_token: String,
    worker: impl FnOnce(String, &AtomicBool) -> Result<Preview, String> + Send + 'static,
) -> Result<Preview, String> {
    let flag = requests.begin(&scope, &query_token)?;
    let token = query_token.clone();
    let result = tauri::async_runtime::spawn_blocking(move || worker(token, &flag)).await;
    let cancelled = requests.finish(&scope, &query_token);
    let result = result.map_err(|_| "file_unavailable".to_string())?;
    if cancelled {
        return Err("file_cancelled".into());
    }
    result
}

fn choose_preview(
    token: String,
    flag: &AtomicBool,
    pick: impl FnOnce() -> Result<PathBuf, &'static str>,
) -> Result<Preview, String> {
    if flag.load(Ordering::Acquire) {
        return Err("file_cancelled".into());
    }
    let path = pick()?;
    let root = path.parent().ok_or("file_invalid_path")?;
    preview(root, &path, token, None, flag)
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) fn cancel_file_preview(
    window: tauri::WebviewWindow,
    requests: tauri::State<'_, Requests>,
    query_token: String,
) -> Result<(), String> {
    if !valid_token(&query_token) {
        return Err("file_invalid_request".into());
    }
    requests.cancel(window.label(), &query_token);
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::{
            ffi::OsStrExt,
            fs::{symlink, PermissionsExt},
        },
        path::PathBuf,
    };
    struct Fixture(PathBuf);
    std::thread_local! {
        pub(super) static AFTER_SESSION_READ: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
    }
    const TOKEN: &str = "12345678-1234-4234-8234-123456789abc";

    #[test]
    fn closure_t13_session_preview_rechecks_actual_history_after_read() {
        for change in [
            "none",
            "cwd",
            "launch",
            "started",
            "conversation",
            "ssh",
            "missing",
            "cancel",
        ] {
            let f = Fixture::new();
            let path = f.0.join("literal.txt");
            fs::write(&path, "owned literal").unwrap();
            let history =
                Arc::new(crate::history::HistoryStore::open(f.0.join("history")).unwrap());
            let id = crate::next_session_id();
            history
                .start(&crate::SessionSummary {
                    session_id: id.clone(),
                    cwd: f.0.to_str().unwrap().into(),
                    command: None,
                    status: "running".into(),
                    ssh: None,
                    launch: None,
                })
                .unwrap();
            let app = tauri::test::mock_builder()
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .unwrap();
            let manager = crate::SessionManager::default();
            *manager.history.lock().unwrap() = Some(history.clone());
            app.manage(manager);
            let flag = Arc::new(AtomicBool::new(false));
            let cancelled = flag.clone();
            AFTER_SESSION_READ.with(|hook| {
                *hook.borrow_mut() = Some(Box::new(move || {
                    let mut records = history.records.lock().unwrap();
                    let record = &mut records[0];
                    match change {
                        "none" => {}
                        "cwd" => record.summary.cwd.push_str("/changed"),
                        "launch" => {
                            record.summary.launch = Some(crate::AgentLaunch {
                                codex: None,
                                env_refs: Default::default(),
                                adapter: "claude".into(),
                                mode: "new".into(),
                                extra_args: String::new(),
                                prompt: None,
                                provider: None,
                            })
                        }
                        "started" => record.started_at += 1,
                        "conversation" => {
                            record.conversation_id = Some("changed-conversation".into())
                        }
                        "ssh" => record.summary.ssh = Some(
                            serde_json::from_value(
                                serde_json::json!({"host":"fixture.test","user":null,"port":null}),
                            )
                            .unwrap(),
                        ),
                        "missing" => records.clear(),
                        "cancel" => cancelled.store(true, Ordering::Release),
                        _ => unreachable!(),
                    }
                }))
            });
            let result = session_preview(
                app.handle(),
                id.clone(),
                path.to_str().unwrap().into(),
                TOKEN.into(),
                &flag,
            );
            AFTER_SESSION_READ.with(|hook| {
                hook.borrow_mut().take();
            });
            match change {
                "none" => {
                    let reply = result.unwrap();
                    assert_eq!(reply.session_id.as_deref(), Some(id.as_str()));
                    assert!(
                        matches!(reply.content,Content::Text{ref text} if text=="owned literal")
                    );
                }
                "missing" => assert_eq!(result.unwrap_err(), "file_session_unavailable"),
                "cancel" => assert_eq!(result.unwrap_err(), "file_cancelled"),
                _ => assert_eq!(result.unwrap_err(), "file_session_changed", "{change}"),
            }
        }
    }

    #[test]
    fn closure_t13_preview_worker_releases_queries_and_rejects_late_cancel() {
        tauri::async_runtime::block_on(async {
            let requests = Requests::default();
            assert_eq!(
                preview_request_with(
                    "main".into(),
                    requests.clone(),
                    "bad".into(),
                    |_, _| panic!("invalid request admitted")
                )
                .await
                .unwrap_err(),
                "file_invalid_request"
            );
            assert_eq!(
                preview_request_with(
                    "main".into(),
                    requests.clone(),
                    TOKEN.into(),
                    |_, _| panic!("owned worker failure")
                )
                .await
                .unwrap_err(),
                "file_unavailable"
            );
            let f = Fixture::new();
            let path = f.0.join("file.txt");
            fs::write(&path, "content").unwrap();
            let shared = requests.clone();
            assert_eq!(
                preview_request_with(
                    "main".into(),
                    requests.clone(),
                    TOKEN.into(),
                    move |token, flag| {
                        let result = choose_preview(token, flag, || Ok(path));
                        shared.cancel("main", TOKEN);
                        result
                    }
                )
                .await
                .unwrap_err(),
                "file_cancelled"
            );
            let next = "22345678-1234-4234-8234-123456789abc";
            assert_eq!(
                preview_request_with(
                    "main".into(),
                    requests.clone(),
                    next.into(),
                    |token, flag| choose_preview(token, flag, || Err("file_cancelled"))
                )
                .await
                .unwrap_err(),
                "file_cancelled"
            );
            assert!(requests.0.lock().unwrap()["main"].active.is_none());
            assert_eq!(
                preview_request_with(
                    "main".into(),
                    requests.clone(),
                    next.into(),
                    |token, flag| choose_preview(token, flag, || Err("file_invalid_path"))
                )
                .await
                .unwrap_err(),
                "file_invalid_path"
            );
            assert!(requests.0.lock().unwrap()["main"].active.is_none());
        });
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn jpeg_rejects_missing_scan_data_even_when_imageio_recovers() {
        let bytes = include_bytes!("../../tests/fixtures/file-preview-2x3.jpg");
        let scan = bytes.windows(2).position(|v| v == b"\xff\xda").unwrap();
        let start =
            scan + 2 + u16::from_be_bytes(bytes[scan + 2..scan + 4].try_into().unwrap()) as usize;
        let mut corrupt = bytes[..start].to_vec();
        corrupt.extend_from_slice(b"\xff\xd9");
        assert_eq!(image_info(&corrupt).unwrap_err(), "file_invalid_image");
        let mut corrupt = bytes[..start].to_vec();
        corrupt.extend_from_slice(b"\xff\xd0\xff\xd9");
        assert_eq!(image_info(&corrupt).unwrap_err(), "file_invalid_image");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn file_preview_static_image_formats_decode_and_ignore_file_extension() {
        for (bytes, mime) in [
            (
                include_bytes!("../../tests/fixtures/file-preview-2x3.png").as_slice(),
                "image/png",
            ),
            (
                include_bytes!("../../tests/fixtures/file-preview-2x3.jpg").as_slice(),
                "image/jpeg",
            ),
            (
                include_bytes!("../../tests/fixtures/file-preview-2x3.webp").as_slice(),
                "image/webp",
            ),
        ] {
            assert_eq!(
                image_info(bytes).unwrap(),
                ImageInfo {
                    mime,
                    width: 2,
                    height: 3
                }
            );
            assert!(image_info(&bytes[..bytes.len() / 2]).is_err());
        }
        let f = Fixture::new();
        fs::write(f.0.join("fake.png"), "<script>literal</script>").unwrap();
        assert!(
            preview(
                &f.0,
                &f.0.join("fake.png"),
                "token".into(),
                None,
                &AtomicBool::new(false)
            )
            .is_err(),
            "an image extension cannot authenticate text as image data"
        );
        let bytes = include_bytes!("../../tests/fixtures/file-preview-2x3.png");
        fs::write(f.0.join("image.txt"), bytes).unwrap();
        let result = preview(
            &f.0,
            &f.0.join("image.txt"),
            "token".into(),
            None,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert!(matches!(
            result.content,
            Content::Image {
                width: 2,
                height: 3,
                ..
            }
        ));
        fs::write(f.0.join("plain.svg"), "<svg><script>literal</script></svg>").unwrap();
        assert!(matches!(
            preview(
                &f.0,
                &f.0.join("plain.svg"),
                "token".into(),
                None,
                &AtomicBool::new(false)
            )
            .unwrap()
            .content,
            Content::Text { .. }
        ));
        fs::write(f.0.join("disguised.svg"), bytes).unwrap();
        assert!(preview(
            &f.0,
            &f.0.join("disguised.svg"),
            "token".into(),
            None,
            &AtomicBool::new(false)
        )
        .is_err());
        let mut corrupt = bytes.to_vec();
        corrupt[45] ^= 1;
        assert_eq!(image_info(&corrupt).unwrap_err(), "file_invalid_image");
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn file_preview_animation_pixel_and_byte_limits_fail_before_image_decode() {
        assert_eq!(
            image_info(include_bytes!(
                "../../tests/fixtures/file-preview-corrupt.png"
            ))
            .unwrap_err(),
            "file_invalid_image"
        );
        for bytes in [
            include_bytes!("../../tests/fixtures/file-preview-animated.png").as_slice(),
            include_bytes!("../../tests/fixtures/file-preview-animated.webp").as_slice(),
        ] {
            assert_eq!(image_info(bytes).unwrap_err(), "file_animated_image");
        }
        assert_eq!(
            image_info(include_bytes!(
                "../../tests/fixtures/file-preview-over16mp.png"
            ))
            .unwrap_err(),
            "file_image_pixel_limit"
        );
        assert_eq!(
            image_info(include_bytes!("../../tests/fixtures/file-preview-16mp.png"))
                .unwrap()
                .width,
            4000
        );
        assert_eq!(
            image_info(&vec![0; IMAGE_LIMIT + 1]).unwrap_err(),
            "file_too_large"
        );
        for bytes in [
            b"<svg>literal</svg>".as_slice(),
            b"<html>literal</html>",
            b"GIF89a fake",
            b"RIFFxxxxWEBPxxxx",
        ] {
            assert!(image_info(bytes).is_err());
        }
    }
    #[test]
    fn file_preview_precancel_never_opens_chooser_and_cancel_during_choice_never_reads() {
        let cancelled = AtomicBool::new(true);
        assert_eq!(
            choose_preview("token".into(), &cancelled, || panic!(
                "cancelled chooser must never open"
            ))
            .unwrap_err(),
            "file_cancelled"
        );
        let flag = AtomicBool::new(false);
        assert_eq!(
            choose_preview("token".into(), &flag, || {
                flag.store(true, Ordering::Release);
                Ok(PathBuf::from("/missing/file"))
            })
            .unwrap_err(),
            "file_cancelled"
        );
    }
    impl Fixture {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("yam-preview-{}", crate::next_session_id()));
            fs::create_dir(&p).unwrap();
            Self(fs::canonicalize(p).unwrap())
        }
        fn read(&self, name: &str) -> Result<String, &'static str> {
            read_text(&self.0, &self.0.join(name), &AtomicBool::new(false), || {})
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn file_preview_session_alias_preserves_request_correlation_and_native_bounds() {
        let f = Fixture::new();
        let outside = Fixture::new();
        fs::write(f.0.join("file.txt"), "literal").unwrap();
        fs::write(outside.0.join("secret"), "SECRET").unwrap();
        let alias = outside.0.join("project-alias");
        symlink(&f.0, &alias).unwrap();
        for cwd in [
            alias.clone(),
            PathBuf::from(format!("{}/", alias.display())),
        ] {
            for path in [
                alias.join("file.txt"),
                f.0.join("file.txt"),
                PathBuf::from(format!("{}//file.txt", alias.display())),
            ] {
                let requested = path.to_str().unwrap();
                let result = session_file_preview(
                    &cwd,
                    "s-alias",
                    requested,
                    "token".into(),
                    &AtomicBool::new(false),
                )
                .unwrap();
                assert_eq!(
                    result.path, requested,
                    "native alias reads must correlate to the exact requested file"
                );
                assert!(result.path.starts_with(&(result.root.clone() + "/")));
                assert!(matches!(result.content, Content::Text { ref text } if text == "literal"));
            }
        }
        for path in [
            outside.0.join("secret"),
            alias.join("../secret"),
            alias.join(".git/config"),
        ] {
            assert!(session_file_preview(
                &alias,
                "s-alias",
                path.to_str().unwrap(),
                "token".into(),
                &AtomicBool::new(false)
            )
            .is_err());
        }
        symlink(outside.0.join("secret"), f.0.join("escape")).unwrap();
        assert!(session_file_preview(
            &alias,
            "s-alias",
            alias.join("escape").to_str().unwrap(),
            "token".into(),
            &AtomicBool::new(false)
        )
        .is_err());
        assert_eq!(
            session_file_preview(
                &alias,
                "s-alias",
                alias.join("file.txt").to_str().unwrap(),
                "token".into(),
                &AtomicBool::new(true)
            )
            .unwrap_err(),
            "file_cancelled"
        );
    }
    #[test]
    fn file_preview_utf8_empty_boundary_and_literal_markup() {
        let f = Fixture::new();
        for text in [
            "".to_string(),
            "中文 😀\n<script>literal</script>".into(),
            "x".repeat(TEXT_LIMIT),
        ] {
            fs::write(f.0.join("file.html"), &text).unwrap();
            assert_eq!(f.read("file.html").unwrap(), text);
        }
        fs::write(f.0.join("big"), vec![b'x'; TEXT_LIMIT + 1]).unwrap();
        assert_eq!(f.read("big").unwrap_err(), "file_too_large");
        fs::write(f.0.join("bad"), [0xff, 0xfe]).unwrap();
        assert_eq!(f.read("bad").unwrap_err(), "file_invalid_utf8");
    }
    #[test]
    fn file_preview_rejects_escape_links_metadata_and_nonregular_files() {
        let f = Fixture::new();
        let outside = Fixture::new();
        fs::write(outside.0.join("secret"), "SECRET").unwrap();
        fs::write(f.0.join("plain"), "ok").unwrap();
        fs::create_dir(f.0.join("dir")).unwrap();
        fs::create_dir(f.0.join(".git")).unwrap();
        fs::write(f.0.join(".git/config"), "SECRET").unwrap();
        symlink(outside.0.join("secret"), f.0.join("link")).unwrap();
        symlink(&outside.0, f.0.join("linked-dir")).unwrap();
        let fifo = std::ffi::CString::new(f.0.join("fifo").as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        fs::hard_link(outside.0.join("secret"), f.0.join("hard")).unwrap();
        for name in [
            "dir",
            ".git/config",
            "link",
            "linked-dir/secret",
            "fifo",
            "hard",
            "../secret",
            "missing",
        ] {
            assert!(f.read(name).is_err(), "{name}");
        }
        assert_eq!(
            read_text(
                &f.0,
                &outside.0.join("secret"),
                &AtomicBool::new(false),
                || {}
            )
            .unwrap_err(),
            "file_outside_root"
        );
        assert_eq!(
            read_text(&f.0, &f.0.join("plain"), &AtomicBool::new(true), || {}).unwrap_err(),
            "file_cancelled"
        );
        fs::set_permissions(f.0.join("plain"), fs::Permissions::from_mode(0o0)).unwrap();
        assert!(f.read("plain").is_err());
    }
    #[test]
    fn file_preview_rejects_file_and_root_replacement_after_open() {
        for mode in ["file", "symlink", "root", "modify"] {
            let f = Fixture::new();
            let outside = Fixture::new();
            fs::write(f.0.join("plain"), "OLD").unwrap();
            fs::write(outside.0.join("secret"), "SECRET").unwrap();
            let moved = f.0.with_extension("moved");
            let result = read_text(
                &f.0,
                &f.0.join("plain"),
                &AtomicBool::new(false),
                || match mode {
                    "root" => {
                        fs::rename(&f.0, &moved).unwrap();
                        fs::create_dir(&f.0).unwrap();
                        fs::write(f.0.join("plain"), "NEW").unwrap();
                    }
                    "modify" => {
                        fs::write(f.0.join("plain"), "NEW").unwrap();
                    }
                    _ => {
                        fs::rename(f.0.join("plain"), f.0.join("old")).unwrap();
                        if mode == "symlink" {
                            symlink(outside.0.join("secret"), f.0.join("plain")).unwrap();
                        } else {
                            fs::write(f.0.join("plain"), "NEW").unwrap();
                        }
                    }
                },
            );
            assert!(result.is_err(), "{mode}");
            let _ = fs::remove_dir_all(moved);
        }
    }
    #[test]
    fn file_preview_registry_scopes_tokens_and_fences_precancellation() {
        let r = Requests::default();
        let token = "12345678-1234-4234-8234-123456789abc";
        assert!(r.begin("main", "bad").is_err());
        let first = r.begin("main", token).unwrap();
        assert_eq!(r.begin("main", token).unwrap_err(), "file_busy");
        let other = r.begin("secondary", token).unwrap();
        r.cancel("main", token);
        assert!(first.load(Ordering::Acquire));
        assert!(!other.load(Ordering::Acquire));
        r.finish("main", "other");
        assert_eq!(r.begin("main", token).unwrap_err(), "file_cancelled");
        r.finish("main", token);
        r.cancel("future", token);
        assert_eq!(r.begin("future", token).unwrap_err(), "file_cancelled");
        for n in 0..40 {
            r.cancel("future", &format!("token-{n}"));
        }
        assert_eq!(r.0.lock().unwrap()["future"].cancelled.len(), 16);
    }
}
