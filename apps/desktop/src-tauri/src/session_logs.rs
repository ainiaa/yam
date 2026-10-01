use serde::{Deserialize, Serialize};

const MAX_LOG_BYTES: usize = 8 * 1024 * 1024;
const MAX_SCAN_BYTES: usize = 64 * 1024 * 1024;

pub(super) struct LogSource {
    pub session_id: String,
    pub cwd: String,
}
pub(super) struct LogData {
    pub data: String,
    pub offset: u64,
}
#[derive(Deserialize, Serialize)]
pub(super) struct SearchRequest {
    pub query: String,
    pub case_sensitive: bool,
    pub skip: usize,
    pub limit: usize,
}
#[derive(Debug, Serialize, Deserialize)]
pub(super) struct LogHit {
    session_id: String,
    cwd: String,
    offset: u64,
    column: usize,
    text: String,
}
#[derive(Debug, Serialize, Deserialize)]
pub(super) struct SearchPage {
    hits: Vec<LogHit>,
    has_more: bool,
    complete: bool,
    issues: Vec<String>,
}
pub(super) struct RecordedLine {
    pub offset: u64,
    pub text: String,
}

pub(super) fn plain_lines(raw: &str, base: u64) -> impl Iterator<Item = RecordedLine> + '_ {
    enum Parse {
        Ground,
        Escape,
        Csi,
        Payload(bool),
        PayloadEscape(bool),
    }
    let mut state = Parse::Ground;
    let mut chars = raw.char_indices();
    let mut text = String::new();
    let mut offset = base;
    let mut previous_cr = false;
    std::iter::from_fn(move || {
        for (index, ch) in chars.by_ref() {
            let crlf = previous_cr && ch == '\n';
            previous_cr = ch == '\r';
            match state {
                Parse::Ground => match ch {
                    '\x1b' => state = Parse::Escape,
                    '\u{9b}' => state = Parse::Csi,
                    '\u{9d}' => state = Parse::Payload(true),
                    '\u{90}' | '\u{9e}' | '\u{9f}' => state = Parse::Payload(false),
                    '\r' | '\n' => {
                        let start = offset;
                        offset = base + index as u64 + ch.len_utf8() as u64;
                        if !crlf {
                            return Some(RecordedLine {
                                offset: start,
                                text: std::mem::take(&mut text),
                            });
                        }
                    }
                    '\u{8}' => {
                        text.pop();
                    }
                    '\t' => text.push('\t'),
                    _ if !ch.is_control() => text.push(ch),
                    _ => {}
                },
                Parse::Escape => match ch {
                    '[' => state = Parse::Csi,
                    ']' => state = Parse::Payload(true),
                    'P' | '^' | '_' => state = Parse::Payload(false),
                    '\x1b' | ' '..='/' => {}
                    _ => state = Parse::Ground,
                },
                Parse::Csi => {
                    if ch == '\x1b' {
                        state = Parse::Escape;
                    } else if ('@'..='~').contains(&ch) {
                        state = Parse::Ground;
                    }
                }
                Parse::Payload(bell) => {
                    if ch == '\u{9c}' || (bell && ch == '\x07') {
                        state = Parse::Ground;
                    } else if ch == '\x1b' {
                        state = Parse::PayloadEscape(bell);
                    }
                }
                Parse::PayloadEscape(bell) => {
                    state = if ch == '\\' || ch == '\u{9c}' || (bell && ch == '\x07') {
                        Parse::Ground
                    } else if ch == '\x1b' {
                        Parse::PayloadEscape(bell)
                    } else {
                        Parse::Payload(bell)
                    };
                }
            }
        }
        if text.is_empty() {
            None
        } else {
            Some(RecordedLine {
                offset,
                text: std::mem::take(&mut text),
            })
        }
    })
}

fn match_position(text: &str, needle: &str, sensitive: bool) -> Option<usize> {
    if sensitive {
        return text.find(needle).map(|byte| text[..byte].chars().count());
    }
    let byte = text.to_lowercase().find(needle)?;
    let mut position = 0;
    for (index, ch) in text.chars().enumerate() {
        position += ch.to_lowercase().map(char::len_utf8).sum::<usize>();
        if position > byte {
            return Some(index);
        }
    }
    None
}

pub(super) fn search(
    sources: &[LogSource],
    read: impl Fn(&str) -> Result<LogData, String>,
    request: &SearchRequest,
    cancelled: impl Fn() -> bool,
) -> Result<SearchPage, String> {
    if request.query.trim().is_empty()
        || request.query.contains('\0')
        || request.query.chars().count() > 256
        || !(1..=50).contains(&request.limit)
        || request.skip > 5000
    {
        return Err(
            "Use 1–256 query characters, up to 50 results, and at most 5000 skipped lines".into(),
        );
    }
    let needle = if request.case_sensitive {
        request.query.clone()
    } else {
        request.query.to_lowercase()
    };
    let mut page = SearchPage {
        hits: Vec::new(),
        has_more: false,
        complete: true,
        issues: Vec::new(),
    };
    let mut bytes = 0usize;
    let mut matches = 0usize;
    for (index, source) in sources.iter().enumerate() {
        if cancelled() {
            return Err("Search cancelled".into());
        }
        if index == 256 {
            page.complete = false;
            page.issues
                .push("256-session scan budget reached; narrow the search to one session".into());
            break;
        }
        if bytes >= MAX_SCAN_BYTES {
            page.complete = false;
            page.issues
                .push("64 MiB scan budget reached; narrow the search to one session".into());
            break;
        }
        let log = match read(&source.session_id) {
            Ok(log) => log,
            Err(error) => {
                page.complete = false;
                page.issues.push(format!("{}: {error}", source.session_id));
                continue;
            }
        };
        if log.data.len() > MAX_LOG_BYTES {
            page.complete = false;
            page.issues
                .push(format!("{}: log exceeds 8 MiB budget", source.session_id));
            continue;
        }
        if log.data.len() > MAX_SCAN_BYTES.saturating_sub(bytes) {
            page.complete = false;
            page.issues
                .push("64 MiB scan budget reached; narrow the search to one session".into());
            break;
        }
        bytes += log.data.len();
        for line in plain_lines(&log.data, log.offset) {
            if cancelled() {
                return Err("Search cancelled".into());
            }
            if let Some(position) = match_position(&line.text, &needle, request.case_sensitive) {
                if matches >= request.skip {
                    if page.hits.len() == request.limit {
                        page.has_more = true;
                        return Ok(page);
                    }
                    page.hits.push(LogHit {
                        session_id: source.session_id.clone(),
                        cwd: source.cwd.clone(),
                        offset: line.offset,
                        column: position,
                        text: line
                            .text
                            .chars()
                            .skip(position.saturating_sub(128))
                            .take(512)
                            .collect(),
                    });
                }
                matches += 1;
            }
        }
    }
    Ok(page)
}

pub(super) fn excerpt(log: &LogData, offset: u64, column: usize) -> Result<String, String> {
    if offset < log.offset {
        return Err("This result is no longer in the retained log; search again".into());
    }
    let mut context = std::collections::VecDeque::new();
    let mut found = false;
    let mut following = 0;
    for line in plain_lines(&log.data, log.offset) {
        if line.offset == offset {
            if column > line.text.chars().count() {
                return Err("Invalid log column".into());
            }
            found = true;
            context.push_back(
                line.text
                    .chars()
                    .skip(column.saturating_sub(128))
                    .take(512)
                    .collect::<String>(),
            );
        } else if !found {
            if line.offset > offset {
                break;
            }
            if context.len() == 10 {
                context.pop_front();
            }
            context.push_back(line.text.chars().take(512).collect::<String>());
        } else {
            context.push_back(line.text.chars().take(512).collect::<String>());
            following += 1;
            if following == 10 {
                break;
            }
        }
    }
    if !found {
        return Err("This recorded position is unavailable; search again".into());
    }
    Ok(context.into_iter().collect::<Vec<_>>().join("\n"))
}

pub(super) fn export_text(metadata: &str, log: &LogData, raw: bool) -> String {
    if raw {
        return format!("{metadata}{}", log.data);
    }
    let mut output = metadata.to_owned();
    for line in plain_lines(&log.data, log.offset) {
        output.push_str(&line.text);
        output.push('\n');
    }
    output
}

pub(super) fn write_export(target: &std::path::Path, data: &[u8]) -> Result<(), String> {
    use std::io::Write;
    publish_export(target, |file| {
        file.write_all(data)?;
        file.sync_all()
    })
}

fn publish_export(
    target: &std::path::Path,
    write: impl FnOnce(&mut std::fs::File) -> std::io::Result<()>,
) -> Result<(), String> {
    let parent = target
        .parent()
        .filter(|_| target.is_absolute() && target.file_name().is_some())
        .ok_or("Select an absolute export file path")?;
    let temporary = parent.join(format!(".yam-export-{}.tmp", super::next_session_id()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("Cannot create export: {error}"))?;
    let result = (|| {
        write(&mut file)?;
        // Linking a complete file publishes it atomically without replacing any existing target.
        std::fs::hard_link(&temporary, target)
    })();
    drop(file);
    let cleanup = std::fs::remove_file(&temporary);
    result.map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            "Export file already exists; choose a new file name".to_string()
        } else {
            format!("Export was not saved: {error}")
        }
    })?;
    cleanup
        .map_err(|error| format!("Export was saved, but temporary file cleanup failed: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sources() -> Vec<LogSource> {
        vec![
            LogSource {
                session_id: "s-one".into(),
                cwd: "/one".into(),
            },
            LogSource {
                session_id: "s-two".into(),
                cwd: "/two".into(),
            },
        ]
    }
    fn request(query: &str) -> SearchRequest {
        SearchRequest {
            query: query.into(),
            case_sensitive: false,
            skip: 0,
            limit: 2,
        }
    }
    fn read(id: &str) -> Result<LogData, String> {
        Ok(LogData {
            data: if id == "s-one" {
                "First\n中文 😀\nFIRST again\n"
            } else {
                "first other\n"
            }
            .into(),
            offset: 100,
        })
    }

    #[test]
    fn literal_search_handles_unicode_case_and_page_boundaries() {
        let page = search(&sources(), read, &request("first"), || false).unwrap();
        assert_eq!(page.hits.len(), 2);
        assert!(page.has_more);
        assert_eq!(page.hits[0].session_id, "s-one");
        assert_eq!(page.hits[0].offset, 100);
        let mut next = request("first");
        next.skip = 2;
        let page = search(&sources(), read, &next, || false).unwrap();
        assert_eq!(page.hits.len(), 1);
        assert_eq!(page.hits[0].session_id, "s-two");
        assert!(!page.has_more);
        assert_eq!(
            search(&sources(), read, &request("中文 😀"), || false)
                .unwrap()
                .hits
                .len(),
            1
        );
        let mut exact = request("FIRST");
        exact.case_sensitive = true;
        assert_eq!(
            search(&sources(), read, &exact, || false)
                .unwrap()
                .hits
                .len(),
            1
        );
        assert!(search(&sources(), read, &request("absent"), || false)
            .unwrap()
            .hits
            .is_empty());
    }

    #[test]
    fn control_payloads_are_not_searchable_or_executable_and_offsets_are_preserved() {
        let lines=plain_lines("\x1b[31mred\x1b[0m\r\n\x1b]8;;https://secret\x07link\x1b]8;;\x07\n\x1bPprivate\nbody\x1b\\safe\n",40).collect::<Vec<_>>();
        assert_eq!(
            lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(),
            ["red", "link", "safe"]
        );
        assert_eq!(lines[0].offset, 40);
        assert!(lines[1].offset > 40);
        assert_eq!(plain_lines("bad\u{8}X\n", 0).next().unwrap().text, "baX");
        assert_eq!(
            plain_lines("\u{9b}31mOK\u{9d}secret\u{9c}\n", 0)
                .next()
                .unwrap()
                .text,
            "OK"
        );
    }

    #[test]
    fn validation_cancellation_and_read_failures_do_not_claim_complete_results() {
        for query in ["", "  ", "\0"] {
            assert!(search(&sources(), read, &request(query), || false).is_err());
        }
        let mut invalid = request("first");
        invalid.limit = 0;
        assert!(search(&sources(), read, &invalid, || false).is_err());
        invalid.limit = 51;
        assert!(search(&sources(), read, &invalid, || false).is_err());
        assert!(search(&sources(), read, &request(&"x".repeat(257)), || false).is_err());
        assert!(search(&sources(), read, &request("first"), || true)
            .unwrap_err()
            .contains("cancelled"));
        let page = search(
            &sources(),
            |_| Err("read denied".into()),
            &request("first"),
            || false,
        )
        .unwrap();
        assert_eq!(page.issues.len(), 2);
        assert!(page.hits.is_empty());
        assert!(!page.complete);
    }

    #[test]
    fn oversized_logs_are_reported_and_matching_long_lines_keep_the_match_visible() {
        let page = search(
            &sources()[..1],
            |_| {
                Ok(LogData {
                    data: "x".repeat(MAX_LOG_BYTES + 1),
                    offset: 0,
                })
            },
            &request("x"),
            || false,
        )
        .unwrap();
        assert!(!page.complete);
        assert!(page.hits.is_empty());
        let page = search(
            &sources()[..1],
            |_| {
                Ok(LogData {
                    data: format!("{}needle{}", "中".repeat(1000), "😀".repeat(1000)),
                    offset: 0,
                })
            },
            &request("needle"),
            || false,
        )
        .unwrap();
        assert!(page.hits[0].text.contains("needle"));
        assert!(page.hits[0].text.chars().count() <= 512);
    }

    #[test]
    fn excerpt_uses_absolute_output_position_and_rejects_expired_or_invalid_locations() {
        let log = LogData {
            data: "one\n中文 😀 needle\nthree\n".into(),
            offset: 100,
        };
        assert!(excerpt(&log, 104, 5).unwrap().contains("中文 😀 needle"));
        for (offset, column) in [(99, 0), (102, 0), (999, 0), (104, 1000)] {
            assert!(excerpt(&log, offset, column).is_err());
        }
        let log = LogData {
            data: format!("{}needle", "中".repeat(2000)),
            offset: 400,
        };
        let value = excerpt(&log, 400, 2000).unwrap();
        assert!(value.contains("needle"));
        assert!(value.chars().count() <= 512);
    }

    #[test]
    fn export_formats_keep_metadata_and_unicode_without_executing_control_payloads() {
        let log = LogData {
            data: "\x1b[31m中文 😀\x1b[0m\n\x1b]52;c;secret\x07done\n".into(),
            offset: 123,
        };
        let plain = export_text("metadata\n", &log, false);
        assert!(plain.starts_with("metadata\n"));
        assert!(plain.contains("中文 😀\ndone\n"));
        assert!(!plain.contains("secret"));
        assert!(!plain.contains('\x1b'));
        let raw = export_text("metadata\n", &log, true);
        assert!(raw.ends_with(&log.data));
        assert!(raw.contains("secret"));
    }

    #[test]
    fn plain_export_preserves_blank_lines_and_scanning_does_not_collect_all_lines() {
        let log = LogData {
            data: "one\r\n\r\ntwo\n\n".into(),
            offset: 0,
        };
        assert_eq!(export_text("", &log, false), "one\n\ntwo\n\n");
        assert_eq!(plain_lines(&"\n".repeat(1024 * 1024), 0).take(2).count(), 2);
        let page = search(
            &sources()[..1],
            |_| {
                Ok(LogData {
                    data: "İ".repeat(1000) + "needle",
                    offset: 0,
                })
            },
            &request("NEEDLE"),
            || false,
        )
        .unwrap();
        assert!(page.hits[0].text.contains("needle"));
    }

    #[test]
    fn all_session_queries_have_a_file_budget_and_cancellation_stops_between_reads() {
        let many = (0..300)
            .map(|n| LogSource {
                session_id: format!("s-{n}"),
                cwd: "/tmp".into(),
            })
            .collect::<Vec<_>>();
        let reads = std::cell::Cell::new(0);
        let page = search(
            &many,
            |_| {
                reads.set(reads.get() + 1);
                Err("missing".into())
            },
            &request("x"),
            || false,
        )
        .unwrap();
        assert!(reads.get() <= 256);
        assert!(!page.complete);
        assert!(page
            .issues
            .iter()
            .any(|s| s.contains("session scan budget")));
        let cancelled = std::cell::Cell::new(false);
        assert!(search(
            &sources(),
            |id| {
                cancelled.set(true);
                read(id)
            },
            &request("x"),
            || cancelled.get()
        )
        .is_err());
    }

    #[test]
    fn export_writes_new_files_only_and_preserves_existing_targets_on_failure() {
        let root = std::env::temp_dir().join(format!(
            "yam-export-test-{}-{}",
            std::process::id(),
            super::super::next_session_id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let target = root.join("中文 output.txt");
        write_export(&target, b"complete").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"complete");
        assert!(write_export(&target, b"replacement").is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"complete");
        assert!(write_export(&root.join("missing/target.txt"), b"x").is_err());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn interrupted_export_never_publishes_partial_output() {
        use std::io::Write;
        let root = std::env::temp_dir().join(super::super::next_session_id());
        std::fs::create_dir_all(&root).unwrap();
        let target = root.join("export.txt");
        assert!(publish_export(&target, |file| {
            file.write_all(b"partial")?;
            Err(std::io::Error::other("injected write failure"))
        })
        .is_err());
        assert!(!target.exists());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        std::fs::remove_dir_all(root).unwrap();
    }
}
