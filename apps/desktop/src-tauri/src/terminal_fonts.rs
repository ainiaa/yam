// Author: Jeff.Liu. CoreText enumerates fonts without reading user documents or spawning processes.
#[cfg(target_os = "macos")]
fn installed_fonts() -> Result<Vec<String>, String> {
    use std::ffi::{c_char, c_void, CStr};
    type Ref = *const c_void;
    #[link(name = "CoreText", kind = "framework")]
    extern "C" {
        fn CTFontManagerCopyAvailableFontFamilyNames() -> Ref;
        fn CTFontCreateWithName(name: Ref, size: f64, matrix: Ref) -> Ref;
        fn CTFontGetSymbolicTraits(font: Ref) -> u32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFArrayGetCount(array: Ref) -> isize;
        fn CFArrayGetValueAtIndex(array: Ref, index: isize) -> Ref;
        fn CFStringGetCString(string: Ref, buffer: *mut c_char, size: isize, encoding: u32)
            -> bool;
        fn CFRelease(value: Ref);
    }
    struct Owned(Ref);
    impl Drop for Owned {
        fn drop(&mut self) {
            unsafe { CFRelease(self.0) }
        }
    }
    unsafe {
        let names = CTFontManagerCopyAvailableFontFamilyNames();
        if names.is_null() {
            return Err("font_catalog_unavailable".into());
        }
        let names = Owned(names);
        let count = CFArrayGetCount(names.0);
        if !(0..=8192).contains(&count) {
            return Err("font_catalog_unavailable".into());
        }
        let mut result = Vec::new();
        for index in 0..count {
            let name = CFArrayGetValueAtIndex(names.0, index);
            if name.is_null() {
                continue;
            }
            let font = CTFontCreateWithName(name, 13.0, std::ptr::null());
            if font.is_null() {
                continue;
            }
            let font = Owned(font);
            // kCTFontMonoSpaceTrait from CTFontTraits.h.
            if CTFontGetSymbolicTraits(font.0) & (1 << 10) == 0 {
                continue;
            }
            let mut bytes = [0 as c_char; 1024];
            if CFStringGetCString(name, bytes.as_mut_ptr(), bytes.len() as isize, 0x08000100) {
                if let Ok(name) = CStr::from_ptr(bytes.as_ptr()).to_str() {
                    if !name.is_empty()
                        && name.chars().count() <= 200
                        && !name.chars().any(char::is_control)
                    {
                        result.push(name.into());
                    }
                }
            }
        }
        result.sort();
        result.dedup();
        Ok(result)
    }
}
#[cfg(not(target_os = "macos"))]
fn installed_fonts() -> Result<Vec<String>, String> {
    Err("font_catalog_unsupported".into())
}

#[tauri::command]
pub(crate) fn list_terminal_fonts(window: tauri::Webview) -> Result<Vec<String>, String> {
    if !["main", "terminal-secondary"].contains(&window.label())
        || window.window().label() != window.label()
    {
        return Err("font_catalog_unavailable".into());
    }
    installed_fonts()
}

#[cfg(test)]
mod tests {
    #[test]
    fn font_discovery_returns_unique_valid_installed_monospace_names() {
        #[cfg(target_os = "macos")]
        {
            let fonts = super::installed_fonts().unwrap();
            assert!(!fonts.is_empty());
            assert!(fonts.iter().any(|s| s == "Menlo" || s == "Monaco"));
            assert!(fonts.windows(2).all(|p| p[0] < p[1]));
            assert!(fonts
                .iter()
                .all(|s| !s.is_empty() && !s.chars().any(char::is_control)));
        }
        #[cfg(not(target_os = "macos"))]
        assert!(super::installed_fonts().is_err());
    }
}
