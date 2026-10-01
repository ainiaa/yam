// Author: Jeff.Liu
use std::{
    io::{BufRead, BufReader, Read},
    path::Path,
};

// Resolve only the trusted UUID filename; directory encoding is deliberately left to Claude.
// Official SDK also reads projects/<encoded-directory>/<UUID>.jsonl for native sessions.
pub(super) fn validate(config: &Path, cwd: &Path, id: &str) -> Result<(), String> {
    if !super::valid_resume_id(id) {
        return Err("Invalid Claude conversation ID".into());
    }
    let cwd = cwd
        .canonicalize()
        .map_err(|_| "Original Claude directory is unavailable")?;
    let entries = std::fs::read_dir(config.join("projects"))
        .map_err(|_| "Claude conversation storage is unavailable")?;
    let mut candidate = None;
    for (index, entry) in entries.enumerate() {
        if index >= 4096 {
            return Err("Claude project lookup exceeded its scan budget".into());
        }
        let entry = entry.map_err(|e| format!("Cannot inspect Claude storage: {e}"))?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let path = entry
            .path()
            .join(format!("{}.jsonl", id.to_ascii_lowercase()));
        match path.try_exists() {
            Ok(false) => continue,
            Ok(true) => {
                if candidate.replace(path).is_some() {
                    return Err("Claude conversation identity is ambiguous".into());
                }
            }
            Err(e) => return Err(format!("Cannot inspect Claude conversation: {e}")),
        }
    }
    let path = candidate
        .ok_or("Original Claude conversation was not found; no new conversation was started")?;
    let file =
        std::fs::File::open(path).map_err(|e| format!("Cannot read Claude conversation: {e}"))?;
    let reader = BufReader::new(file.take(1024 * 1024));
    for line in reader.lines() {
        let line = line.map_err(|e| format!("Cannot read Claude metadata: {e}"))?;
        let value: serde_json::Value =
            serde_json::from_str(&line).map_err(|_| "Claude conversation metadata is invalid")?;
        if !matches!(value["type"].as_str(), Some("user" | "assistant")) {
            continue;
        }
        if value["sessionId"].as_str() != Some(id) || value["isSidechain"] != false {
            return Err("Claude conversation is not the original main session".into());
        }
        let original = value["cwd"]
            .as_str()
            .ok_or("Claude conversation directory is missing")?;
        if Path::new(original).canonicalize().ok().as_ref() != Some(&cwd) {
            return Err(
                "Original Claude conversation directory differs; resume was not started".into(),
            );
        }
        return Ok(());
    }
    Err("Claude conversation has no verifiable main-session metadata".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "446cd50d-099d-4a12-bcbc-5ab13ffa6944";
    #[test]
    fn only_existing_main_conversations_in_the_original_directory_are_resumable() {
        let root = std::env::temp_dir().join(super::super::next_session_id());
        let cwd = root.join("project 中文");
        let project = root.join("projects/encoded-directory");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        let path = project.join(format!("{ID}.jsonl"));
        let entry = serde_json::json!({"type":"user","sessionId":ID,"cwd":cwd,"isSidechain":false,"message":{"content":"private"}});
        std::fs::write(&path, format!("{{\"type\":\"metadata\"}}\n{entry}\n")).unwrap();
        assert!(validate(&root, &cwd, ID).is_ok());
        assert!(validate(&root, &root, ID).is_err());
        assert!(validate(&root, &cwd, "--last").is_err());
        for (field, value) in [
            ("sessionId", serde_json::json!("another")),
            ("isSidechain", serde_json::json!(true)),
            ("cwd", serde_json::Value::Null),
        ] {
            let mut bad = entry.clone();
            bad[field] = value;
            std::fs::write(&path, bad.to_string()).unwrap();
            assert!(validate(&root, &cwd, ID).is_err());
        }
        std::fs::write(&path, "not JSON").unwrap();
        assert!(validate(&root, &cwd, ID).is_err());
        std::fs::write(&path, "x".repeat(1024 * 1024 + 1)).unwrap();
        assert!(validate(&root, &cwd, ID).is_err());
        std::fs::write(&path, entry.to_string()).unwrap();
        let duplicate = root.join("projects/second");
        std::fs::create_dir_all(&duplicate).unwrap();
        std::fs::write(duplicate.join(format!("{ID}.jsonl")), entry.to_string()).unwrap();
        assert!(validate(&root, &cwd, ID).unwrap_err().contains("ambiguous"));
        std::fs::remove_file(duplicate.join(format!("{ID}.jsonl"))).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert!(validate(&root, &cwd, ID).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
