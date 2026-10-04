# T13 macOS recoverable Trash API assessment

Preparation only; no GUI, filesystem operation against candidate targets, Objective-C call, source/dependency edit, or Trash action was performed.

## Scope anchor

The authoritative correction is in `/tmp/yam-t13-cleanup-design-review.md`, especially “Scope correction after reading original T13” and “Recoverable Trash vs intermediate quarantine” (lines 102–123). Original T13 permits recoverable Trash as final disposition; it does not require permanent erasure or universal same-UID-writer immunity. A visible system Trash move can count as completed cleanup only after the clean/ownership/active preflight, registration removal, final disposition and journal state are verified. On API refusal or indeterminate result, preserve the quarantined tree and record recovery-needed; never fall back to recursive erase. Trash support must be explicitly platform-scoped and reported as such.

## Existing macOS dependencies and binding

`apps/desktop/src-tauri/Cargo.toml` already has macOS-target direct dependencies:
- `objc2 = "0.6.4"`
- `objc2-foundation = "0.3.2"`
- `objc2-user-notifications = "0.3.2"`
- `block2 = "0.6.2"`

The lock pins `objc2-foundation 0.3.2`. The dependency does not disable default features; its local manifest default feature set includes `NSFileManager`, `NSURL`, `NSError`, `NSString` and `std`. The existing generated Foundation binding exposes:

```rust
NSFileManager::defaultManager() -> Retained<NSFileManager>
trashItemAtURL_resultingItemURL_error(
    &self,
    url: &NSURL,
    out_resulting_url: Option<&mut Option<Retained<NSURL>>>,
) -> Result<(), Retained<NSError>>
NSURL::fileURLWithFileSystemRepresentation_isDirectory_relativeToURL(...)
NSURL::fileSystemRepresentation() -> NonNull<c_char>
```

The Trash method is gated on the already-default-enabled `NSError` and `NSURL` features. Thus the smallest macOS implementation can use existing Objective-C bindings, without a new crate, Swift source/build, `osascript`, or a runtime compiler. No dependency proposal is needed for this API path. Do not add Cargo features unless a later frozen manifest proves defaults were changed.

## API evidence and result semantics

Apple’s Objective-C method is `-[NSFileManager trashItemAtURL:resultingItemURL:error:]`; it returns YES when the item was successfully moved to Trash and NO when it was not moved, with NSError out parameter. When requested, `resultingItemURL` is set to the final Trash location; Apple explicitly says the name may change to avoid collisions and that this returned URL should be used to access the item. Local macOS 14.4 SDK’s `Foundation.framework/Headers/NSFileManager.h` repeats those semantics, marks the API available since macOS 10.8, and notes that failure returns NO with NSError. Rust’s objc2-foundation binding maps this to `Result<(), Retained<NSError>>` and accepts an optional out-URL slot.

Therefore a successful call supplies the exact URL that can be stored as the final Trash location in the YAM cleanup journal. Do not predict the Trash basename or derive it from the source. Persist the returned URL (bounded/validated representation) as soon as possible and verify the source/quarantine identity is gone and the returned item exists/has expected identity before publishing a completed status.

The method is synchronous and Apple documents no timeout, cancellation, durability barrier, or atomic transaction coupling it to Git registry deletion or YAM’s journal. Run the call on a worker so the UI/owner control loop is not blocked, but a wrapper timeout cannot cancel a Foundation call already in progress. If a deadline expires or the process stops between the filesystem move and journal save, classify the outcome as unknown/recovery-needed and reconcile from durable journal plus source/result identity; do not assume an error means no movement unless the method returned failure, and do not claim journal and Trash move are atomic. A process crash after successful Trash move but before storing the returned URL is a real gap: the precise URL may need bounded reconciliation from known Trash entries/metadata or the operation must remain unresolved. Avoid claiming guaranteed recovery unless that reconciliation is specified and tested.

## Path, Unicode, and error handling

Pass the actual filesystem path without lossy UTF-8 conversion. The existing binding includes `NSURL::fileURLWithFileSystemRepresentation_isDirectory_relativeToURL`; on macOS the Rust side can use `std::os::unix::ffi::OsStrExt` bytes, a temporary NUL-terminated buffer, and the NSURL filesystem-representation initializer. Set `isDirectory = true` for the whole quarantine directory and pass no base URL. This avoids `to_string_lossy()`, preserves non-ASCII names, and handles valid non-UTF-8 macOS path bytes; reject embedded NUL before FFI. The resulting NSURL can be read through `fileSystemRepresentation()` and converted back through `CStr` plus `OsStrExt`/PathBuf while the NSURL remains alive. Check that result is a file URL and that a nonempty, absolute filesystem path is returned before journaling. Do not log arbitrary NSError descriptions or private target paths; surface a fixed error code/message and retain the detailed native error only in appropriately private diagnostic handling if the project already supports it.

The Foundation URL constructor / out pointer and returned C path are unsafe FFI boundaries: validate NUL termination, pointer lifetime and directory type, and keep the returned NSURL alive while extracting its filesystem representation. Recheck candidate identity and inventory immediately before native call, then verify source disappearance and destination identity afterwards. Trash is a namespace move, not proof that pre-open handles stopped writing.

## Finite landing and recovery behavior

If Root authorizes implementation after freezing T13, prefer one `#[cfg(target_os = "macos")]` wrapper in the existing cleanup/worktree module, with a narrow test seam around the function pointer/result DTO (no production shell command). Keep the destination path operation journal explicit:
1. Finish lifecycle/ownership/clean preflight and durable prepared/quarantine state.
2. Move whole owned directory to a collision-safe private quarantine location on the same volume and journal/verify that state, if needed by the existing flow.
3. Remove only the validated Git registration using the already-proven no-force path.
4. Call Foundation Trash on the exact quarantined directory; request the resulting URL.
5. On success, verify expected source absent and returned object present/expected, then persist a distinct `trashed` / recoverable-complete state including returned location and report “moved to Trash; branch retained”. No claim of disk-space reclamation or automatic Git-worktree restoration.
6. On returned NSError/NO, unexpected identity, path mismatch or timeout/unknown effect, preserve data, keep recovery metadata and report recovery-needed. Never recursively delete as fallback.

Make the user flow’s “Preview + explicit confirmation” and actual active-session/clean/ownership checks prerequisites. Trash operation failure after Git registry removal means the files may remain in a quarantine path with a broken `.git` pointer; accurately report this and avoid claiming a restore operation can recreate the Git registration.

Minimum macOS-specific tests with an injected native seam: returned URL differs from source/name collision and gets journaled; Unicode/non-UTF8 path conversion boundaries; NSError failure preserves Q and never calls erase; timeout/unknown state is recovery-needed; crash windows before/after Trash move and before/after journal save reconcile without false completion; success checks returned destination identity. Native platform acceptance must use an isolated, synthetic owned worktree and actual macOS Trash, only in a separately authorized native test stage.

This is a macOS-only proof. Linux/freedesktop and Windows Trash integrations need their own APIs, bindings, package tests and native acceptance; do not call this cross-platform support.

## Sources checked

- Apple Objective-C API: [NSFileManager trashItemAtURL:resultingItemURL:error:](https://developer.apple.com/documentation/foundation/filemanager/trashitem%28at%3Aresultingitemurl%3A%29?changes=_8&language=objc) — URL output, name collision behavior, true/false result.
- Apple Swift API: [FileManager trashItem(at:resultingItemURL:)](https://developer.apple.com/documentation/foundation/filemanager/trashitem%28at%3Aresultingitemurl%3A%29?changes=__3) — resulting URL is the moved item’s Trash location.
- Local SDK: `/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/System/Library/Frameworks/Foundation.framework/Headers/NSFileManager.h`, declaration/comments at lines 211–215 (SDK 14.4).
- Existing bindings: `/Users/liuwenyuan/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/objc2-foundation-0.3.2/src/generated/NSFileManager.rs` (Trash out URL API) and `.../NSURL.rs` (filesystem representation URLs).
- Direct Cargo dependency and feature declarations: `apps/desktop/src-tauri/Cargo.toml` lines 42–45; pinned package in `apps/desktop/src-tauri/Cargo.lock`.
